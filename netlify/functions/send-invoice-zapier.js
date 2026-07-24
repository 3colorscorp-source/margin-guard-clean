const fetch = globalThis.fetch;
if (!fetch) {
  throw new Error("Global fetch is not available. Set Netlify Node to 18+.");
}
const crypto = require("crypto");

const { readSessionFromEvent } = require("./_lib/session");
const { supabaseRequest } = require("./_lib/supabase-admin");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MATERIAL_COST_LABEL = "Material Cost";
const INVOICE_TYPE_UNEXPECTED_MATERIAL = "[invoice_type:unexpected_material_cost]";
const REMAINING_BALANCE_LABEL = "Remaining Balance";
const SOURCE_INVOICE_MARKER_RE =
  /\[source_invoice:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\]/i;

function isMaterialCostInvoice(invoice) {
  const label = String(invoice?.invoice_label || "").trim();
  if (label.toLowerCase() === MATERIAL_COST_LABEL.toLowerCase()) return true;
  return String(invoice?.notes || "").includes(INVOICE_TYPE_UNEXPECTED_MATERIAL);
}

function isRemainingBalanceInvoice(invoice) {
  if (isMaterialCostInvoice(invoice)) return false;
  const label = String(invoice?.invoice_label || "").trim();
  if (label.toLowerCase() === REMAINING_BALANCE_LABEL.toLowerCase()) return true;
  const notes = String(invoice?.notes || "");
  if (!SOURCE_INVOICE_MARKER_RE.test(notes)) return false;
  if (notes.includes(INVOICE_TYPE_UNEXPECTED_MATERIAL)) return false;
  return true;
}

function buildRemainingBalanceEmailCopy({
  customerName,
  projectName,
  publicUrl,
  projectContractTotal,
  projectPaidToDate,
  remainingProjectBalance,
  invoiceAmount,
  invoiceBalanceDue,
  businessName
}) {
  const subject = `Remaining balance invoice ready — ${projectName}`;
  const body = [
    `Hi ${customerName},`,
    "",
    "I hope you're doing well.",
    "",
    `A remaining balance invoice for the ${projectName} project is ready. This invoice reflects the balance currently due after payments already recorded on this project.`,
    "",
    "You can view it here:",
    "",
    publicUrl,
    "",
    "Here's a quick summary:",
    `• Invoice type: Remaining Balance`,
    `• This invoice amount: ${invoiceAmount}`,
    `• Amount due on this invoice: ${invoiceBalanceDue}`,
    "",
    "Project payment summary:",
    `• Project contract total: ${projectContractTotal}`,
    `• Project paid to date: ${projectPaidToDate}`,
    `• Remaining project balance: ${remainingProjectBalance}`,
    "",
    "If anything isn’t clear or you’d like to go over the details, I’m happy to help.",
    "",
    "Thank you again — I truly appreciate the opportunity to work on your project.",
    "",
    `— ${businessName}`
  ].join("\n");
  return { subject, body };
}

function buildMaterialCostEmailCopy({
  customerName,
  projectName,
  publicUrl,
  invoiceAmount,
  paidAmount,
  balanceDue,
  businessName
}) {
  const subject = `Material cost invoice ready — ${projectName}`;
  const body = [
    `Hi ${customerName},`,
    "",
    "I hope you're doing well.",
    "",
    `A material cost invoice for the ${projectName} project is ready. This invoice covers additional materials connected to this project.`,
    "",
    "You can view it here:",
    "",
    publicUrl,
    "",
    "Here's a quick summary:",
    `• Material cost invoice: ${invoiceAmount}`,
    `• Paid to date on this invoice: ${paidAmount}`,
    `• Amount due on this invoice: ${balanceDue}`,
    "",
    "If anything isn’t clear or you’d like to go over the details, I’m happy to help.",
    "",
    "Thank you again — I truly appreciate the opportunity to work on your project.",
    "",
    `— ${businessName}`
  ].join("\n");
  return { subject, body };
}

function isPartialBalanceDueInvoice(invoice, body) {
  if (isMaterialCostInvoice(invoice)) return false;
  if (isRemainingBalanceInvoice(invoice)) return false;
  const paid = toNumber(pickFirstStr(body?.paid_to_date, body?.paidAmount, invoice.paid_amount), 0);
  const balanceDue = toNumber(
    pickFirstStr(body?.invoice_balance_due, body?.balance_due, body?.remaining_balance, invoice.balance_due),
    0
  );
  const invoiceAmount = toNumber(pickFirstStr(body?.invoice_amount, invoice.amount), 0);
  const contractTotal = toNumber(
    pickFirstStr(body?.contract_total, body?.project_contract_total, invoice.amount),
    invoiceAmount
  );
  if (paid <= 0.005) return false;
  if (balanceDue <= 0.005) return false;
  const totalRef = Math.max(contractTotal, invoiceAmount);
  if (totalRef <= balanceDue + 0.005) return false;
  return true;
}

