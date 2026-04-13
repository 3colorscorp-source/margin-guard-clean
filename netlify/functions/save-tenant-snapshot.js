const { readSessionFromEvent } = require("./_lib/session");
const { supabaseRequest } = require("./_lib/supabase-admin");

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  };
}

function extractBrandingFromSnapshotPayload(payload) {
  const storage = payload?.storage && typeof payload.storage === "object" ? payload.storage : {};
  const settings =
    storage["mg_settings_v2"] && typeof storage["mg_settings_v2"] === "object" ? storage["mg_settings_v2"] : {};
  const brand =
    storage["mg_business_branding_v1"] && typeof storage["mg_business_branding_v1"] === "object"
      ? storage["mg_business_branding_v1"]
      : {};
  return {
    business_name: String(brand.businessName || settings.bizName || "").trim(),
    logo_url: String(brand.logoUrl || settings.publicLogoUrl || "").trim(),
    business_email: String(brand.businessEmail || settings.businessEmail || "").trim(),
    business_phone: String(brand.businessPhone || settings.businessPhone || "").trim(),
    business_address: String(brand.businessAddress || settings.businessAddress || "").trim()
  };
}

async function upsertTenantBranding(tenantId, row) {
  await supabaseRequest("tenant_branding", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: {
      tenant_id: tenantId,
      business_name: row.business_name || "",
      logo_url: row.logo_url || "",
      business_email: row.business_email || "",
      business_phone: row.business_phone || "",
      business_address: row.business_address || ""
    }
  });
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

    let brandingWarning = null;
    try {
      const brandingRow = extractBrandingFromSnapshotPayload(payload);
      await upsertTenantBranding(tenant.id, brandingRow);
    } catch (err) {
      brandingWarning = err?.message || "tenant_branding upsert failed";
    }

    return json(200, {
      ok: true,
      snapshot: Array.isArray(inserted) ? inserted[0] : inserted,
      brandingOk: !brandingWarning,
      ...(brandingWarning ? { brandingWarning } : {})
    });
  } catch (err) {
    return json(500, { error: err.message || "Unable to save snapshot" });
  }
};
