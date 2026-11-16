/**
 * Owner Copy Signing Link after the original one-shot URL is gone.
 * POST /.netlify/functions/contract-invitation-copy-link
 * Body: { envelope_id, signer_id }
 * Returns signing_url once. Never returns raw token. Does not send email.
 */

"use strict";

const { requireOwnerOrAdmin } = require("./_lib/require-owner-or-admin");
const { unknownKeys, trimField, validUuid } = require("./_lib/contract-envelope");
const { revealOwnerCopyLink, API_VERSION } = require("./_lib/contract-invitation-copy-link");

const ALLOWED_BODY_KEYS = new Set(["envelope_id", "signer_id"]);

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

function publicOriginFromEvent(event) {
  const headers = event.headers || {};
  const proto =
    trimField(headers["x-forwarded-proto"] || headers["X-Forwarded-Proto"]) || "https";
  const host = trimField(headers.host || headers.Host);
  if (host) return `${proto}://${host}`;
  return (
    trimField(process.env.PUBLIC_SITE_URL) ||
    trimField(process.env.URL) ||
    trimField(process.env.SITE_URL) ||
    ""
  );
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") return json(204, {});
    if (event.httpMethod !== "POST") {
      return json(405, {
        ok: false,
        error: "Method not allowed",
        code: "method_not_allowed",
      });
    }

    const body = parseBody(event.body);
    if (!body) {
      return json(400, {
        ok: false,
        error: "Invalid JSON body",
        code: "invalid_json",
      });
    }
    if (Object.prototype.hasOwnProperty.call(body, "tenant_id")) {
      return json(400, {
        ok: false,
        error: "tenant_id is not accepted from client",
        code: "tenant_id_forbidden",
      });
    }
    const unknown = unknownKeys(body, ALLOWED_BODY_KEYS);
    if (unknown.length) {
      return json(400, {
        ok: false,
        error: `Unknown fields: ${unknown.join(", ")}`,
        code: "unknown_fields",
      });
    }

    const envelopeId = trimField(body.envelope_id).toLowerCase();
    const signerId = trimField(body.signer_id).toLowerCase();
    if (!validUuid(envelopeId) || !validUuid(signerId)) {
      return json(400, {
        ok: false,
        error: "envelope_id and signer_id are required",
        code: "invalid_id",
      });
    }

    const { tenant, membership } = await requireOwnerOrAdmin(event);
    const result = await revealOwnerCopyLink({
      tenantId: tenant.id,
      envelopeId,
      signerId,
      membershipId: membership?.id || null,
      publicOrigin: publicOriginFromEvent(event),
    });

    if (!result.ok) {
      return json(result.status || 400, {
        ok: false,
        error: result.error,
        code: result.code,
        version: API_VERSION,
      });
    }

    return json(200, {
      ok: true,
      version: API_VERSION,
      signing_url: result.signing_url,
      previous_link_replaced: result.previous_link_replaced === true,
      generation_number: result.generation_number,
      recipient_masked: result.recipient_masked || null,
    });
  } catch (err) {
    if (err?.isGuardError) {
      return json(err.statusCode || 403, {
        ok: false,
        error: err.message,
        code: err.code,
      });
    }
    console.error("contract-invitation-copy-link", err);
    return json(500, {
      ok: false,
      error: "Server error",
      code: "server_error",
    });
  }
};

exports._test = { ALLOWED_BODY_KEYS, API_VERSION };
