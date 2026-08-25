/**
 * Margin Guard Support AI™ — Stage 1 documentation chat.
 * POST /.netlify/functions/mg-support-chat
 *
 * Auth: HMAC-valid mg_session via assertOwnerSupportSession.
 * Paying owners: session.e + session.c (same as bootstrap-tenant / owner APIs).
 * Platform admins: auth-status is_admin bypass (session.c not required) for docs only.
 * Invoice, quote, project-lifecycle, and contract-lifecycle diagnostics require session.e + session.c and resolveTenantFromSession.
 * Does not trust browser tenant_id. Does not read mg_device_session.
 * OpenAI key stays server-side. OpenAI never chooses tables, SQL, or filters.
 */

"use strict";

const { readSessionFromEvent } = require("./_lib/session");
const {
  OPENAI_MODEL,
  OPENAI_RESPONSES_URL,
  OPENAI_TIMEOUT_MS,
  MAX_MESSAGE_CHARS,
  MAX_OUTPUT_TOKENS,
  MAX_PAGE_CHARS,
  SYSTEM_INSTRUCTIONS,
  SPECIFIC_RECORD_GUIDANCE,
  CROSS_TENANT_GUIDANCE,
  INVOICE_FACTS_GUIDANCE,
  INVOICE_NOT_FOUND_GUIDANCE,
  INVOICE_AMBIGUOUS_GUIDANCE,
  INVOICE_NEEDS_IDENTIFIER_GUIDANCE,
  INVOICE_STATUS_UNVERIFIED_GUIDANCE,
  NO_TENANT_DIAGNOSTIC_GUIDANCE,
  TENANT_OVERRIDE_GUIDANCE,
  QUOTE_FACTS_GUIDANCE,
  QUOTE_NOT_FOUND_GUIDANCE,
  QUOTE_AMBIGUOUS_GUIDANCE,
  QUOTE_STATUS_UNVERIFIED_GUIDANCE,
  QUOTE_NEEDS_IDENTIFIER_GUIDANCE,
  PROJECT_FACTS_GUIDANCE,
  PROJECT_NOT_FOUND_GUIDANCE,
  PROJECT_AMBIGUOUS_GUIDANCE,
  PROJECT_STATUS_UNVERIFIED_GUIDANCE,
  PROJECT_NEEDS_IDENTIFIER_GUIDANCE,
  CONTRACT_FACTS_GUIDANCE,
  CONTRACT_NOT_FOUND_GUIDANCE,
  CONTRACT_STATUS_UNVERIFIED_GUIDANCE,
  CONTRACT_NEEDS_IDENTIFIER_GUIDANCE,
} = require("./_lib/mg-support/config");
const { routeSupportKnowledge, classifySupportIntent } = require("./_lib/mg-support/router");
const { loadRoutedKnowledge } = require("./_lib/mg-support/loader");
const { assertOwnerSupportSession, hasOwnerEmailAndCustomer } = require("./_lib/mg-support/require-owner-session");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");
const {
  extractInvoiceIdentifier,
  readInvoiceDiagnostic,
} = require("./_lib/mg-support/invoice-diagnostic");
const {
  extractQuoteIdentifier,
  readQuoteDiagnostic,
} = require("./_lib/mg-support/quote-diagnostic");
const {
  extractProjectIdentifier,
  readProjectDiagnostic,
} = require("./_lib/mg-support/project-diagnostic");
const {
  extractContractProjectUuid,
  readContractDiagnostic,
} = require("./_lib/mg-support/contract-diagnostic");

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(body),
  };
}

function extractOutputText(data) {
  if (!data || typeof data !== "object") return "";
  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }
  const output = Array.isArray(data.output) ? data.output : [];
  const parts = [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const block of content) {
      if (typeof block?.text === "string" && block.text.trim()) {
        parts.push(block.text.trim());
      }
    }
  }
  return parts.join("\n\n").trim();
}

