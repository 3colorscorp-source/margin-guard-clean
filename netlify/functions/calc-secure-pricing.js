const { readSessionFromEvent } = require("./_lib/session");
const { supabaseRequest } = require("./_lib/supabase-admin");
const { calculateSecurePricing } = require("./_lib/pricing-engine");

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  };
}

function extractSettingsFromSnapshotPayload(payload) {
  if (!payload || typeof payload !== "object") return {};
  const storage =
    payload.storage && typeof payload.storage === "object" ? payload.storage : {};
  const mg =
    storage["mg_settings_v2"] && typeof storage["mg_settings_v2"] === "object"
      ? storage["mg_settings_v2"]
      : {};
  return mg;
}

async function resolveTenant(session) {
  let tenants = await supabaseRequest(
    `tenants?stripe_customer_id=eq.${encodeURIComponent(session.c)}&select=id,owner_email,stripe_customer_id`
  );
  let tenant = Array.isArray(tenants) ? tenants[0] : null;

  if (!tenant?.id && session.e) {
    const byEmail = await supabaseRequest(
      `tenants?owner_email=eq.${encodeURIComponent(String(session.e).trim().toLowerCase())}&select=id,owner_email,stripe_customer_id`
    );
    tenant = Array.isArray(byEmail) ? byEmail[0] : null;

    if (tenant?.id && session.c && tenant.stripe_customer_id !== session.c) {
      await supabaseRequest(`tenants?id=eq.${encodeURIComponent(tenant.id)}`, {
        method: "PATCH",
        body: { stripe_customer_id: session.c }
      });
    }
  }

  return tenant;
}

async function loadTenantSettingsFromLatestSnapshot(tenantId) {
  const rows = await supabaseRequest(
    `tenant_snapshots?tenant_id=eq.${tenantId}&select=payload&order=created_at.desc&limit=1`
  );
  const row = Array.isArray(rows) ? rows[0] : null;
  return extractSettingsFromSnapshotPayload(row?.payload);
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

    const tenant = await resolveTenant(session);
    if (!tenant?.id) {
      return json(404, { error: "Tenant not found. Run bootstrap first." });
    }

    const tenantSettings = await loadTenantSettingsFromLatestSnapshot(tenant.id);

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch (_err) {
      return json(400, { error: "Invalid JSON" });
    }

    const input = {
      workers: body.workers,
      price: body.price,
      _manualPriceTouched: body._manualPriceTouched
    };

    const result = calculateSecurePricing(input, tenantSettings);

    return json(200, {
      ok: true,
      tenant_id: tenant.id,
      pricing: result
    });
  } catch (err) {
    return json(500, { error: err.message || "Unable to calculate secure pricing" });
  }
};
