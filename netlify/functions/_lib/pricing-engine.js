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

module.exports = {
  calculateSecurePricing
};
