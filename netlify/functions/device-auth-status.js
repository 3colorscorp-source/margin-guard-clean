/**
 * Device session auth status for mg_device_session.
 * Step 3E-C5-A — not wired into portals yet.
 */

const { requireDeviceSession } = require("./_lib/tenant-device-guard");

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

function membershipDisplayName(profile) {
  return String(profile?.display_name || profile?.full_name || "").trim();
}

function safeAuthPayload(ctx) {
  return {
    ok: true,
    active: true,
    auth_mode: "device",
    portal_type: ctx.portalType || null,
    tenant: ctx.tenant
      ? {
          id: ctx.tenant.id,
          name: ctx.tenant.name || null,
          slug: ctx.tenant.slug || null,
        }
      : null,
    membership: ctx.membership
      ? {
          id: ctx.membership.id,
          email: ctx.membership.email || null,
          display_name: membershipDisplayName(ctx.membership),
          role: ctx.membership.role || null,
          status: ctx.membership.status || null,
        }
      : null,
    device: ctx.device
      ? {
          id: ctx.device.id,
          display_name: ctx.device.display_name || "",
          status: ctx.device.status,
        }
      : null,
    expires_at: ctx.deviceSession?.expires_at || null,
  };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "GET") {
      return json(405, { error: "Method not allowed" });
    }

    const ctx = await requireDeviceSession(event);
    return json(200, safeAuthPayload(ctx));
  } catch (err) {
    if (err.isGuardError) {
      return json(err.statusCode || 401, {
        ok: false,
        active: false,
        error: err.message,
        code: err.code || "device_session_invalid",
      });
    }
    return json(500, { error: err.message || "Unexpected error" });
  }
};
