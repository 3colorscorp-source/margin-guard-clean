/**
 * Owner-only: permanently delete a tenant_devices row.
 * Sessions are deleted first (tenant-scoped). Quote/project attribution
 * source_device_id FKs are ON DELETE SET NULL.
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

    const deletedSessionsCount = await deleteDeviceSessions(existing.id, ctx.tenant.id);

    await supabaseRequest(`tenant_devices?id=eq.${did}&tenant_id=eq.${tid}`, {
      method: "DELETE",
    });

    return json(200, {
      ok: true,
      deleted: true,
      device_id: existing.id,
      deleted_sessions_count: deletedSessionsCount,
    });
  } catch (err) {
    if (err.isGuardError) {
      return json(err.statusCode, { error: err.message, code: err.code });
    }
    return json(500, { error: err.message || "Unexpected error" });
  }
};
