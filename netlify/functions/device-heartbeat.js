/**
 * Device session heartbeat — refresh last_seen_at and rolling TTL.
 * Step 3E-C5-A — not wired into portals yet.
 */

const { supabaseRequest } = require("./_lib/supabase-admin");
const { DEVICE_SESSION_TTL_SECONDS } = require("./_lib/device-session");
const { requireDeviceSession } = require("./_lib/tenant-device-guard");

const ROLLING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

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

function computeRollingExpiry(currentExpiresAtIso) {
  const now = Date.now();
  const currentExpires = Date.parse(String(currentExpiresAtIso || ""));
  const withinWindow =
    Number.isFinite(currentExpires) && currentExpires < now + ROLLING_WINDOW_MS;
  if (!withinWindow) {
    return {
      extended: false,
      expiresAt: String(currentExpiresAtIso || ""),
    };
  }
  return {
    extended: true,
    expiresAt: new Date(now + DEVICE_SESSION_TTL_SECONDS * 1000).toISOString(),
  };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { error: "Method not allowed" });
    }

    const ctx = await requireDeviceSession(event);
    const nowIso = new Date().toISOString();
    const { extended, expiresAt } = computeRollingExpiry(ctx.deviceSession.expires_at);

    const sessionPatch = {
      last_seen_at: nowIso,
    };
    if (extended) {
      sessionPatch.expires_at = expiresAt;
    }

    const sessionRows = await supabaseRequest(
      `device_sessions?id=eq.${encodeURIComponent(ctx.deviceSession.id)}&status=eq.active`,
      {
        method: "PATCH",
        body: sessionPatch,
      }
    );
    const updatedSession = Array.isArray(sessionRows) ? sessionRows[0] : sessionRows;
    if (!updatedSession?.id) {
      return json(500, { error: "Device session was not updated" });
    }

    await supabaseRequest(
      `tenant_devices?id=eq.${encodeURIComponent(ctx.device.id)}&tenant_id=eq.${encodeURIComponent(ctx.tenant.id)}`,
      {
        method: "PATCH",
        body: { last_seen_at: nowIso },
      }
    );

    return json(200, {
      ok: true,
      extended,
      expires_at: updatedSession.expires_at || expiresAt,
      portal_type: ctx.portalType || null,
    });
  } catch (err) {
    if (err.isGuardError) {
      return json(err.statusCode || 401, {
        error: err.message,
        code: err.code || "device_session_invalid",
      });
    }
    return json(500, { error: err.message || "Unexpected error" });
  }
};
