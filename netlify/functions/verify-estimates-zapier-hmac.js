"use strict";

/**
 * Server-side estimates HMAC verifier for Zapier.
 * Secret comes only from ZAPIER_WEBHOOK_SECRET. Request hmac_secret is ignored.
 * Does not activate sender fail-closed.
 */
const { verifyEstimatesCatchHook } = require("./_lib/zapier-hmac-v1");

const MAX_BODY_BYTES = 8192;
const FAIL_BODY = {
  signature_valid: false,
  final_to: "",
  final_additional_recipients: "",
  final_from_name: "",
  final_subject: "",
  final_body: "",
};

let nowMsHook = null;

function jsonHeaders() {
  return {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  };
}

function reply(statusCode, body) {
  return {
    statusCode,
    headers: jsonHeaders(),
    body: JSON.stringify(body),
  };
}

function fail(statusCode) {
  return reply(statusCode == null ? 200 : statusCode, FAIL_BODY);
}

function rawText(event) {
  const raw = event && event.body;
  if (raw == null) return "";
  if (event.isBase64Encoded) {
    try {
      return Buffer.from(String(raw), "base64").toString("utf8");
    } catch (_err) {
      return null;
    }
  }
  if (typeof raw === "string") return raw;
  try {
    return JSON.stringify(raw);
  } catch (_err) {
    return null;
  }
}

exports.handler = async (event) => {
  try {
    if (!event || event.httpMethod !== "POST") return fail(405);
    const text = rawText(event);
    if (text == null) return fail(200);
    if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) return fail(413);

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (_err) {
      return fail(200);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fail(200);

    const picked = {
      zapier_signature: parsed.zapier_signature,
      zapier_timestamp: parsed.zapier_timestamp,
      zapier_nonce: parsed.zapier_nonce,
      zapier_signature_version: parsed.zapier_signature_version,
      zapier_signed_payload: parsed.zapier_signed_payload,
    };
    const result = verifyEstimatesCatchHook(picked, {
      envSecretOnly: true,
      nowMs: nowMsHook == null ? Date.now() : nowMsHook,
    });
    return reply(200, {
      signature_valid: result.signature_valid === true,
      final_to: String(result.final_to || ""),
      final_additional_recipients: String(result.final_additional_recipients || ""),
      final_from_name: String(result.final_from_name || ""),
      final_subject: String(result.final_subject || ""),
      final_body: String(result.final_body || ""),
    });
  } catch (_err) {
    return fail(200);
  }
};

exports._test = {
  setNowMs(ms) {
    nowMsHook = ms;
  },
  MAX_BODY_BYTES,
};
