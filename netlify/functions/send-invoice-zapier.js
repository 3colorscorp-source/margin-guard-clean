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
    `• Invoice / contract total: ${contractOrInvoiceTotal}`,
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

async function resolveRemainingBalanceEmailContext(invoice, body) {
  const tenantId = String(invoice.tenant_id || "").trim();
  const projectId = String(invoice.project_id || pickFirstStr(body.project_id, body.projectId) || "").trim();
  const quoteId = String(invoice.quote_id || pickFirstStr(body.quote_id, body.quoteId) || "").trim();
  const quoteTotal = await loadQuoteTotal(tenantId, quoteId);
  const projectTotal = await loadProjectTotal(tenantId, projectId);
  const bodyContract = toNumber(pickFirstStr(body.project_contract_total, body.contract_total), NaN);
  const projectContractTotal =
    Number.isFinite(bodyContract) && bodyContract > 0
      ? bodyContract
      : quoteTotal > 0
        ? quoteTotal
        : projectTotal > 0
          ? projectTotal
          : Math.max(toNumber(invoice.amount, 0), 0);
  const bodyPaid = toNumber(pickFirstStr(body.project_paid_to_date, body.paid_to_date, body.paidAmount), NaN);
  let projectPaidToDate = Number.isFinite(bodyPaid) && bodyPaid >= 0 ? bodyPaid : await loadProjectPaidToDate(tenantId, projectId, quoteId);
  projectPaidToDate = Math.max(projectPaidToDate, 0);
  const invoiceAmount = Math.max(toNumber(pickFirstStr(body.invoice_amount, invoice.amount), 0), 0);
  const bodyInvoiceDue = toNumber(pickFirstStr(body.invoice_balance_due, body.balance_due, body.remaining_balance), NaN);
  const invoiceBalanceDue = Number.isFinite(bodyInvoiceDue)
    ? Math.max(bodyInvoiceDue, 0)
    : Math.max(toNumber(invoice.balance_due, invoiceAmount), 0);
  const remainingProjectBalance = Math.max(
    toNumber(pickFirstStr(body.remaining_project_balance), projectContractTotal - projectPaidToDate),
    0
  );
  return {
    projectContractTotal,
    projectPaidToDate,
    remainingProjectBalance,
    invoiceAmount,
    invoiceBalanceDue
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
    const webhookUrl = String(process.env.ZAPIER_INVOICE_SEND_WEBHOOK_URL || "").trim();
    if (!webhookUrl || /TU_WEBHOOK_URL_AQUI/i.test(webhookUrl)) {
      return jsonError(
        503,
        "webhook_not_configured",
        "Zapier invoice webhook is not configured. Set Netlify environment variable ZAPIER_INVOICE_SEND_WEBHOOK_URL to your real Zapier Catch Hook URL (https://hooks.zapier.com/...). Do not use an empty value or the placeholder text."
      );
    }

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
    const invoiceAmountFormatted = formatMoney(
      pickFirstStr(body.invoice_amount, invoice.amount),
      invoice.currency
    );
    const paidOnInvoiceFormatted = formatMoney(
      pickFirstStr(body.paid_to_date, body.paidAmount, invoice.paid_amount),
      invoice.currency
    );
    const balanceOnInvoiceFormatted = formatMoney(
      pickFirstStr(body.invoice_balance_due, body.balance_due, body.remaining_balance, invoice.balance_due),
      invoice.currency
    );
    const contractOrInvoiceTotalFormatted = formatMoney(
      pickFirstStr(body.contract_total, body.project_contract_total, body.invoice_amount, invoice.amount),
      invoice.currency
    );
    let amount;
    let paid_to_date;
    let balance_due;
    let invoice_copy_variant = "standard";
    let remainingBalanceContext = null;

    if (isMaterialCost) {
      amount = invoiceAmountFormatted;
      paid_to_date = paidOnInvoiceFormatted;
      balance_due = balanceOnInvoiceFormatted;
      invoice_copy_variant = "material_cost";
    } else if (isRemainingBalance) {
      remainingBalanceContext = await resolveRemainingBalanceEmailContext(invoice, body);
      amount = formatMoney(remainingBalanceContext.invoiceBalanceDue, invoice.currency);
      paid_to_date = formatMoney(remainingBalanceContext.projectPaidToDate, invoice.currency);
      balance_due = formatMoney(remainingBalanceContext.invoiceBalanceDue, invoice.currency);
      invoice_copy_variant = "remaining_balance";
    } else if (isPartialBalanceDue) {
      amount = balanceOnInvoiceFormatted;
      paid_to_date = paidOnInvoiceFormatted;
      balance_due = balanceOnInvoiceFormatted;
      invoice_copy_variant = "partial_balance_due";
    } else {
      amount = formatMoney(pickFirstStr(body.contract_total, body.amount, invoice.amount), invoice.currency);
      paid_to_date = formatMoney(pickFirstStr(body.paid_to_date, body.paidAmount, invoice.paid_amount), invoice.currency);
      balance_due = formatMoney(pickFirstStr(body.balance_due, body.remaining_balance, invoice.balance_due), invoice.currency);
    }

    /** Zapier Catch Hook field names (exact keys with spaces). */
    const payload = {
      client_name,
      client_email,
      "Client Email": client_email,
      public_invoice_url,
      "Public Invoice Url": public_invoice_url,
      business_name,
      project_name,
      amount,
      paid_to_date,
      balance_due,
      invoice_label: pickFirstStr(invoice.invoice_label),
      invoice_copy_variant,
      tenant_id: tenantId,
      invoice_id,
      quote_id,
      project_id,
      event_type,
      schema_version,
      idempotency_key
    };

    if (isRemainingBalance && remainingBalanceContext) {
      const projectContractTotalFormatted = formatMoney(
        remainingBalanceContext.projectContractTotal,
        invoice.currency
      );
      const projectPaidToDateFormatted = formatMoney(
        remainingBalanceContext.projectPaidToDate,
        invoice.currency
      );
      const remainingProjectBalanceFormatted = formatMoney(
        remainingBalanceContext.remainingProjectBalance,
        invoice.currency
      );
      const emailCopy = buildRemainingBalanceEmailCopy({
        customerName: client_name,
        projectName: project_name,
        publicUrl: public_invoice_url,
        projectContractTotal: projectContractTotalFormatted,
        projectPaidToDate: projectPaidToDateFormatted,
        remainingProjectBalance: remainingProjectBalanceFormatted,
        invoiceAmount: invoiceAmountFormatted,
        invoiceBalanceDue: balanceOnInvoiceFormatted,
        businessName: business_name || "Three Colors Corp"
      });
      payload.project_contract_total = projectContractTotalFormatted;
      payload.project_paid_to_date = projectPaidToDateFormatted;
      payload.remaining_project_balance = remainingProjectBalanceFormatted;
      payload.invoice_amount = invoiceAmountFormatted;
      payload.invoice_balance_due = balanceOnInvoiceFormatted;
      payload.email_subject = emailCopy.subject;
      payload.email_body = emailCopy.body;
      payload["Email Subject"] = emailCopy.subject;
      payload["Email Body"] = emailCopy.body;
      payload.summary_line_1_label = "Invoice type";
      payload.summary_line_1_value = "Remaining Balance";
      payload.summary_line_2_label = "This invoice amount";
      payload.summary_line_2_value = invoiceAmountFormatted;
      payload.summary_line_3_label = "Amount due on this invoice";
      payload.summary_line_3_value = balanceOnInvoiceFormatted;
      payload.summary_line_4_label = "Project contract total";
      payload.summary_line_4_value = projectContractTotalFormatted;
      payload.summary_line_5_label = "Project paid to date";
      payload.summary_line_5_value = projectPaidToDateFormatted;
      payload.summary_line_6_label = "Remaining project balance";
      payload.summary_line_6_value = remainingProjectBalanceFormatted;
    }

    if (isMaterialCost) {
      const emailCopy = buildMaterialCostEmailCopy({
        customerName: client_name,
        projectName: project_name,
        publicUrl: public_invoice_url,
        invoiceAmount: invoiceAmountFormatted,
        paidAmount: paidOnInvoiceFormatted,
        balanceDue: balanceOnInvoiceFormatted,
        businessName: business_name || "Three Colors Corp"
      });
      payload.email_subject = emailCopy.subject;
      payload.email_body = emailCopy.body;
      payload["Email Subject"] = emailCopy.subject;
      payload["Email Body"] = emailCopy.body;
      payload.summary_line_1_label = "Material cost invoice";
      payload.summary_line_1_value = invoiceAmountFormatted;
      payload.summary_line_2_label = "Paid to date on this invoice";
      payload.summary_line_2_value = paidOnInvoiceFormatted;
      payload.summary_line_3_label = "Amount due on this invoice";
      payload.summary_line_3_value = balanceOnInvoiceFormatted;
    }

    if (isPartialBalanceDue) {
      const emailCopy = buildPartialBalanceDueEmailCopy({
        customerName: client_name,
        projectName: project_name,
        publicUrl: public_invoice_url,
        contractOrInvoiceTotal: contractOrInvoiceTotalFormatted,
        paidToDate: paidOnInvoiceFormatted,
        balanceDue: balanceOnInvoiceFormatted,
        businessName: business_name || "Three Colors Corp"
      });
      payload.email_subject = emailCopy.subject;
      payload.email_body = emailCopy.body;
      payload["Email Subject"] = emailCopy.subject;
      payload["Email Body"] = emailCopy.body;
      payload.summary_line_1_label = "Amount due on this invoice";
      payload.summary_line_1_value = balanceOnInvoiceFormatted;
      payload.summary_line_2_label = "Invoice / contract total";
      payload.summary_line_2_value = contractOrInvoiceTotalFormatted;
      payload.summary_line_3_label = "Paid to date";
      payload.summary_line_3_value = paidOnInvoiceFormatted;
      payload.summary_line_4_label = "Remaining balance";
      payload.summary_line_4_value = balanceOnInvoiceFormatted;
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
      amount,
      paid_to_date,
      balance_due
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
