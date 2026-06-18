/**
 * Step 3E-C18-B — shared read-only quote edit lock evaluation (no writes).
 */

const { supabaseRequest } = require("./supabase-admin");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const LOCKED_STATUSES = new Set(["accepted", "approved", "archived"]);

const EDITABLE_STATUS_CANDIDATES = new Set([
  "draft",
  "ready_to_send",
  "sent",
  "pending",
  "declined",
  "rejected",
]);

/** Invoice statuses that do not block quote edit. */
const NON_BLOCKING_INVOICE_STATUSES = new Set([
  "void",
  "archived",
  "cancelled",
  "canceled",
]);

const EDITABLE_FIELD_NAMES = [
  "client_name",
  "client_email",
  "client_phone",
  "project_name",
  "title",
  "project_address",
  "job_site",
  "notes",
  "terms",
  "start_date",
  "due_date",
];

const QUOTE_GUARD_SELECT = [
  "id",
  "tenant_id",
  "quote_number_display",
  "project_name",
  "title",
  "client_name",
  "client_email",
  "client_phone",
  "project_address",
  "job_site",
  "status",
  "total",
  "deposit_required",
  "currency",
  "notes",
  "terms",
  "start_date",
  "due_date",
  "created_at",
  "updated_at",
  "accepted_at",
  "deposit_paid_at",
  "public_token",
  "exclusions_initials",
  "exclusions_acknowledged_at",
  "change_order_acknowledged_at",
  "first_view_tracked_at",
].join(",");

function normStatus(s) {
  return String(s || "")
    .trim()
    .toLowerCase();
}

function pickFirst(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  return "";
}

function isNonEmptyTs(value) {
  return Boolean(String(value ?? "").trim());
}

function buildPublicQuoteUrl(publicToken) {
  const token = String(publicToken || "").trim();
  if (!token) return null;
  const siteUrl = String(
    process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.SITE_URL || ""
  ).replace(/\/+$/, "");
  if (siteUrl) {
    return `${siteUrl}/estimate-public.html?token=${encodeURIComponent(token)}`;
  }
  return `/estimate-public.html?token=${encodeURIComponent(token)}`;
}

function serializeSafeQuote(row) {
  if (!row?.id) return null;
  return {
    id: row.id,
    quote_number_display: row.quote_number_display ?? null,
    project_name: pickFirst(row.project_name, row.title) || null,
    title: row.title ?? null,
    client_name: row.client_name ?? null,
    client_email: row.client_email ?? null,
    client_phone: row.client_phone ?? null,
    project_address: pickFirst(row.project_address, row.job_site) || null,
    job_site: row.job_site ?? null,
    status: row.status ?? null,
    total: row.total ?? null,
    deposit_required: row.deposit_required ?? null,
    currency: row.currency ?? "USD",
    notes: row.notes ?? null,
    terms: row.terms ?? null,
    start_date: row.start_date ?? null,
    due_date: row.due_date ?? null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
    accepted_at: row.accepted_at ?? null,
    public_url: buildPublicQuoteUrl(row.public_token),
  };
}

