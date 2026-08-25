/**
 * Closed read-only invoice diagnostic for Support AI Stage 2.
 * Fixed table, fixed select, GET only, trusted tenant_id filter, max 2 rows.
 * Never send raw rows or restricted fields to OpenAI.
 *
 * Owner-visible `status` matches Invoice Hub's derived lifecycle overlay:
 * archived / void / fully-paid / deposit_paid / accepted, then Hub remainder
 * (open→draft, sent_at→sent, overdue overlay, raw fallback).
 * Fully-paid uses invoices.amount, invoices.paid_amount, quotes.total, and a
 * closed tenant_project_payments amount sum. Money is discarded before OpenAI.
 * Overdue uses Hub UTC `toISOString().slice(0, 10)` and derived balanceDue > 0.
 * Does not reproduce browser project salePrice fallback.
 */
"use strict";

const { supabaseRequest } = require("../supabase-admin");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const INVOICE_DIAGNOSTIC_SELECT_FIELDS = [
  "id",
  "tenant_id",
  "invoice_no",
  "status",
  "type",
  "invoice_label",
  "created_at",
  "due_date",
  "sent_at",
  "voided_at",
  "public_token",
  "quote_id",
  "project_id",
  "payment_status",
  "amount",
  "paid_amount",
];

/** Nested quote lifecycle flags plus total for server-side paid math only. */
const INVOICE_DIAGNOSTIC_QUOTE_EMBED = "quotes(status,accepted_at,deposit_paid_at,total)";

const INVOICE_DIAGNOSTIC_SELECT =
  INVOICE_DIAGNOSTIC_SELECT_FIELDS.join(",") + "," + INVOICE_DIAGNOSTIC_QUOTE_EMBED;

const INVOICE_DIAGNOSTIC_PAYMENT_SELECT = "amount";
const PAID_TOLERANCE = 0.005;

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
]);

function isUuid(value) {
  return UUID_RE.test(String(value || "").trim());
}

function isSqlOrListAllProbe(message) {
  const text = String(message || "").toLowerCase();
  return (
    /\brun sql\b/.test(text) ||
    /\bquery the database\b/.test(text) ||
    /\bselect \*/.test(text) ||
    /\blist all invoices\b/.test(text) ||
    /\bshow (me )?(every|all) invoices\b/.test(text) ||
    /\bevery invoice\b/.test(text) ||
    /\bfrom invoices\b/.test(text) ||
    /\barbitrary table\b/.test(text)
  );
}

const TENANT_OVERRIDE_STOPWORDS = new Set([
  "isolation",
  "context",
  "account",
  "accounts",
  "security",
  "boundaries",
  "boundary",
  "model",
  "scoping",
  "from",
  "in",
  "is",
  "of",
  "for",
  "the",
  "a",
  "an",
  "my",
  "our",
  "your",
]);

function overrideTokenLooksLikeId(raw) {
  const t = String(raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "");
  if (!t) return false;
  return !TENANT_OVERRIDE_STOPWORDS.has(t);
}

function isTenantOverrideAttempt(message) {
  const text = String(message || "").toLowerCase();
  if (!text) return false;

  if (/\btenant[ _-]?id\s*[=:]\s*\S+/.test(text)) return true;
  const tenantIdArg = text.match(/\btenant[ _-]?id\s+(\S+)/);
  if (tenantIdArg && overrideTokenLooksLikeId(tenantIdArg[1])) return true;

  const useTenant = text.match(/\buse\s+tenant(?:[ _-]?id)?\s+(\S+)/);
  if (useTenant && overrideTokenLooksLikeId(useTenant[1])) return true;

  if (/\bswitch\s+to\s+tenant\b/.test(text)) return true;
  if (/\buse\s+another\s+tenant\b/.test(text)) return true;
  if (/\bignore\s+my\s+(current\s+)?tenant\b/.test(text)) return true;
  if (/\buse\s+this\s+tenant\s+id\s+instead\b/.test(text)) return true;
  if (/\binstead\s+of\s+my\s+(current\s+)?tenant\b/.test(text)) return true;
  if (/\b(force|override)\s+(the\s+)?tenant\b/.test(text)) return true;

  const queryTenant = text.match(/\bquery\s+tenant\s+(\S+)/);
  if (queryTenant && overrideTokenLooksLikeId(queryTenant[1])) return true;

  const businessId = text.match(/\bbusiness\s+id\s+(\S+)/);
  if (businessId && overrideTokenLooksLikeId(businessId[1])) return true;

  const companyTenant = text.match(/\bcompany\s+tenant\s+(\S+)/);
  if (companyTenant && overrideTokenLooksLikeId(companyTenant[1])) return true;

  return false;
}

