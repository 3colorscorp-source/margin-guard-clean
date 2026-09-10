/**
 * Estimates Zapier Catch Hook HMAC verifier (Code by Zapier).
 *
 * Paste this file into a Code step. Map ONLY:
 *   hmac_secret                ← ZAPIER_WEBHOOK_SECRET (Zapier secret store)
 *   zapier_signature            ← Catch Hook
 *   zapier_timestamp            ← Catch Hook
 *   zapier_nonce               ← Catch Hook
 *   zapier_signature_version    ← Catch Hook
 *   zapier_signed_payload       ← Catch Hook
 *
 * Then: output = runEstimatesHmacCodeStep(inputData);
 *
 * Evidence: Catch Hook does not keep the raw POST body or X-MG-* headers for
 * Code-by-Zapier inputData (docs/CH-013A21Z-ZAPIER-CONTRACT-EMAIL.md). Do not
 * reconstruct JSON from flattened Catch Hook fields. HMAC is over the exact
 * zapier_signed_payload string (timestamp.nonce.JSON) attached after signing.
 *
 * Do not log hmac_secret, signatures, emails, or URLs.
 */
"use strict";

const crypto = require("crypto");

const ESTIMATES_HMAC_MAX_AGE_MS = 300000;

function emptyResult() {
  return { signature_valid: false, final_subject: "", final_body: "" };
}

function timingSafeHexEqual(a, b) {
  try {
    const bufA = Buffer.from(String(a), "utf8");
    const bufB = Buffer.from(String(b), "utf8");
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  } catch (_err) {
    return false;
  }
}

function authorizedEmailCopy(payload) {
  const subject = String(payload && payload.subject ? payload.subject : "").trim();
  const body = String(
    (payload && (payload.messageText || payload.message_note)) || ""
  ).trim();
  if (body) return { final_subject: subject, final_body: body };
  const lines = [];
  const name = String((payload && (payload.to_name || payload.client_name)) || "").trim();
  const url = String((payload && payload.public_quote_url) || "").trim();
  const biz = String((payload && payload.business_name) || "").trim();
  if (name) lines.push(name);
  if (url) lines.push(url);
  if (biz) lines.push(biz);
  return { final_subject: subject, final_body: lines.join("\n") };
}

function verifyEstimatesHmacCatchHook(inputData, options) {
  const out = emptyResult();
  const input = inputData && typeof inputData === "object" ? inputData : {};
  const secret = String(input.hmac_secret || "").trim();
  if (!secret) return out;

  const signature = String(input.zapier_signature || "").trim().toLowerCase();
  const timestamp = String(input.zapier_timestamp || "").trim();
  const nonce = String(input.zapier_nonce || "").trim();
  const version = String(input.zapier_signature_version || "").trim();
  const signedPayload = input.zapier_signed_payload;

  if (typeof signedPayload !== "string" || !signedPayload) return out;
  if (version !== "v1") return out;
  if (!/^[0-9a-f]{64}$/.test(signature)) return out;
  if (!/^[0-9a-f]{32,64}$/.test(nonce)) return out;

  const tsMs = Date.parse(timestamp);
  if (!Number.isFinite(tsMs)) return out;
  const nowMs =
    options && typeof options.nowMs === "number" ? options.nowMs : Date.now();
  if (tsMs > nowMs) return out;
  if (nowMs - tsMs > ESTIMATES_HMAC_MAX_AGE_MS) return out;

  const prefix = timestamp + "." + nonce + ".";
  if (signedPayload.indexOf(prefix) !== 0) return out;

  const expected = crypto.createHmac("sha256", secret).update(signedPayload, "utf8").digest("hex");
  if (!timingSafeHexEqual(signature, expected)) return out;

  let payload;
  try {
    payload = JSON.parse(signedPayload.slice(prefix.length));
  } catch (_err) {
    return out;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return out;
  if (payload.zapier_signature != null || payload.zapier_signed_payload != null) return out;

  const copy = authorizedEmailCopy(payload);
  out.signature_valid = true;
  out.final_subject = copy.final_subject;
  out.final_body = copy.final_body;
  return out;
}

function runEstimatesHmacCodeStep(inputData, options) {
  const result = verifyEstimatesHmacCatchHook(inputData, options);
  return {
    signature_valid: result.signature_valid === true ? "true" : "false",
    final_subject: result.final_subject,
    final_body: result.final_body,
  };
}

module.exports = {
  ESTIMATES_HMAC_MAX_AGE_MS,
  verifyEstimatesHmacCatchHook,
  runEstimatesHmacCodeStep,
};
