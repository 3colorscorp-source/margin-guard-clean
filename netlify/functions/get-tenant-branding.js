const { readSessionFromEvent } = require("./_lib/session");
const { supabaseRequest } = require("./_lib/supabase-admin");

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "GET") {
      return json(405, { error: "Method not allowed" });
    }

    const session = readSessionFromEvent(event);
    if (!session?.e || !session?.c) {
      return json(401, { error: "Unauthorized" });
    }

    const tenants = await supabaseRequest(
      `tenants?stripe_customer_id=eq.${encodeURIComponent(session.c)}&select=id,name`
    );
    const tenant = Array.isArray(tenants) ? tenants[0] : null;
    if (!tenant?.id) {
      return json(404, { error: "Tenant not found. Run bootstrap first." });
    }

    let branding = null;
    try {
      const rows = await supabaseRequest(
        `tenant_branding?tenant_id=eq.${tenant.id}&select=*`
      );
      branding = Array.isArray(rows) ? rows[0] : rows;
    } catch (_err) {
      branding = null;
    }

    const fallbackName = String(tenant.name || "").trim();
    const merged = {
      business_name: String(branding?.business_name || fallbackName || "").trim(),
      logo_url: String(branding?.logo_url || "").trim(),
      business_email: String(branding?.business_email || "").trim(),
      business_phone: String(branding?.business_phone || "").trim(),
      business_address: String(branding?.business_address || "").trim()
    };

    return json(200, { ok: true, branding: merged });
  } catch (err) {
    return json(500, { error: err.message || "Unable to load tenant branding" });
  }
};
