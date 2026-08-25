/**
 * Support-only canonical invoice email. Empty-body / server-row reconstruction.
 * Does not import or wrap send-invoice-zapier.js. Never accepts client amount hints.
 */
"use strict";

const MATERIAL_COST_LABEL = "Material Cost";
const INVOICE_TYPE_UNEXPECTED_MATERIAL = "[invoice_type:unexpected_material_cost]";
const SOURCE_INVOICE_MARKER_RE =
  /\[source_invoice:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\]/i;

const PROJECT_PAYMENT_LABELS = [
  "Start Payment",
  "Progress Payment",
  "Final Payment",
  "Remaining Balance",
  "Change Order",
];
const PROJECT_PAYMENT_LABEL_SET = new Set(PROJECT_PAYMENT_LABELS.map((s) => s.toLowerCase()));
const FULL_REMAINING_LABEL_SET = new Set(["remaining balance", "final payment"]);

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

function roundMoney(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
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

function normalizeProjectPaymentLabel(raw) {
  const s = String(raw || "").trim();
  if (!s) return "Progress Payment";
  const hit = PROJECT_PAYMENT_LABELS.find((l) => l.toLowerCase() === s.toLowerCase());
  return hit || s;
}

function isMaterialCostInvoice(invoice) {
  const label = String(invoice?.invoice_label || "").trim();
  if (label.toLowerCase() === MATERIAL_COST_LABEL.toLowerCase()) return true;
  return String(invoice?.notes || "").includes(INVOICE_TYPE_UNEXPECTED_MATERIAL);
}

function isProjectPaymentInvoice(invoice) {
  if (isMaterialCostInvoice(invoice)) return false;
  const label = String(invoice?.invoice_label || "").trim().toLowerCase();
  if (PROJECT_PAYMENT_LABEL_SET.has(label)) return true;
  const notes = String(invoice?.notes || "");
  if (!SOURCE_INVOICE_MARKER_RE.test(notes)) return false;
  if (notes.includes(INVOICE_TYPE_UNEXPECTED_MATERIAL)) return false;
  return true;
}

function isFullRemainingStageLabel(label) {
  return FULL_REMAINING_LABEL_SET.has(String(label || "").trim().toLowerCase());
}

function isPartialBalanceDueInvoice(invoice) {
  if (isMaterialCostInvoice(invoice)) return false;
  if (isProjectPaymentInvoice(invoice)) return false;
  const paid = toNumber(invoice?.paid_amount, 0);
  const balanceDue = toNumber(invoice?.balance_due, 0);
  const invoiceAmount = toNumber(invoice?.amount, 0);
  if (paid <= 0.005) return false;
  if (balanceDue <= 0.005) return false;
  if (invoiceAmount <= balanceDue + 0.005) return false;
  return true;
}

function classifySupportInvoiceCopyVariant(invoice) {
  if (isMaterialCostInvoice(invoice)) return "material_cost";
  if (isProjectPaymentInvoice(invoice)) return "project_payment";
  if (isPartialBalanceDueInvoice(invoice)) return "partial_balance_due";
  return "standard";
}

function emailBodyToHtml(bodyText) {
  const esc = String(bodyText || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;white-space:pre-wrap;">${esc}</div>`;
}

function bodyHasFakeZeroSummary(emailBody, requiredFormattedAmounts) {
  const body = String(emailBody || "");
  for (const formatted of requiredFormattedAmounts) {
    if (!formatted) continue;
    if (!body.includes(String(formatted))) return true;
  }
  const zeroHits = (body.match(/\$0\.00/g) || []).length;
  if (zeroHits >= 3 && requiredFormattedAmounts.some((a) => a && !String(a).includes("$0.00"))) {
    return true;
  }
  return false;
}

function buildProjectPaymentEmailCopy(args) {
  const stage = normalizeProjectPaymentLabel(args.invoiceLabel);
  const subject = `${stage} invoice ready — ${args.projectName}`;
  const body = [
    `Hi ${args.customerName},`,
    "",
    "I hope you're doing well.",
    "",
    `A ${stage.toLowerCase()} invoice for the ${args.projectName} project is ready.`,
    "",
    "You can view it here:",
    "",
    args.publicUrl,
    "",
    "Here's a quick summary:",
    `• Invoice type: ${stage}`,
    `• This invoice amount: ${args.invoiceAmount}`,
    `• Amount due on this invoice: ${args.invoiceBalanceDue}`,
    "",
    "Project payment summary:",
    `• Project contract total: ${args.projectContractTotal}`,
    `• Project paid to date: ${args.projectPaidToDate}`,
    `• Remaining project balance before this invoice: ${args.remainingBeforeInvoice}`,
    `• Projected remaining balance after this invoice if paid: ${args.projectedRemainingAfter}`,
    "",
    "If anything isn’t clear or you’d like to go over the details, I’m happy to help.",
    "",
    "Thank you again — I truly appreciate the opportunity to work on your project.",
    "",
    `— ${args.businessName}`,
  ].join("\n");
  return { subject, body };
}

function buildMaterialCostEmailCopy(args) {
  const subject = `Material cost invoice ready — ${args.projectName}`;
  const body = [
    `Hi ${args.customerName},`,
    "",
    "I hope you're doing well.",
    "",
    `A material cost invoice for the ${args.projectName} project is ready. This invoice covers additional materials connected to this project.`,
    "",
    "You can view it here:",
    "",
    args.publicUrl,
    "",
    "Here's a quick summary:",
    `• Material cost invoice: ${args.invoiceAmount}`,
    `• Paid to date on this invoice: ${args.paidAmount}`,
    `• Amount due on this invoice: ${args.balanceDue}`,
    "",
    "If anything isn’t clear or you’d like to go over the details, I’m happy to help.",
    "",
    "Thank you again — I truly appreciate the opportunity to work on your project.",
    "",
    `— ${args.businessName}`,
  ].join("\n");
  return { subject, body };
}

function buildPartialBalanceDueEmailCopy(args) {
  const subject = `Invoice balance ready — ${args.projectName}`;
  const body = [
    `Hi ${args.customerName},`,
    "",
    "I hope you're doing well.",
    "",
    `Your invoice for the ${args.projectName} project has a remaining balance due. Payments already recorded on this invoice are reflected below.`,
    "",
    "You can view it here:",
    "",
    args.publicUrl,
    "",
    "Here's a quick summary:",
    `• Amount due on this invoice: ${args.balanceDue}`,
    "",
    "Payment summary:",
    `• Invoice total: ${args.contractOrInvoiceTotal}`,
    `• Paid to date: ${args.paidToDate}`,
    `• Remaining balance: ${args.balanceDue}`,
    "",
    "If anything isn’t clear or you’d like to go over the details, I’m happy to help.",
    "",
    "Thank you again — I truly appreciate the opportunity to work on your project.",
    "",
    `— ${args.businessName}`,
  ].join("\n");
  return { subject, body };
}

function buildStandardEmailCopy(args) {
  const subject = `Invoice ready — ${args.projectName}`;
  const body = [
    `Hi ${args.customerName},`,
    "",
    "I hope you're doing well.",
    "",
    `Your invoice for the ${args.projectName} project is ready.`,
    "",
    "You can view it here:",
    "",
    args.publicUrl,
    "",
    "Here's a quick summary:",
    `• Contract total: ${args.contractTotal}`,
    `• Paid to date: ${args.paidToDate}`,
    `• Remaining balance: ${args.balanceDue}`,
    "",
    "If anything isn’t clear or you’d like to go over the details, I’m happy to help.",
    "",
    "Thank you again — I truly appreciate the opportunity to work on your project.",
    "",
    `— ${args.businessName}`,
  ].join("\n");
  return { subject, body };
}

function buildCanonicalInvoiceEmail({
  invoice_copy_variant,
  customerName,
  projectName,
  publicUrl,
  businessName,
  currency,
  nums,
}) {
  const fmt = (n) => formatMoney(n, currency);
  const brand = businessName || "Three Colors Corp";

  if (invoice_copy_variant === "material_cost") {
    const invoice_amount = roundMoney(nums.invoice_amount);
    const paid_to_date = roundMoney(nums.paid_to_date);
    const balance_due = roundMoney(nums.balance_due);
    const emailCopy = buildMaterialCostEmailCopy({
      customerName,
      projectName,
      publicUrl,
      invoiceAmount: fmt(invoice_amount),
      paidAmount: fmt(paid_to_date),
      balanceDue: fmt(balance_due),
      businessName: brand,
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
    };
  }

  if (invoice_copy_variant === "remaining_balance" || invoice_copy_variant === "project_payment") {
    const invoice_amount = roundMoney(nums.invoice_amount);
    const balance_due = roundMoney(nums.balance_due);
    const project_contract_total = roundMoney(nums.project_contract_total);
    const project_paid_to_date = roundMoney(nums.project_paid_to_date);
    const remaining_before = roundMoney(
      nums.remaining_before_invoice != null ? nums.remaining_before_invoice : nums.remaining_project_balance
    );
    const projected_after = roundMoney(
      nums.projected_remaining_after != null
        ? nums.projected_remaining_after
        : Math.max(remaining_before - invoice_amount, 0)
    );
    const invoiceLabel = normalizeProjectPaymentLabel(nums.invoice_label || "Progress Payment");
    const emailCopy = buildProjectPaymentEmailCopy({
      customerName,
      projectName,
      publicUrl,
      invoiceLabel,
      projectContractTotal: fmt(project_contract_total),
      projectPaidToDate: fmt(project_paid_to_date),
      remainingBeforeInvoice: fmt(remaining_before),
      projectedRemainingAfter: fmt(projected_after),
      invoiceAmount: fmt(invoice_amount),
      invoiceBalanceDue: fmt(balance_due),
      businessName: brand,
    });
    return {
      invoice_copy_variant: "project_payment",
      invoice_label: invoiceLabel,
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
      remaining_project_balance: remaining_before,
      remaining_balance_before_invoice: remaining_before,
      projected_remaining_after_invoice: projected_after,
      remaining_balance: remaining_before,
      amount: invoice_amount,
    };
  }

  if (invoice_copy_variant === "partial_balance_due") {
    const invoice_amount = roundMoney(nums.invoice_amount);
    const paid_to_date = roundMoney(nums.paid_to_date);
    const balance_due = roundMoney(nums.balance_due);
    const contract_total = roundMoney(nums.contract_total || invoice_amount);
    const emailCopy = buildPartialBalanceDueEmailCopy({
      customerName,
      projectName,
      publicUrl,
      contractOrInvoiceTotal: fmt(contract_total),
      paidToDate: fmt(paid_to_date),
      balanceDue: fmt(balance_due),
      businessName: brand,
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
    };
  }

  const invoice_amount = roundMoney(nums.invoice_amount);
  const paid_to_date = roundMoney(nums.paid_to_date);
  const balance_due = roundMoney(nums.balance_due);
  const contract_total = roundMoney(nums.contract_total || invoice_amount);
  const emailCopy = buildStandardEmailCopy({
    customerName,
    projectName,
    publicUrl,
    contractTotal: fmt(contract_total),
    paidToDate: fmt(paid_to_date),
    balanceDue: fmt(balance_due),
    businessName: brand,
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
  };
}

function validateCanonicalInvoiceEmail(canonical) {
  const variant = String(canonical?.invoice_copy_variant || "");
  const fail = (detail) => ({
    ok: false,
    detail: String(detail || ""),
    message: "Invoice email payload is missing required balance values. Email was not sent.",
  });

  if (!canonical?.email_subject || !canonical?.email_body) {
    return fail("missing_email_copy");
  }

  if (variant === "remaining_balance" || variant === "project_payment") {
    if (!(canonical.invoice_amount > 0.005)) return fail("project_payment_invoice_amount");
    if (!(canonical.balance_due > 0.005)) return fail("project_payment_balance_due");
    if (!(canonical.amount_due_on_this_invoice > 0.005)) return fail("project_payment_amount_due");
    if (!(canonical.project_contract_total > 0.005)) return fail("project_payment_project_contract_total");
    if (!(canonical.project_paid_to_date >= -0.005)) return fail("project_payment_project_paid_to_date");
    if (!(canonical.contract_total > 0.005)) return fail("project_payment_contract_total");
    const remainingBefore = Number(
      canonical.remaining_balance_before_invoice != null
        ? canonical.remaining_balance_before_invoice
        : canonical.remaining_project_balance
    );
    if (!(remainingBefore >= -0.005)) return fail("project_payment_remaining_before");
    if (isFullRemainingStageLabel(canonical.invoice_label)) {
      if (Math.abs(remainingBefore - Number(canonical.invoice_amount)) > 0.02) {
        if (remainingBefore <= 0.005 && canonical.invoice_amount > 0.005) {
          return fail("full_remaining_label_zero_project_remaining");
        }
      }
    }
    const invoiceAmountF = formatMoney(canonical.invoice_amount);
    const dueF = formatMoney(canonical.amount_due_on_this_invoice);
    if (
      bodyHasFakeZeroSummary(canonical.email_body, [invoiceAmountF, dueF]) ||
      !String(canonical.email_body).includes(invoiceAmountF) ||
      !String(canonical.email_body).includes(dueF)
    ) {
      return fail("project_payment_email_body_amounts");
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
    if (
      !(canonical.invoice_amount > canonical.balance_due + 0.005) &&
      !(canonical.contract_total > canonical.balance_due + 0.005)
    ) {
      return fail("partial_total_vs_balance");
    }
    return { ok: true };
  }

  const mains = [
    canonical.invoice_amount,
    canonical.contract_total,
    canonical.balance_due,
    canonical.amount_due_on_this_invoice,
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
    remaining_balance_before_invoice: canonical.remaining_balance_before_invoice,
    projected_remaining_after_invoice: canonical.projected_remaining_after_invoice,
    remaining_balance: canonical.remaining_balance,
    amount: canonical.amount,
  };
  return {
    ...basePayload,
    ...moneyFields,
    invoice_copy_variant: canonical.invoice_copy_variant,
    invoice_label: canonical.invoice_label || pickFirstStr(basePayload.invoice_label),
    email_subject: canonical.email_subject,
    email_body: canonical.email_body,
    email_html: canonical.email_html,
    "Email Subject": canonical.email_subject,
    "Email Body": canonical.email_body,
    "Email Html": canonical.email_html,
    "Invoice Copy Variant": canonical.invoice_copy_variant,
    "Invoice Label": canonical.invoice_label,
    "Invoice Amount": canonical.invoice_amount,
    "Balance Due": canonical.balance_due,
    "Amount Due On This Invoice": canonical.amount_due_on_this_invoice,
    "Paid To Date": canonical.paid_to_date,
    "Contract Total": canonical.contract_total,
    "Project Contract Total": canonical.project_contract_total,
    "Project Paid To Date": canonical.project_paid_to_date,
    "Remaining Project Balance": canonical.remaining_project_balance,
    "Remaining Balance Before Invoice": canonical.remaining_balance_before_invoice,
    "Projected Remaining After Invoice": canonical.projected_remaining_after_invoice,
    "Remaining Balance": canonical.remaining_balance,
  };
}

async function supabaseGet(deps, path) {
  if (typeof deps.supabaseGet === "function") return deps.supabaseGet(path);
  if (typeof deps.supabaseRequest === "function") {
    return deps.supabaseRequest(path, { method: "GET" });
  }
  return null;
}

async function loadQuoteTotal(tenantId, quoteId, deps) {
  if (!tenantId || !quoteId) return 0;
  try {
    const rows = await supabaseGet(
      deps,
      `quotes?id=eq.${encodeURIComponent(quoteId)}&tenant_id=eq.${encodeURIComponent(tenantId)}&select=total&limit=1`
    );
    const row = Array.isArray(rows) ? rows[0] : null;
    const n = Number(row?.total);
    return Number.isFinite(n) ? Math.max(n, 0) : 0;
  } catch (_err) {
    return 0;
  }
}

async function loadProjectTotal(tenantId, projectId, deps) {
  if (!tenantId || !projectId) return 0;
  try {
    const rows = await supabaseGet(
      deps,
      `tenant_projects?id=eq.${encodeURIComponent(projectId)}&tenant_id=eq.${encodeURIComponent(tenantId)}&select=sale_price&limit=1`
    );
    const row = Array.isArray(rows) ? rows[0] : null;
    const n = Number(row?.sale_price);
    return Number.isFinite(n) ? Math.max(n, 0) : 0;
  } catch (_err) {
    return 0;
  }
}

async function loadProjectPaidToDate(tenantId, projectId, quoteId, deps) {
  if (!tenantId) return 0;
  const params = new URLSearchParams();
  params.set("tenant_id", `eq.${tenantId}`);
  params.set("select", "amount");
  params.set("limit", "500");
  if (projectId) params.set("project_id", `eq.${projectId}`);
  else if (quoteId) params.set("quote_id", `eq.${quoteId}`);
  else return 0;
  try {
    const rows = await supabaseGet(deps, `tenant_project_payments?${params.toString()}`);
    const list = Array.isArray(rows) ? rows : [];
    return list.reduce((sum, row) => {
      const n = Number(row?.amount);
      return sum + (Number.isFinite(n) ? n : 0);
    }, 0);
  } catch (_err) {
    return 0;
  }
}

async function resolveSupportProjectPaymentContext(invoice, deps = {}) {
  const tenantId = String(invoice.tenant_id || "").trim();
  const projectId = String(invoice.project_id || "").trim();
  const quoteId = String(invoice.quote_id || "").trim();
  const quoteTotal = await loadQuoteTotal(tenantId, quoteId, deps);
  const projectTotal = await loadProjectTotal(tenantId, projectId, deps);
  const dbPaid = Math.max(await loadProjectPaidToDate(tenantId, projectId, quoteId, deps), 0);

  const invoiceAmount = Math.max(roundMoney(toNumber(invoice.amount, 0)), 0);
  const projectContractTotal =
    (quoteTotal > 0 ? roundMoney(quoteTotal) : null) ??
    (projectTotal > 0 ? roundMoney(projectTotal) : null) ??
    invoiceAmount;
  const invoiceBalanceDue =
    toNumber(invoice.balance_due, 0) > 0.005
      ? roundMoney(invoice.balance_due)
      : invoiceAmount;
  const remainingBeforeInvoice = Math.max(roundMoney(projectContractTotal - dbPaid), 0);
  const projectedRemainingAfter = Math.max(roundMoney(remainingBeforeInvoice - invoiceAmount), 0);

  return {
    invoiceLabel: normalizeProjectPaymentLabel(invoice.invoice_label || "Progress Payment"),
    projectContractTotal: roundMoney(projectContractTotal),
    projectPaidToDate: roundMoney(dbPaid),
    remainingBeforeInvoice: roundMoney(remainingBeforeInvoice),
    projectedRemainingAfter: roundMoney(projectedRemainingAfter),
    invoiceAmount: roundMoney(invoiceAmount),
    invoiceBalanceDue: roundMoney(invoiceBalanceDue),
  };
}

function invoiceMoneyFromRow(invoice) {
  const invoiceAmountNum = Math.max(roundMoney(toNumber(invoice.amount, 0)), 0);
  const paidOnInvoiceNum = Math.max(roundMoney(toNumber(invoice.paid_amount, 0)), 0);
  const balanceOnInvoiceNum =
    toNumber(invoice.balance_due, NaN) > 0.005
      ? roundMoney(invoice.balance_due)
      : Math.max(roundMoney(invoiceAmountNum - paidOnInvoiceNum), 0);
  return {
    invoice_amount: invoiceAmountNum,
    paid_to_date: paidOnInvoiceNum,
    balance_due: balanceOnInvoiceNum,
    contract_total: invoiceAmountNum,
    project_contract_total: invoiceAmountNum,
    project_paid_to_date: paidOnInvoiceNum,
    remaining_project_balance: balanceOnInvoiceNum,
  };
}

async function buildSupportCanonicalInvoiceEmail({ invoice, publicUrl, businessName, deps = {} }) {
  const variant = classifySupportInvoiceCopyVariant(invoice);
  let nums = invoiceMoneyFromRow(invoice);
  if (variant === "project_payment") {
    const ctx = await resolveSupportProjectPaymentContext(invoice, deps);
    nums = {
      invoice_label: ctx.invoiceLabel,
      invoice_amount: ctx.invoiceAmount,
      paid_to_date: ctx.projectPaidToDate,
      balance_due: ctx.invoiceBalanceDue,
      contract_total: ctx.projectContractTotal,
      project_contract_total: ctx.projectContractTotal,
      project_paid_to_date: ctx.projectPaidToDate,
      remaining_project_balance: ctx.remainingBeforeInvoice,
      remaining_before_invoice: ctx.remainingBeforeInvoice,
      projected_remaining_after: ctx.projectedRemainingAfter,
    };
  }
  const canonical = buildCanonicalInvoiceEmail({
    invoice_copy_variant: variant,
    customerName: pickFirstStr(invoice.customer_name, invoice.project_name) || "there",
    projectName: pickFirstStr(invoice.project_name) || "your project",
    publicUrl,
    businessName: pickFirstStr(businessName, invoice.business_name) || "Three Colors Corp",
    currency: invoice.currency,
    nums,
  });
  return { canonical, variant };
}

module.exports = {
  classifySupportInvoiceCopyVariant,
  isMaterialCostInvoice,
  isProjectPaymentInvoice,
  isPartialBalanceDueInvoice,
  buildSupportCanonicalInvoiceEmail,
  validateCanonicalInvoiceEmail,
  applyCanonicalToZapierPayload,
  pickFirstStr,
};
