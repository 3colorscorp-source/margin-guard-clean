const { readSessionFromEvent } = require("./_lib/session");
const { supabaseRequest } = require("./_lib/supabase-admin");

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { error: "Method not allowed" });
    }

    const session = readSessionFromEvent(event);
    if (!session?.e || !session?.c) {
      return json(401, { error: "Unauthorized" });
    }

    const tenants = await supabaseRequest(`tenants?stripe_customer_id=eq.${encodeURIComponent(session.c)}&select=id`);
    const tenant = Array.isArray(tenants) ? tenants[0] : null;
    if (!tenant?.id) {
      return json(404, { error: "Tenant not found. Run bootstrap first." });
    }

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch (_err) {
      return json(400, { error: "Invalid JSON" });
    }

    const payload = body.payload && typeof body.payload === "object" ? body.payload : {};
    const snapshotVersion = Number(body.snapshot_version || 1);

    const inserted = await supabaseRequest("tenant_snapshots", {
      method: "POST",
      body: {
        tenant_id: tenant.id,
        snapshot_version: Number.isFinite(snapshotVersion) ? snapshotVersion : 1,
        source: "margin-guard-web",
        payload,
        created_by_email: String(session.e || "").trim().toLowerCase()
      }
    });

    return json(200, {
      ok: true,
      snapshot: Array.isArray(inserted) ? inserted[0] : inserted
    });
  } catch (err) {
    return json(500, { error: err.message || "Unable to save snapshot" });
  }
};
