/**
 * CH-011C — List Envelope signers (Owner/Admin, read-only).
 * GET /.netlify/functions/contract-signers?envelope_id=
 */

"use strict";

const { requireOwnerOrAdmin } = require("./_lib/require-owner-or-admin");

const {
  API_VERSION,
  validUuid,
  unknownKeys,
  loadEnvelopeForTenant,
  listSignersForEnvelope,
  trimField,
} = require("./_lib/contract-signer");

const ALLOWED_QUERY_KEYS = new Set(["envelope_id"]);

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function singleQueryValue(value) {
  if (Array.isArray(value)) return value[0];
  return value;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") return json(204, {});
    if (event.httpMethod !== "GET") {
      return json(405, {
        ok: false,
        error: "Method not allowed",
        code: "method_not_allowed",
      });
    }

    const query = event.queryStringParameters || {};
    const unknown = unknownKeys(query, ALLOWED_QUERY_KEYS);
    if (unknown.length) {
      return json(400, {
        ok: false,
        error: `Unknown query fields: ${unknown.join(", ")}`,
        code: "unknown_fields",
      });
    }

    const envelopeId = trimField(singleQueryValue(query.envelope_id)).toLowerCase();
    if (!validUuid(envelopeId)) {
      return json(400, {
        ok: false,
        error: "envelope_id is required",
        code: "invalid_envelope_id",
      });
    }

    const { tenant } = await requireOwnerOrAdmin(event);
    const envelope = await loadEnvelopeForTenant(tenant.id, envelopeId);
    if (!envelope?.id) {
      return json(404, {
        ok: false,
        error: "Envelope not found",
        code: "not_found",
      });
    }

    const signers = await listSignersForEnvelope(tenant.id, envelopeId);
    return json(200, {
      ok: true,
      version: API_VERSION,
      envelope_id: envelopeId,
      signers,
    });
  } catch (err) {
    if (err?.isGuardError) {
      return json(err.statusCode || 403, {
        ok: false,
        error: err.message,
        code: err.code,
      });
    }
    console.error("contract-signers", err);
    return json(500, {
      ok: false,
      error: "Server error",
      code: "server_error",
    });
  }
};

exports._test = { ALLOWED_QUERY_KEYS, API_VERSION };
