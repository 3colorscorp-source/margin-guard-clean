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

/** Same as publish-public-quote.js */
function validateWorkersForPricing(workers) {
  if (!Array.isArray(workers) || workers.length === 0) {
    return { ok: false, error: "workers must be a non-empty array with labor lines." };
  }
  let sumDays = 0;
  for (const w of workers) {
    sumDays += Math.max(0, Number(w?.days || 0));
  }
  if (!Number.isFinite(sumDays) || sumDays <= 0) {
    return {
      ok: false,
      error: "workers must include at least one line with days greater than zero."
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
      return json(400, { error: "Invalid JSON" });
    }

    const pricingIn = parsePublishPricingInput(body);
    const wCheck = validateWorkersForPricing(pricingIn.workers);
    if (!wCheck.ok) {
      return json(400, { error: wCheck.error });
    }

    const tenantSettings = await loadTenantSettingsFromLatestSnapshot(tenant.id);

    let financials;
    try {
      financials = calculateQuotePublishFinancials(
        {
          workers: pricingIn.workers,
          price: pricingIn.price,
          _manualPriceTouched: pricingIn._manualPriceTouched
        },
        tenantSettings
      );
    } catch (err) {
      return json(400, {
        error: err?.message || "Unable to compute quote pricing from inputs."
      });
    }

    const minPrice = financials.minimum_price;
    if (isManualOfferActive(pricingIn)) {
      const rawManual = String(pricingIn.price ?? "").trim();
      const manualRequested = Number(rawManual);
      if (!Number.isFinite(manualRequested)) {
        return json(400, {
          error: "Manual offered price must be a valid number."
        });
      }
      if (manualRequested + 1e-9 < Number(minPrice)) {
        return json(400, {
          error: `Manual offered price cannot be below the minimum allowed (${Number(minPrice).toFixed(2)}).`
        });
      }
    }

    if (
      !Number.isFinite(financials.total) ||
      financials.total <= 0 ||
      !Number.isFinite(financials.deposit_required) ||
      financials.deposit_required <= 0
    ) {
      return json(400, { error: "Computed total or deposit is invalid." });
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
