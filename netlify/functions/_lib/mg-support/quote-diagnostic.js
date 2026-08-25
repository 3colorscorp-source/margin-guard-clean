/**
 * Closed read-only quote diagnostic for Support AI Stage 2C.
 * Fixed quotes table, fixed select, GET only, trusted tenant_id filter, max 2 rows.
 * Never send raw rows, public_token, PII, or financial fields to OpenAI.
 *
 * Owner-visible `status` is normalized Sales Admin raw quotes.status
 * (lowercase). Expiration is a separate date fact, never a status overlay.
 * Quotes have no persisted sent_at. delivery.submitted_to_email_bridge is
 * null (unknown), not false. Do not infer email send from status or public_token.
 */
"use strict";

const { supabaseRequest } = require("../supabase-admin");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const QUOTE_DIAGNOSTIC_SELECT_FIELDS = [
  "id",
  "tenant_id",
  "quote_number_display",
  "status",
  "created_at",
  "accepted_at",
  "expiration_date",
  "public_token",
];

const QUOTE_DIAGNOSTIC_SELECT = QUOTE_DIAGNOSTIC_SELECT_FIELDS.join(",");

const IDENTIFIER_STOPWORDS = new Set([
  "hub",
  "status",
  "draft",
  "sent",
  "type",
  "page",
  "id",
  "the",
  "my",
  "this",
  "that",
  "a",
  "an",
  "still",
  "was",
  "is",
  "been",
  "public",
  "accepted",
  "approved",
  "declined",
  "expired",
  "expiration",
]);

function isUuid(value) {
  return UUID_RE.test(String(value || "").trim());
}

function isEstimateDisplayNumber(value) {
  return /^20\d{2}-\d{4}$/.test(String(value || "").trim());
}

function isQuoteSqlOrListAllProbe(message) {
  const text = String(message || "").toLowerCase();
  return (
    /\blist all quotes\b/.test(text) ||
    /\blist all estimates\b/.test(text) ||
    /\bshow (me )?(every|all) quotes\b/.test(text) ||
    /\bshow (me )?(every|all) estimates\b/.test(text) ||
    /\bevery quote\b/.test(text) ||
    /\bevery estimate\b/.test(text) ||
    /\bevery accepted estimate\b/.test(text) ||
    /\bfrom quotes\b/.test(text)
  );
}

