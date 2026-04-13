const { supabaseRequest } = require("./_lib/supabase-admin");

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
  "issue_date",
  "type",
  "notes"
].join(",");

function pickPublicInvoiceFields(row) {
  const keys = INVOICE_SELECT.split(",");
  const out = {};
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(row, k)) {
      out[k] = row[k];
    }
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

    const path = `invoices?public_token=eq.${encodeURIComponent(trimmed)}&select=${INVOICE_SELECT}&limit=2`;

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

    const invoice = pickPublicInvoiceFields(rows[0]);

    return json(200, {
      ok: true,
      invoice
    });
  } catch (err) {
    return json(500, { error: err.message || "Server error" });
  }
};
