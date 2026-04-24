const fetch = globalThis.fetch;
if (!fetch) {
  throw new Error("Global fetch is not available. Set Netlify Node to 18+.");
}

const { readSessionFromEvent } = require("./_lib/session");
const { supabaseRequest } = require("./_lib/supabase-admin");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
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

    const tenantRows = await supabaseRequest(
      `tenants?id=eq.${encodeURIComponent(tenantId)}&select=id,name,owner_email`
    );
    const tenantRow = Array.isArray(tenantRows) ? tenantRows[0] : null;

    const webhookUrl = String(process.env.ZAPIER_INVOICE_SEND_WEBHOOK_URL || "").trim();
    if (!webhookUrl) {
      return json(503, { ok: false, error: "Invoice send webhook is not configured." });
    }

    const token = String(invoice.public_token || "").trim();
    if (!token) {
      return json(422, { ok: false, error: "Invoice has no public_token; publish or sync draft first." });
    }

    const origin = originFromEvent(event);
    const publicInvoiceUrl = origin
      ? `${origin}/invoice-public.html?token=${encodeURIComponent(token)}`
      : `/invoice-public.html?token=${encodeURIComponent(token)}`;

    const tenantEmail = pickFirstStr(session.e, tenantRow?.owner_email);
    const businessName = pickFirstStr(invoice.business_name, tenantRow?.name);
    const clientEmail = pickFirstStr(invoice.customer_email);

    const amt = Number(invoice.amount || 0);
    const bal =
      invoice.balance_due != null && invoice.balance_due !== ""
        ? Number(invoice.balance_due)
        : amt - Number(invoice.paid_amount || 0);

    const payload = {
      event_type: "invoice_sent",
      invoice_id: invoice.id,
      invoice_no: invoice.invoice_no || "",
      client_email: clientEmail,
      tenant_email: tenantEmail,
      business_name: businessName,
      project_name: invoice.project_name || "",
      amount: amt,
      balance_due: Number.isFinite(bal) ? bal : amt,
      due_date: invoice.due_date || "",
      public_invoice_url: publicInvoiceUrl,
      public_token: token
    };

    let zapRes;
    try {
      zapRes = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload)
      });
    } catch (err) {
      console.warn("[Invoice Send] Zapier request failed", err?.message || err);
      return json(502, { ok: false, error: "Unable to reach invoice send webhook." });
    }

    if (!zapRes.ok) {
      const text = await zapRes.text().catch(() => "");
      console.warn("[Invoice Send] Zapier non-OK", zapRes.status, text.slice(0, 500));
      return json(502, { ok: false, error: "Invoice send webhook returned an error." });
    }

    console.log("[Invoice Send] Zapier completed");

    const sentAt = new Date().toISOString();
    const filter = `id=eq.${encodeURIComponent(String(invoice.id))}&tenant_id=eq.${encodeURIComponent(tenantId)}`;
    const updated = await supabaseRequest(`invoices?${filter}`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: { sent_at: sentAt, status: "sent" }
    });
    const rows = Array.isArray(updated) ? updated : updated ? [updated] : [];
    const row = rows[0];
    if (!row?.id) {
      return json(500, { ok: false, error: "Invoice was forwarded but could not be updated in the database." });
    }

    console.log("[Invoice Send] invoice marked sent");

    return json(200, { ok: true, forwarded: true, invoice: row });
  } catch (err) {
    console.warn("[Invoice Send] error", err?.message || err);
    return json(500, { ok: false, error: err.message || "Server error" });
  }
};
