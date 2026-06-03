/**
 * Mark an operational plan day completed (Supervisor-safe, tenant-scoped).
 */

const { readSessionFromEvent } = require("./_lib/session");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");
const { supabaseRequest } = require("./_lib/supabase-admin");
const { resolveAuthUserIdByEmail } = require("./_lib/auth-resolve-user-id");
const {
  upsertDayProgressCompleted,
  reopenDayProgress,
} = require("./_lib/project-day-progress");

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

function str(v, max = 8000) {
  return String(v == null ? "" : v)
    .trim()
    .slice(0, max);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
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

    let supervisorUserId = session.u ? String(session.u).trim() : "";
    if (!supervisorUserId) {
      supervisorUserId = (await resolveAuthUserIdByEmail(session.e)) || "";
    }

    const body = parseBody(event.body);
    const projectId = str(body.project_id, 128);
    const dayNumber = Math.floor(num(body.day_number));
    const phase = str(body.phase, 500);
    const completionNote = str(body.completion_note || body.note, 8000);

    if (!UUID_RE.test(projectId)) {
      return json(400, { error: "Valid project_id is required" });
    }
    if (!Number.isFinite(dayNumber) || dayNumber < 1) {
      return json(400, { error: "day_number must be a positive integer" });
    }

    const tid = encodeURIComponent(tenant.id);
    const projRows = await supabaseRequest(
      `tenant_projects?id=eq.${encodeURIComponent(projectId)}&tenant_id=eq.${tid}&select=id&limit=1`
    );
    if (!Array.isArray(projRows) || !projRows[0]?.id) {
      return json(403, { error: "Project not found for this tenant" });
    }

    const reopen =
      body.reopen === true ||
      String(body.action || "")
        .trim()
        .toLowerCase() === "reopen";

    try {
      const result = reopen
        ? await reopenDayProgress({
            tenantId: tenant.id,
            projectId,
            dayNumber,
          })
        : await upsertDayProgressCompleted({
            tenantId: tenant.id,
            projectId,
            dayNumber,
            phase,
            completionNote,
            completedBy: supervisorUserId || null,
          });
      return json(200, { ok: true, ...result });
    } catch (err) {
      const msg = String(err?.message || err || "");
      if (/tenant_project_day_progress|relation|column|42703/i.test(msg)) {
        return json(500, {
          error:
            "Day progress table is not available. Run SUPABASE_TENANT_PROJECT_DAY_PROGRESS.sql in Supabase.",
        });
      }
      throw err;
    }
  } catch (err) {
    return json(500, { error: err.message || "Unexpected error" });
  }
};
