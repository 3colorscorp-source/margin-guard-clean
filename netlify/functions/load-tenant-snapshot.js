const { readSessionFromEvent } = require("./_lib/session");
const { supabaseRequest } = require("./_lib/supabase-admin");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");
const { hasOwnerSessionIdentity } = require("./_lib/owner-access");

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "GET") {
      return json(405, { error: "Method not allowed" });
    }

    const session = readSessionFromEvent(event);
    if (!hasOwnerSessionIdentity(session)) {
      return json(401, { error: "Unauthorized" });
    }

    const tenant = await resolveTenantFromSession(session);
    if (!tenant?.id) {
      return json(403, {
        error: "No membership found for this account.",
        code: "membership_not_found",
      });
    }

    const rows = await supabaseRequest(
      `tenant_snapshots?tenant_id=eq.${encodeURIComponent(String(tenant.id))}&select=*&order=created_at.desc&limit=1`
    );
    const snapshot = Array.isArray(rows) ? rows[0] : null;

    return json(200, {
      ok: true,
      snapshot: snapshot || null
    });
  } catch (err) {
    return json(500, { error: err.message || "Unable to load snapshot" });
  }
};
