/**
 * Mark an operational plan day completed (Supervisor-safe, tenant-scoped).
 */

const { resolveAuthUserIdByEmail } = require("./_lib/auth-resolve-user-id");
const { mapDeviceDayProgressWriteResult } = require("./_lib/supervisor-device-field-dto");
const {
  isOwnerContext,
  loadTenantProjectForSupervisorAction,
  resolveOwnerOrSupervisorContext,
} = require("./_lib/tenant-device-guard");
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
    return null;
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

async function resolveOwnerActorUserId(session) {
  let supervisorUserId = session?.u ? String(session.u).trim() : "";
  if (!supervisorUserId) {
    supervisorUserId = (await resolveAuthUserIdByEmail(session.e)) || "";
  }
  return supervisorUserId;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { error: "Method not allowed" });
    }

    const body = parseBody(event.body);
    if (body == null) {
      return json(400, { error: "Invalid JSON", code: "invalid_json" });
    }

    const ctx = await resolveOwnerOrSupervisorContext(event);
    const isDevice = ctx.auth_mode === "device";
    const tenant = ctx.tenant;
    if (!tenant?.id) {
      return json(404, { error: "Tenant not found" });
    }

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

    await loadTenantProjectForSupervisorAction(ctx, projectId);

    let supervisorUserId = null;
    if (isDevice) {
      const authUserId = String(ctx.membership?.auth_user_id || "").trim();
      if (!authUserId) {
        return json(403, {
          error: "Supervisor must sign in once before updating day progress",
          code: "supervisor_auth_user_id_missing",
        });
      }
      supervisorUserId = authUserId;
    } else if (isOwnerContext(ctx)) {
      supervisorUserId = (await resolveOwnerActorUserId(ctx.session)) || null;
    } else {
      return json(403, { error: "Forbidden", code: "forbidden" });
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
            completedBy: supervisorUserId,
          });

      if (isDevice) {
        return json(200, mapDeviceDayProgressWriteResult(result));
      }

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
    if (err.isGuardError) {
      return json(err.statusCode || 403, {
        error: err.message,
        code: err.code || "guard_error",
      });
    }
    return json(500, { error: err.message || "Unexpected error" });
  }
};
