/**
 * POST — tenant-scoped duplicate of a server invoice (new draft row).
 */
const { readSessionFromEvent } = require("./_lib/session");
const { supabaseRequest } = require("./_lib/supabase-admin");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");
const { makePublicToken } = require("./_lib/public-token");
const { pickFirst } = require("./_lib/tenant-display");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ALLOWED_INVOICE_TYPES = new Set(["DEPOSIT", "PROGRESS", "FINAL"]);

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}

function finiteMoney(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.round(n * 100) / 100;
}

function pickStr(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  return "";
}

function normStatus(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase();
}

function normalizeInvoiceType(raw) {
  const t = String(raw || "")
    .trim()
    .toUpperCase();
  return ALLOWED_INVOICE_TYPES.has(t) ? t : "PROGRESS";
}

function normalizeDueDate(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function buildDuplicateInsert(source, tenantId) {
  const amount = Math.max(finiteMoney(source.amount, 0), 0);
  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  const payload = {
    tenant_id: tenantId,
    public_token: makePublicToken("inv"),
    invoice_no: `INV-${Date.now()}`,
    customer_name: pickStr(source.customer_name),
    customer_email: pickStr(source.customer_email),
    project_name: pickStr(source.project_name),
    invoice_label: pickStr(source.invoice_label),
    notes: source.notes != null ? String(source.notes) : "",
    amount,
    paid_amount: 0,
    balance_due: amount,
    issue_date: today,
    due_date: normalizeDueDate(source.due_date),
    type: normalizeInvoiceType(source.type),
    business_name: pickStr(source.business_name),
    currency: pickStr(source.currency) || "USD",
    status: "draft",
    created_at: now,
    updated_at: now
  };
  const projectId = pickStr(source.project_id);
  if (projectId && UUID_RE.test(projectId)) {
    payload.project_id = projectId;
  }
  return payload;
}

/**
 * POST — duplicate one tenant invoice as a new draft.
 * Body: { invoice_id }
 */
exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "Method Not Allowed" });
    }

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
      return json(400, { ok: false, error: "Invalid JSON body." });
    }

    const clientTenantId = pickFirst(body.tenant_id, body.tenantId);
    if (
      clientTenantId != null &&
      clientTenantId !== "" &&
      String(clientTenantId) !== tenantId
    ) {
      return json(403, { ok: false, error: "tenant_id does not match the signed-in account." });
    }

    const rawId = pickFirst(body.invoice_id, body.invoiceId, body.id);
    const invoiceId = rawId ? String(rawId).trim() : "";
    if (!invoiceId) {
      return json(400, { ok: false, error: "invoice_id is required." });
    }
    if (!UUID_RE.test(invoiceId)) {
      return json(400, { ok: false, error: "Invalid invoice_id (expected UUID)." });
    }

    const iidEnc = encodeURIComponent(invoiceId);
    const tidEnc = encodeURIComponent(tenantId);
    const rows = await supabaseRequest(
      `invoices?id=eq.${iidEnc}&tenant_id=eq.${tidEnc}&select=*&limit=1`,
      { method: "GET" }
    );
    const source = Array.isArray(rows) && rows[0] ? rows[0] : null;
    if (!source?.id) {
      return json(404, { ok: false, error: "Invoice not found." });
    }

    if (normStatus(source.status) === "archived") {
      return json(422, { ok: false, error: "Cannot duplicate an archived invoice." });
    }

    const insertPayload = buildDuplicateInsert(source, tenantId);
    let created;
    try {
      created = await supabaseRequest("invoices", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: insertPayload
      });
    } catch (insertErr) {
      const msg = String(insertErr?.message || insertErr || "");
      const projectColumnMissing = /column .*project_id.* does not exist/i.test(msg);
      if (projectColumnMissing && insertPayload.project_id) {
        const fallbackPayload = { ...insertPayload };
        delete fallbackPayload.project_id;
        created = await supabaseRequest("invoices", {
          method: "POST",
          headers: { Prefer: "return=representation" },
          body: fallbackPayload
        });
      } else {
        throw insertErr;
      }
    }

    const invoice = Array.isArray(created) ? created[0] : created;
    if (!invoice?.id) {
      return json(500, { ok: false, error: "Insert did not return an invoice row." });
    }
    if (String(invoice.tenant_id || "") !== tenantId) {
      return json(500, { ok: false, error: "Duplicate invoice was stored without valid tenant scope." });
    }

    return json(200, {
      ok: true,
      invoice,
      source_invoice_id: String(source.id)
    });
  } catch (err) {
    console.error("[duplicate-tenant-invoice]", err);
    return json(500, { ok: false, error: err.message || "Server error" });
  }
};
