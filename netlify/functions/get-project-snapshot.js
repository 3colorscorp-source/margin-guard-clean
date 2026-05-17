const { readSessionFromEvent } = require("./_lib/session");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");
const { supabaseRequest } = require("./_lib/supabase-admin");
const { computeProjectSnapshot } = require("./_lib/project-snapshot");

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
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

    const tenant = await resolveTenantFromSession(session);
    if (!tenant?.id) {
      return json(404, { error: "Tenant not found" });
    }

    const qs = event.queryStringParameters || {};
    const projectId = String(qs.project_id || "").trim();
    if (!projectId) {
      return json(400, { error: "project_id is required" });
    }

    const tid = encodeURIComponent(tenant.id);
    const pid = encodeURIComponent(projectId);

    const projRows = await supabaseRequest(
      `tenant_projects?id=eq.${pid}&tenant_id=eq.${tid}&select=*`
    );
    const project = Array.isArray(projRows) ? projRows[0] : null;
    if (!project?.id) {
      return json(403, { error: "Project not found for this tenant" });
    }

    const [reportRows, expenseRows, coRows] = await Promise.all([
      supabaseRequest(
        `tenant_project_reports?tenant_id=eq.${tid}&project_id=eq.${pid}&select=hours,days`
      ),
      supabaseRequest(
        `tenant_project_expenses?tenant_id=eq.${tid}&project_id=eq.${pid}&select=amount`
      ),
      supabaseRequest(
        `tenant_project_change_orders?tenant_id=eq.${tid}&project_id=eq.${pid}&select=client_price,status`
      ),
    ]);

    const reports = Array.isArray(reportRows) ? reportRows : [];
    const expenses = Array.isArray(expenseRows) ? expenseRows : [];
    const changeOrders = Array.isArray(coRows) ? coRows : [];

    const snapshot = computeProjectSnapshot({
      project,
      reports,
      expenses,
      changeOrders,
    });

    return json(200, {
      ok: true,
      project_id: project.id,
      snapshot,
    });
  } catch (err) {
    return json(500, { error: err.message || "Unexpected error" });
  }
};