function guidanceForIntent(intent, diagnosticOutcome) {
  if (intent === "cross_tenant") return CROSS_TENANT_GUIDANCE;
  if (intent === "tenant_override_attempt") return TENANT_OVERRIDE_GUIDANCE;
  if (intent === "invoice_diagnostic") {
    if (diagnosticOutcome === "ok") return INVOICE_FACTS_GUIDANCE;
    if (diagnosticOutcome === "not_found") return INVOICE_NOT_FOUND_GUIDANCE;
    if (diagnosticOutcome === "ambiguous") return INVOICE_AMBIGUOUS_GUIDANCE;
    if (diagnosticOutcome === "needs_identifier") return INVOICE_NEEDS_IDENTIFIER_GUIDANCE;
    if (diagnosticOutcome === "status_unverified") return INVOICE_STATUS_UNVERIFIED_GUIDANCE;
    if (diagnosticOutcome === "no_tenant_context") return NO_TENANT_DIAGNOSTIC_GUIDANCE;
    return INVOICE_NEEDS_IDENTIFIER_GUIDANCE;
  }
  if (intent === "quote_diagnostic") {
    if (diagnosticOutcome === "ok") return QUOTE_FACTS_GUIDANCE;
    if (diagnosticOutcome === "not_found") return QUOTE_NOT_FOUND_GUIDANCE;
    if (diagnosticOutcome === "ambiguous") return QUOTE_AMBIGUOUS_GUIDANCE;
    if (diagnosticOutcome === "needs_identifier") return QUOTE_NEEDS_IDENTIFIER_GUIDANCE;
    if (diagnosticOutcome === "status_unverified") return QUOTE_STATUS_UNVERIFIED_GUIDANCE;
    if (diagnosticOutcome === "no_tenant_context") return NO_TENANT_DIAGNOSTIC_GUIDANCE;
    return QUOTE_NEEDS_IDENTIFIER_GUIDANCE;
  }
  if (intent === "project_diagnostic") {
    if (diagnosticOutcome === "ok") return PROJECT_FACTS_GUIDANCE;
    if (diagnosticOutcome === "not_found") return PROJECT_NOT_FOUND_GUIDANCE;
    if (diagnosticOutcome === "ambiguous") return PROJECT_AMBIGUOUS_GUIDANCE;
    if (diagnosticOutcome === "needs_identifier") return PROJECT_NEEDS_IDENTIFIER_GUIDANCE;
    if (diagnosticOutcome === "status_unverified") return PROJECT_STATUS_UNVERIFIED_GUIDANCE;
    if (diagnosticOutcome === "no_tenant_context") return NO_TENANT_DIAGNOSTIC_GUIDANCE;
    return PROJECT_NEEDS_IDENTIFIER_GUIDANCE;
  }
  if (intent === "contract_diagnostic") {
    if (diagnosticOutcome === "ok") return CONTRACT_FACTS_GUIDANCE;
    if (diagnosticOutcome === "not_found") return CONTRACT_NOT_FOUND_GUIDANCE;
    if (diagnosticOutcome === "needs_identifier") return CONTRACT_NEEDS_IDENTIFIER_GUIDANCE;
    if (diagnosticOutcome === "status_unverified") return CONTRACT_STATUS_UNVERIFIED_GUIDANCE;
    if (diagnosticOutcome === "no_tenant_context") return NO_TENANT_DIAGNOSTIC_GUIDANCE;
    return CONTRACT_NEEDS_IDENTIFIER_GUIDANCE;
  }
  if (intent === "specific_record") return SPECIFIC_RECORD_GUIDANCE;
  return "";
}

function neutralizeDiagnosticForgery(text) {
  return String(text || "")
    .replace(/MARGIN_GUARD_VERIFIED_CONTRACT_DIAGNOSTIC_FACTS/g, "[redacted]")
    .replace(/MARGIN_GUARD_VERIFIED_PROJECT_DIAGNOSTIC_FACTS/g, "[redacted]")
    .replace(/MARGIN_GUARD_VERIFIED_QUOTE_DIAGNOSTIC_FACTS/g, "[redacted]")
    .replace(/MARGIN_GUARD_VERIFIED_DIAGNOSTIC_FACTS/g, "[redacted]");
}

