/**
 * Financial Command Center metrics.
 * Canonical operating cost: owner_settings.overhead_monthly
 * Canonical savings months: owner_settings.savings_target_months
 * Canonical runway tones: owner_settings.runway_green_days / runway_yellow_days
 *
 * Missing/failed settings must not become fake $0 / 0.0 months / High Risk.
 */
"use strict";

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function finiteOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function healthToneFromScore(score) {
  if (score >= 80) return "green";
  if (score >= 55) return "amber";
  return "red";
}

/**
 * Business Health (only when overhead_monthly > 0 is loaded):
 *   score = clamp(
 *     (runwayMonths * 7)
 *     + (min(savingsPct, 100) * 0.35)
 *     + (operatingBalance >= overheadMonthly ? 20 : 0),
 *     0, 100
 *   )
 *   tone = green if score >= 80, amber if score >= 55, else red
 *
 * Inputs: cash_on_hand, savings_balance, operating (expenses) balance,
 *         overhead_monthly, savings_target_months.
 * Missing settings: available=false, score=null, tone=unknown — not High Risk.
 */
function computeFinancialCommandMetrics(input) {
  const src = input && typeof input === "object" ? input : {};
  const settingsError = src.settingsError === true;
  const settingsLoaded = src.settingsLoaded !== false && !settingsError;
  const overheadMonthly = finiteOrNull(src.overheadMonthly);
  const savingsTargetMonths = finiteOrNull(src.savingsTargetMonths);
  const cashOnHand = finiteOrNull(src.cashOnHand);
  const savingsBalance = finiteOrNull(src.savingsBalance);
  const operatingBalance = finiteOrNull(src.operatingBalance);
  const runwayGreenDays = finiteOrNull(src.runwayGreenDays);
  const runwayYellowDays = finiteOrNull(src.runwayYellowDays);

  const unavailable = {
    available: false,
    reason: settingsError ? "unavailable" : "setup_required",
    overheadMonthly: null,
    savingsTargetMonths: null,
    runwayMonths: null,
    runwayDays: null,
    savingsTarget: null,
    savingsPct: null,
    healthScore: null,
    healthTone: "unknown",
    healthLabel: settingsError ? "Operating cost unavailable" : "Setup required",
    runwayLabel: settingsError ? "Operating cost unavailable" : "Setup required",
    savingsTargetLabel: settingsError ? "Operating cost unavailable" : "Setup required",
    savingsProgressLabel: settingsError ? "Operating cost unavailable" : "Setup required",
    runwayGreenDays,
    runwayYellowDays,
  };

  if (!settingsLoaded || settingsError) {
    return unavailable;
  }

  if (!(overheadMonthly > 0)) {
    return {
      ...unavailable,
      reason: "setup_required",
      healthLabel: "Setup required",
      runwayLabel: "Setup required",
      savingsTargetLabel: "Setup required",
      savingsProgressLabel: "Setup required",
    };
  }

  const cash = cashOnHand == null ? 0 : cashOnHand;
  const savings = savingsBalance == null ? 0 : savingsBalance;
  const operating = operatingBalance == null ? 0 : operatingBalance;
  const runwayMonths = cash / overheadMonthly;
  const runwayDays = runwayMonths * 30;
  const savingsTarget =
    savingsTargetMonths > 0 ? overheadMonthly * savingsTargetMonths : null;
  const savingsPct =
    savingsTarget != null && savingsTarget > 0
      ? clamp((savings / savingsTarget) * 100, 0, 999)
      : null;
  const savingsForScore = savingsPct == null ? 0 : Math.min(savingsPct, 100);
  const healthScore = clamp(
    runwayMonths * 7 + savingsForScore * 0.35 + (operating >= overheadMonthly ? 20 : 0),
    0,
    100
  );
  const healthTone = healthToneFromScore(healthScore);

  return {
    available: true,
    reason: "ok",
    overheadMonthly,
    savingsTargetMonths: savingsTargetMonths > 0 ? savingsTargetMonths : null,
    runwayMonths,
    runwayDays,
    savingsTarget,
    savingsPct,
    healthScore,
    healthTone,
    healthLabel:
      healthTone === "green"
        ? "Cash discipline is protecting the business."
        : healthTone === "amber"
          ? "The business is stable but under pressure."
          : "High risk. Real cash is not protecting operations.",
    runwayLabel: `${runwayMonths.toFixed(2)} months`,
    savingsTargetLabel: savingsTarget == null ? "Setup required" : null,
    savingsProgressLabel:
      savingsPct == null ? "Setup required" : `${savingsPct.toFixed(2)}%`,
    runwayGreenDays,
    runwayYellowDays,
  };
}

const api = {
  clamp,
  computeFinancialCommandMetrics,
  healthToneFromScore,
};

if (typeof module === "object" && module.exports) {
  module.exports = api;
}

if (typeof window !== "undefined") {
  window.MgFinancialCommandMetrics = api;
}
