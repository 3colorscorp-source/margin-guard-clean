/**
 * Closed Support invoice-resend eligibility + exact-UUID reload.
 * Stricter Hub send gates. No PII/money in returned reasons.
 */
"use strict";

const {
  computePaidFacts,
  deriveOwnerVisibleInvoiceStatus,
  PAID_TOLERANCE,
  INVOICE_DIAGNOSTIC_PAYMENT_SELECT,
  sumScopedLedgerAmounts,
} = require("./invoice-diagnostic");
const { isUuid } = require("./action-token");
const { supabaseRequest } = require("../supabase-admin");

function isValidHubDeliveryEmail(email) {
  const text = String(email || "").trim();
  return text.includes("@") && text.includes(".") && text.length >= 5 && text.length < 320;
}

const INVOICE_RESEND_SELECT_FIELDS = [
  "id",
  "tenant_id",
  "invoice_no",
  "status",
  "type",
  "invoice_label",
  "notes",
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
  "balance_due",
  "currency",
  "customer_email",
  "customer_name",
  "project_name",
  "business_name",
];

const INVOICE_RESEND_QUOTE_EMBED = "quotes(status,accepted_at,deposit_paid_at,total)";
const INVOICE_RESEND_SELECT =
  INVOICE_RESEND_SELECT_FIELDS.join(",") + "," + INVOICE_RESEND_QUOTE_EMBED;

const ALLOWED_VISIBLE_STATUSES = new Set([
  "draft",
  "sent",
  "partial",
  "overdue",
  "accepted",
  "deposit_paid",
]);

function buildInvoiceReloadPath(tenantId, invoiceId) {
  const params = new URLSearchParams();
  params.set("tenant_id", `eq.${tenantId}`);
  params.set("id", `eq.${invoiceId}`);
  params.set("select", INVOICE_RESEND_SELECT);
  params.set("limit", "2");
  return `invoices?${params.toString()}`;
}

function buildPaymentQueryPath(tenantId, invoiceId) {
  const params = new URLSearchParams();
  params.set("tenant_id", `eq.${tenantId}`);
  params.set("invoice_id", `eq.${invoiceId}`);
  params.set("select", INVOICE_DIAGNOSTIC_PAYMENT_SELECT);
  return `tenant_project_payments?${params.toString()}`;
}

function evaluateInvoiceResendEligibility(invoice, paidFacts) {
  if (!invoice || !isUuid(invoice.id)) {
    return { ok: false, reason: "not_found" };
  }
  const raw = String(invoice.status || "").trim().toLowerCase();
  if (raw === "archived") return { ok: false, reason: "archived" };
  if (raw === "void") return { ok: false, reason: "void" };
  if (raw === "cancelled" || raw === "canceled") return { ok: false, reason: "cancelled" };
  if (String(invoice.voided_at || "").trim()) return { ok: false, reason: "void" };

  const email = String(invoice.customer_email || "").trim();
  if (!email) return { ok: false, reason: "missing_email" };
  if (!isValidHubDeliveryEmail(email)) return { ok: false, reason: "missing_email" };

  if (!String(invoice.public_token || "").trim()) {
    return { ok: false, reason: "missing_public_token" };
  }

  const amount = Number(invoice.amount);
  if (!(Number.isFinite(amount) && amount > PAID_TOLERANCE)) {
    return { ok: false, reason: "ineligible_amount" };
  }

  const computed = paidFacts && typeof paidFacts.isFullyPaid === "boolean"
    ? paidFacts
    : computePaidFacts(invoice, 0);
  if (computed.isFullyPaid) return { ok: false, reason: "paid" };

  const balanceDue = Number(invoice.balance_due);
  if (Number.isFinite(balanceDue) && balanceDue <= PAID_TOLERANCE) {
    return { ok: false, reason: "paid" };
  }

  const visible = deriveOwnerVisibleInvoiceStatus(invoice, computed);
  if (visible === "archived") return { ok: false, reason: "archived" };
  if (visible === "void") return { ok: false, reason: "void" };
  if (visible === "paid") {
    return { ok: true, reason: "eligible", visible_status: visible };
  }
  if (!ALLOWED_VISIBLE_STATUSES.has(visible)) {
    return { ok: false, reason: "ineligible_status" };
  }
  return { ok: true, reason: "eligible", visible_status: visible };
}

function defaultResendGet(path, opts) {
  return supabaseRequest(path, opts || { method: "GET" });
}

async function reloadInvoiceForResend(tenantId, invoiceId, deps = {}) {
  const tid = String(tenantId || "").trim();
  const iid = String(invoiceId || "").trim();
  if (!isUuid(tid) || !isUuid(iid)) {
    return { outcome: "not_found", invoice: null, queryPath: "" };
  }
  const get = deps.supabaseGet || deps.supabaseRequest || defaultResendGet;
  if (typeof get !== "function") {
    return { outcome: "status_unverified", invoice: null, queryPath: "" };
  }
  const queryPath = buildInvoiceReloadPath(tid, iid);
  let rows;
  try {
    rows = deps.supabaseGet
      ? await deps.supabaseGet(queryPath)
      : await (deps.supabaseRequest || defaultResendGet)(queryPath, { method: "GET" });
  } catch (_err) {
    return { outcome: "status_unverified", invoice: null, queryPath };
  }
  const list = (Array.isArray(rows) ? rows : []).filter(
    (row) =>
      String(row?.tenant_id || "").trim() === tid &&
      String(row?.id || "").trim().toLowerCase() === iid.toLowerCase()
  );
  if (list.length === 0) return { outcome: "not_found", invoice: null, queryPath };
  if (list.length > 1) return { outcome: "ambiguous", invoice: null, queryPath };

  const invoice = list[0];
  const paymentQueryPath = buildPaymentQueryPath(tid, iid);
  let payRows;
  try {
    payRows = deps.supabaseGet
      ? await deps.supabaseGet(paymentQueryPath)
      : await (deps.supabaseRequest || defaultResendGet)(paymentQueryPath, { method: "GET" });
  } catch (_err) {
    return { outcome: "status_unverified", invoice, queryPath, paymentQueryPath };
  }
  if (!Array.isArray(payRows)) {
    return { outcome: "status_unverified", invoice, queryPath, paymentQueryPath };
  }
  const paidFacts = computePaidFacts(invoice, sumScopedLedgerAmounts(payRows, tid, iid));
  const eligibility = evaluateInvoiceResendEligibility(invoice, paidFacts);
  return {
    outcome: eligibility.ok ? "ok" : eligibility.reason,
    invoice,
    paidFacts,
    eligibility,
    queryPath,
    paymentQueryPath,
  };
}

function denialMessage(reason) {
  if (reason === "missing_email") return "saved delivery email is missing";
  if (reason === "missing_public_token") return "public invoice reference is missing";
  if (reason === "invoice_state_changed") return "invoice changed after confirmation";
  if (reason === "already_claimed") {
    return "another resend is already in progress or awaiting verification";
  }
  if (reason === "expired") return "That confirmation has expired.";
  if (reason === "invalid_token") return "That confirmation is not valid.";
  if (reason === "not_found" || reason === "ambiguous") {
    return "invoice state no longer allows resend";
  }
  return "invoice state no longer allows resend";
}

module.exports = {
  INVOICE_RESEND_SELECT,
  INVOICE_RESEND_SELECT_FIELDS,
  ALLOWED_VISIBLE_STATUSES,
  isValidHubDeliveryEmail,
  buildInvoiceReloadPath,
  buildPaymentQueryPath,
  evaluateInvoiceResendEligibility,
  reloadInvoiceForResend,
  denialMessage,
};
