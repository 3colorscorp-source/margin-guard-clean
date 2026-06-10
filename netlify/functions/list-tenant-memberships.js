/**
 * Owner-only: list tenant memberships (profiles) for the owner tenant.
 * Step 3E-C6-B — read-only membership management.
 */

const { supabaseRequest } = require("./_lib/supabase-admin");
const { requireOwnerMembership } = require("./_lib/tenant-device-guard");

const ALLOWED_ROLE_FILTERS = new Set(["owner", "admin", "seller", "supervisor"]);
const ALLOWED_STATUS_FILTERS = new Set(["invited", "active", "suspended", "removed"]);

const LIST_SELECT =
  "id,email,display_name,full_name,role,status,invited_at,accepted_at,created_at";

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

function serializeMembership(row) {
  return {
    id: row.id,
    email: row.email || null,
    display_name: String(row.display_name || "").trim(),
    full_name: String(row.full_name || "").trim(),
    role: row.role || null,
    status: row.status || null,
    invited_at: row.invited_at || null,
    accepted_at: row.accepted_at || null,
    created_at: row.created_at || null,
  };
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

    return json(200, {
      ok: true,
      memberships: memberships.map(serializeMembership),
    });
  } catch (err) {
    if (err.isGuardError) {
      return json(err.statusCode, { error: err.message, code: err.code });
    }
    return json(500, { error: err.message || "Unexpected error" });
  }
};
