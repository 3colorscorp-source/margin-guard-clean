/**
 * CH-011H — List audit certificates for an envelope (Owner/Admin).
 * GET /.netlify/functions/contract-certificates?envelope_id=
 */

"use strict";

const { requireOwnerOrAdmin } = require("./_lib/require-owner-or-admin");

const {
  API_VERSION,
  validUuid,
  listCertificatesForEnvelope,
  trimField,
} = require("./_lib/contract-certificate");

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
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

    const envelopeId = trimField(
      event?.queryStringParameters?.envelope_id
    ).toLowerCase();
    if (!validUuid(envelopeId)) {
      return json(400, {
        ok: false,
        error: "envelope_id is required",
        code: "invalid_envelope_id",
      });
    }

    const { tenant } = await requireOwnerOrAdmin(event);
    const certificates = await listCertificatesForEnvelope(
      tenant.id,
      envelopeId
    );

    return json(200, {
      ok: true,
      version: API_VERSION,
      certificates,
    });
  } catch (err) {
    if (err?.isGuardError) {
      return json(err.statusCode || 403, {
        ok: false,
        error: err.message,
        code: err.code,
      });
    }
    console.error("contract-certificates", err?.message || err);
    return json(500, {
      ok: false,
      error: "Server error",
      code: "server_error",
    });
  }
};

exports._test = { API_VERSION };
