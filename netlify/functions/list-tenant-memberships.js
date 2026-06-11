/**
 * Owner-only: list tenant memberships (profiles) for the owner tenant.
 * Step 3E-C6-B — read-only membership management.
 * Step 3E-C14-E1A — safe onboarding status fields (auth_linked, supervisor counts).
 */

const { supabaseRequest } = require("./_lib/supabase-admin");
const { requireOwnerMembership } = require("./_lib/tenant-device-guard");

const ALLOWED_ROLE_FILTERS = new Set(["owner", "admin", "seller", "supervisor"]);
const ALLOWED_STATUS_FILTERS = new Set(["invited", "active", "suspended", "removed"]);

const LIST_SELECT =
  "id,email,display_name,full_name,role,status,invited_at,accepted_at,created_at,auth_user_id";

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  };
}

function normFilter(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function normRole(value) {
  return normFilter(value);
}

function serializeMembership(row, opts = {}) {
  const authUserId = String(row.auth_user_id || "").trim();
  const role = normRole(row.role);
  const out = {
    id: row.id,
    email: row.email || null,
    display_name: String(row.display_name || "").trim(),
    full_name: String(row.full_name || "").trim(),
    role: row.role || null,
    status: row.status || null,
    invited_at: row.invited_at || null,
    accepted_at: row.accepted_at || null,
    created_at: row.created_at || null,
    auth_linked: Boolean(authUserId),
  };
  if (role === "supervisor") {
    out.assigned_project_count = Number(opts.assignedProjectCount) || 0;
    out.active_device_count = Number(opts.activeDeviceCount) || 0;
  }
  return out;
}

async function loadAssignedProjectCountsByAuthUserId(tenantId, authUserIds) {
  const counts = new Map();
  for (const id of authUserIds) {
    counts.set(id, 0);
  }
  if (!authUserIds.length) {
    return counts;
  }

  const tid = encodeURIComponent(tenantId);
  const rows = await supabaseRequest(
    `tenant_projects?tenant_id=eq.${tid}&select=supervisor_user_id`
  );
  if (!Array.isArray(rows)) {
    return counts;
  }
  for (const row of rows) {
    const supervisorId = String(row.supervisor_user_id || "").trim();
    if (!supervisorId || !counts.has(supervisorId)) {
      continue;
    }
    counts.set(supervisorId, (counts.get(supervisorId) || 0) + 1);
  }
  return counts;
}

async function loadActiveSupervisorDeviceCountsByMembershipId(tenantId, membershipIds) {
  const counts = new Map();
  for (const id of membershipIds) {
    counts.set(id, 0);
  }
  if (!membershipIds.length) {
    return counts;
  }

  const tid = encodeURIComponent(tenantId);
  const rows = await supabaseRequest(
    `tenant_devices?tenant_id=eq.${tid}&status=eq.active&portal_type=eq.supervisor&select=assigned_membership_id`
  );
  if (!Array.isArray(rows)) {
    return counts;
  }
  for (const row of rows) {
    const membershipId = String(row.assigned_membership_id || "").trim();
    if (!membershipId || !counts.has(membershipId)) {
      continue;
    }
    counts.set(membershipId, (counts.get(membershipId) || 0) + 1);
  }
  return counts;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "GET") {
      return json(405, { error: "Method not allowed" });
    }

    const ctx = await requireOwnerMembership(event);
    const params = event.queryStringParameters || {};

    const roleFilter = normFilter(params.role);
    if (roleFilter && !ALLOWED_ROLE_FILTERS.has(roleFilter)) {
      return json(400, {
        error: "role must be owner, admin, seller, or supervisor",
        code: "invalid_role_filter",
      });
    }

    const statusFilter = normFilter(params.status);
    if (statusFilter && !ALLOWED_STATUS_FILTERS.has(statusFilter)) {
      return json(400, {
        error: "status must be invited, active, suspended, or removed",
        code: "invalid_status_filter",
      });
    }

    const parts = [
      "profiles",
      "?tenant_id=eq." + encodeURIComponent(ctx.tenant.id),
      "&select=" + LIST_SELECT,
    ];
    if (roleFilter) {
      parts.push("&role=eq." + encodeURIComponent(roleFilter));
    }
    if (statusFilter) {
      parts.push("&status=eq." + encodeURIComponent(statusFilter));
    }
    parts.push("&order=role.asc,email.asc");

    const rows = await supabaseRequest(parts.join(""));
    const memberships = Array.isArray(rows) ? rows : [];

    const supervisorRows = memberships.filter((row) => normRole(row.role) === "supervisor");
    const linkedSupervisorAuthIds = [
      ...new Set(
        supervisorRows
          .map((row) => String(row.auth_user_id || "").trim())
          .filter(Boolean)
      ),
    ];
    const supervisorMembershipIds = [
      ...new Set(
        supervisorRows.map((row) => String(row.id || "").trim()).filter(Boolean)
      ),
    ];

    const [projectCountsByAuth, deviceCountsByMembership] = await Promise.all([
      loadAssignedProjectCountsByAuthUserId(ctx.tenant.id, linkedSupervisorAuthIds),
      loadActiveSupervisorDeviceCountsByMembershipId(
        ctx.tenant.id,
        supervisorMembershipIds
      ),
    ]);

    return json(200, {
      ok: true,
      memberships: memberships.map((row) => {
        const role = normRole(row.role);
        const authUserId = String(row.auth_user_id || "").trim();
        const membershipId = String(row.id || "").trim();
        const opts = {};
        if (role === "supervisor") {
          opts.assignedProjectCount = authUserId
            ? projectCountsByAuth.get(authUserId) || 0
            : 0;
          opts.activeDeviceCount = deviceCountsByMembership.get(membershipId) || 0;
        }
        return serializeMembership(row, opts);
      }),
    });
  } catch (err) {
    if (err.isGuardError) {
      return json(err.statusCode, { error: err.message, code: err.code });
    }
    return json(500, { error: err.message || "Unexpected error" });
  }
};
