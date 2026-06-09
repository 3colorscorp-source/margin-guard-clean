/**
 * Owner-only: list tenant_devices for the owner tenant (read-only).
 * Step 3E-C1 skeleton.
 */

const { supabaseRequest } = require("./_lib/supabase-admin");
const { PROFILE_SELECT } = require("./_lib/membership-resolve");
const { requireOwnerMembership } = require("./_lib/tenant-device-guard");

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  };
}

function normId(value) {
  return String(value || "").trim();
}

function membershipLabel(profile) {
  if (!profile) return "";
  const display = String(profile.display_name || profile.full_name || "").trim();
  return display;
}

function serializeDevice(row, assignedMembership) {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    portal_type: row.portal_type,
    assigned_membership_id: row.assigned_membership_id,
    display_name: row.display_name || "",
    status: row.status,
    device_fingerprint: row.device_fingerprint || null,
    last_seen_at: row.last_seen_at || null,
    revoked_at: row.revoked_at || null,
    created_by_membership_id: row.created_by_membership_id || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    has_pairing_code: Boolean(row.pairing_code_hash),
    pairing_expires_at: row.pairing_expires_at || null,
    assigned_membership: assignedMembership
      ? {
          id: assignedMembership.id,
          email: assignedMembership.email || null,
          display_name: membershipLabel(assignedMembership),
          role: assignedMembership.role || null,
          status: assignedMembership.status || null,
        }
      : null,
  };
}

async function loadMembershipMap(tenantId, membershipIds) {
  const ids = [...new Set(membershipIds.map(normId).filter(Boolean))];
  if (!ids.length) return new Map();

  const inList = ids.map(encodeURIComponent).join(",");
  const rows = await supabaseRequest(
    `profiles?tenant_id=eq.${encodeURIComponent(tenantId)}&id=in.(${inList})&select=${PROFILE_SELECT}`
  );
  const map = new Map();
  if (Array.isArray(rows)) {
    for (const row of rows) {
      if (row?.id) map.set(String(row.id), row);
    }
  }
  return map;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "GET") {
      return json(405, { error: "Method not allowed" });
    }

    const ctx = await requireOwnerMembership(event);
    const tid = encodeURIComponent(ctx.tenant.id);

    const rows = await supabaseRequest(
      `tenant_devices?tenant_id=eq.${tid}&select=*&order=created_at.desc`
    );
    const devices = Array.isArray(rows) ? rows : [];
    const membershipMap = await loadMembershipMap(
      ctx.tenant.id,
      devices.map((d) => d.assigned_membership_id)
    );

    return json(200, {
      ok: true,
      devices: devices.map((row) =>
        serializeDevice(row, membershipMap.get(String(row.assigned_membership_id)) || null)
      ),
    });
  } catch (err) {
    if (err.isGuardError) {
      return json(err.statusCode, { error: err.message, code: err.code });
    }
    return json(500, { error: err.message || "Unexpected error" });
  }
};
