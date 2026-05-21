const { readSessionFromEvent } = require("./_lib/session");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");
const { supabaseRequest } = require("./_lib/supabase-admin");
const {
  mapBaselineRow,
  migrationBaselineForSupervisor,
  upsertMigrationBaseline,
  syncOperationalSnapshotDatesFromBaseline,
  loadMigrationBaseline,
} = require("./_lib/migration-baseline");

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
    const projectId = str(body.project_id, 128);
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

    const estDays = Number(body.estimated_total_days);
    if (!Number.isFinite(estDays) || estDays <= 0) {
      return json(400, { error: "estimated_total_days must be greater than zero" });
    }

    const result = await upsertMigrationBaseline(tenant.id, projectId, body);
    const baseline = await loadMigrationBaseline(tenant.id, projectId);
    if (baseline) {
      await syncOperationalSnapshotDatesFromBaseline(tenant.id, projectId, baseline);
      const patch = {
        estimated_days: baseline.estimated_total_days,
        due_date: baseline.target_finish_date,
        updated_at: new Date().toISOString(),
      };
      await supabaseRequest(
        `tenant_projects?id=eq.${encodeURIComponent(projectId)}&tenant_id=eq.${tid}`,
        { method: "PATCH", body: patch }
      );
    }

    return json(200, {
      ok: true,
      project_id: projectId,
      baseline: migrationBaselineForSupervisor(mapBaselineRow(baseline)),
      persist: result,
    });
  } catch (err) {
    return json(500, { error: err.message || "Unexpected error" });
  }
};