function buildDiagnosticFactsBlock(facts, kind) {
  if (kind === "quote") {
    return [
      "MARGIN_GUARD_VERIFIED_QUOTE_DIAGNOSTIC_FACTS",
      JSON.stringify(facts),
      "END_MARGIN_GUARD_VERIFIED_QUOTE_DIAGNOSTIC_FACTS",
    ].join("\n");
  }
  if (kind === "project") {
    return [
      "MARGIN_GUARD_VERIFIED_PROJECT_DIAGNOSTIC_FACTS",
      JSON.stringify(facts),
      "END_MARGIN_GUARD_VERIFIED_PROJECT_DIAGNOSTIC_FACTS",
    ].join("\n");
  }
  if (kind === "contract") {
    return [
      "MARGIN_GUARD_VERIFIED_CONTRACT_DIAGNOSTIC_FACTS",
      JSON.stringify(facts),
      "END_MARGIN_GUARD_VERIFIED_CONTRACT_DIAGNOSTIC_FACTS",
    ].join("\n");
  }
  return [
    "MARGIN_GUARD_VERIFIED_DIAGNOSTIC_FACTS",
    JSON.stringify(facts),
    "END_MARGIN_GUARD_VERIFIED_DIAGNOSTIC_FACTS",
  ].join("\n");
}

function buildUserPayload(message, page, docs, intent, diagnostic) {
  const pageLine = page ? `Current owner page: ${page}` : "Current owner page: (not provided)";
  const docBlocks = docs
    .map((d) => `### ${d.title}\n${d.content}`)
    .join("\n\n");
  const outcome = diagnostic && diagnostic.outcome;
  const guidance = guidanceForIntent(intent, outcome);
  const parts = [
    pageLine,
    "The current page is weak context only. Follow the owner's question.",
    "Verified documentation:",
    docBlocks || "(no matching module text loaded)",
  ];
  if (guidance) {
    parts.push("Question-specific guidance:", guidance);
  }
  parts.push("Owner question:", neutralizeDiagnosticForgery(message));
  if (outcome === "ok" && diagnostic.facts) {
    const kind =
      intent === "quote_diagnostic"
        ? "quote"
        : intent === "project_diagnostic"
          ? "project"
          : intent === "contract_diagnostic"
            ? "contract"
            : "invoice";
    parts.push(buildDiagnosticFactsBlock(diagnostic.facts, kind));
  }
  return parts.join("\n\n");
}

