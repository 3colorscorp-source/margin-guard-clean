/**
 * Server-side secure pricing (Phase 1: structure + simulated output).
 * Real migration from browser calcSales will come in later phases.
 */

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function finiteNumber(n, fallback = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? x : fallback;
}

function laborBaseFromWorkers(workers, tenantSettings) {
  const list = Array.isArray(workers) ? workers : [];
  const hoursPerDay = Number(tenantSettings.hoursPerDay || 8);
  const baseHelper = Number(tenantSettings.baseHelper || 45);
  const baseInstaller = Number(tenantSettings.baseInstaller || 75);

  let sum = 0;
  for (const w of list) {
    const days = Number(w?.days || 0);
    const fallback = w?.type === "helper" ? baseHelper : baseInstaller;
    // Seller cannot override rates — always tenant Business Settings.
    const rate = fallback;
    sum += days * hoursPerDay * rate;
  }
  return sum;
}

/** Strip client-supplied labor rates; keep type, days, hours, name only. */
function sanitizeWorkersForTenantPricing(workers) {
  const list = Array.isArray(workers) ? workers : [];
  return list.map((w) => {
    const obj = w && typeof w === "object" ? w : {};
    return {
      name: obj.name,
      type: obj.type === "helper" ? "helper" : "installer",
      days: Math.max(0, Number(obj.days || 0)),
      hours: Math.max(0, Number(obj.hours || 0)),
    };
  });
}

/**
 * Offered price from allowed slider stages only (min / negotiation / recommended).
 * Ignores arbitrary manual typed prices from the browser.
 */
function resolveOfferedFromPricingInput(input, financials) {
  const min = finiteNumber(financials.minimum_price, 0);
  const neg = finiteNumber(financials.negotiation, 0);
  const rec = finiteNumber(financials.recommended_price, 0);
  const stageRaw =
    input?.pricing_stage ?? input?.pricingStage ?? input?.pricing_stage_index;
  if (stageRaw !== undefined && stageRaw !== null && String(stageRaw).trim() !== "") {
    const stage = Number(stageRaw);
    if (stage <= 0) return round2(min);
    if (stage === 1) return round2(neg);
    return round2(rec);
  }
  const touched = Boolean(input?._sliderTouched || input?._manualPriceTouched);
  if (touched) {
    const p = finiteNumber(input?.price, NaN);
    if (Number.isFinite(p)) {
      for (const anchor of [min, neg, rec]) {
        if (Math.abs(p - anchor) <= 0.02) return round2(anchor);
      }
    }
  }
  return round2(rec);
}

/**
 * @param {object} input - { workers, price, _manualPriceTouched }
 * @param {object} tenantSettings - mg_settings_v2 from snapshot (or {})
 */
function calculateSecurePricing(input, tenantSettings) {
  const settings = tenantSettings && typeof tenantSettings === 'object' ? tenantSettings : {};
  const workers = input?.workers;
  const base = laborBaseFromWorkers(workers, settings);

  // Simulated multipliers (not production parity with calcSales yet)
  const recommended_price = round2(base * 1.45);
  const minimum_allowed_price = round2(base * 1.12);
  const negotiationMid = (recommended_price + minimum_allowed_price) / 2;

  const commission_pct = Number(settings.salesCommissionPct || 10);
  const manualTouched = Boolean(input?._manualPriceTouched);
  const rawPrice = input?.price;
  const parsedPrice =
    rawPrice === '' || rawPrice == null ? NaN : Number(rawPrice);
  const offered =
    manualTouched && Number.isFinite(parsedPrice) ? parsedPrice : recommended_price;

  const commission_amount = round2(Math.max(offered, 0) * (commission_pct / 100));
  const needs_approval = offered < negotiationMid;

  return {
    recommended_price,
    minimum_allowed_price,
    commission_amount,
    commission_pct,
    needs_approval
  };
}

/**
 * Full publish-quote financials (aligned with public/js/app.js calcSales + offered branch).
 * total = offered (manual price when _manualPriceTouched + valid price, else recommended).
 * deposit_required = max($1000, 10% of total) unless extended later via settings.
 */
