/**
 * Margin Guard Support AI™ — Stage 1 documentation chat.
 * POST /.netlify/functions/mg-support-chat
 *
 * Auth: HMAC-valid mg_session via assertOwnerSupportSession.
 * Paying owners: session.e + session.c (same as bootstrap-tenant / owner APIs).
 * Platform admins: auth-status is_admin bypass (session.c not required).
 * Does not query invoices, quotes, payments, projects, or financial tables.
 * Does not trust browser tenant_id. Does not read mg_device_session.
 * OpenAI key stays server-side.
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
} = require("./_lib/mg-support/config");
const { routeSupportKnowledge } = require("./_lib/mg-support/router");
const { loadRoutedKnowledge } = require("./_lib/mg-support/loader");
const { assertOwnerSupportSession } = require("./_lib/mg-support/require-owner-session");

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

function buildUserPayload(message, page, docs) {
  const pageLine = page ? `Current owner page: ${page}` : "Current owner page: (not provided)";
  const docBlocks = docs
    .map((d) => `### ${d.title}\n${d.content}`)
    .join("\n\n");
  return [
    pageLine,
    "Verified documentation:",
    docBlocks || "(no matching module text loaded)",
    "Owner question:",
    message,
  ].join("\n\n");
}

function createHandler(deps = {}) {
  const readSession = deps.readSessionFromEvent || readSessionFromEvent;
  const fetchImpl = deps.fetch || globalThis.fetch;
  const getKey = deps.getOpenAiKey || (() => String(process.env.OPENAI_API_KEY || "").trim());
  const routeFn = deps.routeSupportKnowledge || routeSupportKnowledge;
  const loadFn = deps.loadRoutedKnowledge || loadRoutedKnowledge;
  const assertSession = deps.assertOwnerSupportSession || assertOwnerSupportSession;

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
            input: buildUserPayload(message, page, docs),
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
