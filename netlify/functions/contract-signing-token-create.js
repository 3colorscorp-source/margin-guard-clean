/**
 * CH-011D — Create signing token (Owner/Admin).
 * POST /.netlify/functions/contract-signing-token-create
 * Returns raw token once; stores SHA-256 hash only.
 */

"use strict";

const { requireOwnerOrAdmin } = require("./_lib/require-owner-or-admin");

const {
  API_VERSION,
  validUuid,
  unknownKeys,
  createSigningToken,
  trimField,
} = require("./_lib/contract-signing-token");

const ALLOWED_BODY_KEYS = new Set(["signer_id", "expires_in_days"]);

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
    const unknown = unknownKeys(body, ALLOWED_BODY_KEYS);
    if (unknown.length) {
      return json(400, {
        ok: false,
        error: `Unknown fields: ${unknown.join(", ")}`,
        code: "unknown_fields",
      });
    }
    if (Object.prototype.hasOwnProperty.call(body, "tenant_id")) {
      return json(400, {
        ok: false,
        error: "tenant_id is not accepted from client",
        code: "tenant_id_forbidden",
      });
    }
    if (Object.prototype.hasOwnProperty.call(body, "token")) {
      return json(400, {
        ok: false,
        error: "token is not accepted from client",
        code: "token_forbidden",
      });
    }
    if (Object.prototype.hasOwnProperty.call(body, "token_hash")) {
      return json(400, {
        ok: false,
        error: "token_hash is not accepted from client",
        code: "token_hash_forbidden",
      });
    }

    const signerId = trimField(body.signer_id).toLowerCase();
    if (!validUuid(signerId)) {
      return json(400, {
        ok: false,
        error: "signer_id is required",
        code: "invalid_signer_id",
      });
    }

    const { tenant } = await requireOwnerOrAdmin(event);
    const result = await createSigningToken({
      tenantId: tenant.id,
      signerId,
      expiresInDays:
        body.expires_in_days === undefined || body.expires_in_days === null
          ? undefined
          : body.expires_in_days,
    });

    if (!result.ok) {
      return json(result.status || 400, {
        ok: false,
        error: result.error,
        code: result.code,
        active_token_id: result.active_token_id || undefined,
        version: API_VERSION,
      });
    }

    return json(200, {
      ok: true,
      version: API_VERSION,
      token: result.token,
    });
  } catch (err) {
    if (err?.isGuardError) {
      return json(err.statusCode || 403, {
        ok: false,
        error: err.message,
        code: err.code,
      });
    }
    console.error("contract-signing-token-create", err);
    return json(500, {
      ok: false,
      error: "Server error",
      code: "server_error",
    });
  }
};

exports._test = { ALLOWED_BODY_KEYS, API_VERSION };