function calculateQuotePublishFinancials(input, tenantSettings) {
  const settings = tenantSettings && typeof tenantSettings === "object" ? tenantSettings : {};
  const workers = sanitizeWorkersForTenantPricing(
    Array.isArray(input?.workers) ? input.workers : []
  );

  function finiteNumber(n, fallback = 0) {
    const x = Number(n);
    return Number.isFinite(x) ? x : fallback;
  }

  const hoursPerDay = Math.max(Number(settings.hoursPerDay || 8), 0.25);
  const taxPct =
    (Number(settings.wcPct || 0) +
      Number(settings.ficaPct || 0) +
      Number(settings.futaPct || 0) +
      Number(settings.casuiPct || 0)) /
    100;
  const stdHours = Number(settings.stdHours || 0);
  const overheadMonthly = Number(settings.overheadMonthly || 0);
  const overheadPerHour = stdHours > 0 ? overheadMonthly / stdHours : 0;

  const laborByWorker = workers.map((worker) => {
    const days = Math.max(0, Number(worker.days || 0));
    const baseRate =
      worker.type === "helper"
        ? Number(settings.baseHelper || 0)
        : Number(settings.baseInstaller || 0);
    const rate = baseRate;
    const hours = days * hoursPerDay;
    const cost = hours * rate;
    return { days, rate, hours, cost };
  });

  const labor = laborByWorker.reduce((sum, row) => sum + row.cost, 0);
  const totalHours = laborByWorker.reduce((sum, row) => sum + row.hours, 0);
  const totalWorkerDays = laborByWorker.reduce((sum, row) => sum + row.days, 0);
  const taxes = labor * taxPct;
  const overhead = totalHours * overheadPerHour;
  const beforeProfit = labor + taxes + overhead;
  const reservePct = Number(settings.reservePct ?? 5);
  const reserve = beforeProfit * (reservePct / 100);
  const recommendedProfit = beforeProfit * (Number(settings.profitPct || 0) / 100);
  const minimumProfit = beforeProfit * 0.15;
  const recommended = beforeProfit + recommendedProfit + reserve;
  const minimum = beforeProfit + minimumProfit + reserve;
  const negotiation =
    recommended > minimum ? minimum + (recommended - minimum) * 0.5 : minimum;

  const offered = resolveOfferedFromPricingInput(input, {
    minimum_price: round2(minimum),
    negotiation: round2(negotiation),
    recommended_price: round2(recommended),
  });

  const total = round2(offered);
  const deposit_required = round2(Math.max(1000, total * 0.1));

  return {
    recommended_price: round2(recommended),
    minimum_price: round2(minimum),
    negotiation: round2(negotiation),
    total,
    deposit_required,
    labor: round2(labor),
    totalHours: round2(totalHours),
    totalWorkerDays: round2(totalWorkerDays),
    before_profit: round2(beforeProfit),
    reserve: round2(reserve)
  };
}

/**
 * Mirrors public/js/app.js computeSalesMarginDecisionFromEconomics (yellow = manual review band).
 */
function computeSalesMarginDecisionFromEconomics(offeredPrice, beforeProfit, reserve, settings) {
  const s = settings && typeof settings === "object" ? settings : {};
  const targetPct = finiteNumber(s.profitPct, 30);
  const minPct = finiteNumber(s.minimumMarginPct != null ? s.minimumMarginPct : 15, 15);
  const price = finiteNumber(offeredPrice, 0);
  const bp = finiteNumber(beforeProfit, 0);
  const res = finiteNumber(reserve, 0);
  const internalCost = bp + res;
  if (!(price > 0) || !Number.isFinite(internalCost)) {
    return {
      realMarginPct: null,
      level: "red",
      profitPct: targetPct,
      minimumMarginPct: minPct,
      internalCost
    };
  }
  const realMarginPct = ((price - internalCost) / price) * 100;
  let level = "green";
  if (realMarginPct >= targetPct) {
    level = "green";
  } else if (realMarginPct >= minPct) {
    level = "yellow";
  } else {
    level = "red";
  }
  return {
    realMarginPct,
    level,
    profitPct: targetPct,
    minimumMarginPct: minPct,
    internalCost
  };
}

/**
 * @param {{ workers: unknown[]; offered_price: number }} rowLike
 * @param {object} tenantSettings
 */
function marginLevelForSalesApproval(rowLike, tenantSettings) {
  const workers = Array.isArray(rowLike?.workers) ? rowLike.workers : [];
  const offered = finiteNumber(rowLike?.offered_price, 0);
  const financials = calculateQuotePublishFinancials(
    {
      workers,
      price: offered,
      _manualPriceTouched: true
    },
    tenantSettings
  );
  const gate = computeSalesMarginDecisionFromEconomics(
    offered,
    financials.before_profit,
    financials.reserve,
    tenantSettings
  );
  return { gate, financials };
}

/**
 * Sell rates for manual Invoice Hub invoices: one lead-installer hour and one installer day,
 * using the same economics as quote publish (labor + burden + overhead + profit + reserve).
 */
function computeManualInvoiceSystemSellRates(tenantSettings) {
  const settings = tenantSettings && typeof tenantSettings === "object" ? tenantSettings : {};
  const hoursPerDay = Math.max(Number(settings.hoursPerDay || 8), 0.25);
  const hourlyFin = calculateQuotePublishFinancials(
    {
      workers: [{ type: "installer", days: 1 / hoursPerDay }],
      price: "",
      _manualPriceTouched: false
    },
    settings
  );
  const dailyFin = calculateQuotePublishFinancials(
    {
      workers: [{ type: "installer", days: 1 }],
      price: "",
      _manualPriceTouched: false
    },
    settings
  );
  return {
    system_hourly_rate: hourlyFin.total,
    system_daily_rate: dailyFin.total
  };
}

module.exports = {
  calculateSecurePricing,
  calculateQuotePublishFinancials,
  computeSalesMarginDecisionFromEconomics,
  marginLevelForSalesApproval,
  computeManualInvoiceSystemSellRates,
  sanitizeWorkersForTenantPricing,
  resolveOfferedFromPricingInput,
};
