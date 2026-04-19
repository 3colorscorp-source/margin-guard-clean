const { readSessionFromEvent } = require("./_lib/session");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");
const { supabaseRequest } = require("./_lib/supabase-admin");

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  };
}

function parseBody(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

function str(v, max = 128) {
  return String(v == null ? "" : v)
    .trim()
    .slice(0, max);
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { error: "Method not allowed" });
    }

    const session = readSessionFromEvent(event);
    if (!session?.e || !session?.c) {
      return json(401, { error: "Unauthorized" });
    }

    const tenant = await resolveTenantFromSession(session);
    if (!tenant?.id) {
      return json(404, { error: "Tenant not found" });
    }

    const body = parseBody(event.body);
    const changeOrderId = str(body.change_order_id, 128);
    if (!changeOrderId) {
      return json(400, { error: "change_order_id is required" });
    }

    const tid = encodeURIComponent(tenant.id);
    const coRows = await supabaseRequest(
      `tenant_project_change_orders?id=eq.${encodeURIComponent(changeOrderId)}&tenant_id=eq.${tid}&select=id,status`
    );
    const co = Array.isArray(coRows) ? coRows[0] : null;
    if (!co?.id) {
      return json(404, { error: "Change order not found" });
    }

    const status = String(co.status || "").toLowerCase();
    if (status === "applied") {
      return json(200, {
        ok: false,
        deleted: false,
        error: "Applied change orders cannot be deleted.",
        changeOrderId: co.id,
      });
    }

    await supabaseRequest(`tenant_project_change_orders?id=eq.${encodeURIComponent(changeOrderId)}&tenant_id=eq.${tid}`, {
      method: "DELETE",
    });

    return json(200, { ok: true, deleted: true, changeOrderId: co.id });
  } catch (err) {
    return json(500, { error: err.message || "Unexpected error" });
  }
};
