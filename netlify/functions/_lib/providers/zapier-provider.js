/**
 * CH-013A.2.1Z — Zapier webhook email provider (active beta transport).
 * Posts a canonical HMAC-signed payload to Zapier Catch Hook → Gmail.
 * Never logs webhook URL secrets, HMAC secret, raw tokens, signing URLs, or HTML bodies.
 * No direct Gmail API. No Resend dependency.
 */

"use strict";

const crypto = require("crypto");
const {
  normalizeSendResult,
  normalizeHealth,
  defaultCapabilities,
  classifyHttpFailure,
  trimField,
} = require("./provider-interface");

const API_VERSION = "ch-013a21z-v1";
const PROVIDER = "zapier";
const SCHEMA_VERSION = "1";
const EVENT_TYPE = "contract_signing_invitation";
/** CH-013A.2.9 — outer wire envelope that carries timestamp+signature in the body. */
const ENVELOPE_SCHEMA_VERSION = "1";
const DEFAULT_TIMEOUT_MS = 20000;
const TIMESTAMP_HEADER = "X-Margin-Guard-Timestamp";
const SIGNATURE_HEADER = "X-Margin-Guard-Signature";
const IDEMPOTENCY_HEADER = "X-Margin-Guard-Idempotency-Key";
/** Producer/consumer freshness window for timestamps (ms). */
const TIMESTAMP_MAX_SKEW_MS = 5 * 60 * 1000;

function getFetch() {
  if (typeof globalThis.fetch === "function") return globalThis.fetch;
  throw new Error("Global fetch is not available");
}

