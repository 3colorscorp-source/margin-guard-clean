/**
 * Owner-only: permanently delete a seller/supervisor membership.
 * Assigned devices and sessions are deleted first (tenant-scoped).
 * Quotes/projects keep history; membership attribution FKs SET NULL.
 */

const { supabaseRequest } = require("./_lib/supabase-admin");
const { resolveMembershipById } = require("./_lib/membership-resolve");
const { requireOwnerMembership } = require("./_lib/tenant-device-guard");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_TARGET_ROLES = new Set(["seller", "supervisor"]);
const PROTECTED_ROLES = new Set(["owner", "admin"]);

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

function normRole(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

async function deleteDeviceSessions(deviceId, tenantId) {
  const rows = await supabaseRequest(
    [
      "device_sessions",
      "?device_id=eq." + encodeURIComponent(deviceId),
      "&tenant_id=eq." + encodeURIComponent(tenantId),
    ].join(""),
    { method: "DELETE" }
  );
  if (Array.isArray(rows)) return rows.length;
  return rows?.id ? 1 : 0;
}

async function deleteAssignedDevices(tenantId, membershipId) {
  const tid = encodeURIComponent(tenantId);
  const mid = encodeURIComponent(membershipId);
  const deviceRows = await supabaseRequest(
    `tenant_devices?tenant_id=eq.${tid}&assigned_membership_id=eq.${mid}&select=id`
  );
  const devices = Array.isArray(deviceRows) ? deviceRows : [];
  let deletedDevicesCount = 0;
  let deletedSessionsCount = 0;

  for (const device of devices) {
    if (!device?.id) continue;
    deletedSessionsCount += await deleteDeviceSessions(device.id, tenantId);
    const did = encodeURIComponent(device.id);
    await supabaseRequest(`tenant_devices?id=eq.${did}&tenant_id=eq.${tid}`, {
      method: "DELETE",
    });
    deletedDevicesCount += 1;
  }

  return { deletedDevicesCount, deletedSessionsCount };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { error: "Method not allowed" });
    }

    const ctx = await requireOwnerMembership(event);
    const body = parseBody(event.body);

    const membershipId = String(body.membership_id || body.membershipId || "").trim();
    if (!UUID_RE.test(membershipId)) {
      return json(400, { error: "Valid membership_id is required" });
    }

    if (membershipId === String(ctx.membership.id)) {
      return json(403, {
        error: "Owner membership cannot be deleted",
        code: "protected_membership",
      });
    }

    const existing = await resolveMembershipById(
      supabaseRequest,
      ctx.tenant.id,
      membershipId
    );
    if (!existing?.id) {
      return json(404, { error: "Membership not found", code: "membership_not_found" });
    }

    const targetRole = normRole(existing.role);
    if (PROTECTED_ROLES.has(targetRole) || !ALLOWED_TARGET_ROLES.has(targetRole)) {
      return json(403, {
        error: "This membership cannot be deleted",
        code: "protected_membership",
      });
    }

    const deleted = await deleteAssignedDevices(ctx.tenant.id, existing.id);

    const tid = encodeURIComponent(ctx.tenant.id);
    const mid = encodeURIComponent(existing.id);
    await supabaseRequest(`profiles?id=eq.${mid}&tenant_id=eq.${tid}`, {
      method: "DELETE",
    });

    return json(200, {
      ok: true,
      deleted: true,
      membership_id: existing.id,
      deleted_devices_count: deleted.deletedDevicesCount,
      deleted_sessions_count: deleted.deletedSessionsCount,
    });
  } catch (err) {
    if (err.isGuardError) {
      return json(err.statusCode, { error: err.message, code: err.code });
    }
    return json(500, { error: err.message || "Unexpected error" });
  }
};
