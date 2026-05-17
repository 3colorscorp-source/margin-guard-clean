const { readSessionFromEvent } = require("./_lib/session");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");
const { supabaseRequest } = require("./_lib/supabase-admin");
const { computeProjectOperationalSnapshot } = require("./_lib/project-operational-snapshot");

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  };
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function extractSupervisorBonusPctFromSnapshotPayload(payload) {
  if (!payload || typeof payload !== "object") return 1;
  const storage =
    payload.storage && typeof payload.storage === "object" ? payload.storage : {};
  const mg =
    storage.mg_settings_v2 && typeof storage.mg_settings_v2 === "object"
      ? storage.mg_settings_v2
      : {};
  return num(mg.supervisorBonusPct, 1);
}

async function loadSupervisorBonusPctForTenant(tenantId) {
  const tid = encodeURIComponent(tenantId);
  try {
    const rows = await supabaseRequest(
      `tenant_snapshots?tenant_id=eq.${tid}&select=payload&order=created_at.desc&limit=1`
    );
    const row = Array.isArray(rows) ? rows[0] : null;
    return extractSupervisorBonusPctFromSnapshotPayload(row?.payload);
  } catch (_e) {
    return 1;
  }
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

    const [reportRows, expenseRows, bonusPct] = await Promise.all([
      supabaseRequest(
        `tenant_project_reports?tenant_id=eq.${tid}&project_id=eq.${pid}&select=hours,days`
      ),
      supabaseRequest(
        `tenant_project_expenses?tenant_id=eq.${tid}&project_id=eq.${pid}&select=id`
      ),
      loadSupervisorBonusPctForTenant(tenant.id),
    ]);

    const operational_snapshot = computeProjectOperationalSnapshot({
      project,
      reports: Array.isArray(reportRows) ? reportRows : [],
      expenses: Array.isArray(expenseRows) ? expenseRows : [],
      supervisorBonusPctPoints: bonusPct,
    });

    return json(200, {
      ok: true,
      project_id: project.id,
      operational_snapshot,
    });
  } catch (err) {
    return json(500, { error: err.message || "Unexpected error" });
  }
};
