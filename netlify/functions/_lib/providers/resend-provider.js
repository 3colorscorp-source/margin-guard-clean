/**
 * CH-013A.2.1 — Resend email provider.
 * Sole module allowed to call Resend HTTP for contract invitation delivery.
 * Never logs API keys, Authorization headers, raw tokens, signing URLs, or HTML bodies.
 */

"use strict";

const {
  normalizeSendResult,
  normalizeHealth,
  defaultCapabilities,
  classifyHttpFailure,
  trimField,
} = require("./provider-interface");

const API_VERSION = "ch-013a21-v1";
const PROVIDER = "resend";
const RESEND_URL = "https://api.resend.com/emails";
const DEFAULT_TIMEOUT_MS = 15000;

function getFetch() {
  if (typeof globalThis.fetch === "function") return globalThis.fetch;
  throw new Error("Global fetch is not available");
}

function deliveryEnabled() {
  const raw = trimField(process.env.CONTRACT_EMAIL_DELIVERY_ENABLED).toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function getApiKey() {
  return trimField(process.env.RESEND_API_KEY);
}

function getFromAddress() {
  return trimField(process.env.CONTRACT_EMAIL_FROM);
}

function getReplyToFallback() {
  return trimField(process.env.CONTRACT_EMAIL_REPLY_TO);
}

/**
 * Parse CONTRACT_EMAIL_INTERNAL_ALLOWLIST (comma-separated, case-insensitive).
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
  // Practical validation — not a full RFC parser.
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
  if (!getApiKey()) {
    return normalizeHealth({
      available: false,
      provider: PROVIDER,
      reason: "missing_api_key",
    });
  }
  if (!getFromAddress()) {
    return normalizeHealth({
      available: false,
      provider: PROVIDER,
      reason: "missing_from",
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
 * @param {{
 *   to: string,
 *   subject: string,
 *   html: string,
 *   text?: string,
 *   from_name?: string,
 *   reply_to?: string,
 *   idempotency_key?: string,
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
      error_message: `Resend unavailable: ${caps.reason || "unavailable"}`,
    });
  }

  const to = normalizeEmail(input.to);
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
  const html = String(input.html || "");
  const text = String(input.text || "");
  if (!subject || (!html && !text)) {
    return normalizeSendResult({
      accepted: false,
      retryable: false,
      provider: PROVIDER,
      error_code: "invalid_message",
      error_message: "Subject and body are required",
    });
  }

  const fromEmail = getFromAddress();
  const fromName = trimField(input.from_name);
  const replyToRaw =
    trimField(input.reply_to) || getReplyToFallback() || undefined;
  // Reject header-injection attempts in Reply-To / display names.
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
  const from = fromName ? `${fromName} <${fromEmail}>` : fromEmail;
  const replyTo = replyToRaw;

  const body = {
    from,
    to: [to],
    subject,
  };
  if (html) body.html = html;
  if (text) body.text = text;
  if (replyTo) body.reply_to = replyTo;

  const headers = {
    Authorization: `Bearer ${getApiKey()}`,
    "Content-Type": "application/json",
  };
  const idem = trimField(input.idempotency_key);
  if (idem) headers["Idempotency-Key"] = idem.slice(0, 256);

  const fetchImpl = typeof input.fetchImpl === "function" ? input.fetchImpl : getFetch();
  const timeoutMs = Number(input.timeout_ms) > 0 ? Number(input.timeout_ms) : DEFAULT_TIMEOUT_MS;
  const controller =
    typeof AbortController !== "undefined" ? new AbortController() : null;
  let timer = null;
  if (controller) {
    timer = setTimeout(() => controller.abort(), timeoutMs);
  }

  try {
    const res = await fetchImpl(RESEND_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller ? controller.signal : undefined,
    });
    if (timer) clearTimeout(timer);

    let messageId = null;
    try {
      const json = await res.json();
      messageId = trimField(json?.id) || null;
    } catch (_e) {
      messageId = null;
    }

    if (res.ok && messageId) {
      return normalizeSendResult({
        accepted: true,
        retryable: false,
        provider: PROVIDER,
        provider_message_id: messageId,
      });
    }
    if (res.ok && !messageId) {
      return normalizeSendResult({
        accepted: false,
        retryable: true,
        provider: PROVIDER,
        error_code: "provider_missing_message_id",
        error_message: "Provider accepted without message id",
      });
    }

    const classified = classifyHttpFailure(res.status, false);
    return normalizeSendResult({
      ...classified,
      provider: PROVIDER,
    });
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
  health,
  send,
  supportsTracking,
  supportsTemplates,
  supportsBranding,
  supportsAttachments,
  deliveryEnabled,
  getFromAddress,
  getReplyToFallback,
  parseAllowlist,
  isRecipientAllowlisted,
  isValidEmail,
  normalizeEmail,
  defaultCapabilities: () =>
    defaultCapabilities({
      supportsTracking: false,
      supportsTemplates: false,
      supportsBranding: true,
      supportsAttachments: false,
    }),
};
