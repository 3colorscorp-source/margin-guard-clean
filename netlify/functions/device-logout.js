/**
 * Device session logout — revoke active session and clear mg_device_session.
 * Step 3E-C5-A — not wired into portals yet.
 */

const { supabaseRequest } = require("./_lib/supabase-admin");
const { clearDeviceSessionCookie } = require("./_lib/device-session");
const { resolveDeviceSession } = require("./_lib/tenant-device-guard");

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

async function revokeDeviceSessionIfPresent(event) {
  try {
    const ctx = await resolveDeviceSession(event);
    if (!ctx?.deviceSession?.id) return;
    const nowIso = new Date().toISOString();
    await supabaseRequest(
      `device_sessions?id=eq.${encodeURIComponent(ctx.deviceSession.id)}&status=eq.active`,
      {
        method: "PATCH",
        body: {
          status: "revoked",
          revoked_at: nowIso,
        },
      }
    );
  } catch (_err) {
    /* missing/invalid session — still clear cookie */
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  await revokeDeviceSessionIfPresent(event);

  return json(200, { ok: true }, { "Set-Cookie": clearDeviceSessionCookie() });
};
