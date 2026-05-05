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

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
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
      `tenant_project_change_orders?id=eq.${encodeURIComponent(changeOrderId)}&tenant_id=eq.${tid}&select=*`
    );
    const co = Array.isArray(coRows) ? coRows[0] : null;
    if (!co?.id) {
      return json(404, { error: "Change order not found" });
    }

    const status = String(co.status || "").toLowerCase();
    if (status === "applied") {
      return json(200, {
        ok: false,
        applied: false,
        alreadyApplied: true,
        error: "Change order already applied.",
        changeOrderId: co.id,
        projectId: co.project_id,
      });
    }

    const projectId = str(co.project_id, 128);
    if (!projectId) {
      return json(400, { error: "Change order has no project_id" });
    }

    const projRows = await supabaseRequest(
      `tenant_projects?id=eq.${encodeURIComponent(projectId)}&tenant_id=eq.${tid}&select=*`
    );
    const proj = Array.isArray(projRows) ? projRows[0] : null;
    if (!proj?.id) {
      return json(403, { error: "Project not found for this tenant" });
    }

    const clientPrice = Math.max(0, num(co.client_price, 0));
    const salePrice = Math.max(0, num(proj.sale_price, 0));
    const prevApplied = Math.max(0, num(proj.applied_change_order_total, 0));
    const newApplied = prevApplied + clientPrice;
    const newProjected = salePrice + newApplied;

    const now = new Date().toISOString();

    await supabaseRequest(`tenant_project_change_orders?id=eq.${encodeURIComponent(changeOrderId)}&tenant_id=eq.${tid}`, {
      method: "PATCH",
      body: {
        status: "applied",
        updated_at: now,
      },
    });

    await supabaseRequest(`tenant_projects?id=eq.${encodeURIComponent(projectId)}&tenant_id=eq.${tid}`, {
      method: "PATCH",
      body: {
        applied_change_order_total: newApplied,
        projected_revenue_total: newProjected,
        updated_at: now,
      },
    });

    return json(200, {
      ok: true,
      applied: true,
      changeOrderId: co.id,
      projectId: projectId,
      appliedChangeOrderTotal: newApplied,
      projectedRevenueTotal: newProjected,
    });
  } catch (err) {
    return json(500, { error: err.message || "Unexpected error" });
  }
};
