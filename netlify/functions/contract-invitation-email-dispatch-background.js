/**
 * CH-013A.2.1 — Controlled email dispatch (Netlify background function).
 * POST /.netlify/functions/contract-invitation-email-dispatch-background
 *
 * Body is IDs only (Design B). Raw signing secret is opened from encrypted
 * invitation.metadata.email_handoffs[attempt_id] (AES-256-GCM, Design B).
 * Purpose-bound AAD: tenant_id|invitation_id|generation_id|attempt_id.
 *
 * Threat model (Netlify docs):
 * - Background request payload limit 256 KB; platform retains invocation payload
 *   for retries (retry after 1m, again after 2m on failure) — body is replayed.
 * - Function logs / exception telemetry may capture console output and thrown values.
 * Therefore plaintext raw tokens MUST NOT appear in the background body or logs.
 *
 * Auth: CONTRACT_EMAIL_DISPATCH_SECRET via X-MG-Dispatch-Key (fail closed).
 * Recipient is loaded from signer record server-side — never from the body.
 */

"use strict";

const {
  API_VERSION,
  dispatchInvitationEmail,
  scrubSecretsDeep,
} = require("./_lib/contract-invitation-email");
const { timingSafeEqualString } = require("./_lib/email-delivery-handoff");
const { trimField, validUuid } = require("./_lib/platform-events");

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function parseBody(raw) {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function assertInternal(event) {
  const expected = trimField(process.env.CONTRACT_EMAIL_DISPATCH_SECRET);
  if (!expected) {
    return {
      ok: false,
      status: 403,
      error: "Dispatch secret not configured",
      code: "dispatch_secret_missing",
    };
  }
  const headers = event.headers || {};
  const got = trimField(
    headers["x-mg-dispatch-key"] ||
      headers["X-MG-Dispatch-Key"] ||
      headers["x-mg-dispatch-secret"]
  );
  if (!timingSafeEqualString(got, expected)) {
    return { ok: false, status: 403, error: "Forbidden", code: "dispatch_forbidden" };
  }
  return { ok: true };
}

const ALLOWED_BODY_KEYS = new Set([
  "tenant_id",
  "attempt_id",
  "invitation_id",
  "public_origin",
  "correlation_id",
]);

exports.handler = async (event) => {
  try {
    if (String(event.httpMethod || "POST").toUpperCase() !== "POST") {
      return json(405, { ok: false, error: "Method Not Allowed" });
    }

    const gate = assertInternal(event);
    if (!gate.ok) {
      return json(gate.status, { ok: false, error: gate.error, code: gate.code });
    }

    const body = parseBody(event.body);
    if (!body) {
      return json(400, { ok: false, error: "Invalid JSON body", code: "invalid_json" });
    }

    const unknown = Object.keys(body).filter((k) => !ALLOWED_BODY_KEYS.has(k));
    if (unknown.length) {
      return json(400, {
        ok: false,
        error: `Unknown or forbidden fields: ${unknown.join(", ")}`,
        code: "forbidden_field",
      });
    }

    if (
      !validUuid(trimField(body.tenant_id)) ||
      !validUuid(trimField(body.attempt_id)) ||
      !validUuid(trimField(body.invitation_id))
    ) {
      return json(400, {
        ok: false,
        error: "tenant_id, attempt_id, invitation_id required",
        code: "invalid_id",
      });
    }

    const result = await dispatchInvitationEmail(
      {
        tenant_id: trimField(body.tenant_id),
        attempt_id: trimField(body.attempt_id),
        invitation_id: trimField(body.invitation_id),
        public_origin: trimField(body.public_origin) || null,
        correlation_id: trimField(body.correlation_id) || null,
      },
      {}
    );

    const safe = scrubSecretsDeep({
      ok: Boolean(result.ok),
      version: API_VERSION,
      attempt_id: result.attempt_id || body.attempt_id || null,
      accepted: Boolean(result.accepted),
      awaiting_callback: Boolean(result.awaiting_callback),
      idempotent: Boolean(result.idempotent),
      retryable: Boolean(result.retryable),
      code: result.code || null,
      error: result.ok
        ? null
        : String(result.error || result.code || "dispatch_failed").slice(0, 200),
      provider_message_id: result.provider_message_id || null,
    });

    return json(result.ok ? 200 : result.retryable ? 503 : 422, safe);
  } catch (err) {
    const scrubbed = scrubSecretsDeep({
      message: err?.message || String(err),
    });
    console.error(
      "contract-invitation-email-dispatch-background",
      scrubbed.message || "error"
    );
    return json(500, {
      ok: false,
      error: "Server error",
      code: "server_error",
      version: API_VERSION,
    });
  }
};
