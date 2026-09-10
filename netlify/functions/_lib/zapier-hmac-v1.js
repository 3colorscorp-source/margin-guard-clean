"use strict";

/**
 * Invoice Hub Zapier HMAC v1, reused for estimates outbound (Phase 1).
 * Canonical: `${timestamp}.${nonce}.${JSON.stringify(unsignedPayload)}`
 * Signature fields are attached AFTER signing so the HMAC covers the unsigned JSON.
 * zapier_signed_payload is that exact canonical string so Zapier Catch Hook can
 * verify without reconstructing JSON (Catch Hook drops raw body and X-MG-* headers).
 * ESTIMATES_HMAC_PHASE1_COMPATIBILITY_MODE: missing secret returns null; caller still POSTs unsigned.
 */
const crypto = require("crypto");

const ESTIMATES_HMAC_PHASE1_COMPATIBILITY_MODE = "ESTIMATES_HMAC_PHASE1_COMPATIBILITY_MODE";
const ESTIMATES_HMAC_MAX_AGE_MS = 300000;

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
    signed_payload: canonical,
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
    payload.zapier_signed_payload = meta.signed_payload;
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

function emptyCatchHookResult() {
  return {
    signature_valid: false,
    final_to: "",
    final_additional_recipients: "",
    final_subject: "",
    final_body: "",
  };
}

const EMAIL_MAX_LEN = 254;
const EMAIL_RE = /^[a-z0-9._%+\-]+@[a-z0-9.-]+\.[a-z]{2,}$/;

function normalizeOneEmail(raw) {
  const s = String(raw == null ? "" : raw).trim().toLowerCase();
  if (!s || s.length > EMAIL_MAX_LEN) return "";
  if (/[\x00-\x1f\x7f]/.test(s)) return "";
  if (/[,;<>()"\\]/.test(s)) return "";
  if (/\b(bcc|cc|to)\s*:/.test(s)) return "";
  if (!EMAIL_RE.test(s)) return "";
  return s;
}

/**
 * Recipients from signed JSON only. Invalid To fails closed.
 * Additional addresses are normalized and deduped; never expanded from outer fields.
 */
function authorizeSignedRecipients(payload) {
  const to = normalizeOneEmail(payload && payload.client_email);
  if (!to) return null;
  const extraRaw = payload && payload.additional_recipients;
  const parts = Array.isArray(extraRaw)
    ? extraRaw
    : String(extraRaw == null ? "" : extraRaw).split(/[,;]/);
  const seen = Object.create(null);
  seen[to] = true;
  const extras = [];
  for (let i = 0; i < parts.length; i += 1) {
    const email = normalizeOneEmail(parts[i]);
    if (!email || seen[email]) continue;
    seen[email] = true;
    extras.push(email);
  }
  return {
    final_to: to,
    final_additional_recipients: extras.join(","),
  };
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

/**
 * Zapier Catch Hook verifier. HMAC only over zapier_signed_payload.
 * Do not JSON.stringify Catch Hook fields — Catch Hook reorders and drops raw body.
 */
function verifyEstimatesCatchHook(inputData, options) {
  const out = emptyCatchHookResult();
  const input = inputData && typeof inputData === "object" ? inputData : {};
  const opts = options && typeof options === "object" ? options : {};
  const secret = opts.envSecretOnly
    ? String(process.env.ZAPIER_WEBHOOK_SECRET || "").trim()
    : String(input.hmac_secret || "").trim();
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

  const recipients = authorizeSignedRecipients(payload);
  if (!recipients) return out;
  const copy = authorizedEmailCopy(payload);
  out.signature_valid = true;
  out.final_to = recipients.final_to;
  out.final_additional_recipients = recipients.final_additional_recipients;
  out.final_subject = copy.final_subject;
  out.final_body = copy.final_body;
  return out;
}

module.exports = {
  ESTIMATES_HMAC_PHASE1_COMPATIBILITY_MODE,
  ESTIMATES_HMAC_MAX_AGE_MS,
  canonicalString,
  buildZapierSignatureMeta,
  attachZapierSignature,
  verifyZapierSignature,
  verifyEstimatesCatchHook,
  resolveZapierWebhookSecret,
};
