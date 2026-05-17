/**
 * Supervisor execution bonus (labor-budget based only — no contract revenue).
 */

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function round2(n) {
  return Math.round(num(n, 0) * 100) / 100;
}

/**
 * @param {{ laborBudget: number, effectiveDays: number, daysSpent: number, supervisorBonusPctPoints: number }} input
 */
function computeSupervisorExecutionBonus(input) {
  const lb = num(input?.laborBudget, 0);
  const timeline = num(input?.effectiveDays, 0);
  const spent = num(input?.daysSpent, 0);
  const pctPoints = num(input?.supervisorBonusPctPoints, 0);
  const rate = pctPoints / 100;
  const bonusBase = lb * rate;
  const delayDays = Math.max(0, spent - timeline);
  const penaltyPerDay = timeline > 0 ? bonusBase / timeline : 0;
  const bonusActual = Math.max(0, bonusBase - delayDays * penaltyPerDay);
  const pctOfPotential = bonusBase > 0 ? Math.round((bonusActual / bonusBase) * 100) : 0;
  return {
    bonusBase: round2(bonusBase),
    bonusActual: round2(bonusActual),
    delayDays: round2(delayDays),
    penaltyPerDay: round2(penaltyPerDay),
    pctOfPotential,
    pctPoints,
  };
}

function supervisorBonusStatusFromCalc(calc, laborBudget) {
  if (num(laborBudget, 0) <= 0) return "Not available";
  const pct = num(calc?.pctOfPotential, 0);
  const delay = num(calc?.delayDays, 0);
  if (pct >= 80 && delay <= 0.5) return "On track";
  if (pct >= 50) return "At risk";
  return "Behind";
}

module.exports = {
  computeSupervisorExecutionBonus,
  supervisorBonusStatusFromCalc,
};
