/**
 * Owner-only: revoke a tenant_devices row (soft revoke; no row delete).
 * Step 3E-C1 skeleton — device session revocation comes in a later step.
 */

const { supabaseRequest } = require("./_lib/supabase-admin");
const { assertSameTenant, requireOwnerMembership } = require("./_lib/tenant-device-guard");

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

    const deviceId = String(body.device_id || body.deviceId || "").trim();
    if (!UUID_RE.test(deviceId)) {
      return json(400, { error: "Valid device_id is required" });
    }

    const tid = encodeURIComponent(ctx.tenant.id);
    const did = encodeURIComponent(deviceId);
    const existingRows = await supabaseRequest(
      `tenant_devices?id=eq.${did}&tenant_id=eq.${tid}&select=*&limit=1`
    );
    const existing = Array.isArray(existingRows) ? existingRows[0] : null;
    if (!existing?.id) {
      return json(404, { error: "Device not found" });
    }

    assertSameTenant(ctx.tenant.id, existing.tenant_id);

    const nowIso = new Date().toISOString();
    const patchBody = {
      status: "revoked",
      revoked_at: existing.revoked_at || nowIso,
    };

    const updatedRows = await supabaseRequest(`tenant_devices?id=eq.${did}&tenant_id=eq.${tid}`, {
      method: "PATCH",
      body: patchBody,
    });
    const device = Array.isArray(updatedRows) ? updatedRows[0] : updatedRows;
    if (!device?.id) {
      return json(500, { error: "Device row was not returned after revoke" });
    }

    return json(200, { ok: true, device: serializeDevice(device) });
  } catch (err) {
    if (err.isGuardError) {
      return json(err.statusCode, { error: err.message, code: err.code });
    }
    return json(500, { error: err.message || "Unexpected error" });
  }
};