function buildPartialBalanceDueEmailCopy({
  customerName,
  projectName,
  publicUrl,
  contractOrInvoiceTotal,
  paidToDate,
  balanceDue,
  businessName
}) {
  const subject = `Invoice balance ready — ${projectName}`;
  const body = [
    `Hi ${customerName},`,
    "",
    "I hope you're doing well.",
    "",
    `Your invoice for the ${projectName} project has a remaining balance due. Payments already recorded on this invoice are reflected below.`,
    "",
    "You can view it here:",
    "",
    publicUrl,
    "",
    "Here's a quick summary:",
    `• Amount due on this invoice: ${balanceDue}`,
    "",
    "Payment summary:",
    `• Invoice total: ${contractOrInvoiceTotal}`,
    `• Paid to date: ${paidToDate}`,
    `• Remaining balance: ${balanceDue}`,
    "",
    "If anything isn’t clear or you’d like to go over the details, I’m happy to help.",
    "",
    "Thank you again — I truly appreciate the opportunity to work on your project.",
    "",
    `— ${businessName}`
  ].join("\n");
  return { subject, body };
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}

/** Structured error for Invoice Hub; `error` mirrors `message` for older clients. */
function jsonError(statusCode, reason, message, extra = {}) {
  const msg = String(message || "").trim() || String(reason || "").replace(/_/g, " ");
  return json(statusCode, {
    ok: false,
    reason: String(reason || "error"),
    message: msg,
    error: msg,
    ...extra
  });
}

function originFromEvent(event) {
  const host = String(event?.headers?.host || event?.headers?.["x-forwarded-host"] || "").split(",")[0].trim();
  if (!host) {
    const u = String(process.env.URL || process.env.DEPLOY_PRIME_URL || "").trim().replace(/\/+$/, "");
    return u;
  }
  const proto = String(event?.headers?.["x-forwarded-proto"] || "https")
    .split(",")[0]
    .trim()
    .replace(/:$/, "");
  return `${proto || "https"}://${host}`.replace(/\/+$/, "");
}

function pickFirstStr(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  return "";
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function formatMoney(value, currency) {
  const cur = String(currency || "USD").trim() || "USD";
  const n = toNumber(value, 0);
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: cur }).format(n);
  } catch (_err) {
    return `$${n.toFixed(2)}`;
  }
}

async function loadQuoteTotal(tenantId, quoteId) {
  if (!tenantId || !quoteId) return 0;
  try {
    const rows = await supabaseRequest(
      `quotes?id=eq.${encodeURIComponent(quoteId)}&tenant_id=eq.${encodeURIComponent(tenantId)}&select=total&limit=1`,
      { method: "GET" }
    );
    const row = Array.isArray(rows) ? rows[0] : null;
    const n = Number(row?.total);
    return Number.isFinite(n) ? Math.max(n, 0) : 0;
  } catch (_err) {
    return 0;
  }
}

async function loadProjectTotal(tenantId, projectId) {
  if (!tenantId || !projectId) return 0;
  try {
    const rows = await supabaseRequest(
      `tenant_projects?id=eq.${encodeURIComponent(projectId)}&tenant_id=eq.${encodeURIComponent(tenantId)}&select=sale_price&limit=1`,
      { method: "GET" }
    );
    const row = Array.isArray(rows) ? rows[0] : null;
    const n = Number(row?.sale_price);
    return Number.isFinite(n) ? Math.max(n, 0) : 0;
  } catch (_err) {
    return 0;
  }
}

async function loadProjectPaidToDate(tenantId, projectId, quoteId) {
  if (!tenantId) return 0;
  const params = new URLSearchParams();
  params.set("tenant_id", `eq.${tenantId}`);
  params.set("select", "amount");
  params.set("limit", "500");
  if (projectId) params.set("project_id", `eq.${projectId}`);
  else if (quoteId) params.set("quote_id", `eq.${quoteId}`);
  else return 0;
  try {
    const rows = await supabaseRequest(`tenant_project_payments?${params.toString()}`, { method: "GET" });
    const list = Array.isArray(rows) ? rows : [];
    return list.reduce((sum, row) => {
      const n = Number(row?.amount);
      return sum + (Number.isFinite(n) ? n : 0);
    }, 0);
  } catch (_err) {
    return 0;
  }
}

