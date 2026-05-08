// LOCKED STABLE FILE - ANTI-REGRESSION WARNING
// Multi-tenant safety for manual invoice creation has been audited.
// Owner approval is required before any modification to this file.
// Public Work Details rendering depends on persisted invoices.notes.
// Stripe checkout-related invoice behavior is protected and must not be changed incidentally.
// Any future change requires full regression testing across manual create, DB persistence, and public invoice display.
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

function moneyText(v) {
  return `$${money(v).toFixed(2)}`;
}

function normalizeBillingType(raw) {
  const s = str(raw, 32).toLowerCase();
  if (s === "hourly" || s === "daily" || s === "flat_amount") return s;
  return "";
}

function cleanMultilineText(raw, maxLen = 8000) {
  const s = String(raw == null ? "" : raw)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim()
    .slice(0, maxLen);
  return s
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

function buildManualInvoiceClientNotes({
  description,
  billingType,
  quantity,
  systemRateUsed,
  laborSubtotal,
  materialDescription,
  materialsCost,
  total,
}) {
  const sections = [];
  if (description) {
    sections.push(`Service details:\n${description}`);
  }

  const billingLine =
    billingType === "hourly"
      ? `Hourly service — ${quantity} hours at ${moneyText(systemRateUsed)}/hr`
      : billingType === "daily"
        ? `Daily service — ${quantity} days at ${moneyText(systemRateUsed)}/day`
        : `Flat service — ${moneyText(systemRateUsed)}`;
  sections.push(`Billing:\n${billingLine}\nLabor subtotal: ${moneyText(laborSubtotal)}`);

  if (materialDescription || materialsCost > 0) {
    const materialLines = [];
    if (materialDescription) materialLines.push(materialDescription);
    materialLines.push(`Materials subtotal: ${moneyText(materialsCost)}`);
    sections.push(`Materials:\n${materialLines.join("\n")}`);
  }

  sections.push(`Invoice total:\n${moneyText(total)}`);
  return sections.join("\n\n").slice(0, 8000);
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
    const descriptionSource = [
      body.description,
      body.work_details,
      body.workDetails,
      body.notes,
      body.scope,
      body.scope_of_work,
      body.scopeOfWork,
    ].find((v) => String(v == null ? "" : v).trim());
    const description = cleanMultilineText(descriptionSource, 5000);
    const billingType = normalizeBillingType(body.billing_type);
    const quantityRaw = money(body.quantity);
    const dueDate = str(body.due_date, 32);
    const materialDescription = cleanMultilineText(body.material_description, 2000);
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
    const billingTypeLabel =
      billingType === "hourly" ? "Hourly service" : billingType === "daily" ? "Daily service" : "Flat service";
    const quantityLabel = billingType === "hourly" ? "hours" : billingType === "daily" ? "days" : "flat";
    const rateLabel = billingType === "hourly" ? "hr" : billingType === "daily" ? "day" : "flat";
    const formatMoney = (value) => moneyText(value);
    const safeDescription = String(description || "").trim();
    const safeMaterialDescription = String(materialDescription || "").trim();

    const notesParts = [];
    if (safeDescription) {
      notesParts.push(`Service details:\n${safeDescription}`);
    }
    notesParts.push(
      `Billing:\n${billingTypeLabel} — ${quantity} ${quantityLabel} at ${formatMoney(systemRateUsed)}/${rateLabel}`
    );
    notesParts.push(`Labor subtotal: ${formatMoney(laborSubtotal)}`);
    if (safeMaterialDescription || Number(materialsCost || 0) > 0) {
      notesParts.push(
        `Materials:\n${safeMaterialDescription || "Materials"}\nMaterials subtotal: ${formatMoney(materialsCost)}`
      );
    }
    notesParts.push(`Invoice total: ${formatMoney(total)}`);

    const notesFinal = notesParts.join("\n\n").trim();
    console.log("[manual invoice incoming description]", body.description);
    console.log("[manual invoice notesFinal]", notesFinal);
    console.log("[manual invoice notesFinal length]", String(notesFinal || "").length);
    if (!String(notesFinal || "").trim()) {
      return json(500, { ok: false, error: "manual_invoice_notes_generation_failed" });
    }

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
      notes: notesFinal,
      status: "draft",
      invoice_label: "Manual Invoice",
      created_at: now,
      updated_at: now,
    };
    const insertPayload = { ...insertBase, notes: notesFinal };
    console.log("[manual invoice insertPayload notes length]", String(insertPayload?.notes || "").length);

    let created;
    try {
      created = await supabaseRequest("invoices", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: { ...insertPayload, source: "manual_invoice" },
      });
    } catch (err) {
      const msg = String(err?.message || "");
      const sourceMissing = /column .*source.* does not exist|source/i.test(msg);
      if (!sourceMissing) throw err;
      created = await supabaseRequest("invoices", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: insertPayload,
      });
    }

    const insertedInvoice = Array.isArray(created) ? created[0] : created;
    if (!insertedInvoice?.id) {
      return json(500, { error: "Insert did not return invoice row." });
    }

    const insertedId = String(insertedInvoice.id);
    const selectedRows = await supabaseRequest(
      `invoices?id=eq.${encodeURIComponent(insertedId)}&tenant_id=eq.${encodeURIComponent(tenantId)}&select=id,tenant_id,invoice_no,customer_name,customer_email,project_name,amount,balance_due,status,due_date,notes&limit=1`
    );
    let finalInvoice = Array.isArray(selectedRows) ? selectedRows[0] : selectedRows;
    if (!finalInvoice?.id) {
      return json(500, { ok: false, error: "manual_invoice_post_insert_lookup_failed" });
    }

    if (!String(finalInvoice.notes || "").trim()) {
      const repaired = await supabaseRequest(
        `invoices?id=eq.${encodeURIComponent(insertedId)}&tenant_id=eq.${encodeURIComponent(tenantId)}`,
        {
          method: "PATCH",
          headers: { Prefer: "return=representation" },
          body: { notes: notesFinal, updated_at: new Date().toISOString() },
        }
      );
      finalInvoice = Array.isArray(repaired) ? repaired[0] : repaired;
      if (!String(finalInvoice?.notes || "").trim()) {
        return json(500, { ok: false, error: "manual_invoice_notes_persist_failed" });
      }
    }

    return json(200, {
      ok: true,
      debug_notes_length: String(finalInvoice?.notes || "").length,
      debug_notes_preview: String(finalInvoice?.notes || "").slice(0, 120),
      invoice: {
        id: finalInvoice.id,
        tenant_id: finalInvoice.tenant_id,
        invoice_no: finalInvoice.invoice_no,
        customer_name: finalInvoice.customer_name,
        customer_email: finalInvoice.customer_email,
        project_name: finalInvoice.project_name,
        amount: finalInvoice.amount,
        balance_due: finalInvoice.balance_due,
        status: finalInvoice.status,
        due_date: finalInvoice.due_date,
      },
    });
  } catch (err) {
    return json(500, { error: err.message || "Server error" });
  }
};
