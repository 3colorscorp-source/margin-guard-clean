/**
 * Square webhook signature: HMAC-SHA256(notificationUrl + rawBody) base64.
 * Header: x-square-hmacsha256-signature
 * Do not use x-square-signature / SHA1.
 */
"use strict";

const crypto = require("crypto");

function headerLookup(headers, name) {
  if (!headers || typeof headers !== "object") return "";
  const want = String(name).toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === want) return String(value || "");
  }
  return "";
}

/**
 * Exact string Square signed. Null if the body is not a verifiable string
 * (already-parsed JSON cannot be used).
 */
function getSquareRawBody(event) {
  if (!event || event.body == null) return "";
  if (typeof event.body !== "string") return null;
  if (event.isBase64Encoded) {
    try {
      return Buffer.from(event.body, "base64").toString("utf8");
    } catch (_err) {
      return null;
    }
  }
  return event.body;
}

function readSquareSignatureHeader(headers) {
  return headerLookup(headers, "x-square-hmacsha256-signature");
}

function readSquareEnvironmentHeader(headers) {
  return headerLookup(headers, "square-environment");
}

function computeSquareSignature(notificationUrl, rawBody, signatureKey) {
  const hmac = crypto.createHmac("sha256", String(signatureKey || ""));
  hmac.update(String(notificationUrl || "") + String(rawBody || ""), "utf8");
  return hmac.digest("base64");
}

function timingSafeEqualB64(a, b) {
  try {
    const ba = Buffer.from(String(a || ""), "utf8");
    const bb = Buffer.from(String(b || ""), "utf8");
    if (ba.length === 0 || bb.length === 0 || ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  } catch (_err) {
    return false;
  }
}

function verifySquareWebhookSignature({
  rawBody,
  signatureHeader,
  signatureKey,
  notificationUrl,
}) {
  if (rawBody == null || typeof rawBody !== "string") return false;
  const header = String(signatureHeader || "");
  const key = String(signatureKey || "");
  const url = String(notificationUrl || "");
  if (!header || !key || !url) return false;
  const expected = computeSquareSignature(url, rawBody, key);
  return timingSafeEqualB64(expected, header);
}

module.exports = {
  computeSquareSignature,
  getSquareRawBody,
  headerLookup,
  readSquareEnvironmentHeader,
  readSquareSignatureHeader,
  verifySquareWebhookSignature,
};
