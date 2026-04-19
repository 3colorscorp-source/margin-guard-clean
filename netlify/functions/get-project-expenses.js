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

function mapRow(row) {
  if (!row || typeof row !== "object") return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    project_id: row.project_id,
    expense_date: row.expense_date == null ? null : String(row.expense_date).slice(0, 10),
    amount: Number(row.amount) || 0,
    note: row.note == null ? "" : String(row.note),
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
      `tenant_projects?id=eq.${encodeURIComponent(projectId)}&tenant_id=eq.${tid}&select=id`
    );
    const proj = Array.isArray(projRows) ? projRows[0] : null;
    if (!proj?.id) {
      return json(403, { error: "Project not found for this tenant" });
    }

    const rows = await supabaseRequest(
      `tenant_project_expenses?tenant_id=eq.${tid}&project_id=eq.${encodeURIComponent(projectId)}&select=*&order=expense_date.desc,created_at.desc`
    );
    const list = Array.isArray(rows) ? rows.map(mapRow).filter(Boolean) : [];

    return json(200, { ok: true, expenses: list });
  } catch (err) {
    return json(500, { error: err.message || "Unexpected error" });
  }
};
