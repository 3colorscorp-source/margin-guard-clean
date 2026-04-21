const { readSessionFromEvent } = require("./_lib/session");
const { supabaseRequest } = require("./_lib/supabase-admin");

/** Reject abusive snapshot POST sizes (untrusted browser input). */
const MAX_SNAPSHOT_BODY_CHARS = 2_500_000;

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  };
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Validates tenant snapshot from browser before insert.
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function validateTenantSnapshotPayload(payload) {
  if (!isPlainObject(payload)) {
    return { ok: false, reason: "payload must be an object" };
  }

  if (!("storage" in payload) || !isPlainObject(payload.storage)) {
    return { ok: false, reason: "payload.storage must be an object" };
  }

  const storage = payload.storage;
  const mg = storage["mg_settings_v2"];

  if (!isPlainObject(mg)) {
    return { ok: false, reason: "payload.storage.mg_settings_v2 must be present and be an object" };
  }

  const num = (key) => {
    const v = mg[key];
    if (v === "" || v === undefined || v === null) return NaN;
    return Number(v);
  };

  const bi = num("baseInstaller");
  const bh = num("baseHelper");
  if (!Number.isFinite(bi) || bi <= 0) {
    return { ok: false, reason: "mg_settings_v2.baseInstaller must be a finite number greater than 0" };
  }
  if (!Number.isFinite(bh) || bh <= 0) {
    return { ok: false, reason: "mg_settings_v2.baseHelper must be a finite number greater than 0" };
  }

  const pm = String(mg.pricingMode ?? "").trim();
  if (pm !== "hour" && pm !== "day") {
    return { ok: false, reason: "mg_settings_v2.pricingMode must be hour or day" };
  }

  const hpd = num("hoursPerDay");
  const std = num("stdHours");
  if (!Number.isFinite(hpd) || hpd <= 0) {
    return { ok: false, reason: "mg_settings_v2.hoursPerDay must be a finite number greater than 0" };
  }
  if (!Number.isFinite(std) || std <= 0) {
    return { ok: false, reason: "mg_settings_v2.stdHours must be a finite number greater than 0" };
  }

  const om = num("overheadMonthly");
  if (!Number.isFinite(om) || om < 0) {
    return { ok: false, reason: "mg_settings_v2.overheadMonthly must be a finite number >= 0" };
  }

  const wc = num("wcPct");
  const fi = num("ficaPct");
  if (!Number.isFinite(wc) || wc <= 0) {
    return { ok: false, reason: "mg_settings_v2.wcPct must be a finite number greater than 0" };
  }
  if (!Number.isFinite(fi) || fi <= 0) {
    return { ok: false, reason: "mg_settings_v2.ficaPct must be a finite number greater than 0" };
  }

  const fu = num("futaPct");
  const ca = num("casuiPct");
  if (!Number.isFinite(fu) || fu < 0) {
    return { ok: false, reason: "mg_settings_v2.futaPct must be a finite number >= 0" };
  }
  if (!Number.isFinite(ca) || ca < 0) {
    return { ok: false, reason: "mg_settings_v2.casuiPct must be a finite number >= 0" };
  }

  const pr = num("profitPct");
  if (!Number.isFinite(pr) || pr < 0) {
    return { ok: false, reason: "mg_settings_v2.profitPct must be a finite number >= 0" };
  }

  let mm = num("minimumMarginPct");
  if (!Number.isFinite(mm)) mm = 0;
  if (mm < 0) {
    return { ok: false, reason: "mg_settings_v2.minimumMarginPct must be a finite number >= 0" };
  }
  if (mm > pr) {
    return {
      ok: false,
      reason: "mg_settings_v2.minimumMarginPct must be less than or equal to mg_settings_v2.profitPct (target margin)"
    };
  }

  const sc = num("salesCommissionPct");
  const su = num("supervisorBonusPct");
  if (!Number.isFinite(sc) || sc < 0) {
    return { ok: false, reason: "mg_settings_v2.salesCommissionPct must be a finite number >= 0" };
  }
  if (!Number.isFinite(su) || su < 0) {
    return { ok: false, reason: "mg_settings_v2.supervisorBonusPct must be a finite number >= 0" };
  }

  const re = num("reservePct");
  if (!Number.isFinite(re) || re < 5) {
    return { ok: false, reason: "mg_settings_v2.reservePct must be a finite number >= 5" };
  }

  return { ok: true };
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
          body: {
            stripe_customer_id: session.c
          }
        });
      }
    }

    if (!tenant?.id) {
      return json(404, { error: "Tenant not found. Run bootstrap first. Revisa la sesion (Stripe) e intenta de nuevo." });
    }

    const rawBody = event.body || "";
    if (rawBody.length > MAX_SNAPSHOT_BODY_CHARS) {
      console.log("[save-tenant-snapshot] invalid snapshot: body too large", {
        tenant_id: tenant.id,
        reason: "request body exceeds maximum size"
      });
      return json(400, { error: "Snapshot request body is too large" });
    }

    let body = {};
    try {
      body = JSON.parse(rawBody || "{}");
    } catch (_err) {
      return json(400, { error: "Invalid JSON" });
    }

    const payload = body.payload;
    const snapshotCheck = validateTenantSnapshotPayload(payload);
    if (!snapshotCheck.ok) {
      console.log("[save-tenant-snapshot] invalid snapshot payload", {
        tenant_id: tenant.id,
        reason: snapshotCheck.reason
      });
      return json(400, { error: snapshotCheck.reason || "Invalid snapshot payload" });
    }

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
