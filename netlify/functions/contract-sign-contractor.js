/**
 * CH-084 — Contractor in-app signature (Owner/Admin session).
 * POST /.netlify/functions/contract-sign-contractor
 * Explicit typed/drawn act. Never auto-signs from Legal Profile.
 * Mints a contractor-only token internally and does not return it.
 */

"use strict";

const { requireOwnerOrAdmin } = require("./_lib/require-owner-or-admin");
const {
  API_VERSION,
  unknownKeys,
  captureContractorInAppSignature,
  clientIpFromEvent,
  userAgentFromEvent,
  trimField,
  validUuid,
} = require("./_lib/contract-sign");

const ALLOWED_BODY_KEYS = new Set([
  "envelope_id",
  "expected_updated_at",
  "signature_method",
  "signature_payload",
  "consent_esign",
]);

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

    for (const forbidden of [
      "tenant_id",
      "signer_id",
      "signing_token",
      "token",
      "token_id",
      "package_id",
      "authorized_signer_name",
    ]) {
      if (Object.prototype.hasOwnProperty.call(body, forbidden)) {
        return json(400, {
          ok: false,
          error: `${forbidden} is not accepted from client`,
          code: `${forbidden}_forbidden`,
        });
      }
    }

    const envelopeId = trimField(body.envelope_id).toLowerCase();
    if (!validUuid(envelopeId)) {
      return json(400, {
        ok: false,
        error: "envelope_id is required",
        code: "invalid_envelope_id",
      });
    }

    const { tenant } = await requireOwnerOrAdmin(event);
    const result = await captureContractorInAppSignature({
      tenantId: tenant.id,
      envelopeId,
      signatureMethod: body.signature_method,
      signaturePayload: body.signature_payload,
      consentEsign: body.consent_esign === true,
      expectedUpdatedAt: body.expected_updated_at,
      ipAddress: clientIpFromEvent(event),
      userAgent: userAgentFromEvent(event),
    });

    if (!result.ok) {
      return json(result.status || 400, {
        ok: false,
        error: result.error,
        code: result.code,
        signer_status: result.signer_status || undefined,
        signed_at: result.signed_at || undefined,
        current_updated_at: result.current_updated_at || undefined,
        version: API_VERSION,
      });
    }

    return json(200, {
      ok: true,
      version: API_VERSION,
      progression: result.progression,
      signature_event_id: result.signature_event_id,
      signer: result.signer,
      envelope: result.envelope,
      package: result.package,
      next_signer: result.next_signer,
    });
  } catch (err) {
    if (err?.isGuardError) {
      return json(err.statusCode || 403, {
        ok: false,
        error: err.message,
        code: err.code,
      });
    }
    console.error("contract-sign-contractor", err);
    return json(500, {
      ok: false,
      error: "Server error",
      code: "server_error",
    });
  }
};

exports._test = { ALLOWED_BODY_KEYS, API_VERSION };
