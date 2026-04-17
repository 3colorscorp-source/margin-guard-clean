/**
 * Server-side secure pricing (Phase 1: structure + simulated output).
 * Real migration from browser calcSales will come in later phases.
 */

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function laborBaseFromWorkers(workers, tenantSettings) {
  const list = Array.isArray(workers) ? workers : [];
  const hoursPerDay = Number(tenantSettings.hoursPerDay || 8);
  const baseHelper = Number(tenantSettings.baseHelper || 45);
  const baseInstaller = Number(tenantSettings.baseInstaller || 75);

  let sum = 0;
  for (const w of list) {
    const days = Number(w?.days || 0);
    const fallback = w?.type === 'helper' ? baseHelper : baseInstaller;
    const rate =
      w?.rate === '' || w?.rate == null ? fallback : Number(w?.rate || 0);
    sum += days * hoursPerDay * rate;
  }
  return sum;
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
  const workers = Array.isArray(input?.workers) ? input.workers : [];

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
    const rate =
      worker.rate === "" || worker.rate == null ? baseRate : Number(worker.rate || 0);
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

  const rawOffered =
    input?.price === null || input?.price === undefined ? "" : String(input.price);
  const manualOfferedActive = Boolean(input?._manualPriceTouched) && rawOffered !== "";
  const offered = manualOfferedActive
    ? finiteNumber(rawOffered, recommended)
    : recommended;

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
    totalWorkerDays: round2(totalWorkerDays)
  };
}

module.exports = {
  calculateSecurePricing,
  calculateQuotePublishFinancials
};