function deliveryEnabled() {
  const raw = trimField(process.env.CONTRACT_EMAIL_DELIVERY_ENABLED).toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function getWebhookUrl() {
  return trimField(process.env.CONTRACT_EMAIL_ZAPIER_WEBHOOK_URL);
}

function getHmacSecret() {
  return trimField(process.env.CONTRACT_EMAIL_ZAPIER_HMAC_SECRET);
}

function getFromNameFallback() {
  return trimField(process.env.CONTRACT_EMAIL_FROM_NAME) || "Margin Guard Contracts";
}

function getReplyToFallback() {
  return trimField(process.env.CONTRACT_EMAIL_REPLY_TO);
}

/**
 * Parse CONTRACT_EMAIL_INTERNAL_ALLOWLIST (comma-separated, case-insensitive).
 * Empty list => block all.
 */
function parseAllowlist(raw) {
  const src = raw == null ? process.env.CONTRACT_EMAIL_INTERNAL_ALLOWLIST : raw;
  return String(src || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function normalizeEmail(email) {
  return trimField(email).toLowerCase();
}

function isValidEmail(email) {
  const s = normalizeEmail(email);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function isRecipientAllowlisted(email, allowlistOverride) {
  const list = Array.isArray(allowlistOverride)
    ? allowlistOverride.map((e) => normalizeEmail(e)).filter(Boolean)
    : parseAllowlist();
  if (!list.length) return false;
  return list.includes(normalizeEmail(email));
}

function health() {
  if (!deliveryEnabled()) {
    return normalizeHealth({
      available: false,
      provider: PROVIDER,
      reason: "delivery_disabled",
    });
  }
  if (!getWebhookUrl()) {
    return normalizeHealth({
      available: false,
      provider: PROVIDER,
      reason: "missing_webhook_url",
    });
  }
  if (!getHmacSecret()) {
    return normalizeHealth({
      available: false,
      provider: PROVIDER,
      reason: "missing_hmac_secret",
    });
  }
  return normalizeHealth({
    available: true,
    provider: PROVIDER,
    reason: "",
  });
}

function supportsTracking() {
  return false;
}

function supportsTemplates() {
  return false;
}

function supportsBranding() {
  return true;
}

function supportsAttachments() {
  return false;
}

/**
 * Deterministic JSON: recursively sort object keys. Arrays preserve order.
 * Undefined values omitted. null preserved.
 */
function canonicalizeValue(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (Array.isArray(value)) {
    return value.map((v) => canonicalizeValue(v));
  }
  if (typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      const next = canonicalizeValue(value[key]);
      if (next !== undefined) out[key] = next;
    }
    return out;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    return null;
  }
  return value;
}

function canonicalizeJson(payload) {
  return JSON.stringify(canonicalizeValue(payload));
}

/**
 * Sign: HMAC-SHA256(secret, `${timestamp}.${canonicalBody}`) → hex.
 * Zapier Code step must recompute the same string and compare in constant time.
 */
function signCanonicalBody(canonicalBody, timestampIso, secret) {
  const message = `${String(timestampIso)}.${String(canonicalBody)}`;
  return crypto.createHmac("sha256", secret).update(message, "utf8").digest("hex");
}

function timingSafeEqualHex(a, b) {
  const left = String(a || "");
  const right = String(b || "");
  if (!left || !right || left.length !== right.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
  } catch (_e) {
    return false;
  }
}

/**
 * Validate ISO-8601 timestamp freshness (± TIMESTAMP_MAX_SKEW_MS).
 */
function assertTimestampFresh(timestampIso, nowMs = Date.now()) {
  const raw = trimField(timestampIso);
  if (!raw) {
    return { ok: false, code: "timestamp_missing", error: "Timestamp header required" };
  }
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) {
    return { ok: false, code: "timestamp_invalid", error: "Timestamp must be ISO-8601" };
  }
  const delta = ms - nowMs;
  if (delta > TIMESTAMP_MAX_SKEW_MS) {
    return { ok: false, code: "timestamp_future", error: "Timestamp too far in the future" };
  }
  if (delta < -TIMESTAMP_MAX_SKEW_MS) {
    return { ok: false, code: "timestamp_stale", error: "Timestamp outside freshness window" };
  }
  return { ok: true, ms };
}

/**
 * Verify HMAC over exact UTF-8 bytes: HMAC-SHA256(secret, `${timestamp}.${rawBody}`) → hex.
 * Used for callbacks (raw callback JSON) and as the primitive for body-envelope verify.
 * @param {{
 *   rawBody: string,
 *   timestamp: string,
 *   signature: string,
 *   secret: string,
 *   nowMs?: number,
 * }} input
 */
function verifySignedRequest(input = {}) {
  const rawBody = input.rawBody == null ? "" : String(input.rawBody);
  const timestamp = trimField(input.timestamp);
  const signature = trimField(input.signature).toLowerCase();
  const secret = trimField(input.secret);
  if (!secret) {
    return { ok: false, code: "hmac_secret_missing", error: "HMAC secret missing" };
  }
  if (!signature) {
    return { ok: false, code: "signature_missing", error: "Signature header required" };
  }
  if (!/^[0-9a-f]+$/.test(signature) || signature.length % 2 !== 0) {
    return { ok: false, code: "signature_invalid", error: "Signature must be hex" };
  }
  const fresh = assertTimestampFresh(timestamp, input.nowMs);
  if (!fresh.ok) return fresh;
  const expected = signCanonicalBody(rawBody, timestamp, secret).toLowerCase();
  if (!timingSafeEqualHex(signature, expected)) {
    return { ok: false, code: "signature_mismatch", error: "HMAC verification failed" };
  }
  return { ok: true };
}

/**
 * CH-013A.2.9 — build the outer webhook wire envelope.
 * HMAC is over `timestamp + "." + signed_body` (invitation canonical JSON string).
 * Headers mirror body timestamp/signature for diagnostics; Zapier Step 2 reads the body.
 * @param {{ signedBody: string, timestamp?: string, secret: string }} input
 */
function buildSignedWireEnvelope(input = {}) {
  const signedBody = input.signedBody == null ? "" : String(input.signedBody);
  const secret = trimField(input.secret);
  const timestamp = trimField(input.timestamp) || new Date().toISOString();
  if (!signedBody) {
    return { ok: false, code: "signed_body_missing", error: "signed_body required" };
  }
  if (!secret) {
    return { ok: false, code: "hmac_secret_missing", error: "HMAC secret missing" };
  }
  const signature = signCanonicalBody(signedBody, timestamp, secret).toLowerCase();
  const envelope = {
    envelope_schema_version: ENVELOPE_SCHEMA_VERSION,
    timestamp,
    signature,
    signed_body: signedBody,
  };
  return {
    ok: true,
    envelope,
    timestamp,
    signature,
    signed_body: signedBody,
    wire_body: canonicalizeJson(envelope),
  };
}

/**
 * CH-013A.2.9 — verify an outer body envelope, then expose signed_body only if HMAC passes.
 * Does NOT parse signed_body into the invitation object (caller does that after verify).
 * @param {{
 *   rawBody?: string,
 *   envelope?: object,
 *   secret: string,
 *   nowMs?: number,
 * }} input
 */
function verifySignedEnvelope(input = {}) {
  const secret = trimField(input.secret);
  if (!secret) {
    return { ok: false, code: "hmac_secret_missing", error: "HMAC secret missing" };
  }

  let envelope = input.envelope;
  if (!envelope) {
    const raw = input.rawBody == null ? "" : String(input.rawBody);
    if (!raw) {
      return { ok: false, code: "envelope_missing", error: "Outer envelope body missing" };
    }
    try {
      envelope = JSON.parse(raw);
    } catch (_e) {
      return { ok: false, code: "envelope_not_json", error: "Outer envelope is not JSON" };
    }
  }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    return { ok: false, code: "envelope_invalid", error: "Outer envelope must be an object" };
  }

  const timestamp = trimField(envelope.timestamp);
  const signature = trimField(envelope.signature).toLowerCase();
  // signed_body must be the exact string used for HMAC — never rebuild before verify.
  if (envelope.signed_body == null || envelope.signed_body === "") {
    return { ok: false, code: "signed_body_missing", error: "signed_body required" };
  }
  if (typeof envelope.signed_body !== "string") {
    return {
      ok: false,
      code: "signed_body_invalid",
      error: "signed_body must be a JSON string",
    };
  }
  const signedBody = envelope.signed_body;

  const verified = verifySignedRequest({
    rawBody: signedBody,
    timestamp,
    signature,
    secret,
    nowMs: input.nowMs,
  });
  if (!verified.ok) return verified;

  return {
    ok: true,
    timestamp,
    signature,
    signed_body: signedBody,
    envelope_schema_version: trimField(envelope.envelope_schema_version) || ENVELOPE_SCHEMA_VERSION,
  };
}

/**
 * Build the canonical Zapier webhook payload (no raw token / token_hash / token_id).
 */
function buildCanonicalPayload(input = {}) {
  const idem = trimField(input.idempotency_key);
  return {
    schema_version: SCHEMA_VERSION,
    event_type: EVENT_TYPE,
    tenant_id: trimField(input.tenant_id) || null,
    project_id: trimField(input.project_id) || null,
    quote_id: trimField(input.quote_id) || null,
    package_id: trimField(input.package_id) || null,
    envelope_id: trimField(input.envelope_id) || null,
    invitation_id: trimField(input.invitation_id) || null,
    generation_id: trimField(input.generation_id) || null,
    generation_number:
      input.generation_number == null || input.generation_number === ""
        ? null
        : Number(input.generation_number),
    attempt_id: trimField(input.attempt_id) || null,
    recipient_email: normalizeEmail(input.recipient_email || input.to),
    recipient_name: trimField(input.recipient_name),
    subject: trimField(input.subject),
    html_body: String(input.html_body != null ? input.html_body : input.html || ""),
    text_body: String(input.text_body != null ? input.text_body : input.text || ""),
    reply_to: trimField(input.reply_to) || null,
    from_name: trimField(input.from_name) || getFromNameFallback(),
    expires_at: trimField(input.expires_at) || null,
    correlation_id: trimField(input.correlation_id) || null,
    sent_at: trimField(input.sent_at) || new Date().toISOString(),
    idempotency_key: idem || null,
  };
}

function parseZapierResponse(status, json) {
  const body = json && typeof json === "object" ? json : {};
  const accepted = body.accepted === true;
  const messageId = trimField(body.provider_message_id) || null;

  // Synchronous custom responses are NOT supported by Zapier Catch Hook/Raw Hook.
  // A bare HTTP 2xx from Catch Hook means "Zapier received the webhook", NOT Gmail sent.
  // Only an explicit accepted=true + provider_message_id may mark transport accepted
  // (reserved for future sync products or test doubles). Production relies on callback.
  if (status >= 200 && status < 300 && accepted && messageId) {
    return normalizeSendResult({
      accepted: true,
      retryable: false,
      provider: PROVIDER,
      provider_message_id: messageId,
      error_code: null,
      error_message: null,
    });
  }

  if (status >= 200 && status < 300 && accepted && !messageId) {
    return normalizeSendResult({
      accepted: false,
      retryable: false,
      provider: PROVIDER,
      error_code: "provider_missing_message_id",
      error_message: "Zapier accepted without provider_message_id",
    });
  }

  if (status >= 200 && status < 300 && body.ok === false) {
    return normalizeSendResult({
      accepted: false,
      retryable: body.retryable === true,
      provider: PROVIDER,
      error_code: trimField(body.error_code) || "zapier_rejected",
      error_message: trimField(body.error_message) || "Zapier rejected delivery",
    });
  }

  if (status >= 200 && status < 300) {
    // Generic Catch Hook / Catch Raw Hook ack — await signed callback after Gmail.
    return {
      accepted: false,
      retryable: false,
      provider: PROVIDER,
      provider_message_id: null,
      error_code: "awaiting_zapier_callback",
      error_message: "Zapier webhook acknowledged; awaiting Gmail callback",
      awaiting_callback: true,
    };
  }

  const classified = classifyHttpFailure(status, false);
  return normalizeSendResult({
    ...classified,
    provider: PROVIDER,
  });
}

/**
 * @param {{
 *   to?: string,
 *   recipient_email?: string,
 *   recipient_name?: string,
 *   subject: string,
 *   html?: string,
 *   text?: string,
 *   html_body?: string,
 *   text_body?: string,
 *   from_name?: string,
 *   reply_to?: string,
 *   idempotency_key?: string,
 *   tenant_id?: string,
 *   project_id?: string,
 *   quote_id?: string,
 *   package_id?: string,
 *   envelope_id?: string,
 *   invitation_id?: string,
 *   generation_id?: string,
 *   generation_number?: number,
 *   attempt_id?: string,
 *   expires_at?: string,
 *   correlation_id?: string,
 *   sent_at?: string,
 *   fetchImpl?: Function,
 *   timeout_ms?: number,
 * }} input
 */
async function send(input = {}) {
  const caps = health();
  if (!caps.available) {
    return normalizeSendResult({
      accepted: false,
      retryable: false,
      provider: PROVIDER,
      error_code: caps.reason || "provider_unavailable",
      error_message: `Zapier unavailable: ${caps.reason || "unavailable"}`,
    });
  }

  const to = normalizeEmail(input.recipient_email || input.to);
  if (!isValidEmail(to)) {
    return normalizeSendResult({
      accepted: false,
      retryable: false,
      provider: PROVIDER,
      error_code: "invalid_recipient",
      error_message: "Invalid recipient email",
    });
  }

  if (!isRecipientAllowlisted(to)) {
    return normalizeSendResult({
      accepted: false,
      retryable: false,
      provider: PROVIDER,
      error_code: "internal_recipient_only",
      error_message: "Recipient is outside the internal allowlist",
    });
  }

  const subject = trimField(input.subject);
  const html = String(input.html_body != null ? input.html_body : input.html || "");
  const text = String(input.text_body != null ? input.text_body : input.text || "");
  if (!subject || (!html && !text)) {
    return normalizeSendResult({
      accepted: false,
      retryable: false,
      provider: PROVIDER,
      error_code: "invalid_message",
      error_message: "Subject and body are required",
    });
  }

  const fromName = trimField(input.from_name) || getFromNameFallback();
  const replyToRaw = trimField(input.reply_to) || getReplyToFallback() || "";
  if (replyToRaw && /[\r\n]/.test(replyToRaw)) {
    return normalizeSendResult({
      accepted: false,
      retryable: false,
      provider: PROVIDER,
      error_code: "header_injection",
      error_message: "Reply-To contains forbidden characters",
    });
  }
  if (fromName && /[\r\n]/.test(fromName)) {
    return normalizeSendResult({
      accepted: false,
      retryable: false,
      provider: PROVIDER,
      error_code: "header_injection",
      error_message: "From display name contains forbidden characters",
    });
  }

  const idem = trimField(input.idempotency_key);
  if (!idem) {
    return normalizeSendResult({
      accepted: false,
      retryable: false,
      provider: PROVIDER,
      error_code: "missing_idempotency_key",
      error_message: "Idempotency key required",
    });
  }

  const payload = buildCanonicalPayload({
    ...input,
    recipient_email: to,
    subject,
    html_body: html,
    text_body: text,
    from_name: fromName,
    reply_to: replyToRaw || null,
    idempotency_key: idem,
  });

  // Forbidden fields must never appear as separate top-level keys.
  for (const forbidden of [
    "raw_token",
    "token",
    "token_hash",
    "token_id",
    "signing_token_id",
    "api_key",
    "service_role",
  ]) {
    if (Object.prototype.hasOwnProperty.call(payload, forbidden)) {
      delete payload[forbidden];
    }
  }

  // CH-013A.2.9 — sign the invitation payload string, wrap it in a body envelope so
  // Zapier Step 2 can verify HMAC from raw_body alone (no header-field mapping).
  const signedBody = canonicalizeJson(payload);
  const timestamp = new Date().toISOString();
  const sealed = buildSignedWireEnvelope({
    signedBody,
    timestamp,
    secret: getHmacSecret(),
  });
  if (!sealed.ok) {
    return normalizeSendResult({
      accepted: false,
      retryable: false,
      provider: PROVIDER,
      error_code: sealed.code || "envelope_build_failed",
      error_message: sealed.error || "Could not build signed wire envelope",
    });
  }

  const headers = {
    "Content-Type": "application/json",
    // Headers kept for diagnostics / backward compatibility; must equal body fields.
    [TIMESTAMP_HEADER]: sealed.timestamp,
    [SIGNATURE_HEADER]: sealed.signature,
    [IDEMPOTENCY_HEADER]: idem.slice(0, 256),
  };

  const fetchImpl = typeof input.fetchImpl === "function" ? input.fetchImpl : getFetch();
  const timeoutMs = Number(input.timeout_ms) > 0 ? Number(input.timeout_ms) : DEFAULT_TIMEOUT_MS;
  const controller =
    typeof AbortController !== "undefined" ? new AbortController() : null;
  let timer = null;
  if (controller) {
    timer = setTimeout(() => controller.abort(), timeoutMs);
  }

  try {
    const res = await fetchImpl(getWebhookUrl(), {
      method: "POST",
      headers,
      body: sealed.wire_body,
      signal: controller ? controller.signal : undefined,
    });
    if (timer) clearTimeout(timer);

    let json = null;
    try {
      json = await res.json();
    } catch (_e) {
      json = null;
    }

    const normalized = parseZapierResponse(res.status, json);
    if (normalized.accepted) {
      return {
        ...normalized,
        idempotent: json?.idempotent === true,
      };
    }
    return normalized;
  } catch (err) {
    if (timer) clearTimeout(timer);
    const aborted =
      err?.name === "AbortError" || /aborted|timeout/i.test(String(err?.message || err));
    const classified = classifyHttpFailure(0, true);
    return normalizeSendResult({
      ...classified,
      provider: PROVIDER,
      error_code: aborted ? "network_timeout" : classified.error_code,
      error_message: aborted
        ? "Provider request timed out"
        : "Provider network error",
    });
  }
}

module.exports = {
  API_VERSION,
  PROVIDER,
  SCHEMA_VERSION,
  EVENT_TYPE,
  ENVELOPE_SCHEMA_VERSION,
  TIMESTAMP_HEADER,
  SIGNATURE_HEADER,
  IDEMPOTENCY_HEADER,
  TIMESTAMP_MAX_SKEW_MS,
  health,
  send,
  supportsTracking,
  supportsTemplates,
  supportsBranding,
  supportsAttachments,
  deliveryEnabled,
  getWebhookUrl,
  getHmacSecret,
  getFromNameFallback,
  getReplyToFallback,
  parseAllowlist,
  isRecipientAllowlisted,
  isValidEmail,
  normalizeEmail,
  canonicalizeJson,
  canonicalizeValue,
  signCanonicalBody,
  timingSafeEqualHex,
  assertTimestampFresh,
  verifySignedRequest,
  buildSignedWireEnvelope,
  verifySignedEnvelope,
  buildCanonicalPayload,
  parseZapierResponse,
  defaultCapabilities: () =>
    defaultCapabilities({
      supportsTracking: false,
      supportsTemplates: false,
      supportsBranding: true,
      supportsAttachments: false,
    }),
};
