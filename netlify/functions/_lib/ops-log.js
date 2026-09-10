/**
 * Structured ops logs for Netlify Functions (filter: mg_ops === true).
 * Do not pass secrets, emails, names, full payloads, URLs, tokens, signatures, or nonces.
 * Allowed: event name, status, counts, codes, and non-sensitive request/correlation IDs.
 */

const DETAIL_MAX = 400;

const ALLOWED_KEYS = new Set([
  "req_id",
  "fn",
  "event",
  "level",
  "outcome",
  "tenant_id",
  "quote_id",
  "http_status",
  "detail",
  "additional_recipient_count",
  "recipient_count",
]);

const FORBIDDEN_KEYS = [
  "additional_recipients",
  "additionalRecipients",
  "client_email",
  "to_email",
  "toEmail",
  "tenant_email",
  "owner_email",
  "client_name",
  "to_name",
  "business_name",
  "messageText",
  "message_note",
  "public_quote_url",
  "pdf_url",
  "pdfUrl",
  "publicQuoteUrl",
  "public_token",
  "publicToken",
  "zapier_signature",
  "zapier_timestamp",
  "zapier_nonce",
  "zapier_signature_version",
  "signature",
  "nonce",
  "secret",
  "payload",
  "body",
  "webhookUrl",
  "webhook_url",
];

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const URL_RE = /https?:\/\/[^\s"'\\]+/gi;

function makeReqId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

function truncateDetail(value) {
  if (value === undefined || value === null) return null;
  const s = String(value);
  if (s.length <= DETAIL_MAX) return s;
  return `${s.slice(0, DETAIL_MAX)}…`;
}

function sanitizeDetail(value) {
  const truncated = truncateDetail(value);
  if (!truncated) return null;
  return truncated.replace(EMAIL_RE, "[redacted]").replace(URL_RE, "[redacted-url]");
}

function countAdditionalRecipients(value) {
  if (value == null) return 0;
  if (Array.isArray(value)) {
    return value.filter((v) => String(v == null ? "" : v).trim()).length;
  }
  const s = String(value).trim();
  if (!s) return 0;
  return s
    .split(/[,;]/)
    .map((part) => part.trim())
    .filter(Boolean).length;
}

/**
 * @param {object} entry
 */
function logOps(entry) {
  const src = entry && typeof entry === "object" ? entry : {};
  const payload = { mg_ops: true };
  for (const key of ALLOWED_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(src, key)) continue;
    if (FORBIDDEN_KEYS.indexOf(key) >= 0) continue;
    const value = src[key];
    if (value == null || value === "") continue;
    if (key === "detail") {
      const detail = sanitizeDetail(value);
      if (detail) payload.detail = detail;
      continue;
    }
    if (key === "http_status" || key === "additional_recipient_count" || key === "recipient_count") {
      const n = Number(value);
      if (Number.isFinite(n)) payload[key] = n;
      continue;
    }
    payload[key] = String(value);
  }

  const line = JSON.stringify(payload);
  if (src.level === "error") {
    console.error(line);
  } else if (src.level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

module.exports = {
  ALLOWED_KEYS,
  FORBIDDEN_KEYS,
  makeReqId,
  logOps,
  sanitizeDetail,
  truncateDetail,
  countAdditionalRecipients,
};
