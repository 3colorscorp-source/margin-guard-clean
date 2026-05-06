const { readSessionFromEvent } = require("./_lib/session");
const { supabaseRequest } = require("./_lib/supabase-admin");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");
const { makePublicToken } = require("./_lib/public-token");
const { computeManualInvoiceSystemSellRates } = require("./_lib/pricing-engine");

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

function snapshotPricingOk(mg) {
  if (!mg || typeof mg !== "object") return false;
  const bi = Number(mg.baseInstaller);
  return Number.isFinite(bi) && bi > 0;
}

async function loadTenantPricingSettings(tenantId) {
  const rows = await supabaseRequest(
    `tenant_snapshots?tenant_id=eq.${encodeURIComponent(String(tenantId))}&select=payload&order=created_at.desc&limit=1`
  );
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row?.payload || typeof row.payload !== "object") {
    return { settings: {}, hasSnapshot: false, pricingReady: false };
  }
  const storage =
    row.payload.storage && typeof row.payload.storage === "object" ? row.payload.storage : {};
  const mg = storage["mg_settings_v2"];
  const settings = mg && typeof mg === "object" ? mg : {};
  return {
    settings,
    hasSnapshot: true,
    pricingReady: snapshotPricingOk(settings),
  };
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

    const tenantId = String(tenant.id);
    const { settings, hasSnapshot, pricingReady } = await loadTenantPricingSettings(tenantId);

    if (body.preview_system_rates === true) {
      if (!hasSnapshot || !pricingReady) {
        return json(422, { error: "pricing_snapshot_required", ok: false });
      }
      const rates = computeManualInvoiceSystemSellRates(settings);
      return json(200, {
        ok: true,
        system_hourly_rate: rates.system_hourly_rate,
        system_daily_rate: rates.system_daily_rate,
      });
    }

    const clientName = str(body.client_name || body.customer_name, 500);
    const clientEmail = str(body.client_email || body.customer_email, 320).toLowerCase();
    const title = str(body.project_title || body.invoice_title || body.project_name, 2000);
    const description = str(body.description, 8000);
    const notesInput = str(body.notes, 8000);
    const billingType = normalizeBillingType(body.billing_type);
    const quantityRaw = money(body.quantity);
    const dueDate = str(body.due_date, 32);
    const materialDescription = str(body.material_description, 4000);
    const materialsCost = money(body.materials_cost ?? body.material_cost ?? 0);

    if (!hasSnapshot || !pricingReady) {
      return json(422, { error: "pricing_snapshot_required" });
    }

    if (!clientName) return json(400, { error: "client_name_required" });
    if (!clientEmail || !clientEmail.includes("@")) return json(400, { error: "client_email_required" });
    if (!title) return json(400, { error: "title_required" });
    if (!billingType) return json(400, { error: "billing_type_required" });
    if (materialsCost < 0) return json(400, { error: "materials_cost_invalid" });

    const rates = computeManualInvoiceSystemSellRates(settings);
    const systemHourly = money(rates.system_hourly_rate);
    const systemDaily = money(rates.system_daily_rate);

    let quantity = 0;
    let systemRateUsed = 0;
    let laborSubtotal = 0;

    if (billingType === "flat_amount") {
      const flatRaw = body.flat_amount != null ? body.flat_amount : body.rate;
      const flatAmount = money(flatRaw);
      if (!(flatAmount > 0)) return json(400, { error: "flat_amount_required" });
      quantity = 1;
      systemRateUsed = flatAmount;
      laborSubtotal = flatAmount;
    } else {
      quantity = Math.max(quantityRaw, 0);
      if (!(quantity > 0)) return json(400, { error: "quantity_required" });
      if (billingType === "hourly") {
        systemRateUsed = systemHourly;
        if (!(systemRateUsed > 0)) return json(400, { error: "system_hourly_rate_invalid" });
        laborSubtotal = money(quantity * systemRateUsed);
      } else {
        systemRateUsed = systemDaily;
        if (!(systemRateUsed > 0)) return json(400, { error: "system_daily_rate_invalid" });
        laborSubtotal = money(quantity * systemRateUsed);
      }
    }

    const total = money(laborSubtotal + materialsCost);
    if (!(total > 0)) return json(400, { error: "total_must_be_positive" });

    const now = new Date().toISOString();
    const invoiceNo = `INV-${Date.now()}`;
    const detailLines = [
      "--- Manual invoice (Margin Guard pricing) ---",
      `Billing type: ${billingType}`,
      billingType === "flat_amount"
        ? `Flat service amount: ${systemRateUsed}`
        : `Quantity: ${quantity} (${billingType === "daily" ? "days" : "hours"})`,
      billingType === "flat_amount"
        ? null
        : `System ${billingType === "daily" ? "daily" : "hourly"} rate: ${systemRateUsed}`,
      `Labor subtotal: ${laborSubtotal}`,
      materialDescription ? `Materials: ${materialDescription}` : null,
      `Materials cost: ${materialsCost}`,
      `Total / balance due: ${total}`,
    ]
      .filter(Boolean)
      .join("\n");

    const notes = [description, notesInput, detailLines].filter(Boolean).join("\n\n").slice(0, 8000);

    const insertBase = {
      tenant_id: tenantId,
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
