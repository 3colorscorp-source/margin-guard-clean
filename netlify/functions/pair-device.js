/**
 * Public: exchange a valid pairing code for an mg_device_session cookie.
 * Step 3E-C3-A — no UI or portal wiring yet.
 */

const crypto = require("crypto");

const { supabaseRequest } = require("./_lib/supabase-admin");
const {
  DEVICE_SESSION_TTL_SECONDS,
  buildDeviceSessionPayload,
  createDeviceSessionCookieFromPayload,
  hashSessionToken,
} = require("./_lib/device-session");
const {
  membershipIsActive,
  membershipRole,
  resolveMembershipById,
} = require("./_lib/membership-resolve");
const { assertSameTenant } = require("./_lib/tenant-device-guard");

const PAIRING_CODE_RE = /^[A-Z0-9]{8}$/;
const MAX_ACTIVE_SELLER_DEVICES = 3;
const SESSION_TTL_MS = DEVICE_SESSION_TTL_SECONDS * 1000;

function json(statusCode, payload, extraHeaders) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      ...(extraHeaders || {}),
    },
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

function normPortal(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function membershipDisplayName(profile) {
  return String(profile?.display_name || profile?.full_name || "").trim();
}

async function fetchTenantSummary(tenantId) {
  const rows = await supabaseRequest(
    `tenants?id=eq.${encodeURIComponent(tenantId)}&select=id,name,slug&limit=1`
  );
  return Array.isArray(rows) ? rows[0] : null;
}

async function findPendingDeviceByPairingHash(codeHash, nowIso) {
  const rows = await supabaseRequest(
    [
      "tenant_devices",
      "?pairing_code_hash=eq." + encodeURIComponent(codeHash),
      "&status=eq.pending_pair",
      "&revoked_at=is.null",
      "&pairing_expires_at=gt." + encodeURIComponent(nowIso),
      "&select=*",
      "&limit=2",
    ].join("")
  );
  if (!Array.isArray(rows) || !rows.length) return null;
  if (rows.length > 1) {
    const err = new Error("Ambiguous pairing code match");
    err.statusCode = 409;
    err.code = "pairing_code_ambiguous";
    throw err;
  }
  return rows[0];
}

async function revokeActiveDeviceSessions(deviceId, nowIso) {
  await supabaseRequest(
    `device_sessions?device_id=eq.${encodeURIComponent(deviceId)}&status=eq.active`,
    {
      method: "PATCH",
      body: {
        status: "revoked",
        revoked_at: nowIso,
      },
    }
  );
}

async function countActiveSellerDevices(membershipId) {
  const rows = await supabaseRequest(
    [
      "tenant_devices",
      "?assigned_membership_id=eq." + encodeURIComponent(membershipId),
      "&portal_type=eq.seller",
      "&status=eq.active",
      "&select=id",
    ].join("")
  );
  return Array.isArray(rows) ? rows.length : 0;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { error: "Method not allowed" });
    }

    const body = parseBody(event.body);
    if (body == null) {
      return json(400, { error: "Invalid JSON" });
    }

    const pairingCode = String(body.pairing_code || body.pairingCode || "")
      .trim()
      .toUpperCase();
    if (!PAIRING_CODE_RE.test(pairingCode)) {
      return json(400, {
        error: "pairing_code must be 8 uppercase letters or digits",
        code: "invalid_pairing_code_format",
      });
    }

    const deviceFingerprintRaw = body.device_fingerprint ?? body.deviceFingerprint;
    const deviceFingerprint =
      deviceFingerprintRaw == null || String(deviceFingerprintRaw).trim() === ""
        ? null
        : String(deviceFingerprintRaw).trim().slice(0, 512);

    const nowIso = new Date().toISOString();
    const codeHash = hashSessionToken(pairingCode);
    const device = await findPendingDeviceByPairingHash(codeHash, nowIso);
    if (!device?.id) {
      return json(401, {
        error: "Invalid or expired pairing code",
        code: "pairing_code_invalid",
      });
    }

    const portalType = normPortal(device.portal_type);
    const membership = await resolveMembershipById(
      supabaseRequest,
      device.tenant_id,
      device.assigned_membership_id
    );
    if (!membership?.id) {
      return json(403, {
        error: "Assigned membership not found",
        code: "membership_not_found",
      });
    }

    assertSameTenant(device.tenant_id, membership.tenant_id);

    if (!membershipIsActive(membership)) {
      return json(403, {
        error: "Assigned membership is not active",
        code: "membership_inactive",
      });
    }

    if (membershipRole(membership) !== portalType) {
      return json(403, {
        error: "Assigned membership role does not match device portal",
        code: "membership_role_mismatch",
      });
    }

    if (portalType === "seller") {
      const activeCount = await countActiveSellerDevices(membership.id);
      if (activeCount >= MAX_ACTIVE_SELLER_DEVICES) {
        return json(403, {
          error: "Maximum active seller devices reached for this membership",
          code: "seller_device_limit",
        });
      }
    }

    const sessionId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    const { cookie, tokenHash } = createDeviceSessionCookieFromPayload(
      buildDeviceSessionPayload({
        sessionId,
        deviceId: device.id,
        tenantId: device.tenant_id,
        membershipId: membership.id,
        portalType,
      })
    );

    await revokeActiveDeviceSessions(device.id, nowIso);

    const sessionRows = await supabaseRequest("device_sessions", {
      method: "POST",
      body: {
        id: sessionId,
        tenant_id: device.tenant_id,
        device_id: device.id,
        membership_id: membership.id,
        portal_type: portalType,
        session_token_hash: tokenHash,
        status: "active",
        expires_at: expiresAt,
        last_seen_at: nowIso,
      },
    });
    const deviceSession = Array.isArray(sessionRows) ? sessionRows[0] : sessionRows;
    if (!deviceSession?.id) {
      return json(500, { error: "Device session was not created" });
    }

    const updatedDeviceRows = await supabaseRequest(
      `tenant_devices?id=eq.${encodeURIComponent(device.id)}&tenant_id=eq.${encodeURIComponent(device.tenant_id)}`,
      {
        method: "PATCH",
        body: {
          status: "active",
          device_fingerprint: deviceFingerprint,
          last_seen_at: nowIso,
          pairing_code_hash: null,
          pairing_expires_at: null,
        },
      }
    );
    const updatedDevice = Array.isArray(updatedDeviceRows)
      ? updatedDeviceRows[0]
      : updatedDeviceRows;
    if (!updatedDevice?.id) {
      return json(500, { error: "Device was not updated after pairing" });
    }

    const tenant = await fetchTenantSummary(device.tenant_id);

    return json(
      200,
      {
        ok: true,
        portal_type: portalType,
        tenant: tenant
          ? {
              id: tenant.id,
              name: tenant.name || null,
              slug: tenant.slug || null,
            }
          : {
              id: device.tenant_id,
              name: null,
              slug: null,
            },
        membership: {
          id: membership.id,
          email: membership.email || null,
          display_name: membershipDisplayName(membership),
          role: membership.role || null,
          status: membership.status || null,
        },
        device: {
          id: updatedDevice.id,
          display_name: updatedDevice.display_name || "",
          status: updatedDevice.status,
        },
        expires_at: expiresAt,
      },
      { "Set-Cookie": cookie }
    );
  } catch (err) {
    if (err.isGuardError) {
      return json(err.statusCode, { error: err.message, code: err.code });
    }
    if (err.code === "pairing_code_ambiguous") {
      return json(err.statusCode || 409, { error: err.message, code: err.code });
    }
    return json(500, { error: err.message || "Unexpected error" });
  }
};
