/**
 * Optional paste-email quote draft. Owner/seller only.
 * Proposes fields + an operational-plan document and never persists the email.
 * Does not send, approve, publish, or change quote status.
 */
"use strict";

const { resolveOwnerOrSellerContext } = require("./_lib/tenant-device-guard");
const voice = require("./_lib/voice-operational-plan");
const draft = require("./_lib/quote-draft-from-email");

const MODEL_TIMEOUT_MS = 30000;
const DEFAULT_MODEL = "gpt-4o-mini";

function envValue(name, getEnv) {
  if (typeof getEnv === "function") {
    try {
      const v = getEnv(name);
      if (v != null && String(v).trim()) return String(v).trim();
    } catch (_err) {}
  }
  try {
    if (globalThis.Netlify && globalThis.Netlify.env && typeof globalThis.Netlify.env.get === "function") {
      const v = globalThis.Netlify.env.get(name);
      if (v != null && String(v).trim()) return String(v).trim();
    }
  } catch (_envErr) {}
  return String(process.env[name] || "").trim();
}

function json(statusCode, payload) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "private, no-store",
    },
    body: JSON.stringify(payload),
  };
}

function parseBody(raw) {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (_err) {
    return null;
  }
}

function extractOutputText(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) return data.output_text.trim();
  const chunks = [];
  for (const item of Array.isArray(data?.output) ? data.output : []) {
    for (const part of Array.isArray(item?.content) ? item.content : []) {
      if (typeof part?.text === "string") chunks.push(part.text);
      else if (typeof part?.output_text === "string") chunks.push(part.output_text);
    }
  }
  return chunks.join("\n").trim();
}

function parseModelJson(raw) {
  let text = String(raw || "").trim();
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch (_err) {
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first < 0 || last <= first) return null;
    try {
      const parsed = JSON.parse(text.slice(first, last + 1));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch (_nestedErr) {
      return null;
    }
  }
}

function openAiResponsesUrl(rawBase) {
  const base = String(rawBase || "https://api.openai.com").replace(/\/+$/, "");
  return /\/v1$/i.test(base) ? `${base}/responses` : `${base}/v1/responses`;
}

function buildModelInput(sourceText) {
  return [
    sourceText,
    "Extract only facts present in the email and proposal PDF text. Leave missing fields empty. Do not invent crew, hours, dates, quantities, materials, or prices.",
    "If numbered proposal concepts exist (01 demolition, 02 preparation, 03 tile installed), map each to a document day.",
  ].join("\n");
}

async function callOpenAi({ sourceText, fetchImpl, getEnv }) {
  const fetchFn = fetchImpl || fetch;
  const base = envValue("OPENAI_BASE_URL", getEnv) || "https://api.openai.com";
  const apiKey = envValue("OPENAI_API_KEY", getEnv);
  if (!apiKey && !envValue("OPENAI_BASE_URL", getEnv)) {
    const err = new Error("Quote draft AI is not configured.");
    err.code = "ai_not_configured";
    err.statusCode = 503;
    throw err;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
  let response;
  let raw = "";
  try {
    response = await fetchFn(openAiResponsesUrl(base), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: envValue("MG_QUOTE_EMAIL_OPENAI_MODEL", getEnv) || envValue("MG_VOICE_PLAN_OPENAI_MODEL", getEnv) || DEFAULT_MODEL,
        instructions: draft.SYSTEM_INSTRUCTIONS,
        input: buildModelInput(sourceText),
        text: {
          format: {
            type: "json_schema",
            name: "margin_guard_quote_draft_from_email",
            strict: true,
            schema: draft.RESPONSE_SCHEMA,
          },
        },
        max_output_tokens: 4000,
        store: false,
      }),
      signal: controller.signal,
    });
    raw = await response.text();
  } catch (err) {
    const out = new Error(
      err && err.name === "AbortError" ? "Email interpretation timed out." : "Email interpretation is unavailable."
    );
    out.code = err && err.name === "AbortError" ? "ai_timeout" : "ai_unavailable";
    out.statusCode = 502;
    throw out;
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    console.error("[quote-draft-from-email] model http", response.status);
    const err = new Error("Email interpretation is unavailable.");
    err.code = "ai_unavailable";
    err.statusCode = 502;
    throw err;
  }
  let envelope = {};
  try {
    envelope = raw ? JSON.parse(raw) : {};
  } catch (_err) {}
  const parsed = parseModelJson(extractOutputText(envelope));
  if (!parsed) {
    const err = new Error("The email interpretation was not valid. Please try again.");
    err.code = "invalid_ai_response";
    err.statusCode = 502;
    throw err;
  }
  return parsed;
}

