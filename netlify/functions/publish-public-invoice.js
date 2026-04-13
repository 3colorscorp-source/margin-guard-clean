const { readSessionFromEvent } = require("./_lib/session");
const { supabaseRequest } = require("./_lib/supabase-admin");

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
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

    const tenantRows = await supabaseRequest(
      `tenants?stripe_customer_id=eq.${encodeURIComponent(session.c)}&select=id`
    );
    const tenant = Array.isArray(tenantRows) ? tenantRows[0] : null;
    if (!tenant?.id) {
      return json(404, { error: "Tenant not found. Run bootstrap first." });
    }

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch (_err) {
      return json(400, { error: "Invalid JSON" });
    }

    const clientTenantId = body.tenant_id ?? body.tenantId;
    if (
      clientTenantId != null &&
      clientTenantId !== "" &&
      String(clientTenantId) !== String(tenant.id)
    ) {
      return json(403, { error: "Forbidden" });
    }

    const publicToken = body.public_token || `inv_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

    const payload = {
      tenant_id: tenant.id,
      public_token: publicToken,
      invoice_no: body.invoice_no || `INV-${Date.now()}`,
      customer_name: body.customer_name || "",
      customer_email: body.customer_email || "",
      project_name: body.project_name || "",
      amount: Number(body.amount || 0),
      paid_amount: Number(body.paid_amount || 0),
      balance_due: Number(body.balance_due || 0),
      issue_date: body.issue_date || new Date().toISOString().slice(0, 10),
      due_date: body.due_date || "",
      type: body.type || "service",
      notes: body.notes || "",
      payment_link: body.payment_link || "",
      business_name: body.business_name || "",
      logo_url: body.logo_url || "",
      accent_color: body.accent_color || "",
      currency: body.currency || "USD",
      status: body.status || "OPEN"
    };

    let inserted;
    try {
      inserted = await supabaseRequest("invoices", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=representation" },
        body: payload
      });
    } catch (err) {
      return json(502, { error: err.message || "Supabase write failed" });
    }

    const siteUrl = (
      process.env.URL ||
      process.env.DEPLOY_PRIME_URL ||
      process.env.SITE_URL ||
      ""
    ).replace(/\/+$/, "");

    const publicUrl = siteUrl
      ? `${siteUrl}/invoice-public.html?token=${encodeURIComponent(publicToken)}`
      : `/invoice-public.html?token=${encodeURIComponent(publicToken)}`;

    const row = Array.isArray(inserted) ? inserted[0] : inserted;

    return json(200, {
      ok: true,
      tenant_id: tenant.id,
      public_token: publicToken,
      public_url: publicUrl,
      row: row || null
    });
  } catch (err) {
    return json(500, { error: err.message || "Server error" });
  }
};
