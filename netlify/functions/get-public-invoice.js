const { supabaseRequest } = require("./_lib/supabase-admin");
const { loadTenantDisplayForTenantId, pickFirst } = require("./_lib/tenant-display");

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}

/** Columns required by public/invoice-public.html only — no ids or tenant fields. */
const INVOICE_SELECT = [
  "business_name",
  "status",
  "currency",
  "amount",
  "paid_amount",
  "balance_due",
  "accent_color",
  "logo_url",
  "payment_link",
  "invoice_no",
  "due_date",
  "customer_name",
  "customer_email",
  "project_name",
  "invoice_label",
  "issue_date",
  "type",
  "notes",
  "id",
  "tenant_id",
  "quote_id",
  "project_id"
].join(",");

const INVOICE_NUMERIC_KEYS = new Set(["amount", "paid_amount", "balance_due"]);

function pickPublicInvoiceFields(row) {
  const keys = INVOICE_SELECT.split(",");
  const out = {};
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(row, k)) {
      continue;
    }
    const v = row[k];
    if (INVOICE_NUMERIC_KEYS.has(k)) {
      const n = Number(v);
      out[k] = Number.isFinite(n) ? n : 0;
      continue;
    }
    out[k] = v === null || v === undefined ? "" : String(v);
  }
  return out;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "GET") {
      return json(405, { error: "Method Not Allowed" });
    }

    const raw = event.queryStringParameters?.token;
    if (raw === undefined || raw === null) {
      return json(400, { error: "Missing token" });
    }
    const trimmed = String(raw).trim();
    if (trimmed === "") {
      return json(400, { error: "Missing token" });
    }
    if (trimmed.length < 10 || trimmed.length > 256) {
      return json(400, { error: "Invalid token" });
    }
    if (!/^[a-zA-Z0-9_]+$/.test(trimmed)) {
      return json(400, { error: "Invalid token" });
    }

    const path = `invoices?public_token=eq.${encodeURIComponent(trimmed)}&tenant_id=not.is.null&select=${INVOICE_SELECT}&limit=2`;

    let rows;
    try {
      rows = await supabaseRequest(path, { method: "GET" });
    } catch (err) {
      return json(502, { error: err.message || "Failed to read invoice" });
    }

    if (!Array.isArray(rows)) {
      return json(502, { error: "Unexpected response" });
    }

    if (rows.length === 0) {
      return json(404, { error: "Invoice not found" });
    }

    if (rows.length > 1) {
      return json(500, { error: "Invalid invoice reference" });
    }

    const rawRow = rows[0] || {};
    const invoice = pickPublicInvoiceFields(rawRow);
    const tenantId = String(rawRow.tenant_id || "").trim();
    const invoiceId = String(rawRow.id || "").trim();
    const quoteId = String(rawRow.quote_id || "").trim();
    const projectId = String(rawRow.project_id || "").trim();

    const invoiceAmount = Number.isFinite(Number(rawRow.amount)) ? Number(rawRow.amount) : 0;
    const quoteTotal = await loadQuoteTotal(tenantId, quoteId);
    const projectTotal = await loadProjectTotal(tenantId, projectId);
    const contractTotal =
      quoteTotal > 0 ? quoteTotal : projectTotal > 0 ? projectTotal : Math.max(invoiceAmount, 0);
    const paidToDate = await loadPaidToDate({ tenantId, invoiceId, projectId, quoteId });
    const remainingBalance = Math.max(contractTotal - paidToDate, 0);

    if (tenantId) {
      try {
        const td = await loadTenantDisplayForTenantId(tenantId);
        const tenantBusinessName = pickFirst(td?.business_name);
        if (tenantBusinessName) {
          invoice.business_name = tenantBusinessName;
        }
      } catch (_err) {
        /* keep invoice business_name fallback */
      }
    }

    invoice.invoice_amount = invoiceAmount;
    invoice.contract_total = contractTotal;
    invoice.paid_to_date = paidToDate;
    invoice.remaining_balance = remainingBalance;

    return json(200, {
      ok: true,
      invoice
    });
  } catch (err) {
    return json(500, { error: err.message || "Server error" });
  }
};

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

async function loadPaidToDate({ tenantId, invoiceId, projectId, quoteId }) {
  if (!tenantId) return 0;
  const params = new URLSearchParams();
  params.set("tenant_id", `eq.${tenantId}`);
  params.set("select", "amount");
  params.set("limit", "500");
  if (invoiceId) params.set("invoice_id", `eq.${invoiceId}`);
  else if (projectId) params.set("project_id", `eq.${projectId}`);
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
