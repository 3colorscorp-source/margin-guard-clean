const { readSessionFromEvent } = require("./_lib/session");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");
const { supabaseRequest } = require("./_lib/supabase-admin");
const { mapBaselineRow, loadMigrationBaseline } = require("./_lib/migration-baseline");

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
    const projRows = await supabaseRequest(
      `tenant_projects?id=eq.${encodeURIComponent(projectId)}&tenant_id=eq.${tid}&select=id&limit=1`
    );
    if (!Array.isArray(projRows) || !projRows[0]?.id) {
      return json(403, { error: "Project not found for this tenant" });
    }

    const baseline = await loadMigrationBaseline(tenant.id, projectId);

    return json(200, {
      ok: true,
      project_id: projectId,
      baseline: mapBaselineRow(baseline),
      has_baseline: Boolean(baseline),
    });
  } catch (err) {
    return json(500, { error: err.message || "Unexpected error" });
  }
};
