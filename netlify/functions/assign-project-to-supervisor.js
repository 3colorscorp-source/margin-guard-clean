/**
 * Step 3E-C14-C4b — Owner assigns one tenant project to one active supervisor membership.
 * Sets tenant_projects.supervisor_user_id from membership.auth_user_id (not session user).
 */

const { supabaseRequest } = require("./_lib/supabase-admin");
const {
  membershipIsActive,
  membershipRole,
  resolveMembershipById,
} = require("./_lib/membership-resolve");
const { requireOwnerMembership } = require("./_lib/tenant-device-guard");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Project statuses eligible for supervisor assignment. */
const ASSIGNABLE_PROJECT_STATUSES = new Set([
  "signed",
  "assigned",
  "active",
  "in_progress",
  "approved",
  "deposit_paid",
]);

/** Keep current status when already past initial assignment. */
const PRESERVE_PROJECT_STATUSES = new Set([
  "in_progress",
  "completed",
  "deposit_paid",
]);

const PROJECT_SAFE_SELECT = "id,project_name,status";

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

function normStatus(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function supervisorDisplayName(membership) {
  const display = String(membership?.display_name || "").trim();
  const full = String(membership?.full_name || "").trim();
  return display || full || "";
}

function resolvePostAssignStatus(currentStatus) {
  const st = normStatus(currentStatus);
  if (PRESERVE_PROJECT_STATUSES.has(st)) return st;
  if (st === "assigned") return "assigned";
  return "assigned";
}

function safeProjectResponse(row) {
  return {
    name: String(row?.project_name || "").trim(),
    status: normStatus(row?.status) || "signed",
  };
}

function safeSupervisorResponse(membership) {
  return {
    email: String(membership?.email || "").trim(),
    display_name: supervisorDisplayName(membership),
  };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { error: "Method not allowed", code: "method_not_allowed" });
    }

    const ctx = await requireOwnerMembership(event);
    const body = parseBody(event.body);
    if (body == null) {
      return json(400, { error: "Invalid JSON body", code: "invalid_json" });
    }

    const projectId = String(body.project_id || body.projectId || "").trim();
    const supervisorMembershipId = String(
      body.supervisor_membership_id || body.supervisorMembershipId || ""
    ).trim();

    if (!projectId) {
      return json(400, { error: "project_id is required", code: "missing_project_id" });
    }
    if (!supervisorMembershipId) {
      return json(400, {
        error: "supervisor_membership_id is required",
        code: "missing_supervisor_membership_id",
      });
    }
    if (!UUID_RE.test(projectId)) {
      return json(400, { error: "Invalid project id", code: "invalid_project_id" });
    }
    if (!UUID_RE.test(supervisorMembershipId)) {
      return json(400, {
        error: "Invalid supervisor membership id",
        code: "invalid_supervisor_membership_id",
      });
    }

    const tid = encodeURIComponent(ctx.tenant.id);
    const pid = encodeURIComponent(projectId);

    const projectRows = await supabaseRequest(
      `tenant_projects?id=eq.${pid}&tenant_id=eq.${tid}&select=${PROJECT_SAFE_SELECT}&limit=1`
    );
    const project = Array.isArray(projectRows) ? projectRows[0] : null;
    if (!project?.id) {
      return json(404, { error: "Project not found", code: "project_not_found" });
    }

    const projectStatus = normStatus(project.status);
    if (!ASSIGNABLE_PROJECT_STATUSES.has(projectStatus)) {
      return json(409, {
        error: "Project is not in an assignable status",
        code: "project_not_assignable",
      });
    }

    const supervisorMembership = await resolveMembershipById(
      supabaseRequest,
      ctx.tenant.id,
      supervisorMembershipId
    );
    if (!supervisorMembership?.id) {
      return json(404, { error: "Supervisor membership not found", code: "supervisor_not_found" });
    }

    const role = membershipRole(supervisorMembership);
    if (role === "owner" || supervisorMembership.id === ctx.membership.id) {
      return json(403, {
        error: "Cannot assign project to owner membership",
        code: "cannot_assign_owner_as_supervisor_device",
      });
    }
    if (role !== "supervisor") {
      return json(403, {
        error: "Supervisor membership required",
        code: "supervisor_role_required",
      });
    }
    if (!membershipIsActive(supervisorMembership)) {
      return json(403, {
        error: "Supervisor membership must be active",
        code: "supervisor_active_required",
      });
    }

    const authUserId = String(supervisorMembership.auth_user_id || "").trim();
    if (!authUserId) {
      return json(409, {
        error: "Supervisor must sign in once before project assignment",
        code: "supervisor_auth_user_id_missing",
      });
    }

    const nowIso = new Date().toISOString();
    const nextStatus = resolvePostAssignStatus(project.status);
    const patchBody = {
      supervisor_user_id: authUserId,
      status: nextStatus,
      updated_at: nowIso,
    };

    let patched;
    try {
      patched = await supabaseRequest(`tenant_projects?id=eq.${pid}&tenant_id=eq.${tid}`, {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: patchBody,
      });
    } catch (_err) {
      return json(500, { error: "Assignment failed", code: "assignment_failed" });
    }

    const updated = Array.isArray(patched) ? patched[0] : patched;
    if (!updated?.id) {
      return json(500, { error: "Assignment failed", code: "assignment_failed" });
    }

    const refreshedRows = await supabaseRequest(
      `tenant_projects?id=eq.${pid}&tenant_id=eq.${tid}&select=${PROJECT_SAFE_SELECT}&limit=1`
    );
    const refreshed = Array.isArray(refreshedRows) ? refreshedRows[0] : updated;

    return json(200, {
      ok: true,
      project: safeProjectResponse(refreshed),
      supervisor: safeSupervisorResponse(supervisorMembership),
    });
  } catch (err) {
    if (err.isGuardError) {
      return json(err.statusCode, { error: err.message, code: err.code });
    }
    return json(500, { error: "Assignment failed", code: "assignment_failed" });
  }
};
