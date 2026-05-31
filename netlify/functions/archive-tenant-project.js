/**
 * Soft-hide a tenant project from Project Control (does not delete row or touch invoices).
 */

const { readSessionFromEvent } = require("./_lib/session");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");
const { supabaseRequest } = require("./_lib/supabase-admin");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
    const projectId = String(body.project_id || body.projectId || "").trim();
    if (!UUID_RE.test(projectId)) {
      return json(400, { error: "Valid project_id is required" });
    }

    const tid = encodeURIComponent(tenant.id);
    const pid = encodeURIComponent(projectId);

    const rows = await supabaseRequest(
      `tenant_projects?id=eq.${pid}&tenant_id=eq.${tid}&select=id,hidden_from_project_control,status&limit=1`
    );
    const project = Array.isArray(rows) ? rows[0] : null;
    if (!project?.id) {
      return json(403, { error: "Project not found for this tenant" });
    }

    if (project.hidden_from_project_control === true) {
      return json(200, {
        ok: true,
        id: project.id,
        already_hidden: true,
        method: "hidden_from_project_control",
      });
    }

    const nowIso = new Date().toISOString();
    const patch = {
      hidden_from_project_control: true,
      project_control_archived_at: nowIso,
      updated_at: nowIso,
    };

    try {
      await supabaseRequest(`tenant_projects?id=eq.${pid}&tenant_id=eq.${tid}`, {
        method: "PATCH",
        body: patch,
      });
    } catch (err) {
      const msg = String(err?.message || err || "");
      if (/hidden_from_project_control|column/i.test(msg)) {
        return json(500, {
          error:
            "Project Control archive columns are missing. Run SUPABASE_TENANT_PROJECTS_PROJECT_CONTROL_ARCHIVE.sql in Supabase.",
        });
      }
      throw err;
    }

    return json(200, {
      ok: true,
      id: project.id,
      already_hidden: false,
      method: "hidden_from_project_control",
      archived_at: nowIso,
    });
  } catch (err) {
    return json(500, { error: err.message || "Unexpected error" });
  }
};
