/**
 * CH-011G — Capture electronic signature (public, token-gated).
 * POST /.netlify/functions/contract-sign
 * Auth = signing_token only. No session. No outbound mail.
 */

"use strict";

const {
  API_VERSION,
  unknownKeys,
  captureContractSignature,
  clientIpFromEvent,
  userAgentFromEvent,
  trimField,
} = require("./_lib/contract-sign");

const ALLOWED_BODY_KEYS = new Set([
  "signing_token",
  "token",
  "signature_method",
  "signature_payload",
  "consent_esign",
  "expected_updated_at",
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
      "envelope_id",
      "package_id",
      "token_id",
    ]) {
      if (Object.prototype.hasOwnProperty.call(body, forbidden)) {
        return json(400, {
          ok: false,
          error: `${forbidden} is not accepted from client`,
          code: `${forbidden}_forbidden`,
        });
      }
    }

    const signingToken = trimField(body.signing_token || body.token);
    const result = await captureContractSignature({
      rawToken: signingToken,
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
      token: result.token,
      envelope: result.envelope,
      package: result.package,
      next_signer: result.next_signer,
    });
  } catch (err) {
    console.error(
      "contract-sign",
      err?.message || err,
      String(err?.supabaseRaw || "").slice(0, 200)
    );
    return json(500, {
      ok: false,
      error: "Server error",
      code: "server_error",
    });
  }
};

exports._test = { ALLOWED_BODY_KEYS, API_VERSION };
