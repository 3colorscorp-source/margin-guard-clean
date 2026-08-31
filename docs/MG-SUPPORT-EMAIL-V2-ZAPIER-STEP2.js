/**
 * MG-SUPPORT-EMAIL-V2 — Zapier Step 2 HMAC verifier fixture.
 *
 * Paste verifySupportEmailBridgeV2 into Code by Zapier.
 * Input mappings (ONLY these):
 *   hmac_secret     ← SUPPORT_CASE_EMAIL_ZAPIER_HMAC_SECRET
 *   schema_version  ← Catch Hook schema_version
 *   timestamp       ← Catch Hook timestamp
 *   signature       ← Catch Hook signature
 *   payload_b64     ← Catch Hook payload_b64
 *
 * Failure output is ONLY { verified: false }.
 * Never output hmac_secret, computed/expected signature, raw message, or raw payload.
 */
"use strict";

function verifySupportEmailBridgeV2(inputData) {
  const crypto = require("crypto");
  const hmacSecret = String(inputData.hmac_secret || "");
  const schemaVersion = String(inputData.schema_version || "").trim();
  const timestamp = String(inputData.timestamp || "").trim();
  const signature = String(inputData.signature || "").trim().toLowerCase();
  const payloadB64 = String(inputData.payload_b64 || "").trim();
  if (
    !hmacSecret ||
    schemaVersion !== "support_case_email_bridge_v2" ||
    !timestamp ||
    !signature ||
    !payloadB64
  ) {
    return { verified: false };
  }
  if (!/^[0-9a-f]{64}$/.test(signature)) {
    return { verified: false };
  }
  if (!/^[A-Za-z0-9_-]+$/.test(payloadB64)) {
    return { verified: false };
  }
  const computed = crypto
    .createHmac("sha256", hmacSecret)
    .update(timestamp + "." + payloadB64, "utf8")
    .digest("hex");
  const expected = Buffer.from(computed, "hex");
  const received = Buffer.from(signature, "hex");
  if (
    expected.length !== received.length ||
    !crypto.timingSafeEqual(expected, received)
  ) {
    return { verified: false };
  }
  let payload;
  try {
    const json = Buffer.from(payloadB64, "base64url").toString("utf8");
    payload = JSON.parse(json);
  } catch {
    return { verified: false };
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { verified: false };
  }
  if (payload.schema_version !== "support_case_notification_v1") {
    return { verified: false };
  }
  if (payload.timestamp !== timestamp) {
    return { verified: false };
  }
  const allowedEvents = new Set([
    "case_in_review",
    "case_waiting_on_customer",
    "case_resolved",
    "case_reopened",
  ]);
  if (!allowedEvents.has(payload.event_type)) {
    return { verified: false };
  }
  const required = [
    "event_id",
    "event_type",
    "case_ref",
    "recipient_email",
    "subject",
    "text_body",
    "timestamp",
    "idempotency_key",
  ];
  for (const key of required) {
    if (typeof payload[key] !== "string" || !payload[key].trim()) {
      return { verified: false };
    }
  }
  return {
    verified: true,
    event_id: payload.event_id,
    event_type: payload.event_type,
    case_ref: payload.case_ref,
    recipient_email: payload.recipient_email,
    subject: payload.subject,
    text_body: payload.text_body,
    idempotency_key: payload.idempotency_key,
  };
}

module.exports = { verifySupportEmailBridgeV2 };
