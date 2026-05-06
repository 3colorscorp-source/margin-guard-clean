const { readSessionFromEvent } = require("./_lib/session");
const { supabaseRequest } = require("./_lib/supabase-admin");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");
const { makePublicToken } = require("./_lib/public-token");

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function str(v, max = 8000) {
  return String(v == null ? "" : v).trim().slice(0, max);
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function money(v) {
  return Math.round(num(v, 0) * 100) / 100;
}

function normalizeBillingType(raw) {
  const s = str(raw, 32).toLowerCase();
  if (s === "hourly" || s === "daily" || s === "flat_amount") return s;
  return "";
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { error: "Method Not Allowed" });
    }

    const session = readSessionFromEvent(event);
    if (!session?.e || !session?.c) {
      return json(401, { error: "Unauthorized" });
    }

    const tenant = await resolveTenantFromSession(session);
    if (!tenant?.id) {
      return json(422, { error: "Tenant not found for this session." });
    }

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch (_e) {
      return json(400, { error: "invalid_json_body" });
    }

    const clientName = str(body.client_name || body.customer_name, 500);
    const clientEmail = str(body.client_email || body.customer_email, 320).toLowerCase();
    const title = str(body.project_title || body.invoice_title || body.project_name, 2000);
    const description = str(body.description, 8000);
    const notesInput = str(body.notes, 8000);
    const billingType = normalizeBillingType(body.billing_type);
    const quantityRaw = money(body.quantity);
    const rateRaw = money(body.rate);
    const dueDate = str(body.due_date, 32);

    if (!clientName) return json(400, { error: "client_name_required" });
    if (!clientEmail || !clientEmail.includes("@")) return json(400, { error: "client_email_required" });
    if (!title) return json(400, { error: "title_required" });
    if (!billingType) return json(400, { error: "billing_type_required" });

    let quantity = 0;
    let rate = 0;
    let total = 0;
    if (billingType === "flat_amount") {
      rate = Math.max(rateRaw, 0);
      total = rate;
      quantity = 1;
    } else {
      quantity = Math.max(quantityRaw, 0);
      rate = Math.max(rateRaw, 0);
      if (quantity <= 0 || rate <= 0) {
        return json(400, { error: "quantity_rate_required" });
      }
      total = money(quantity * rate);
    }
    if (!(total > 0)) return json(400, { error: "total_must_be_positive" });

    const now = new Date().toISOString();
    const invoiceNo = `INV-${Date.now()}`;
    const billingLine = `Billing type: ${billingType}; Quantity: ${quantity}; Rate: ${rate}; Total: ${total}`;
    const notes = [description, notesInput, billingLine].filter(Boolean).join("\n\n").slice(0, 8000);

    const insertBase = {
      tenant_id: String(tenant.id),
      public_token: makePublicToken("inv"),
      invoice_no: invoiceNo,
      customer_name: clientName,
      customer_email: clientEmail,
      project_name: title,
      amount: total,
      paid_amount: 0,
      balance_due: total,
      issue_date: now.slice(0, 10),
      due_date: dueDate || null,
      type: "PROGRESS",
      notes,
      status: "draft",
      invoice_label: "Manual Invoice",
      created_at: now,
      updated_at: now,
    };

    let created;
    try {
      created = await supabaseRequest("invoices", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: { ...insertBase, source: "manual_invoice" },
      });
    } catch (err) {
      const msg = String(err?.message || "");
      const sourceMissing = /column .*source.* does not exist|source/i.test(msg);
      if (!sourceMissing) throw err;
      created = await supabaseRequest("invoices", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: insertBase,
      });
    }

    const row = Array.isArray(created) ? created[0] : created;
    if (!row?.id) {
      return json(500, { error: "Insert did not return invoice row." });
    }

    return json(200, {
      ok: true,
      invoice: {
        id: row.id,
        tenant_id: row.tenant_id,
        invoice_no: row.invoice_no,
        customer_name: row.customer_name,
        customer_email: row.customer_email,
        project_name: row.project_name,
        amount: row.amount,
        balance_due: row.balance_due,
        status: row.status,
        due_date: row.due_date,
      },
    });
  } catch (err) {
    return json(500, { error: err.message || "Server error" });
  }
};

