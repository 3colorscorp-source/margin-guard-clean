/**
 * CH-011C — Delete draft Envelope signer (Owner/Admin).
 * POST /.netlify/functions/contract-signer-delete
 */

"use strict";

const { requireOwnerOrAdmin } = require("./_lib/require-owner-or-admin");

const {
  API_VERSION,
  validUuid,
  unknownKeys,
  deleteSigner,
  trimField,
} = require("./_lib/contract-signer");

const ALLOWED_BODY_KEYS = new Set(["signer_id", "expected_updated_at"]);

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

    const signerId = trimField(body.signer_id).toLowerCase();
    if (!validUuid(signerId)) {
      return json(400, {
        ok: false,
        error: "signer_id is required",
        code: "invalid_signer_id",
      });
    }
    if (!trimField(body.expected_updated_at)) {
      return json(400, {
        ok: false,
        error: "expected_updated_at is required",
        code: "missing_expected_updated_at",
      });
    }

    const { tenant } = await requireOwnerOrAdmin(event);
    const result = await deleteSigner({
      tenantId: tenant.id,
      signerId,
      expectedUpdatedAt: body.expected_updated_at,
    });

    if (!result.ok) {
      return json(result.status || 400, {
        ok: false,
        error: result.error,
        code: result.code,
        envelope_status: result.envelope_status,
        version: API_VERSION,
      });
    }

    return json(200, {
      ok: true,
      version: API_VERSION,
      deleted_id: result.deleted_id,
      envelope_id: result.envelope_id,
    });
  } catch (err) {
    if (err?.isGuardError) {
      return json(err.statusCode || 403, {
        ok: false,
        error: err.message,
        code: err.code,
      });
    }
    console.error("contract-signer-delete", err);
    return json(500, {
      ok: false,
      error: "Server error",
      code: "server_error",
    });
  }
};

exports._test = { ALLOWED_BODY_KEYS, API_VERSION };
