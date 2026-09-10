"use strict";

/**
 * Invoice Hub Zapier HMAC v1, reused for estimates outbound (Phase 1).
 * Canonical: `${timestamp}.${nonce}.${JSON.stringify(unsignedPayload)}`
 * Signature fields are attached AFTER signing so the HMAC covers the unsigned JSON.
 * ESTIMATES_HMAC_PHASE1_COMPATIBILITY_MODE: missing secret returns null; caller still POSTs unsigned.
 */
const crypto = require("crypto");

const ESTIMATES_HMAC_PHASE1_COMPATIBILITY_MODE = "ESTIMATES_HMAC_PHASE1_COMPATIBILITY_MODE";

function resolveZapierWebhookSecret(explicit) {
  if (explicit !== undefined && explicit !== null) return String(explicit).trim();
  return String(process.env.ZAPIER_WEBHOOK_SECRET || "").trim();
}

function canonicalString(timestamp, nonce, payload) {
  return String(timestamp) + "." + String(nonce) + "." + JSON.stringify(payload);
}

function buildZapierSignatureMeta(payload, options) {
  const opts = options && typeof options === "object" ? options : {};
  const secret = resolveZapierWebhookSecret(opts.secret);
  if (!secret) return null;
  const timestamp = opts.timestamp || new Date().toISOString();
  const nonce = opts.nonce || crypto.randomBytes(16).toString("hex");
  const canonical = canonicalString(timestamp, nonce, payload);
  const signature = crypto.createHmac("sha256", secret).update(canonical).digest("hex");
  return {
    signature,
    timestamp,
    nonce,
    version: "v1",
  };
}

function attachZapierSignature(payload, options) {
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  const meta = buildZapierSignatureMeta(payload, options);
  if (meta && payload && typeof payload === "object") {
    payload.zapier_signature = meta.signature;
    payload.zapier_timestamp = meta.timestamp;
    payload.zapier_nonce = meta.nonce;
    payload.zapier_signature_version = meta.version;
    headers["X-MG-Signature"] = meta.signature;
    headers["X-MG-Timestamp"] = meta.timestamp;
    headers["X-MG-Nonce"] = meta.nonce;
    headers["X-MG-Signature-Version"] = meta.version;
  }
  return { meta, headers };
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

function verifyZapierSignature(unsignedPayload, meta, secret) {
  if (!meta || typeof meta !== "object") return false;
  const expected = buildZapierSignatureMeta(unsignedPayload, {
    secret,
    timestamp: meta.timestamp,
    nonce: meta.nonce,
  });
  if (!expected) return false;
  return (
    expected.version === "v1" &&
    String(meta.version || "") === "v1" &&
    timingSafeHexEqual(meta.signature, expected.signature)
  );
}

module.exports = {
  ESTIMATES_HMAC_PHASE1_COMPATIBILITY_MODE,
  canonicalString,
  buildZapierSignatureMeta,
  attachZapierSignature,
  verifyZapierSignature,
  resolveZapierWebhookSecret,
};
