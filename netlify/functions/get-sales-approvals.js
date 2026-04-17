const { readSessionFromEvent } = require("./_lib/session");
const { supabaseRequest } = require("./_lib/supabase-admin");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "GET") {
      return json(405, { error: "Method Not Allowed" });
    }

    const session = readSessionFromEvent(event);
    if (!session?.e || !session?.c) {
      return json(401, { error: "Unauthorized" });
    }

    const tenant = await resolveTenantFromSession(session);
    if (!tenant?.id) {
      return json(422, {
        error:
          "Cannot load approvals: missing tenant for this account. Run bootstrap-tenant before continuing."
      });
    }

    const path = `sales_approvals?tenant_id=eq.${encodeURIComponent(String(tenant.id))}&order=created_at.desc`;
    let rows;
    try {
      rows = await supabaseRequest(path, { method: "GET" });
    } catch (err) {
      return json(502, {
        error: err?.message || "Failed to load sales approvals"
      });
    }

    const approvals = Array.isArray(rows) ? rows : [];

    return json(200, { ok: true, approvals });
  } catch (err) {
    return json(500, { error: err.message || "Server error" });
  }
};
