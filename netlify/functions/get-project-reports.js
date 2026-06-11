const { supabaseRequest } = require("./_lib/supabase-admin");
const { mapDeviceReportList } = require("./_lib/supervisor-device-field-dto");
const {
  loadTenantProjectForSupervisorAction,
  resolveOwnerOrSupervisorContext,
} = require("./_lib/tenant-device-guard");

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  };
}

function mapRow(row) {
  if (!row || typeof row !== "object") return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    project_id: row.project_id,
    entry_date: row.entry_date == null ? null : String(row.entry_date).slice(0, 10),
    hours: Number(row.hours) || 0,
    days: Number(row.days) || 0,
    note: row.note == null ? "" : String(row.note),
    day_number:
      row.day_number == null || row.day_number === ""
        ? null
        : Math.max(1, Math.floor(Number(row.day_number) || 0)) || null,
    phase: row.phase == null ? "" : String(row.phase),
    created_by: row.created_by ?? null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
  };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "GET") {
      return json(405, { error: "Method not allowed" });
    }

    const ctx = await resolveOwnerOrSupervisorContext(event);
    const isDevice = ctx.auth_mode === "device";
    const tenant = ctx.tenant;
    if (!tenant?.id) {
      return json(404, { error: "Tenant not found" });
    }

    const qs = event.queryStringParameters || {};
    const projectId = String(qs.project_id || "").trim();
    if (!projectId) {
      return json(400, { error: "project_id is required" });
    }

    await loadTenantProjectForSupervisorAction(ctx, projectId);

    const tid = encodeURIComponent(tenant.id);
    const rows = await supabaseRequest(
      `tenant_project_reports?tenant_id=eq.${tid}&project_id=eq.${encodeURIComponent(projectId)}&select=*&order=entry_date.desc,created_at.desc`
    );
    const list = Array.isArray(rows) ? rows : [];

    if (isDevice) {
      return json(200, { ok: true, reports: mapDeviceReportList(list) });
    }

    const reports = list.map(mapRow).filter(Boolean);
    return json(200, { ok: true, reports });
  } catch (err) {
    if (err.isGuardError) {
      return json(err.statusCode || 403, {
        error: err.message,
        code: err.code || "guard_error",
      });
    }
    return json(500, { error: "Fetch failed", code: "fetch_failed" });
  }
};
