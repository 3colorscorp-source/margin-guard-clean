const { readSessionFromEvent } = require("./_lib/session");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");
const { supabaseRequest } = require("./_lib/supabase-admin");
const { resolveAuthUserIdByEmail } = require("./_lib/auth-resolve-user-id");

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
    const projectId = String(body.project_id || "").trim();
    if (!projectId) {
      return json(400, { error: "project_id is required" });
    }

    let supervisorUserId = session.u ? String(session.u).trim() : "";
    if (!supervisorUserId) {
      supervisorUserId = (await resolveAuthUserIdByEmail(session.e)) || "";
    }
    if (!supervisorUserId) {
      return json(400, { error: "Could not resolve supervisor user id" });
    }

    const tid = encodeURIComponent(tenant.id);
    const existing = await supabaseRequest(
      `tenant_projects?id=eq.${encodeURIComponent(projectId)}&tenant_id=eq.${tid}&select=id`
    );
    const row = Array.isArray(existing) ? existing[0] : null;
    if (!row?.id) {
      return json(404, { error: "Project not found" });
    }

    const now = new Date().toISOString();
    await supabaseRequest(`tenant_projects?id=eq.${encodeURIComponent(projectId)}`, {
      method: "PATCH",
      body: {
        supervisor_user_id: supervisorUserId,
        status: "assigned",
        updated_at: now,
      },
    });

    return json(200, { ok: true, project_id: projectId, supervisor_user_id: supervisorUserId });
  } catch (err) {
    return json(500, { error: err.message || "Unexpected error" });
  }
};
