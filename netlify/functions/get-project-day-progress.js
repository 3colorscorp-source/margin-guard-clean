/**
 * GET — Owner-only day progress rows for Project Control metrics sync.
 * Query: project_id (required)
 */

const { readSessionFromEvent } = require("./_lib/session");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");
const {
  resolveProfileRoleForSession,
  roleMayAccessFinancialSnapshot,
} = require("./_lib/resolve-profile-role");
const { loadDayProgressForProject, countCompletedDays } = require("./_lib/project-day-progress");

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

    const role = await resolveProfileRoleForSession(session, tenant.id);
    if (!roleMayAccessFinancialSnapshot(role)) {
      return json(403, { error: "Day progress is restricted to owner role." });
    }

    const projectId = String(event.queryStringParameters?.project_id || "").trim();
    if (!projectId) {
      return json(400, { error: "project_id is required" });
    }

    const rows = await loadDayProgressForProject(tenant.id, projectId);
    return json(200, {
      ok: true,
      project_id: projectId,
      day_progress: rows,
      completed_count: countCompletedDays(rows),
    });
  } catch (err) {
    return json(500, { error: err.message || "Unexpected error" });
  }
};