async function fetchQuoteForTenant(tenantId, quoteId) {
  const tid = encodeURIComponent(String(tenantId));
  const qid = encodeURIComponent(String(quoteId));
  const rows = await supabaseRequest(
    `quotes?id=eq.${qid}&tenant_id=eq.${tid}&select=${QUOTE_GUARD_SELECT}&limit=1`,
    { method: "GET" }
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function hasTenantProjectForQuote(tenantId, quoteId) {
  const tid = encodeURIComponent(String(tenantId));
  const qid = encodeURIComponent(String(quoteId));
  const rows = await supabaseRequest(
    `tenant_projects?tenant_id=eq.${tid}&quote_id=eq.${qid}&select=id&limit=1`,
    { method: "GET" }
  );
  return Array.isArray(rows) && rows.length > 0 && Boolean(rows[0]?.id);
}

async function fetchInvoicesForQuote(tenantId, quoteId) {
  const tid = encodeURIComponent(String(tenantId));
  const qid = encodeURIComponent(String(quoteId));
  const rows = await supabaseRequest(
    `invoices?tenant_id=eq.${tid}&quote_id=eq.${qid}&select=id,status&limit=50`,
    { method: "GET" }
  );
  return Array.isArray(rows) ? rows : [];
}

function hasBlockingInvoice(invoices) {
  for (const inv of invoices) {
    if (!inv?.id) continue;
    const st = normStatus(inv.status);
    if (!NON_BLOCKING_INVOICE_STATUSES.has(st)) {
      return true;
    }
  }
  return false;
}

async function hasPaymentForQuote(tenantId, quoteId, invoiceIds) {
  const tid = encodeURIComponent(String(tenantId));
  const qid = encodeURIComponent(String(quoteId));

  const byQuote = await supabaseRequest(
    `tenant_project_payments?tenant_id=eq.${tid}&quote_id=eq.${qid}&select=id&limit=1`,
    { method: "GET" }
  );
  if (Array.isArray(byQuote) && byQuote.length > 0 && byQuote[0]?.id) {
    return true;
  }

  const ids = Array.from(
    new Set((invoiceIds || []).map((id) => String(id || "").trim()).filter(Boolean))
  );
  if (!ids.length) return false;

  const inList = ids.map((id) => encodeURIComponent(id)).join(",");
  const byInvoice = await supabaseRequest(
    `tenant_project_payments?tenant_id=eq.${tid}&invoice_id=in.(${inList})&select=id&limit=1`,
    { method: "GET" }
  );
  return Array.isArray(byInvoice) && byInvoice.length > 0 && Boolean(byInvoice[0]?.id);
}

function clientAckStarted(quote) {
  if (!quote || typeof quote !== "object") return false;
  if (String(quote.exclusions_initials || "").trim()) return true;
  if (isNonEmptyTs(quote.exclusions_acknowledged_at)) return true;
  if (isNonEmptyTs(quote.change_order_acknowledged_at)) return true;
  return false;
}

/**
 * Evaluate whether a tenant quote may be edited (read-only; no writes).
 *
 * @param {string} tenantId — from session only
 * @param {string} quoteId
 * @returns {Promise<{
 *   ok: boolean,
 *   notFound?: boolean,
 *   invalidQuoteId?: boolean,
 *   quote: object|null,
 *   edit: { is_editable: boolean, locked: boolean, lock_reasons: string[], warnings: string[], editable_fields: string[] },
 *   locks: { has_project: boolean, has_invoice: boolean, has_payment: boolean, deposit_paid: boolean, client_ack_started: boolean }
 * }>}
 */
async function evaluateQuoteEditGuard(tenantId, quoteId) {
  const qid = String(quoteId || "").trim();
  if (!UUID_RE.test(qid)) {
    return {
      ok: false,
      invalidQuoteId: true,
      quote: null,
      edit: {
        is_editable: false,
        locked: true,
        lock_reasons: [],
        warnings: [],
        editable_fields: [],
      },
      locks: {
        has_project: false,
        has_invoice: false,
        has_payment: false,
        deposit_paid: false,
        client_ack_started: false,
      },
    };
  }

  const quote = await fetchQuoteForTenant(tenantId, qid);
  if (!quote?.id) {
    return {
      ok: false,
      notFound: true,
      quote: null,
      edit: {
        is_editable: false,
        locked: true,
        lock_reasons: ["quote_not_found"],
        warnings: [],
        editable_fields: [],
      },
      locks: {
        has_project: false,
        has_invoice: false,
        has_payment: false,
        deposit_paid: false,
        client_ack_started: false,
      },
    };
  }

  const lockReasons = [];
  const warnings = [];
  const statusNorm = normStatus(quote.status);

  const locks = {
    has_project: false,
    has_invoice: false,
    has_payment: false,
    deposit_paid: false,
    client_ack_started: false,
  };

  if (statusNorm === "accepted") {
    lockReasons.push("quote_accepted_status");
  }
  if (statusNorm === "approved") {
    lockReasons.push("quote_approved_status");
  }
  if (statusNorm === "archived") {
    lockReasons.push("quote_archived_status");
  }

  if (isNonEmptyTs(quote.accepted_at)) {
    if (!lockReasons.includes("quote_accepted_at")) {
      lockReasons.push("quote_accepted_at");
    }
  }

  if (isNonEmptyTs(quote.deposit_paid_at)) {
    locks.deposit_paid = true;
    lockReasons.push("deposit_paid");
  }

  locks.has_project = await hasTenantProjectForQuote(tenantId, qid);
  if (locks.has_project) {
    lockReasons.push("quote_has_project");
  }

  const invoices = await fetchInvoicesForQuote(tenantId, qid);
  locks.has_invoice = hasBlockingInvoice(invoices);
  if (locks.has_invoice) {
    lockReasons.push("quote_has_invoice");
  }

  const invoiceIds = invoices.map((inv) => inv.id).filter(Boolean);
  locks.has_payment = await hasPaymentForQuote(tenantId, qid, invoiceIds);
  if (locks.has_payment) {
    lockReasons.push("quote_has_payment");
  }

  locks.client_ack_started = clientAckStarted(quote);
  if (locks.client_ack_started) {
    lockReasons.push("client_ack_started");
  }

  if (statusNorm === "sent" || isNonEmptyTs(quote.first_view_tracked_at)) {
    warnings.push("quote_viewed_or_sent");
  }

  const locked = lockReasons.length > 0;
  const statusAllowsEdit = EDITABLE_STATUS_CANDIDATES.has(statusNorm);
  const isEditable = !locked && statusAllowsEdit;

  return {
    ok: true,
    quote: serializeSafeQuote(quote),
    edit: {
      is_editable: isEditable,
      locked,
      lock_reasons: lockReasons,
      warnings,
      editable_fields: isEditable ? [...EDITABLE_FIELD_NAMES] : [],
    },
    locks,
  };
}

module.exports = {
  UUID_RE,
  LOCKED_STATUSES,
  EDITABLE_STATUS_CANDIDATES,
  EDITABLE_FIELD_NAMES,
  evaluateQuoteEditGuard,
  buildPublicQuoteUrl,
  normStatus,
};
