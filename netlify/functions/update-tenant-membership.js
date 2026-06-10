/**
 * Owner-only: suspend, reactivate, or remove seller/supervisor memberships.
 * Step 3E-C6-D — revokes assigned devices/sessions on suspend/remove.
 */

const { supabaseRequest } = require("./_lib/supabase-admin");
const { resolveMembershipById } = require("./_lib/membership-resolve");
const { requireOwnerMembership } = require("./_lib/tenant-device-guard");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_TARGET_ROLES = new Set(["seller", "supervisor"]);
const PROTECTED_ROLES = new Set(["owner", "admin"]);
const ALLOWED_STATUSES = new Set(["active", "suspended", "removed"]);
const REVOKABLE_DEVICE_STATUSES = new Set(["active", "pending_pair"]);

const MEMBERSHIP_SELECT =
  "id,email,display_name,full_name,role,status,invited_at,accepted_at,created_at";

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

function normText(value, maxLen) {
  return String(value || "")
    .trim()
    .slice(0, maxLen || 200);
}

function normStatus(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function normRole(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key);
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

async function revokeActiveDeviceSessions(deviceId, tenantId, nowIso) {
  const rows = await supabaseRequest(
    [
      "device_sessions",
      "?device_id=eq." + encodeURIComponent(deviceId),
      "&tenant_id=eq." + encodeURIComponent(tenantId),
      "&status=eq.active",
    ].join(""),
    {
      method: "PATCH",
      body: {
        status: "revoked",
        revoked_at: nowIso,
      },
    }
  );
  if (Array.isArray(rows)) return rows.length;
  return rows?.id ? 1 : 0;
}

async function revokeDevicesForMembership(tenantId, membershipId, nowIso) {
  const tid = encodeURIComponent(tenantId);
  const mid = encodeURIComponent(membershipId);
  const deviceRows = await supabaseRequest(
    [
      "tenant_devices",
      "?tenant_id=eq." + tid,
      "&assigned_membership_id=eq." + mid,
      "&status=in.(active,pending_pair)",
      "&select=id,status",
    ].join("")
  );
  const devices = Array.isArray(deviceRows) ? deviceRows : [];
  let revokedDevicesCount = 0;
  let revokedSessionsCount = 0;

  for (const device of devices) {
    if (!device?.id || !REVOKABLE_DEVICE_STATUSES.has(normStatus(device.status))) {
      continue;
    }
    const did = encodeURIComponent(device.id);
    await supabaseRequest(`tenant_devices?id=eq.${did}&tenant_id=eq.${tid}`, {
      method: "PATCH",
      body: {
        status: "revoked",
        revoked_at: nowIso,
      },
    });
    revokedDevicesCount += 1;
    revokedSessionsCount += await revokeActiveDeviceSessions(
      device.id,
      tenantId,
      nowIso
    );
  }

  return { revokedDevicesCount, revokedSessionsCount };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { error: "Method not allowed" });
    }

    const ctx = await requireOwnerMembership(event);
    const body = parseBody(event.body);
    if (body == null) {
      return json(400, { error: "Invalid JSON" });
    }

    if (hasOwn(body, "role") || hasOwn(body, "email") || hasOwn(body, "auth_user_id") || hasOwn(body, "authUserId")) {
      return json(400, {
        error: "role, email, and auth_user_id cannot be changed through this endpoint",
        code: "immutable_field",
      });
    }

    const membershipId = String(body.membership_id || body.membershipId || "").trim();
    if (!UUID_RE.test(membershipId)) {
      return json(400, {
        error: "Valid membership_id is required",
        code: "invalid_membership_id",
      });
    }

    if (membershipId === String(ctx.membership.id)) {
      return json(403, {
        error: "Owner membership cannot be updated through this endpoint",
        code: "protected_membership",
      });
    }

    const existing = await resolveMembershipById(
      supabaseRequest,
      ctx.tenant.id,
      membershipId
    );
    if (!existing?.id) {
      return json(404, {
        error: "Membership not found",
        code: "membership_not_found",
      });
    }

    const targetRole = normRole(existing.role);
    if (PROTECTED_ROLES.has(targetRole)) {
      return json(403, {
        error: "This membership cannot be updated through this endpoint",
        code: "protected_membership",
      });
    }
    if (!ALLOWED_TARGET_ROLES.has(targetRole)) {
      return json(403, {
        error: "This membership cannot be updated through this endpoint",
        code: "protected_membership",
      });
    }

    const hasStatus = hasOwn(body, "status");
    const hasDisplayName = hasOwn(body, "display_name") || hasOwn(body, "displayName");
    const hasFullName = hasOwn(body, "full_name") || hasOwn(body, "fullName");
    if (!hasStatus && !hasDisplayName && !hasFullName) {
      return json(400, {
        error: "At least one of status, display_name, or full_name is required",
        code: "no_updates",
      });
    }

    let nextStatus = normStatus(existing.status);
    if (hasStatus) {
      nextStatus = normStatus(body.status);
      if (!ALLOWED_STATUSES.has(nextStatus)) {
        return json(400, {
          error: "status must be active, suspended, or removed",
          code: "invalid_status",
        });
      }
    }

    const patchBody = {};
    if (hasStatus) {
      patchBody.status = nextStatus;
    }
    if (hasDisplayName) {
      patchBody.display_name = normText(body.display_name || body.displayName, 200);
    }
    if (hasFullName) {
      patchBody.full_name = normText(body.full_name || body.fullName, 200);
    }

    const nowIso = new Date().toISOString();
    let revokedDevicesCount = 0;
    let revokedSessionsCount = 0;
    if (hasStatus && (nextStatus === "suspended" || nextStatus === "removed")) {
      const revoked = await revokeDevicesForMembership(
        ctx.tenant.id,
        membershipId,
        nowIso
      );
      revokedDevicesCount = revoked.revokedDevicesCount;
      revokedSessionsCount = revoked.revokedSessionsCount;
    }

    const tid = encodeURIComponent(ctx.tenant.id);
    const mid = encodeURIComponent(membershipId);
    const updatedRows = await supabaseRequest(
      `profiles?id=eq.${mid}&tenant_id=eq.${tid}&select=${MEMBERSHIP_SELECT}`,
      {
        method: "PATCH",
        body: patchBody,
      }
    );
    const updated = Array.isArray(updatedRows) ? updatedRows[0] : updatedRows;
    if (!updated?.id) {
      return json(500, { error: "Membership row was not returned after update" });
    }

    return json(200, {
      ok: true,
      membership: serializeMembership(updated),
      revoked_devices_count: revokedDevicesCount,
      revoked_sessions_count: revokedSessionsCount,
    });
  } catch (err) {
    if (err.isGuardError) {
      return json(err.statusCode, { error: err.message, code: err.code });
    }
    return json(500, { error: err.message || "Unexpected error" });
  }
};
