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

    const tenants = await supabaseRequest(`tenants?stripe_customer_id=eq.${encodeURIComponent(session.c)}&select=*`);
    const tenant = Array.isArray(tenants) ? tenants[0] : null;
    if (!tenant) {
      return json(404, { error: "Tenant not found" });
    }

    const profiles = await supabaseRequest(`profiles?tenant_id=eq.${tenant.id}&email=eq.${encodeURIComponent(session.e)}&select=*`);
    const profile = Array.isArray(profiles) ? profiles[0] : null;

    return json(200, {
      ok: true,
      tenant,
      profile: profile || null
    });
  } catch (err) {
    return json(500, { error: err.message || "Unable to load tenant context" });
  }
};
