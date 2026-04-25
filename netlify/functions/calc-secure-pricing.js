const { readSessionFromEvent } = require("./_lib/session");
const { supabaseRequest } = require("./_lib/supabase-admin");
const { calculateQuotePublishFinancials } = require("./_lib/pricing-engine");

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  };
}

function badRequest(reason, message) {
  const msg = String(message || "").trim() || "Bad request";
  return json(400, { ok: false, reason, message: msg, error: msg });
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

/** Same as publish-public-quote.js */
function parsePublishPricingInput(body) {
  const workersRaw = body.workers ?? body.sales_workers ?? body.salesWorkers;
  const workers = Array.isArray(workersRaw) ? workersRaw : null;
  const price =
    body.price !== undefined
      ? body.price
      : body.offeredPrice !== undefined
        ? body.offeredPrice
        : body.offered_price;
  const _manualPriceTouched = Boolean(
    body._manualPriceTouched ?? body.manual_price_touched ?? body.manualPriceTouched
  );
  return { workers, price, _manualPriceTouched };
}

/** Convert hours-only lines to fractional days so pricing-engine (days-based) stays correct. */
function normalizeWorkersLaborDays(workers, tenantSettings) {
  const list = Array.isArray(workers) ? workers : [];
  const hpd = Math.max(Number(tenantSettings?.hoursPerDay || 8), 0.25);
  return list.map((w) => {
    const obj = w && typeof w === "object" ? w : {};
    const d = Math.max(0, Number(obj.days || 0));
    const h = Math.max(0, Number(obj.hours || 0));
    const effectiveDays = d > 0 ? d : h > 0 ? h / hpd : 0;
    return { ...obj, days: effectiveDays };
  });
}

/** Same as publish-public-quote.js (expects days already normalized when hours were used). */
function validateWorkersForPricing(workers) {
  if (!Array.isArray(workers) || workers.length === 0) {
    return {
      ok: false,
      reason: "workers_empty",
      error: "workers must be a non-empty array with labor lines."
    };
  }
  let sumDays = 0;
  for (const w of workers) {
    sumDays += Math.max(0, Number(w?.days || 0));
  }
  if (!Number.isFinite(sumDays) || sumDays <= 0) {
    return {
      ok: false,
      reason: "zero_labor",
      error:
        "Each labor line needs days > 0 or hours > 0 (hours are converted using tenant hours per day)."
    };
  }
  return { ok: true };
}

/** Same as publish-public-quote.js */
function isManualOfferActive(pricingIn) {
  const raw =
    pricingIn.price === null || pricingIn.price === undefined ? "" : String(pricingIn.price);
  return Boolean(pricingIn._manualPriceTouched) && String(raw).trim() !== "";
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

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch (_err) {
      return badRequest("invalid_json", "Invalid JSON body");
    }

    const pricingIn = parsePublishPricingInput(body);
    if (!Array.isArray(pricingIn.workers) || pricingIn.workers.length === 0) {
      return badRequest(
        "workers_empty",
        "workers must be a non-empty array with labor lines."
      );
    }

    const tenantSettings = await loadTenantSettingsFromLatestSnapshot(tenant.id);
    const workersNormalized = normalizeWorkersLaborDays(pricingIn.workers, tenantSettings);
    const wCheck = validateWorkersForPricing(workersNormalized);
    if (!wCheck.ok) {
      return badRequest(wCheck.reason || "invalid_workers", wCheck.error);
    }

    let financials;
    try {
      financials = calculateQuotePublishFinancials(
        {
          workers: workersNormalized,
          price: pricingIn.price,
          _manualPriceTouched: pricingIn._manualPriceTouched
        },
        tenantSettings
      );
    } catch (err) {
      return badRequest(
        "pricing_engine_error",
        err?.message || "Unable to compute quote pricing from inputs."
      );
    }

    const minPrice = financials.minimum_price;
    if (isManualOfferActive(pricingIn)) {
      const rawManual = String(pricingIn.price ?? "").trim();
      const manualRequested = Number(rawManual);
      if (!Number.isFinite(manualRequested)) {
        return badRequest("manual_price_nan", "Manual offered price must be a valid number.");
      }
      if (manualRequested + 1e-9 < Number(minPrice)) {
        return badRequest(
          "manual_price_below_minimum",
          `Manual offered price cannot be below the minimum allowed (${Number(minPrice).toFixed(2)}).`
        );
      }
    }

    if (
      !Number.isFinite(financials.total) ||
      financials.total <= 0 ||
      !Number.isFinite(financials.deposit_required) ||
      financials.deposit_required <= 0
    ) {
      return badRequest(
        "invalid_totals",
        "Computed total or deposit is invalid (check tenant snapshot labor rates and overhead)."
      );
    }

    return json(200, {
      ok: true,
      tenant_id: tenant.id,
      pricing: {
        total: financials.total,
        deposit_required: financials.deposit_required,
        recommended_price: financials.recommended_price,
        minimum_price: financials.minimum_price
      }
    });
  } catch (err) {
    return json(500, { error: err.message || "Unable to calculate secure pricing" });
  }
};
