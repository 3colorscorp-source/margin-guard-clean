/**
 * Closed read-only invoice diagnostic for Support AI Stage 2.
 * Fixed table, fixed select, GET only, trusted tenant_id filter, max 2 rows.
 * Never send raw rows or restricted fields to OpenAI.
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
];

const INVOICE_DIAGNOSTIC_SELECT = INVOICE_DIAGNOSTIC_SELECT_FIELDS.join(",");

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

function toModelFacts(row) {
  const sentAt = isNonEmpty(row?.sent_at) ? String(row.sent_at).trim() : null;
  return {
    invoice_no: isNonEmpty(row?.invoice_no) ? String(row.invoice_no).trim() : null,
    status: isNonEmpty(row?.status) ? String(row.status).trim() : null,
    type: isNonEmpty(row?.type) ? String(row.type).trim() : null,
    invoice_label: isNonEmpty(row?.invoice_label) ? String(row.invoice_label).trim() : null,
    created_at: isNonEmpty(row?.created_at) ? String(row.created_at).trim() : null,
    due_date: isNonEmpty(row?.due_date) ? String(row.due_date).trim() : null,
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

async function defaultInvoiceGet(path) {
  return supabaseRequest(path, { method: "GET" });
}

/**
 * @returns {Promise<{ outcome: "ok"|"not_found"|"ambiguous", facts?: object, queryPath: string }>}
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
  return {
    outcome: "ok",
    facts: toModelFacts(list[0]),
    queryPath,
  };
}

module.exports = {
  UUID_RE,
  INVOICE_DIAGNOSTIC_SELECT,
  INVOICE_DIAGNOSTIC_SELECT_FIELDS,
  extractInvoiceIdentifier,
  isInvoiceDiagnosticQuestion,
  isSqlOrListAllProbe,
  isTenantOverrideAttempt,
  toModelFacts,
  buildInvoiceQueryPath,
  readInvoiceDiagnostic,
};
