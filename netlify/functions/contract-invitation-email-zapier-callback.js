/**
 * CH-013A.2.1Z — Zapier → Margin Guard email outcome callback.
 * POST /.netlify/functions/contract-invitation-email-zapier-callback
 *
 * Called by Zap after Gmail Send succeeds/fails. Catch Hook generic 200 is NOT
 * email sent — only this signed callback may finalize sent|failed.
 *
 * Auth: HMAC-SHA256 over timestamp + body (see zapier-provider.verifySignedRequest).
 * Prefer CONTRACT_EMAIL_ZAPIER_CALLBACK_SECRET; else CONTRACT_EMAIL_ZAPIER_HMAC_SECRET
 * with direction-bound material `v1.callback.${rawBody}`.
 *
 * Never accepts browser session auth. Never accepts raw token/URL.
 */

"use strict";

const {
  API_VERSION,
  handleZapierEmailCallback,
  scrubSecretsDeep,
} = require("./_lib/contract-invitation-email");
const {
  TIMESTAMP_HEADER,
  SIGNATURE_HEADER,
} = require("./_lib/providers/zapier-provider");
const { trimField } = require("./_lib/platform-events");

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function header(event, name) {
  const headers = event.headers || {};
  const lower = String(name).toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (String(k).toLowerCase() === lower) return v;
  }
  return "";
}

exports.handler = async (event) => {
  try {
    if (String(event.httpMethod || "POST").toUpperCase() !== "POST") {
      return json(405, { ok: false, error: "Method not allowed", version: API_VERSION });
    }

    // HMAC is verified inside handleZapierEmailCallback against exact rawBody
    // before payload fields are trusted. Parse only after that gate.
    const rawBody = typeof event.body === "string" ? event.body : "";
    const timestamp = trimField(header(event, TIMESTAMP_HEADER));
    const signature = trimField(header(event, SIGNATURE_HEADER));

    const result = await handleZapierEmailCallback({
      rawBody,
      timestamp,
      signature,
      payload: null,
    });

    const status = Number(result.status) || (result.ok ? 200 : 400);
    return json(status, {
      ok: result.ok === true,
      idempotent: result.idempotent === true,
      attempt_id: result.attempt_id || null,
      ui_status: result.ui_status || null,
      provider_message_id: result.provider_message_id || null,
      code: result.code || null,
      error: result.error || null,
      version: API_VERSION,
    });
  } catch (err) {
    const scrubbed = scrubSecretsDeep({
      message: err?.message || String(err),
      name: err?.name,
    });
    return json(500, {
      ok: false,
      error: String(scrubbed.message || "callback failed").slice(0, 200),
      code: "callback_exception",
      version: API_VERSION,
    });
  }
};