function isInvoiceDiagnosticQuestion(message) {
  const text = String(message || "").toLowerCase();
  if (!/\binvoices?\b/.test(text)) return false;
  if (isSqlOrListAllProbe(text)) return false;
  if (/\bhow (do|can|to|does)\b/.test(text) && !extractInvoiceIdentifier(message)) {
    return false;
  }
  return (
    /\b(status|sent|draft|cancel|cancelled|canceled|void|public|submitted|type|issued|overdue|paid)\b/.test(
      text
    ) ||
    /\bwas invoice\b/.test(text) ||
    /\bif invoice\b/.test(text) ||
    /\bshow invoice\b/.test(text) ||
    /\binvoice [a-z0-9-]/i.test(text)
  );
}

function extractInvoiceIdentifier(message) {
  const text = String(message || "").trim();
  if (!text) return null;

  const afterInvoiceUuid = text.match(
    /\binvoices?\s+(?:id\s+)?(?:#|number|no\.?)?\s*:?\s*([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/i
  );
  if (afterInvoiceUuid) {
    return { type: "id", value: afterInvoiceUuid[1] };
  }

  const invToken = text.match(/\b(INV-[A-Za-z0-9][-A-Za-z0-9]{0,80})\b/i);
  if (invToken) {
    return { type: "invoice_no", value: invToken[1] };
  }

  const afterInvoiceToken = text.match(
    /\binvoices?\s*(?:#|number|no\.?)?\s*:?\s*([A-Za-z0-9][-A-Za-z0-9]{0,80})/i
  );
  if (afterInvoiceToken) {
    const value = String(afterInvoiceToken[1] || "").trim();
    if (!value || IDENTIFIER_STOPWORDS.has(value.toLowerCase())) return null;
    if (isUuid(value)) return { type: "id", value };
    return { type: "invoice_no", value };
  }

  return null;
}

function isNonEmpty(value) {
  return String(value ?? "").trim() !== "";
}

function normalizeRawInvoiceStatus(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw || raw === "open") return "draft";
  return raw;
}

/** Hub `new Date().toISOString().slice(0, 10)`. Injectable for tests. */
function utcTodayIsoDate(raw) {
  const text = String(raw || "").trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

/**
 * Hub date-only due_date. Exact YYYY-MM-DD kept. ISO datetime prefix sliced.
 * Empty / malformed → "" (no overdue overlay). Does not parse local/US dates.
 */
function normalizeInvoiceDueDate(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const prefixed = text.match(/^(\d{4}-\d{2}-\d{2})/);
  if (prefixed) return prefixed[1];
  return "";
}

/** PostgREST many-to-one embed may be an object or a one-element array. */
function unwrapQuoteEmbed(row) {
  let quoteWrap = row?.quotes;
  if (Array.isArray(quoteWrap)) quoteWrap = quoteWrap[0];
  return quoteWrap && typeof quoteWrap === "object" ? quoteWrap : null;
}

function finiteMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function sumLedgerAmounts(rows) {
  if (!Array.isArray(rows)) return 0;
  let sum = 0;
  for (const row of rows) {
    sum += finiteMoney(row?.amount);
  }
  return sum;
}

/**
 * Hub-equivalent paid math. Does not use invoices.balance_due or project salePrice.
 * balanceDue is for overdue overlay only and must never reach OpenAI.
 */
function computePaidFacts(row, ledgerPaid) {
  const invoiceAmount = finiteMoney(row?.amount);
  const dbPaid = finiteMoney(row?.paid_amount);
  const ledger = finiteMoney(ledgerPaid);
  const paidAmount = Math.max(dbPaid, ledger);
  const quote = unwrapQuoteEmbed(row);
  const quoteTotal = finiteMoney(quote?.total);
  const contractTotal = quoteTotal > 0 ? quoteTotal : invoiceAmount;
  const balanceDue = Math.max(0, contractTotal - paidAmount);
  const isFullyPaid =
    balanceDue <= PAID_TOLERANCE || (contractTotal > 0 && paidAmount + PAID_TOLERANCE >= contractTotal);
  return { isFullyPaid, balanceDue };
}

function resolvePaidFacts(row, paidFacts) {
  if (paidFacts && typeof paidFacts === "object" && typeof paidFacts.isFullyPaid === "boolean") {
    if (typeof paidFacts.balanceDue === "number") return paidFacts;
    return { ...paidFacts, ...computePaidFacts(row, 0), isFullyPaid: paidFacts.isFullyPaid };
  }
  return computePaidFacts(row, 0);
}

/**
 * Invoice Hub owner-visible Status (`hubServerInvoiceLifecycleDisplayStatus`).
 *
 * Priority:
 * 1. archived
 * 2. void
 * 3. isFullyPaid → paid
 * 4. deposit_paid (invoice payment_status or quote.deposit_paid_at)
 * 5. accepted (quote.accepted_at or quote.status = accepted)
 * 6. remainder (`hubServerInvoiceStatusForDisplay`):
 *    open → draft, sent_at → sent, then overdue overlay may overwrite sent,
 *    else raw fallback
 */
function deriveOwnerVisibleInvoiceStatus(row, paidFacts, options = {}) {
  const rawInv = normalizeRawInvoiceStatus(row?.status);
  if (rawInv === "archived") return "archived";
  if (rawInv === "void") return "void";

  const computed = resolvePaidFacts(row, paidFacts);
  if (computed.isFullyPaid) return "paid";

  const paymentStatus = String(row?.payment_status || "").trim().toLowerCase();
  const quote = unwrapQuoteEmbed(row);
  const quoteDepositAt = isNonEmpty(quote?.deposit_paid_at);
  if (paymentStatus === "deposit_paid" || quoteDepositAt) return "deposit_paid";

  const quoteAcceptedAt = isNonEmpty(quote?.accepted_at);
  const quoteStatus = String(quote?.status || "").trim().toLowerCase();
  if (quoteAcceptedAt || quoteStatus === "accepted") return "accepted";

  let raw = rawInv;
  const sentAtRaw = String(row?.sent_at || "").trim();
  if (sentAtRaw && raw !== "paid" && raw !== "void") {
    raw = "sent";
  }
  const dueRaw = normalizeInvoiceDueDate(row?.due_date);
  const today = utcTodayIsoDate(options.today || options.utcToday);
  const bal = Math.max(finiteMoney(computed.balanceDue), 0);
  if (raw !== "paid" && raw !== "void" && dueRaw && dueRaw < today && bal > 0) {
    raw = "overdue";
  }
  return raw;
}

function toModelFacts(row, paidFacts, options = {}) {
  const sentAt = isNonEmpty(row?.sent_at) ? String(row.sent_at).trim() : null;
  const computed = resolvePaidFacts(row, paidFacts);
  const status = deriveOwnerVisibleInvoiceStatus(row, computed, options);
  const dueRaw = normalizeInvoiceDueDate(row?.due_date);
  return {
    invoice_no: isNonEmpty(row?.invoice_no) ? String(row.invoice_no).trim() : null,
    status,
    is_overdue: status === "overdue",
    type: isNonEmpty(row?.type) ? String(row.type).trim() : null,
    invoice_label: isNonEmpty(row?.invoice_label) ? String(row.invoice_label).trim() : null,
    created_at: isNonEmpty(row?.created_at) ? String(row.created_at).trim() : null,
    due_date: dueRaw || null,
    sent_at: sentAt,
    voided_at: isNonEmpty(row?.voided_at) ? String(row.voided_at).trim() : null,
    has_public_token: isNonEmpty(row?.public_token),
    has_quote: isNonEmpty(row?.quote_id),
    has_project: isNonEmpty(row?.project_id),
    delivery: {
      submitted_to_email_bridge: Boolean(sentAt),
      submitted_at: sentAt,
      can_prove_recipient_received: false,
    },
  };
}

function buildInvoiceQueryPath(tenantId, identifier) {
  const tid = String(tenantId || "").trim();
  const params = new URLSearchParams();
  params.set("tenant_id", `eq.${tid}`);
  params.set("select", INVOICE_DIAGNOSTIC_SELECT);
  params.set("limit", "2");
  if (identifier.type === "id") {
    params.set("id", `eq.${identifier.value}`);
  } else {
    params.set("invoice_no", `eq.${identifier.value}`);
  }
  return `invoices?${params.toString()}`;
}

function buildPaymentQueryPath(tenantId, invoiceId) {
  const tid = String(tenantId || "").trim();
  const iid = String(invoiceId || "").trim();
  const params = new URLSearchParams();
  params.set("tenant_id", `eq.${tid}`);
  params.set("invoice_id", `eq.${iid}`);
  params.set("select", INVOICE_DIAGNOSTIC_PAYMENT_SELECT);
  return `tenant_project_payments?${params.toString()}`;
}

async function defaultInvoiceGet(path) {
  return supabaseRequest(path, { method: "GET" });
}

/**
 * @returns {Promise<{ outcome: "ok"|"not_found"|"ambiguous"|"status_unverified", facts?: object, queryPath: string }>}
 */
async function readInvoiceDiagnostic(tenantId, identifier, deps = {}) {
  const tid = String(tenantId || "").trim();
  if (!tid || !identifier || !identifier.type || !identifier.value) {
    return { outcome: "not_found", queryPath: "" };
  }
  if (identifier.type === "id" && !isUuid(identifier.value)) {
    return { outcome: "not_found", queryPath: "" };
  }

  const queryPath = buildInvoiceQueryPath(tid, identifier);
  const get = deps.supabaseGet || defaultInvoiceGet;
  const rows = await get(queryPath);
  const list = (Array.isArray(rows) ? rows : []).filter(
    (row) => String(row?.tenant_id || "").trim() === tid
  );

  if (list.length === 0) {
    return { outcome: "not_found", queryPath };
  }
  if (list.length > 1) {
    return { outcome: "ambiguous", queryPath };
  }

  const row = list[0];
  const invoiceId = String(row?.id || "").trim();
  if (!isUuid(invoiceId)) {
    return { outcome: "status_unverified", queryPath };
  }

  const paymentQueryPath = buildPaymentQueryPath(tid, invoiceId);
  let payRows;
  try {
    payRows = await get(paymentQueryPath);
  } catch (_err) {
    return { outcome: "status_unverified", queryPath, paymentQueryPath };
  }
  if (!Array.isArray(payRows)) {
    return { outcome: "status_unverified", queryPath, paymentQueryPath };
  }

  const paidFacts = computePaidFacts(row, sumLedgerAmounts(payRows));
  return {
    outcome: "ok",
    invoice_id: invoiceId,
    facts: toModelFacts(row, paidFacts, {
      utcToday: deps.utcToday,
      today: deps.today,
    }),
    queryPath,
    paymentQueryPath,
  };
}

module.exports = {
  UUID_RE,
  PAID_TOLERANCE,
  INVOICE_DIAGNOSTIC_SELECT,
  INVOICE_DIAGNOSTIC_SELECT_FIELDS,
  INVOICE_DIAGNOSTIC_QUOTE_EMBED,
  INVOICE_DIAGNOSTIC_PAYMENT_SELECT,
  extractInvoiceIdentifier,
  isInvoiceDiagnosticQuestion,
  isSqlOrListAllProbe,
  isTenantOverrideAttempt,
  unwrapQuoteEmbed,
  utcTodayIsoDate,
  normalizeInvoiceDueDate,
  computePaidFacts,
  deriveOwnerVisibleInvoiceStatus,
  toModelFacts,
  buildInvoiceQueryPath,
  buildPaymentQueryPath,
  readInvoiceDiagnostic,
};
