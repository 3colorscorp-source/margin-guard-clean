const { readSessionFromEvent } = require("./_lib/session");
const { supabaseRequest } = require("./_lib/supabase-admin");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const PAYMENT_TYPES = new Set(["deposit", "progress", "final", "adjustment"]);
const PAYMENT_METHODS = new Set(["check", "cash", "zelle", "stripe", "bank_transfer", "other"]);

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}

function parseBody(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

function str(v, max = 8000) {
  return String(v == null ? "" : v)
    .trim()
    .slice(0, max);
}

function finiteMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

function optionalUuid(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  return UUID_RE.test(s) ? s : "";
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

    const tenantId = String(tenant.id);
    const tidEnc = encodeURIComponent(tenantId);
    const body = parseBody(event.body);

    const invoiceId = optionalUuid(body.invoice_id || body.invoiceId);
    const projectId = optionalUuid(body.project_id || body.projectId);
    const quoteId = optionalUuid(body.quote_id || body.quoteId);

    if (!invoiceId && !projectId && !quoteId) {
      return json(400, { error: "Provide at least one of invoice_id, project_id, or quote_id." });
    }

    const paymentType = str(body.payment_type || body.paymentType, 32).toLowerCase();
    const paymentMethod = str(body.payment_method || body.paymentMethod, 32).toLowerCase();
    if (!PAYMENT_TYPES.has(paymentType)) {
      return json(400, { error: "Invalid payment_type." });
    }
    if (!PAYMENT_METHODS.has(paymentMethod)) {
      return json(400, { error: "Invalid payment_method." });
    }

    const amount = finiteMoney(body.amount);
    if (amount == null || amount === 0) {
      return json(400, { error: "amount must be a non-zero number." });
    }

    let paidAt = new Date().toISOString();
    const paidAtRaw = str(body.paid_at || body.paidAt, 64);
    if (paidAtRaw) {
      const t = Date.parse(paidAtRaw);
      if (!Number.isFinite(t)) {
        return json(400, { error: "Invalid paid_at (use ISO 8601)." });
      }
      paidAt = new Date(t).toISOString();
    }

    const notes = str(body.notes, 8000);
    const createdBy = str(session.e || session.u || "", 320) || null;

    if (invoiceId) {
      const invRows = await supabaseRequest(
        `invoices?id=eq.${encodeURIComponent(invoiceId)}&tenant_id=eq.${tidEnc}&select=id,quote_id`,
        { method: "GET" }
      );
      const inv = Array.isArray(invRows) && invRows[0] ? invRows[0] : null;
      if (!inv?.id) {
        return json(404, { error: "Invoice not found for this tenant." });
      }
      if (quoteId) {
        const invQ = inv.quote_id != null ? String(inv.quote_id).replace(/-/g, "").toLowerCase() : "";
        const bodyQ = quoteId.replace(/-/g, "").toLowerCase();
        if (invQ && invQ !== bodyQ) {
          return json(400, { error: "quote_id does not match this invoice." });
        }
      }
    }

    if (projectId) {
      const tpRows = await supabaseRequest(
        `tenant_projects?id=eq.${encodeURIComponent(projectId)}&tenant_id=eq.${tidEnc}&select=id`,
        { method: "GET" }
      );
      const tp = Array.isArray(tpRows) && tpRows[0] ? tpRows[0] : null;
      if (!tp?.id) {
        return json(404, { error: "Project not found for this tenant." });
      }
    }

    if (quoteId) {
      const qRows = await supabaseRequest(
        `quotes?id=eq.${encodeURIComponent(quoteId)}&tenant_id=eq.${tidEnc}&select=id`,
        { method: "GET" }
      );
      const q = Array.isArray(qRows) && qRows[0] ? qRows[0] : null;
      if (!q?.id) {
        return json(404, { error: "Quote not found for this tenant." });
      }
    }

    const insertPayload = {
      tenant_id: tenantId,
      quote_id: quoteId || null,
      invoice_id: invoiceId || null,
      project_id: projectId || null,
      payment_type: paymentType,
      payment_method: paymentMethod,
      amount,
      paid_at: paidAt,
      notes,
      created_by: createdBy
    };

    const created = await supabaseRequest("tenant_project_payments", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: insertPayload
    });

    const row = Array.isArray(created) ? created[0] : created;

    return json(200, {
      ok: true,
      payment: row || null
    });
  } catch (err) {
    console.error("[record-tenant-payment]", err);
    return json(500, { ok: false, error: err.message || "Server error" });
  }
};
