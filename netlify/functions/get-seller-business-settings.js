/**
 * GET seller-safe Business Settings from latest tenant snapshot.
 * Device-authenticated seller portal only.
 */
const { supabaseRequest } = require("./_lib/supabase-admin");
const { requireSellerDevice } = require("./_lib/tenant-device-guard");

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
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

async function loadTenantSettingsFromLatestSnapshot(tenantId) {
  const rows = await supabaseRequest(
    `tenant_snapshots?tenant_id=eq.${tenantId}&select=payload&order=created_at.desc&limit=1`
  );
  const row = Array.isArray(rows) ? rows[0] : null;
  return extractSettingsFromSnapshotPayload(row?.payload);
}

const SELLER_SAFE_SETTING_KEYS = [
  "baseInstaller",
  "baseHelper",
  "hoursPerDay",
  "pricingMode",
  "workdaysEnabled",
  "crewCapacity",
  "scheduleBufferDays",
  "allowSellerScheduleOverride",
  "overheadMonthly",
  "stdHours",
  "wcPct",
  "ficaPct",
  "futaPct",
  "casuiPct",
  "profitPct",
  "minimumMarginPct",
  "reservePct",
  "salesCommissionPct",
  "supervisorBonusPct",
  "currency",
  "salesQuoteExpirationDays",
];

function pickSellerSafeSettings(mg) {
  const source = mg && typeof mg === "object" ? mg : {};
  const out = {};
  for (const key of SELLER_SAFE_SETTING_KEYS) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      out[key] = source[key];
    }
  }
  if (!out.currency) out.currency = "USD";
  return out;
}

function validateSellerSafeSettings(settings) {
  const bi = Number(settings.baseInstaller);
  const bh = Number(settings.baseHelper);
  const hpd = Number(settings.hoursPerDay);
  if (!Number.isFinite(bi) || bi <= 0) return false;
  if (!Number.isFinite(bh) || bh <= 0) return false;
  if (!Number.isFinite(hpd) || hpd <= 0) return false;
  const pm = String(settings.pricingMode || "hour").trim().toLowerCase();
  if (pm !== "hour" && pm !== "day") return false;
  return true;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "GET") {
      return json(405, { ok: false, error: "Method not allowed" });
    }

    const ctx = await requireSellerDevice(event);
    const tenant = ctx.tenant;
    if (!tenant?.id) {
      return json(404, {
        ok: false,
        code: "tenant_not_found",
        error: "Tenant not found for this seller device.",
      });
    }

    const mg = await loadTenantSettingsFromLatestSnapshot(tenant.id);
    const settings = pickSellerSafeSettings(mg);

    if (!validateSellerSafeSettings(settings)) {
      return json(200, {
        ok: false,
        code: "seller_settings_missing",
        error:
          "Business Settings are not available. Ask owner to save Business Settings before quoting.",
      });
    }

    return json(200, {
      ok: true,
      settings,
      source: "tenant_snapshot",
    });
  } catch (err) {
    if (err.isGuardError) {
      return json(err.statusCode, {
        ok: false,
        code: err.code || "guard_error",
        error: err.message || "Forbidden",
      });
    }
    return json(500, {
      ok: false,
      code: "seller_settings_load_failed",
      error: err.message || "Unable to load Business Settings.",
    });
  }
};
