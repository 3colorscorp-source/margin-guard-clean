/**
 * Owner-only: create a tenant_devices row (pending_pair, no pairing code yet).
 * Step 3E-C1 skeleton — pairing flow comes in a later step.
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

const PORTAL_TYPES = new Set(["seller", "supervisor"]);

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

function normPortal(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function serializeDevice(row) {
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
  };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { error: "Method not allowed" });
    }

    const ctx = await requireOwnerMembership(event);
    const body = parseBody(event.body);

    const portalType = normPortal(body.portal_type || body.portalType);
    if (!PORTAL_TYPES.has(portalType)) {
      return json(400, { error: "portal_type must be seller or supervisor" });
    }

    const assignedMembershipId = String(
      body.assigned_membership_id || body.assignedMembershipId || ""
    ).trim();
    if (!UUID_RE.test(assignedMembershipId)) {
      return json(400, { error: "Valid assigned_membership_id is required" });
    }

    const assigned = await resolveMembershipById(
      supabaseRequest,
      ctx.tenant.id,
      assignedMembershipId
    );
    if (!assigned?.id) {
      return json(404, { error: "Assigned membership not found for this tenant" });
    }
    if (!membershipIsActive(assigned)) {
      return json(403, { error: "Assigned membership is not active", code: "membership_inactive" });
    }
    if (membershipRole(assigned) !== portalType) {
      return json(403, {
        error: `Assigned membership role must match portal_type (${portalType})`,
        code: "membership_role_mismatch",
      });
    }

    const displayName = String(body.display_name || body.displayName || "")
      .trim()
      .slice(0, 200);

    const insertBody = {
      tenant_id: ctx.tenant.id,
      portal_type: portalType,
      assigned_membership_id: assigned.id,
      display_name: displayName,
      status: "pending_pair",
      created_by_membership_id: ctx.membership.id,
    };

    const rows = await supabaseRequest("tenant_devices", {
      method: "POST",
      body: insertBody,
    });
    const device = Array.isArray(rows) ? rows[0] : rows;
    if (!device?.id) {
      return json(500, { error: "Device row was not returned after insert" });
    }

    return json(200, { ok: true, device: serializeDevice(device) });
  } catch (err) {
    if (err.isGuardError) {
      return json(err.statusCode, { error: err.message, code: err.code });
    }
    return json(500, { error: err.message || "Unexpected error" });
  }
};
