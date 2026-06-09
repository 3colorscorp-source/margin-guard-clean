/**
 * Owner-only: generate or reset pairing code for an existing tenant_devices row.
 * Step 3E-C2-A — no pair-device, device sessions, or cookies yet.
 */

const crypto = require("crypto");

const { supabaseRequest } = require("./_lib/supabase-admin");
const { hashSessionToken } = require("./_lib/device-session");
const { assertSameTenant, requireOwnerMembership } = require("./_lib/tenant-device-guard");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const PAIRING_CODE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const PAIRING_TTL_MS = 5 * 60 * 1000;

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

function normStatus(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function generatePairingCode() {
  let code = "";
  for (let i = 0; i < 8; i++) {
    code += PAIRING_CODE_CHARS[crypto.randomInt(0, PAIRING_CODE_CHARS.length)];
  }
  return code;
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

    const status = normStatus(existing.status);
    if (status === "revoked") {
      return json(409, {
        error: "Cannot reset pairing for a revoked device",
        code: "device_revoked",
      });
    }

    const pairingCode = generatePairingCode();
    const pairingExpiresAt = new Date(Date.now() + PAIRING_TTL_MS).toISOString();
    const patchBody = {
      status: "pending_pair",
      pairing_code_hash: hashSessionToken(pairingCode),
      pairing_expires_at: pairingExpiresAt,
      device_fingerprint: null,
    };

    const updatedRows = await supabaseRequest(`tenant_devices?id=eq.${did}&tenant_id=eq.${tid}`, {
      method: "PATCH",
      body: patchBody,
    });
    const device = Array.isArray(updatedRows) ? updatedRows[0] : updatedRows;
    if (!device?.id) {
      return json(500, { error: "Device row was not returned after pairing reset" });
    }

    return json(200, {
      ok: true,
      pairing_code: pairingCode,
      device: serializeDevice(device),
    });
  } catch (err) {
    if (err.isGuardError) {
      return json(err.statusCode, { error: err.message, code: err.code });
    }
    return json(500, { error: err.message || "Unexpected error" });
  }
};
