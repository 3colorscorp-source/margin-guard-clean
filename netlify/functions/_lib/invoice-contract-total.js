/**
 * Resolve the project contract total for invoices.
 * Start Payment / Progress children omit quote_id (unique constraint), so
 * invoice.amount must never stand in as the contract total.
 */
"use strict";

const SOURCE_INVOICE_RE =
  /\[source_invoice:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\]/i;

const PROJECT_PAYMENT_LABELS = new Set([
  "start payment",
  "progress payment",
  "final payment",
  "remaining balance",
  "change order"
]);

function firstPositiveMoney(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0.005) return n;
  }
  return 0;
}

function snapshotContractTotal(snap) {
  if (!snap || typeof snap !== "object") return 0;
  return firstPositiveMoney(
    snap.price && snap.price.contract_total,
    snap.payment_terms && snap.payment_terms.contract_total,
    snap.quote && snap.quote.total
  );
}

function isProjectPaymentSourceRow(row) {
  if (!row) return false;
  const label = String(row.invoice_label || "").trim().toLowerCase();
  if (PROJECT_PAYMENT_LABELS.has(label)) return true;
  return SOURCE_INVOICE_RE.test(String(row.notes || ""));
}

async function loadQuoteTotal(supabaseRequest, tenantId, quoteId) {
  const tid = String(tenantId || "").trim();
  const qid = String(quoteId || "").trim();
  if (!tid || !qid) return 0;
  try {
    const rows = await supabaseRequest(
      `quotes?id=eq.${encodeURIComponent(qid)}&tenant_id=eq.${encodeURIComponent(tid)}&select=total&limit=1`,
      { method: "GET" }
    );
    const row = Array.isArray(rows) ? rows[0] : null;
    return firstPositiveMoney(row && row.total);
  } catch (_err) {
    return 0;
  }
}

async function loadProjectTotal(supabaseRequest, tenantId, projectId) {
  const tid = String(tenantId || "").trim();
  const pid = String(projectId || "").trim();
  if (!tid || !pid) return 0;
  try {
    const rows = await supabaseRequest(
      `tenant_projects?id=eq.${encodeURIComponent(pid)}&tenant_id=eq.${encodeURIComponent(tid)}&select=sale_price&limit=1`,
      { method: "GET" }
    );
    const row = Array.isArray(rows) ? rows[0] : null;
    return firstPositiveMoney(row && row.sale_price);
  } catch (_err) {
    return 0;
  }
}

async function loadFrozenContractTotal(supabaseRequest, tenantId, projectId) {
  const tid = String(tenantId || "").trim();
  const pid = String(projectId || "").trim();
  if (!tid || !pid) return 0;
  try {
    const rows = await supabaseRequest(
      `tenant_contract_packages?tenant_id=eq.${encodeURIComponent(tid)}` +
        `&project_id=eq.${encodeURIComponent(pid)}` +
        `&status=in.(ready,executed)` +
        `&select=snapshot_json` +
        `&order=version.desc&limit=1`,
      { method: "GET" }
    );
    const row = Array.isArray(rows) ? rows[0] : null;
    return snapshotContractTotal(row && row.snapshot_json);
  } catch (_err) {
    return 0;
  }
}

async function loadSourceInvoice(supabaseRequest, tenantId, notes) {
  const tid = String(tenantId || "").trim();
  const m = SOURCE_INVOICE_RE.exec(String(notes || ""));
  if (!tid || !m) return null;
  try {
    const rows = await supabaseRequest(
      `invoices?id=eq.${encodeURIComponent(m[1])}&tenant_id=eq.${encodeURIComponent(tid)}&select=id,amount,quote_id,project_id,invoice_label,notes&limit=1`,
      { method: "GET" }
    );
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  } catch (_err) {
    return null;
  }
}

/**
 * @param {function} supabaseRequest
 * @param {{ tenantId: string, quoteId?: string, projectId?: string, notes?: string, isProjectPayment?: boolean, invoiceAmount?: number }} args
 * @returns {Promise<number>}
 */
async function resolveInvoiceContractTotal(supabaseRequest, args) {
  const tenantId = String((args && args.tenantId) || "").trim();
  let quoteId = String((args && args.quoteId) || "").trim();
  let projectId = String((args && args.projectId) || "").trim();
  const notes = args && args.notes;
  const isProjectPayment = !!(args && args.isProjectPayment);
  const invoiceAmount = firstPositiveMoney(args && args.invoiceAmount);
  let parentAmount = 0;

  if (isProjectPayment && !quoteId) {
    const parent = await loadSourceInvoice(supabaseRequest, tenantId, notes);
    if (parent) {
      quoteId = String(parent.quote_id || "").trim() || quoteId;
      projectId = projectId || String(parent.project_id || "").trim();
      if (!isProjectPaymentSourceRow(parent)) {
        parentAmount = firstPositiveMoney(parent.amount);
      }
    }
  }

  const quoteTotal = await loadQuoteTotal(supabaseRequest, tenantId, quoteId);
  const projectTotal = await loadProjectTotal(supabaseRequest, tenantId, projectId);
  const frozenTotal = await loadFrozenContractTotal(supabaseRequest, tenantId, projectId);
  const resolved = firstPositiveMoney(frozenTotal, quoteTotal, projectTotal, isProjectPayment ? parentAmount : 0);
  if (isProjectPayment) return resolved;
  return firstPositiveMoney(resolved, invoiceAmount);
}

module.exports = {
  firstPositiveMoney,
  resolveInvoiceContractTotal,
  SOURCE_INVOICE_RE
};