function roundMoney(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function positiveMoney(...values) {
  for (const value of values) {
    const n = toNumber(value, NaN);
    if (Number.isFinite(n) && n > 0.005) return roundMoney(n);
  }
  return null;
}

function nonNegativeMoney(...values) {
  for (const value of values) {
    if (value === undefined || value === null || String(value).trim() === "") continue;
    const n = toNumber(value, NaN);
    if (Number.isFinite(n) && n >= -0.005) return Math.max(roundMoney(n), 0);
  }
  return null;
}

/**
 * Server-authoritative Remaining Balance amounts (aligned with public invoice truth).
 * Body hints may raise values; they must not zero-out real project ledger figures.
 */
async function resolveRemainingBalanceEmailContext(invoice, body) {
  const tenantId = String(invoice.tenant_id || "").trim();
  const projectId = String(invoice.project_id || pickFirstStr(body.project_id, body.projectId) || "").trim();
  const quoteId = String(invoice.quote_id || pickFirstStr(body.quote_id, body.quoteId) || "").trim();
  const quoteTotal = await loadQuoteTotal(tenantId, quoteId);
  const projectTotal = await loadProjectTotal(tenantId, projectId);
  const dbPaid = Math.max(await loadProjectPaidToDate(tenantId, projectId, quoteId), 0);

  const projectContractTotal =
    positiveMoney(body.project_contract_total, body.contract_total) ??
    (quoteTotal > 0 ? roundMoney(quoteTotal) : null) ??
    (projectTotal > 0 ? roundMoney(projectTotal) : null) ??
    Math.max(roundMoney(toNumber(invoice.amount, 0)), 0);

  const bodyProjectPaid = nonNegativeMoney(body.project_paid_to_date);
  const bodyPaidHint = positiveMoney(body.paid_to_date, body.paidAmount);
  let projectPaidToDate = dbPaid;
  if (bodyProjectPaid != null) {
    // Explicit project_paid_to_date: accept, but never replace a positive DB total with 0.
    if (bodyProjectPaid > 0.005 || dbPaid <= 0.005) projectPaidToDate = bodyProjectPaid;
  } else if (bodyPaidHint != null && bodyPaidHint > dbPaid) {
    projectPaidToDate = bodyPaidHint;
  }
  projectPaidToDate = Math.max(roundMoney(projectPaidToDate), 0);

  const invoiceAmount =
    positiveMoney(body.invoice_amount, body.amount, invoice.amount) ??
    Math.max(roundMoney(toNumber(invoice.amount, 0)), 0);

  // Do not use body.remaining_balance here — that field is ambiguous (project vs invoice).
  const invoiceBalanceDue =
    positiveMoney(body.invoice_balance_due, body.balance_due, invoice.balance_due) ??
    invoiceAmount;

  // Public-page safety: if project paid looks missing but invoice is a partial remainder, derive paid.
  if (projectContractTotal > invoiceAmount + 0.005 && projectPaidToDate <= 0.005) {
    projectPaidToDate = roundMoney(projectContractTotal - invoiceAmount);
  }

  const bodyRemaining = nonNegativeMoney(body.remaining_project_balance);
  let remainingProjectBalance = Math.max(roundMoney(projectContractTotal - projectPaidToDate), 0);
  if (bodyRemaining != null && bodyRemaining > 0.005) {
    remainingProjectBalance = bodyRemaining;
  }
  if (remainingProjectBalance <= 0.005 && invoiceBalanceDue > 0.005) {
    remainingProjectBalance = invoiceBalanceDue;
  }
  // If paid still looks missing, prefer this invoice's due over a full-contract "remaining".
  if (
    invoiceBalanceDue > 0.005 &&
    projectContractTotal > invoiceBalanceDue + 0.005 &&
    Math.abs(remainingProjectBalance - projectContractTotal) < 0.02
  ) {
    remainingProjectBalance = invoiceBalanceDue;
  }

  return {
    projectContractTotal: roundMoney(projectContractTotal),
    projectPaidToDate: roundMoney(projectPaidToDate),
    remainingProjectBalance: roundMoney(remainingProjectBalance),
    invoiceAmount: roundMoney(invoiceAmount),
    invoiceBalanceDue: roundMoney(invoiceBalanceDue)
  };
}

function buildStandardEmailCopy({
  customerName,
  projectName,
  publicUrl,
  contractTotal,
  paidToDate,
  balanceDue,
  businessName
}) {
  const subject = `Invoice ready — ${projectName}`;
  const body = [
    `Hi ${customerName},`,
    "",
    "I hope you're doing well.",
    "",
    `Your invoice for the ${projectName} project is ready.`,
    "",
    "You can view it here:",
    "",
    publicUrl,
    "",
    "Here's a quick summary:",
    `• Contract total: ${contractTotal}`,
    `• Paid to date: ${paidToDate}`,
    `• Remaining balance: ${balanceDue}`,
    "",
    "If anything isn’t clear or you’d like to go over the details, I’m happy to help.",
    "",
    "Thank you again — I truly appreciate the opportunity to work on your project.",
    "",
    `— ${businessName}`
  ].join("\n");
  return { subject, body };
}

function emailBodyToHtml(bodyText) {
  const esc = String(bodyText || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;white-space:pre-wrap;">${esc}</div>`;
}

function moneyLooksZero(value) {
  if (value === undefined || value === null) return true;
  if (typeof value === "number") return !(value > 0.005);
  const s = String(value).trim();
  if (!s) return true;
  const n = Number(String(s).replace(/[^0-9.-]/g, ""));
  if (!Number.isFinite(n)) return /\$0(\.00)?\b/.test(s);
  return !(n > 0.005);
}

function bodyHasFakeZeroSummary(emailBody, requiredFormattedAmounts) {
  const body = String(emailBody || "");
  for (const formatted of requiredFormattedAmounts) {
    if (!formatted) continue;
    if (!body.includes(String(formatted))) return true;
  }
  // Block classic misleading all-zero summary blocks when real amounts were expected.
  const zeroHits = (body.match(/\$0\.00/g) || []).length;
  if (zeroHits >= 3 && requiredFormattedAmounts.some((a) => a && !String(a).includes("$0.00"))) {
    return true;
  }
  return false;
}

/**
 * Canonical invoice email object — Margin Guard is source of truth for subject/body.
 */
function buildCanonicalInvoiceEmail({
  invoice_copy_variant,
  customerName,
  projectName,
  publicUrl,
  businessName,
  currency,
  nums
}) {
  const fmt = (n) => formatMoney(n, currency);
  const brand = businessName || "Three Colors Corp";

  if (invoice_copy_variant === "material_cost") {
    const invoice_amount = roundMoney(nums.invoice_amount);
    const paid_to_date = roundMoney(nums.paid_to_date);
    const balance_due = roundMoney(nums.balance_due);
    const invoiceAmountF = fmt(invoice_amount);
    const paidF = fmt(paid_to_date);
    const dueF = fmt(balance_due);
    const emailCopy = buildMaterialCostEmailCopy({
      customerName,
      projectName,
      publicUrl,
      invoiceAmount: invoiceAmountF,
      paidAmount: paidF,
      balanceDue: dueF,
      businessName: brand
    });
    return {
      invoice_copy_variant,
      email_subject: emailCopy.subject,
      email_body: emailCopy.body,
      email_html: emailBodyToHtml(emailCopy.body),
      invoice_amount,
      balance_due,
      amount_due_on_this_invoice: balance_due,
      paid_to_date,
      contract_total: invoice_amount,
      project_contract_total: invoice_amount,
      project_paid_to_date: paid_to_date,
      remaining_project_balance: balance_due,
      remaining_balance: balance_due,
      amount: invoice_amount,
      summary_line_1_label: "Material cost invoice",
      summary_line_1_value: invoiceAmountF,
      summary_line_2_label: "Paid to date on this invoice",
      summary_line_2_value: paidF,
      summary_line_3_label: "Amount due on this invoice",
      summary_line_3_value: dueF
    };
  }

  if (invoice_copy_variant === "remaining_balance") {
    const invoice_amount = roundMoney(nums.invoice_amount);
    const balance_due = roundMoney(nums.balance_due);
    const project_contract_total = roundMoney(nums.project_contract_total);
    const project_paid_to_date = roundMoney(nums.project_paid_to_date);
    const remaining_project_balance = roundMoney(nums.remaining_project_balance);
    const invoiceAmountF = fmt(invoice_amount);
    const dueF = fmt(balance_due);
    const contractF = fmt(project_contract_total);
    const paidF = fmt(project_paid_to_date);
    const remainingF = fmt(remaining_project_balance);
    const emailCopy = buildRemainingBalanceEmailCopy({
      customerName,
      projectName,
      publicUrl,
      projectContractTotal: contractF,
      projectPaidToDate: paidF,
      remainingProjectBalance: remainingF,
      invoiceAmount: invoiceAmountF,
      invoiceBalanceDue: dueF,
      businessName: brand
    });
    return {
      invoice_copy_variant,
      email_subject: emailCopy.subject,
      email_body: emailCopy.body,
      email_html: emailBodyToHtml(emailCopy.body),
      invoice_amount,
      balance_due,
      amount_due_on_this_invoice: balance_due,
      paid_to_date: project_paid_to_date,
      contract_total: project_contract_total,
      project_contract_total,
      project_paid_to_date,
      remaining_project_balance,
      remaining_balance: remaining_project_balance,
      amount: invoice_amount,
      summary_line_1_label: "Invoice type",
      summary_line_1_value: "Remaining Balance",
      summary_line_2_label: "This invoice amount",
      summary_line_2_value: invoiceAmountF,
      summary_line_3_label: "Amount due on this invoice",
      summary_line_3_value: dueF,
      summary_line_4_label: "Project contract total",
      summary_line_4_value: contractF,
      summary_line_5_label: "Project paid to date",
      summary_line_5_value: paidF,
      summary_line_6_label: "Remaining project balance",
      summary_line_6_value: remainingF
    };
  }

  if (invoice_copy_variant === "partial_balance_due") {
    const invoice_amount = roundMoney(nums.invoice_amount);
    const paid_to_date = roundMoney(nums.paid_to_date);
    const balance_due = roundMoney(nums.balance_due);
    const contract_total = roundMoney(nums.contract_total || invoice_amount);
    const contractF = fmt(contract_total);
    const paidF = fmt(paid_to_date);
    const dueF = fmt(balance_due);
    const emailCopy = buildPartialBalanceDueEmailCopy({
      customerName,
      projectName,
      publicUrl,
      contractOrInvoiceTotal: contractF,
      paidToDate: paidF,
      balanceDue: dueF,
      businessName: brand
    });
    return {
      invoice_copy_variant,
      email_subject: emailCopy.subject,
      email_body: emailCopy.body,
      email_html: emailBodyToHtml(emailCopy.body),
      invoice_amount,
      balance_due,
      amount_due_on_this_invoice: balance_due,
      paid_to_date,
      contract_total,
      project_contract_total: contract_total,
      project_paid_to_date: paid_to_date,
      remaining_project_balance: balance_due,
      remaining_balance: balance_due,
      amount: balance_due,
      summary_line_1_label: "Amount due on this invoice",
      summary_line_1_value: dueF,
      summary_line_2_label: "Invoice total",
      summary_line_2_value: contractF,
      summary_line_3_label: "Paid to date",
      summary_line_3_value: paidF,
      summary_line_4_label: "Remaining balance",
      summary_line_4_value: dueF
    };
  }

  // standard
  const invoice_amount = roundMoney(nums.invoice_amount);
  const paid_to_date = roundMoney(nums.paid_to_date);
  const balance_due = roundMoney(nums.balance_due);
  const contract_total = roundMoney(nums.contract_total || invoice_amount);
  const contractF = fmt(contract_total);
  const paidF = fmt(paid_to_date);
  const dueF = fmt(balance_due);
  const emailCopy = buildStandardEmailCopy({
    customerName,
    projectName,
    publicUrl,
    contractTotal: contractF,
    paidToDate: paidF,
    balanceDue: dueF,
    businessName: brand
  });
  return {
    invoice_copy_variant: "standard",
    email_subject: emailCopy.subject,
    email_body: emailCopy.body,
    email_html: emailBodyToHtml(emailCopy.body),
    invoice_amount,
    balance_due,
    amount_due_on_this_invoice: balance_due,
    paid_to_date,
    contract_total,
    project_contract_total: contract_total,
    project_paid_to_date: paid_to_date,
    remaining_project_balance: balance_due,
    remaining_balance: balance_due,
    amount: contract_total,
    summary_line_1_label: "Contract total",
    summary_line_1_value: contractF,
    summary_line_2_label: "Paid to date",
    summary_line_2_value: paidF,
    summary_line_3_label: "Remaining balance",
    summary_line_3_value: dueF
  };
}

function validateCanonicalInvoiceEmail(canonical) {
  const variant = String(canonical?.invoice_copy_variant || "");
  const fail = (detail) => ({
    ok: false,
    detail: String(detail || ""),
    message: "Invoice email payload is missing required balance values. Email was not sent."
  });

  if (!canonical?.email_subject || !canonical?.email_body) {
    return fail("missing_email_copy");
  }

  if (variant === "remaining_balance") {
    if (!(canonical.invoice_amount > 0.005)) return fail("remaining_balance_invoice_amount");
    if (!(canonical.balance_due > 0.005)) return fail("remaining_balance_balance_due");
    if (!(canonical.amount_due_on_this_invoice > 0.005)) return fail("remaining_balance_amount_due");
    if (!(canonical.project_contract_total > 0.005)) return fail("remaining_balance_project_contract_total");
    if (!(canonical.project_paid_to_date >= -0.005)) return fail("remaining_balance_project_paid_to_date");
    if (!(canonical.contract_total > 0.005)) return fail("remaining_balance_contract_total");
    if (!(canonical.remaining_balance > 0.005)) return fail("remaining_balance_remaining_balance");
    if (moneyLooksZero(canonical.paid_to_date) && canonical.project_paid_to_date > 0.005) {
      return fail("remaining_balance_legacy_paid_zero");
    }
    const invoiceAmountF = formatMoney(canonical.invoice_amount);
    const dueF = formatMoney(canonical.amount_due_on_this_invoice);
    if (
      bodyHasFakeZeroSummary(canonical.email_body, [invoiceAmountF, dueF]) ||
      !String(canonical.email_body).includes(invoiceAmountF) ||
      !String(canonical.email_body).includes(dueF)
    ) {
      return fail("remaining_balance_email_body_amounts");
    }
    return { ok: true };
  }

  if (variant === "material_cost") {
    if (!(canonical.invoice_amount > 0.005)) return fail("material_cost_invoice_amount");
    if (!(canonical.balance_due > 0.005) && !(canonical.amount_due_on_this_invoice > 0.005)) {
      return fail("material_cost_amount_due");
    }
    const invoiceAmountF = formatMoney(canonical.invoice_amount);
    if (!String(canonical.email_body).includes(invoiceAmountF)) {
      return fail("material_cost_email_body_amount");
    }
    return { ok: true };
  }

  if (variant === "partial_balance_due") {
    if (!(canonical.paid_to_date > 0.005)) return fail("partial_paid_to_date");
    if (!(canonical.balance_due > 0.005)) return fail("partial_balance_due");
    if (!(canonical.invoice_amount > canonical.balance_due + 0.005) && !(canonical.contract_total > canonical.balance_due + 0.005)) {
      return fail("partial_total_vs_balance");
    }
    return { ok: true };
  }

  // standard: allow legitimate $0 paid_to_date, but block all-main-amounts-zero unless invoice is truly zero
  const mains = [
    canonical.invoice_amount,
    canonical.contract_total,
    canonical.balance_due,
    canonical.amount_due_on_this_invoice
  ];
  const anyPositive = mains.some((n) => Number(n) > 0.005);
  const allZero = mains.every((n) => !(Number(n) > 0.005));
  if (allZero && !(Number(canonical.invoice_amount) === 0 && Number(canonical.contract_total) === 0)) {
    return fail("standard_all_zero");
  }
  if (!anyPositive && Number(canonical.invoice_amount) > 0.005) {
    return fail("standard_inconsistent_zeros");
  }
  return { ok: true };
}

function applyCanonicalToZapierPayload(basePayload, canonical) {
  const moneyFields = {
    invoice_amount: canonical.invoice_amount,
    balance_due: canonical.balance_due,
    amount_due_on_this_invoice: canonical.amount_due_on_this_invoice,
    paid_to_date: canonical.paid_to_date,
    contract_total: canonical.contract_total,
    project_contract_total: canonical.project_contract_total,
    project_paid_to_date: canonical.project_paid_to_date,
    remaining_project_balance: canonical.remaining_project_balance,
    remaining_balance: canonical.remaining_balance,
    amount: canonical.amount
  };

  const titleCase = {
    "Email Subject": canonical.email_subject,
    "Email Body": canonical.email_body,
    "Email Html": canonical.email_html,
    "Invoice Copy Variant": canonical.invoice_copy_variant,
    "Invoice Amount": canonical.invoice_amount,
    "Balance Due": canonical.balance_due,
    "Amount Due On This Invoice": canonical.amount_due_on_this_invoice,
    "Paid To Date": canonical.paid_to_date,
    "Contract Total": canonical.contract_total,
    "Project Contract Total": canonical.project_contract_total,
    "Project Paid To Date": canonical.project_paid_to_date,
    "Remaining Project Balance": canonical.remaining_project_balance,
    "Remaining Balance": canonical.remaining_balance
  };

  return {
    ...basePayload,
    ...moneyFields,
    invoice_copy_variant: canonical.invoice_copy_variant,
    email_subject: canonical.email_subject,
    email_body: canonical.email_body,
    email_html: canonical.email_html,
    summary_line_1_label: canonical.summary_line_1_label,
    summary_line_1_value: canonical.summary_line_1_value,
    summary_line_2_label: canonical.summary_line_2_label,
    summary_line_2_value: canonical.summary_line_2_value,
    summary_line_3_label: canonical.summary_line_3_label,
    summary_line_3_value: canonical.summary_line_3_value,
    summary_line_4_label: canonical.summary_line_4_label,
    summary_line_4_value: canonical.summary_line_4_value,
    summary_line_5_label: canonical.summary_line_5_label,
    summary_line_5_value: canonical.summary_line_5_value,
    summary_line_6_label: canonical.summary_line_6_label,
    summary_line_6_value: canonical.summary_line_6_value,
    ...titleCase
  };
}

function buildZapierSignatureMeta(payload) {
  console.log("[zapier-signature] building signature...");
  const secret = String(process.env.ZAPIER_WEBHOOK_SECRET || "").trim();
  if (!secret) {
    console.log("[zapier-signature] secret missing; sending unsigned");
    return null;
  }
  const timestamp = new Date().toISOString();
  const nonce = crypto.randomBytes(16).toString("hex");
  const canonical = `${timestamp}.${nonce}.${JSON.stringify(payload)}`;
  const signature = crypto
    .createHmac("sha256", secret)
    .update(canonical)
    .digest("hex");
  return {
    signature,
    timestamp,
    nonce,
    version: "v1"
  };
}

async function loadInvoiceForTenant(tenantId, id, publicToken) {
  const params = new URLSearchParams();
  params.set("tenant_id", `eq.${tenantId}`);
  params.set("select", "*");
  params.set("limit", "2");

  if (id) {
    if (!UUID_RE.test(id)) {
      throw new Error("Invalid id (expected UUID).");
    }
    params.set("id", `eq.${id}`);
  } else {
    if (publicToken.length < 8 || publicToken.length > 256 || !/^[a-zA-Z0-9_]+$/.test(publicToken)) {
      throw new Error("Invalid public_token.");
    }
    params.set("public_token", `eq.${publicToken}`);
  }

  const path = `invoices?${params.toString()}`;
  const rows = await supabaseRequest(path, { method: "GET" });
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) return null;
  if (list.length > 1) throw new Error("Ambiguous invoice reference.");
  const invoice = list[0];
  if (String(invoice.tenant_id || "") !== tenantId) return null;
  return invoice;
}

/** Minimal probe when tenant-scoped lookup returns empty (wrong tenant vs missing). */
async function probeInvoiceTenantRow(id, publicToken) {
  try {
    if (id && UUID_RE.test(id)) {
      const rows = await supabaseRequest(
        `invoices?id=eq.${encodeURIComponent(id)}&select=id,tenant_id&limit=1`,
        { method: "GET" }
      );
      const list = Array.isArray(rows) ? rows : [];
      return list[0] || null;
    }
    if (
      publicToken &&
      publicToken.length >= 8 &&
      publicToken.length <= 256 &&
      /^[a-zA-Z0-9_]+$/.test(publicToken)
    ) {
      const rows = await supabaseRequest(
        `invoices?public_token=eq.${encodeURIComponent(publicToken)}&select=id,tenant_id&limit=1`,
        { method: "GET" }
      );
      const list = Array.isArray(rows) ? rows : [];
      return list[0] || null;
    }
  } catch (_e) {
    return null;
  }
  return null;
}

/**
 * POST — tenant-scoped invoice send: forward to Zapier, then mark sent in Supabase.
 * Body: { id } OR { public_token } (exactly one). Never trust client tenant_id.
 */
exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "Method Not Allowed" });
    }

    console.log("[Invoice Send] starting");

    const session = readSessionFromEvent(event);
    if (!session?.e || !session?.c) {
      return json(401, { ok: false, error: "Unauthorized" });
    }

    const tenant = await resolveTenantFromSession(session);
    if (!tenant?.id) {
      return json(422, {
        ok: false,
        error: "Tenant not found for this session. Run bootstrap-tenant first."
      });
    }

    const tenantId = String(tenant.id);
    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch (_err) {
      return json(400, { ok: false, error: "Invalid JSON body" });
    }

    const id = String(pickFirstStr(body.id, body.invoice_id, body.invoiceId) || "").trim();
    const publicToken = String(pickFirstStr(body.public_token, body.publicToken) || "").trim();

    if (id && publicToken) {
      return json(400, { ok: false, error: "Provide only one of id or public_token." });
    }
    if (!id && !publicToken) {
      return json(400, { ok: false, error: "Missing id or public_token." });
    }

    let invoice;
    try {
      invoice = await loadInvoiceForTenant(tenantId, id, publicToken);
    } catch (e) {
      return json(400, { ok: false, error: e.message || "Invalid request" });
    }

    if (!invoice) {
      return json(404, { ok: false, error: "Invoice not found." });
    }

    const invoiceStatus = String(invoice.status || "")
      .trim()
      .toLowerCase();
    if (invoiceStatus === "void") {
      return jsonError(422, "invoice_void", "Cannot send a void invoice.");
    }

    const tenantRows = await supabaseRequest(
      `tenants?id=eq.${encodeURIComponent(tenantId)}&select=id,name,owner_email`
    );
    const tenantRow = Array.isArray(tenantRows) ? tenantRows[0] : null;

    // Webhook URL must come only from Netlify env (never hardcoded in repo).
    // Checked after dry_run so owner email previews still work without posting.
    const webhookUrl = String(process.env.ZAPIER_INVOICE_SEND_WEBHOOK_URL || "").trim();

    const token = String(invoice.public_token || "").trim();
    if (!token) {
      return jsonError(422, "missing_public_token", "Missing public token; publish or sync draft first.");
    }

    const origin = originFromEvent(event);
    const publicInvoiceUrl = origin
      ? `${origin}/invoice-public.html?token=${encodeURIComponent(token)}`
      : `/invoice-public.html?token=${encodeURIComponent(token)}`;

    const businessName = pickFirstStr(invoice.business_name, tenantRow?.name);
    const client_name = pickFirstStr(invoice.customer_name, invoice.project_name);
    const client_email = pickFirstStr(invoice.customer_email);
    const public_invoice_url = publicInvoiceUrl;
    const business_name = businessName;
    const invoice_id = String(invoice.id || "").trim();
    const quote_id = String(invoice.quote_id || "").trim();
    const project_id = String(invoice.project_id || "").trim();
    const event_type = "invoice_sent";
    const schema_version = "invoice_webhook_v1";
    const idempotency_key = `${tenantId}:${invoice_id || token}:invoice_sent`;
    const project_name = pickFirstStr(body.project_name, body.projectName, invoice.project_name);
    const isMaterialCost = isMaterialCostInvoice(invoice);
    const isRemainingBalance = !isMaterialCost && isRemainingBalanceInvoice(invoice);
    const isPartialBalanceDue =
      !isMaterialCost && !isRemainingBalance && isPartialBalanceDueInvoice(invoice, body);

    const invoiceAmountNum =
      positiveMoney(body.invoice_amount, body.amount, invoice.amount) ??
      Math.max(roundMoney(toNumber(invoice.amount, 0)), 0);
    const paidOnInvoiceNum =
      nonNegativeMoney(body.paid_to_date, body.paidAmount, invoice.paid_amount) ?? 0;
    const balanceOnInvoiceNum =
      positiveMoney(body.invoice_balance_due, body.balance_due, body.remaining_balance, invoice.balance_due) ??
      Math.max(roundMoney(invoiceAmountNum - paidOnInvoiceNum), 0);
    const contractOrInvoiceTotalNum =
      positiveMoney(body.contract_total, body.project_contract_total, body.invoice_amount, invoice.amount) ??
      invoiceAmountNum;

    let invoice_copy_variant = "standard";
    let canonicalNums = {
      invoice_amount: invoiceAmountNum,
      paid_to_date: paidOnInvoiceNum,
      balance_due: balanceOnInvoiceNum,
      contract_total: contractOrInvoiceTotalNum,
      project_contract_total: contractOrInvoiceTotalNum,
      project_paid_to_date: paidOnInvoiceNum,
      remaining_project_balance: balanceOnInvoiceNum
    };

    if (isMaterialCost) {
      invoice_copy_variant = "material_cost";
    } else if (isRemainingBalance) {
      invoice_copy_variant = "remaining_balance";
      const remainingBalanceContext = await resolveRemainingBalanceEmailContext(invoice, body);
      canonicalNums = {
        invoice_amount: remainingBalanceContext.invoiceAmount,
        paid_to_date: remainingBalanceContext.projectPaidToDate,
        balance_due: remainingBalanceContext.invoiceBalanceDue,
        contract_total: remainingBalanceContext.projectContractTotal,
        project_contract_total: remainingBalanceContext.projectContractTotal,
        project_paid_to_date: remainingBalanceContext.projectPaidToDate,
        remaining_project_balance: remainingBalanceContext.remainingProjectBalance
      };
    } else if (isPartialBalanceDue) {
      invoice_copy_variant = "partial_balance_due";
    }

    const canonical = buildCanonicalInvoiceEmail({
      invoice_copy_variant,
      customerName: client_name,
      projectName: project_name,
      publicUrl: public_invoice_url,
      businessName: business_name,
      currency: invoice.currency,
      nums: canonicalNums
    });

    const validation = validateCanonicalInvoiceEmail(canonical);
    if (!validation.ok) {
      console.warn("[Invoice Send] email payload validation failed", {
        invoice_id,
        invoice_copy_variant,
        detail: validation.detail,
        canonical: {
          invoice_amount: canonical.invoice_amount,
          balance_due: canonical.balance_due,
          contract_total: canonical.contract_total,
          paid_to_date: canonical.paid_to_date,
          project_contract_total: canonical.project_contract_total,
          project_paid_to_date: canonical.project_paid_to_date,
          remaining_project_balance: canonical.remaining_project_balance
        }
      });
      return jsonError(422, "invalid_email_payload", validation.message, {
        detail: validation.detail,
        invoice_copy_variant
      });
    }

    /** Zapier Catch Hook: snake_case + Title Case aliases. MG owns subject/body. */
    const basePayload = {
      client_name,
      client_email,
      "Client Email": client_email,
      public_invoice_url,
      "Public Invoice Url": public_invoice_url,
      business_name,
      project_name,
      invoice_label: pickFirstStr(invoice.invoice_label),
      tenant_id: tenantId,
      invoice_id,
      quote_id,
      project_id,
      event_type,
      schema_version,
      idempotency_key
    };
    const payload = applyCanonicalToZapierPayload(basePayload, canonical);

    const wantsDryRun = !!(body.dry_run || body.email_preview || body.debug_preview);
    if (wantsDryRun) {
      const sessionEmail = String(session.e || "")
        .trim()
        .toLowerCase();
      const ownerEmail = String(tenantRow?.owner_email || "")
        .trim()
        .toLowerCase();
      if (!ownerEmail || sessionEmail !== ownerEmail) {
        return jsonError(403, "dry_run_owner_only", "Email preview is limited to the tenant owner.");
      }
      console.log("[Invoice Send] dry_run preview — Zapier not called", {
        invoice_id,
        invoice_copy_variant: canonical.invoice_copy_variant
      });
      return json(200, {
        ok: true,
        dry_run: true,
        forwarded: false,
        validation: { ok: true },
        canonical,
        payload
      });
    }

    // Webhook required only for real sends (dry_run already returned above).
    if (!webhookUrl || /TU_WEBHOOK_URL_AQUI/i.test(webhookUrl)) {
      return jsonError(
        503,
        "webhook_not_configured",
        "Zapier invoice webhook is not configured. Set Netlify environment variable ZAPIER_INVOICE_SEND_WEBHOOK_URL to your real Zapier Catch Hook URL (https://hooks.zapier.com/...). Do not use an empty value or the placeholder text."
      );
    }

    console.log("[zapier-signature] running...");
    console.log(
      "[zapier-signature] secret exists:",
      !!process.env.ZAPIER_WEBHOOK_SECRET
    );
    const signatureMeta = buildZapierSignatureMeta(payload);
    console.log("[zapier-signature] signature generated:", !!signatureMeta?.signature);
    if (signatureMeta) {
      payload.zapier_signature = signatureMeta.signature;
      payload.zapier_timestamp = signatureMeta.timestamp;
      payload.zapier_nonce = signatureMeta.nonce;
      payload.zapier_signature_version = signatureMeta.version;
    }
    console.log("[send-invoice-zapier] payload fields", {
      project_name,
      invoice_copy_variant: canonical.invoice_copy_variant,
      amount: payload.amount,
      paid_to_date: payload.paid_to_date,
      balance_due: payload.balance_due,
      contract_total: payload.contract_total,
      remaining_balance: payload.remaining_balance,
      email_subject: payload.email_subject
    });

    console.log("[zapier-invoice]", {
      tenant_id: tenantId,
      invoice_id,
      event_type,
      idempotency_key
    });

    let zapRes;
    try {
      const headers = { "Content-Type": "application/json", Accept: "application/json" };
      if (signatureMeta) {
        headers["X-MG-Signature"] = signatureMeta.signature;
        headers["X-MG-Timestamp"] = signatureMeta.timestamp;
        headers["X-MG-Nonce"] = signatureMeta.nonce;
        headers["X-MG-Signature-Version"] = signatureMeta.version;
      }
      zapRes = await fetch(webhookUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(payload)
      });
    } catch (error) {
      console.warn("[Invoice Send] Zapier request failed", error?.message || error);
      return jsonError(502, "webhook_unreachable", "Unable to reach invoice send webhook.");
    }

    if (!zapRes.ok) {
      const zapierText = await zapRes.text().catch(() => "");
      console.warn("[Invoice Send] Zapier non-OK", zapRes.status, zapierText.slice(0, 500));
      return jsonError(502, "zapier_error", "Zapier webhook returned an error", {
        status: zapRes.status,
        details: zapierText.slice(0, 500)
      });
    }

    console.log("[Invoice Send] Zapier completed");

    const sentAt = new Date().toISOString();
    const filter = `id=eq.${encodeURIComponent(String(invoice.id))}&tenant_id=eq.${encodeURIComponent(tenantId)}`;
    const patchPath = `invoices?${filter}`;
    let updated;
    try {
      updated = await supabaseRequest(patchPath, {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: { sent_at: sentAt, updated_at: sentAt, status: "issued" }
      });
    } catch (patchErr) {
      const msg = String(patchErr?.message || patchErr || "");
      const status = patchErr?.status;
      const isLikelyStatusCheck =
        status === 400 || /check constraint|invoices_status_check|violates check/i.test(msg);
      if (!isLikelyStatusCheck) throw patchErr;
      console.warn("[Invoice Send] status issued not accepted, patching sent_at only", msg.slice(0, 400));
      updated = await supabaseRequest(patchPath, {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: { sent_at: sentAt, updated_at: sentAt }
      });
    }
    const rows = Array.isArray(updated) ? updated : updated ? [updated] : [];
    const row = rows[0];
    if (!row?.id) {
      return jsonError(
        500,
        "database_update_failed",
        "Invoice was forwarded but could not be updated in the database."
      );
    }

    console.log("[Invoice Send] invoice marked sent");

    return json(200, { ok: true, forwarded: true, invoice: row });
  } catch (error) {
    console.warn("[Invoice Send] error", error?.message || error);
    return jsonError(500, "server_error", error.message || "Server error");
  }
};
