/**
 * Soft-archive a tenant project from Project Control (status update only; no row delete).
 * Uses existing tenant_projects.status — prefers "archived", falls back to "cancelled"
 * when the DB check constraint does not yet allow "archived".
 */

const { readSessionFromEvent } = require("./_lib/session");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");
const { supabaseRequest } = require("./_lib/supabase-admin");
const {
  PROJECT_CONTROL_EXCLUDED_STATUSES,
} = require("./_lib/tenant-production-projects");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ARCHIVE_STATUS_PREFERRED = "archived";
const ARCHIVE_STATUS_FALLBACK = "cancelled";

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

function normStatus(s) {
  return String(s || "")
    .trim()
    .toLowerCase();
}

function isAlreadyArchived(status) {
  const st = normStatus(status);
  return (
    PROJECT_CONTROL_EXCLUDED_STATUSES.has(st) &&
    (st === ARCHIVE_STATUS_PREFERRED || st === ARCHIVE_STATUS_FALLBACK)
  );
}

async function patchProjectStatus(tid, pid, status, nowIso) {
  await supabaseRequest(`tenant_projects?id=eq.${pid}&tenant_id=eq.${tid}`, {
    method: "PATCH",
    body: { status, updated_at: nowIso },
  });
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
      `tenant_projects?id=eq.${pid}&tenant_id=eq.${tid}&select=id,status&limit=1`
    );
    const project = Array.isArray(rows) ? rows[0] : null;
    if (!project?.id) {
      return json(403, { error: "Project not found for this tenant" });
    }

    if (isAlreadyArchived(project.status)) {
      return json(200, {
        ok: true,
        id: project.id,
        already_archived: true,
        status: normStatus(project.status),
      });
    }

    const nowIso = new Date().toISOString();
    let appliedStatus = ARCHIVE_STATUS_PREFERRED;

    try {
      await patchProjectStatus(tid, pid, ARCHIVE_STATUS_PREFERRED, nowIso);
    } catch (err) {
      const msg = String(err?.message || err || "");
      const constraintBlocked =
        /check constraint|invalid input value|violates|archived/i.test(msg);
      if (!constraintBlocked) {
        throw err;
      }
      appliedStatus = ARCHIVE_STATUS_FALLBACK;
      await patchProjectStatus(tid, pid, ARCHIVE_STATUS_FALLBACK, nowIso);
    }

    return json(200, {
      ok: true,
      id: project.id,
      already_archived: false,
      status: appliedStatus,
      updated_at: nowIso,
    });
  } catch (err) {
    return json(500, { error: err.message || "Unexpected error" });
  }
};