function extractQuoteIdentifier(message) {
  const text = String(message || "").trim();
  if (!text) return null;

  const afterQuoteUuid = text.match(
    /\b(?:quotes?|estimates?)\s+(?:id\s+)?(?:#|number|no\.?)?\s*:?\s*([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/i
  );
  if (afterQuoteUuid) {
    return { type: "id", value: afterQuoteUuid[1] };
  }

  const displayMatch = text.match(/(?:^|[^0-9a-fA-F-])(20\d{2}-\d{4})(?![0-9a-fA-F-])/);
  if (displayMatch && isEstimateDisplayNumber(displayMatch[1])) {
    return { type: "quote_number_display", value: displayMatch[1] };
  }

  const afterQuoteToken = text.match(
    /\b(?:quotes?|estimates?)\s*(?:#|number|no\.?)?\s*:?\s*([A-Za-z0-9][-A-Za-z0-9]{0,80})/i
  );
  if (afterQuoteToken) {
    const value = String(afterQuoteToken[1] || "").trim();
    if (!value || IDENTIFIER_STOPWORDS.has(value.toLowerCase())) return null;
    if (isUuid(value)) return { type: "id", value };
    if (isEstimateDisplayNumber(value)) return { type: "quote_number_display", value };
    return null;
  }

  return null;
}

function isQuoteDiagnosticQuestion(message) {
  const text = String(message || "").toLowerCase();
  if (!/\b(quotes?|estimates?)\b/.test(text)) return false;
  if (/\binvoices?\b/.test(text)) return false;
  if (isQuoteSqlOrListAllProbe(text)) return false;
  if (/\bhow (do|can|to|does)\b/.test(text) && !extractQuoteIdentifier(message)) {
    return false;
  }
  return (
    /\b(status|sent|draft|accepted|approved|declined|expired|expiration|public|published|page)\b/.test(
      text
    ) ||
    /\bwas (quote|estimate)\b/.test(text) ||
    /\b(has|did) (the )?(quote|estimate)\b/.test(text) ||
    /\b(quote|estimate) [a-z0-9-]/i.test(text)
  );
}

function isNonEmpty(value) {
  return String(value ?? "").trim() !== "";
}

function utcTodayIsoDate(raw) {
  if (isNonEmpty(raw) && /^\d{4}-\d{2}-\d{2}/.test(String(raw).trim())) {
    return String(raw).trim().slice(0, 10);
  }
  return new Date().toISOString().slice(0, 10);
}

function normalizeOwnerVisibleQuoteStatus(value) {
  return String(value || "").trim().toLowerCase();
}

function deriveAccepted(row, status) {
  if (isNonEmpty(row?.accepted_at)) return true;
  return status === "accepted" || status === "approved";
}

function isPastExpirationDate(expirationDate, utcToday) {
  const exp = String(expirationDate || "").trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(exp)) return false;
  return String(utcToday).slice(0, 10) > exp;
}

function isValidPublicReferenceFormat(token) {
  const trimmed = String(token == null ? "" : token).trim();
  if (trimmed === "") return false;
  if (trimmed.length < 10 || trimmed.length > 256) return false;
  return /^[a-zA-Z0-9_]+$/.test(trimmed);
}

const PUBLIC_ACCEPT_ACTION_BLOCKING_STATUSES = new Set(["accepted", "approved"]);

/**
 * Public estimate CONFIGURATION facts from stored quote state only.
 * Does not probe the public endpoint. Does not prove HTTP 200 or uniqueness.
 * Canonical public GET does not filter by quote status or expiration.
 * Accept/decline UI hides those actions when status is accepted or approved.
 */
function derivePublicEstimateFacts(row, opts = {}) {
  const status = normalizeOwnerVisibleQuoteStatus(row?.status);
  const expirationDate = isNonEmpty(row?.expiration_date)
    ? String(row.expiration_date).trim().slice(0, 10)
    : null;
  const utcToday = utcTodayIsoDate(opts.utcToday);
  const expired = isPastExpirationDate(expirationDate, utcToday);
  const configured = isNonEmpty(row?.public_token);
  const formatValid = configured ? isValidPublicReferenceFormat(row?.public_token) : null;
  const responseActionAllowed = !PUBLIC_ACCEPT_ACTION_BLOCKING_STATUSES.has(status);

  let publicPageReason = "not_published";
  if (!configured) publicPageReason = "not_published";
  else if (formatValid !== true) publicPageReason = "invalid_public_reference_format";
  else if (expired) publicPageReason = "expired_but_configured";
  else if (!responseActionAllowed) publicPageReason = "response_action_unavailable";
  else publicPageReason = "configured";

  return {
    public_page_configured: configured,
    public_reference_format_valid: formatValid,
    expired,
    response_action_allowed_by_quote_state: responseActionAllowed,
    public_page_reason: publicPageReason,
  };
}

function toModelFacts(row, opts = {}) {
  const status = normalizeOwnerVisibleQuoteStatus(row?.status);
  const acceptedAt = isNonEmpty(row?.accepted_at) ? String(row.accepted_at).trim() : null;
  const expirationDate = isNonEmpty(row?.expiration_date)
    ? String(row.expiration_date).trim().slice(0, 10)
    : null;
  const utcToday = utcTodayIsoDate(opts.utcToday);
  return {
    quote_no: isNonEmpty(row?.quote_number_display) ? String(row.quote_number_display).trim() : null,
    status,
    created_at: isNonEmpty(row?.created_at) ? String(row.created_at).trim() : null,
    accepted_at: acceptedAt,
    expiration_date: expirationDate,
    is_past_expiration_date: isPastExpirationDate(expirationDate, utcToday),
    has_public_estimate_page: isNonEmpty(row?.public_token),
    accepted: deriveAccepted(row, status),
    declined: status === "declined",
    delivery: {
      submitted_to_email_bridge: null,
      submitted_at: null,
      has_persisted_send_confirmation: false,
      can_prove_recipient_received: false,
    },
    public_estimate: derivePublicEstimateFacts(row, opts),
  };
}

function buildQuoteQueryPath(tenantId, identifier) {
  const tid = String(tenantId || "").trim();
  const params = new URLSearchParams();
  params.set("tenant_id", `eq.${tid}`);
  params.set("select", QUOTE_DIAGNOSTIC_SELECT);
  params.set("limit", "2");
  if (identifier.type === "id") {
    params.set("id", `eq.${identifier.value}`);
  } else {
    params.set("quote_number_display", `eq.${identifier.value}`);
  }
  return `quotes?${params.toString()}`;
}

async function defaultQuoteGet(path) {
  return supabaseRequest(path, { method: "GET" });
}

/**
 * @returns {Promise<{ outcome: "ok"|"not_found"|"ambiguous"|"status_unverified", facts?: object, queryPath: string }>}
 */
async function readQuoteDiagnostic(tenantId, identifier, deps = {}) {
  const tid = String(tenantId || "").trim();
  if (!tid || !identifier || !identifier.type || !identifier.value) {
    return { outcome: "not_found", queryPath: "" };
  }
  if (identifier.type === "id" && !isUuid(identifier.value)) {
    return { outcome: "not_found", queryPath: "" };
  }
  if (
    identifier.type === "quote_number_display" &&
    !isEstimateDisplayNumber(identifier.value)
  ) {
    return { outcome: "not_found", queryPath: "" };
  }

  const queryPath = buildQuoteQueryPath(tid, identifier);
  const get = deps.supabaseGet || defaultQuoteGet;
  let rows;
  try {
    rows = await get(queryPath);
  } catch (_err) {
    return { outcome: "status_unverified", queryPath };
  }
  if (!Array.isArray(rows)) {
    return { outcome: "status_unverified", queryPath };
  }

  const list = rows.filter((row) => String(row?.tenant_id || "").trim() === tid);
  if (list.length === 0) {
    return { outcome: "not_found", queryPath };
  }
  if (list.length > 1) {
    return { outcome: "ambiguous", queryPath };
  }

  return {
    outcome: "ok",
    facts: toModelFacts(list[0], { utcToday: deps.utcToday }),
    queryPath,
  };
}

module.exports = {
  UUID_RE,
  QUOTE_DIAGNOSTIC_SELECT,
  QUOTE_DIAGNOSTIC_SELECT_FIELDS,
  extractQuoteIdentifier,
  isQuoteDiagnosticQuestion,
  isQuoteSqlOrListAllProbe,
  isEstimateDisplayNumber,
  normalizeOwnerVisibleQuoteStatus,
  isPastExpirationDate,
  toModelFacts,
  derivePublicEstimateFacts,
  isValidPublicReferenceFormat,
  buildQuoteQueryPath,
  readQuoteDiagnostic,
};