function buildProposedDocument(emailBody, modelDocument) {
  const cleaned = draft.omitUnstatedCrew(emailBody, draft.stripFinancial(modelDocument || {}));
  const startDate = draft.dateSupportedByEmail(emailBody, cleaned.start_date);
  const dueDate = draft.dateSupportedByEmail(emailBody, cleaned.due_date);
  const normalized = voice.normalizeDocument(
    {
      schema_version: 1,
      source: "keyboard",
      days: Array.isArray(cleaned.days) ? cleaned.days : [],
    },
    { preserveEmptyCrew: true, startDate: null }
  );
  normalized.start_date = startDate || null;
  normalized.due_date = dueDate || null;
  if (Array.isArray(normalized.days)) {
    normalized.days = normalized.days.map((day) => ({
      ...day,
      date: null,
    }));
  }
  return normalized;
}

function createHandler(deps) {
  const options = deps || {};
  const resolveContext = options.resolveContext || resolveOwnerOrSellerContext;
  const interpret = options.interpret || callOpenAi;
  return async function handler(event) {
    const method = String((event && (event.httpMethod || event.method)) || "").toUpperCase();
    if (method !== "POST") {
      return json(405, { ok: false, code: "method_not_allowed", error: "Method not allowed." });
    }
    const body = parseBody(event && event.body);
    if (!body) {
      return json(400, { ok: false, code: "invalid_json", error: "Invalid JSON body." });
    }
    if (Object.prototype.hasOwnProperty.call(body, "tenant_id")) {
      return json(400, {
        ok: false,
        code: "tenant_id_rejected",
        error: "tenant_id is not accepted from the browser.",
      });
    }
    const emailBody = draft.normalizeEmailBody(body.email_body || body.email || body.text || "");
    const sourcePdfs = draft.normalizeSourcePdfs(body.source_pdfs || body.pdfs);
    const sourceText = draft.combineSourceText(emailBody, sourcePdfs);
    if (draft.isInsufficientSource(draft.combinedWorkText(emailBody, sourcePdfs))) {
      return json(400, {
        ok: false,
        code: "insufficient_source",
        error:
          "A client email address is not enough. Paste the email body or attach the proposal PDFs that show the work.",
      });
    }
    if (sourceText.length > draft.MAX_EMAIL_CHARS + 24000) {
      return json(400, {
        ok: false,
        code: "invalid_email_body",
        error: "The pasted email and PDF text is too long. Attach fewer PDFs or shorten the paste.",
      });
    }
    let ctx;
    try {
      ctx = await resolveContext(event);
    } catch (err) {
      return json(err && err.statusCode ? err.statusCode : 401, {
        ok: false,
        code: (err && err.code) || "unauthorized",
        error: (err && err.message) || "Unauthorized.",
      });
    }
    const tenantId = String(ctx && ctx.tenant && ctx.tenant.id ? ctx.tenant.id : "").trim();
    if (!tenantId) {
      return json(401, { ok: false, code: "unauthorized", error: "Unauthorized." });
    }
    let modelResult;
    try {
      modelResult = await interpret({
        sourceText,
        emailBody,
        fetchImpl: options.fetchImpl,
        getEnv: options.getEnv,
      });
    } catch (err) {
      return json(err && err.statusCode ? err.statusCode : 502, {
        ok: false,
        code: (err && err.code) || "ai_unavailable",
        error: (err && err.message) || "Email interpretation is unavailable.",
      });
    }
    const quoteFields = draft.sanitizeQuoteFields(draft.stripFinancial(modelResult.quote_fields));
    const needsReview = draft.ensureNeedsReview(quoteFields, modelResult.needs_review);
    const proposedDocument = buildProposedDocument(sourceText, modelResult.document);
    const incoming = voice.validateIncomingDocument(proposedDocument);
    if (!incoming.ok) {
      return json(422, {
        ok: false,
        code: "invalid_proposed_plan",
        error: (incoming.errors && incoming.errors[0] && incoming.errors[0].message) || "The proposed plan is invalid.",
        errors: incoming.errors,
      });
    }
    const publicScope = voice.buildPublicClientScope(proposedDocument);
    const payload = {
      ok: true,
      persisted: false,
      email_stored: false,
      draft_status: "draft",
      summary: String(modelResult.summary || "").trim().slice(0, 400),
      needs_review: needsReview,
      quote_fields: quoteFields,
      quote_notes: draft.composeQuoteNotes(quoteFields),
      proposed_document: proposedDocument,
      public_client_scope: publicScope,
      operational_plan: draft.deriveOperationalPlan(proposedDocument),
    };
    const serialized = JSON.stringify(payload);
    if (/OPENAI_API_KEY|sk-[a-zA-Z0-9]/.test(serialized)) {
      return json(502, { ok: false, code: "invalid_ai_response", error: "The email interpretation was not valid. Please try again." });
    }
    return json(200, payload);
  };
}

exports.handler = createHandler();
exports.createHandler = createHandler;
exports.callOpenAi = callOpenAi;
exports.buildProposedDocument = buildProposedDocument;