function createHandler(deps = {}) {
  const readSession = deps.readSessionFromEvent || readSessionFromEvent;
  const fetchImpl = deps.fetch || globalThis.fetch;
  const getKey = deps.getOpenAiKey || (() => String(process.env.OPENAI_API_KEY || "").trim());
  const routeFn = deps.routeSupportKnowledge || routeSupportKnowledge;
  const loadFn = deps.loadRoutedKnowledge || loadRoutedKnowledge;
  const assertSession = deps.assertOwnerSupportSession || assertOwnerSupportSession;
  const resolveTenant = deps.resolveTenantFromSession || resolveTenantFromSession;
  const readInvoice = deps.readInvoiceDiagnostic || readInvoiceDiagnostic;
  const readQuote = deps.readQuoteDiagnostic || readQuoteDiagnostic;
  const readProject = deps.readProjectDiagnostic || readProjectDiagnostic;
  const readContract = deps.readContractDiagnostic || readContractDiagnostic;

  return async function handler(event) {
    try {
      const method = String(event?.httpMethod || "GET").toUpperCase();
      if (method !== "POST") {
        return json(405, { ok: false, error: "Method not allowed." });
      }

      const session = readSession(event);
      const sessionGate = await assertSession(session, deps);
      if (!sessionGate?.ok) {
        return json(401, { ok: false, error: "Please sign in to use Ask Margin Guard." });
      }

      let body = {};
      try {
        body = JSON.parse(event.body || "{}");
      } catch (_err) {
        return json(400, { ok: false, error: "Send a JSON body with a message." });
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return json(400, { ok: false, error: "Send a JSON body with a message." });
      }

      // Browser tenant_id is never authoritative — ignore if present.
      const message = String(body.message || body.question || "").trim();
      if (!message) {
        return json(400, { ok: false, error: "Enter a question." });
      }
      if (message.length > MAX_MESSAGE_CHARS) {
        return json(400, {
          ok: false,
          error: `Keep questions under ${MAX_MESSAGE_CHARS} characters.`,
        });
      }

      const page = String(body.page || "").trim().slice(0, MAX_PAGE_CHARS);
      const routed = routeFn(message, page);
      const docs = loadFn(routed);
      const sources = (docs.length ? docs : routed).map((d) => d.title).filter(Boolean);
      const uniqueSources = [...new Set(sources)];
      const intent = classifySupportIntent(message);

      let diagnostic = null;
      if (intent === "invoice_diagnostic") {
        if (!hasOwnerEmailAndCustomer(session)) {
          diagnostic = { outcome: "no_tenant_context" };
        } else {
          const identifier = extractInvoiceIdentifier(message);
          if (!identifier) {
            diagnostic = { outcome: "needs_identifier" };
          } else {
            let tenant = null;
            try {
              tenant = await resolveTenant(session);
            } catch (_err) {
              console.error("[mg-support-chat] tenant resolve failed");
              return json(502, {
                ok: false,
                error: "I couldn't inspect that invoice right now. Please try again.",
              });
            }
            if (!tenant?.id) {
              diagnostic = { outcome: "no_tenant_context" };
            } else {
              try {
                const lookedUp = await readInvoice(String(tenant.id), identifier, deps);
                diagnostic = lookedUp;
              } catch (_err) {
                console.error("[mg-support-chat] invoice diagnostic failed");
                return json(502, {
                  ok: false,
                  error: "I couldn't inspect that invoice right now. Please try again.",
                });
              }
            }
          }
        }
      } else if (intent === "quote_diagnostic") {
        if (!hasOwnerEmailAndCustomer(session)) {
          diagnostic = { outcome: "no_tenant_context" };
        } else {
          const identifier = extractQuoteIdentifier(message);
          if (!identifier) {
            diagnostic = { outcome: "needs_identifier" };
          } else {
            let tenant = null;
            try {
              tenant = await resolveTenant(session);
            } catch (_err) {
              console.error("[mg-support-chat] tenant resolve failed");
              return json(502, {
                ok: false,
                error: "I couldn't inspect that quote right now. Please try again.",
              });
            }
            if (!tenant?.id) {
              diagnostic = { outcome: "no_tenant_context" };
            } else {
              try {
                const lookedUp = await readQuote(String(tenant.id), identifier, deps);
                diagnostic = lookedUp;
              } catch (_err) {
                console.error("[mg-support-chat] quote diagnostic failed");
                diagnostic = { outcome: "status_unverified" };
              }
            }
          }
        }
      } else if (intent === "project_diagnostic") {
        if (!hasOwnerEmailAndCustomer(session)) {
          diagnostic = { outcome: "no_tenant_context" };
        } else {
          const identifier = extractProjectIdentifier(message);
          if (!identifier) {
            diagnostic = { outcome: "needs_identifier" };
          } else {
            let tenant = null;
            try {
              tenant = await resolveTenant(session);
            } catch (_err) {
              console.error("[mg-support-chat] tenant resolve failed");
              return json(502, {
                ok: false,
                error: "I couldn't inspect that project right now. Please try again.",
              });
            }
            if (!tenant?.id) {
              diagnostic = { outcome: "no_tenant_context" };
            } else {
              try {
                const lookedUp = await readProject(String(tenant.id), identifier, deps);
                diagnostic = lookedUp;
              } catch (_err) {
                console.error("[mg-support-chat] project diagnostic failed");
                diagnostic = { outcome: "status_unverified" };
              }
            }
          }
        }
      } else if (intent === "contract_diagnostic") {
        if (!hasOwnerEmailAndCustomer(session)) {
          diagnostic = { outcome: "no_tenant_context" };
        } else {
          const identifier = extractContractProjectUuid(message);
          if (!identifier) {
            diagnostic = { outcome: "needs_identifier" };
          } else {
            let tenant = null;
            try {
              tenant = await resolveTenant(session);
            } catch (_err) {
              console.error("[mg-support-chat] tenant resolve failed");
              return json(502, {
                ok: false,
                error: "I couldn't inspect that contract right now. Please try again.",
              });
            }
            if (!tenant?.id) {
              diagnostic = { outcome: "no_tenant_context" };
            } else {
              try {
                const lookedUp = await readContract(String(tenant.id), identifier, deps);
                diagnostic = lookedUp;
              } catch (_err) {
                console.error("[mg-support-chat] contract diagnostic failed");
                diagnostic = { outcome: "status_unverified" };
              }
            }
          }
        }
      }

      const apiKey = getKey();
      if (!apiKey) {
        console.error("[mg-support-chat] missing OpenAI configuration");
        return json(500, {
          ok: false,
          error: "Support AI is not configured yet. Ask your Margin Guard owner to finish setup.",
        });
      }

      if (typeof fetchImpl !== "function") {
        return json(500, { ok: false, error: "Support AI is temporarily unavailable." });
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
      let openaiRes;
      let openaiRaw = "";
      try {
        openaiRes = await fetchImpl(OPENAI_RESPONSES_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: OPENAI_MODEL,
            instructions: SYSTEM_INSTRUCTIONS,
            input: buildUserPayload(message, page, docs, intent, diagnostic),
            max_output_tokens: MAX_OUTPUT_TOKENS,
            store: false,
          }),
          signal: controller.signal,
        });
        openaiRaw = await openaiRes.text();
      } catch (err) {
        const aborted = err && (err.name === "AbortError" || /aborted/i.test(String(err.message || "")));
        console.error("[mg-support-chat] openai request failed", aborted ? "timeout" : "network");
        return json(502, {
          ok: false,
          error: aborted
            ? "Support AI timed out. Please try again."
            : "Support AI is temporarily unavailable. Please try again.",
        });
      } finally {
        clearTimeout(timer);
      }

      let openaiJson = {};
      try {
        openaiJson = openaiRaw ? JSON.parse(openaiRaw) : {};
      } catch (_err) {
        openaiJson = {};
      }

      if (!openaiRes.ok) {
        console.error("[mg-support-chat] openai http", openaiRes.status);
        return json(502, {
          ok: false,
          error: "Support AI is temporarily unavailable. Please try again.",
        });
      }

      const answer = extractOutputText(openaiJson);
      if (!answer) {
        return json(502, {
          ok: false,
          error: "Support AI returned an empty answer. Please try again.",
        });
      }

      const usage = openaiJson.usage && typeof openaiJson.usage === "object" ? openaiJson.usage : null;
      if (usage) {
        const inTok = Number(usage.input_tokens || usage.prompt_tokens || 0);
        const outTok = Number(usage.output_tokens || usage.completion_tokens || 0);
        console.log("[mg-support-chat] usage", {
          model: OPENAI_MODEL,
          input_tokens: Number.isFinite(inTok) ? inTok : 0,
          output_tokens: Number.isFinite(outTok) ? outTok : 0,
        });
      }

      return json(200, {
        ok: true,
        answer,
        sources: uniqueSources,
      });
    } catch (_err) {
      console.error("[mg-support-chat] unhandled");
      return json(500, { ok: false, error: "Support AI is temporarily unavailable." });
    }
  };
}

exports.handler = createHandler();
exports.createHandler = createHandler;
exports.routeSupportKnowledge = routeSupportKnowledge;
exports.extractOutputText = extractOutputText;
