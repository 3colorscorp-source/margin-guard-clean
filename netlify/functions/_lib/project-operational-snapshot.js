/**
 * Supervisor field performance snapshot — labor/schedule/bonus only (no owner financials).
 */

const { deriveLaborConsumedFromReports, round2, num } = require("./project-snapshot");
const {
  computeSupervisorExecutionBonus,
  supervisorBonusStatusFromCalc,
} = require("./supervisor-execution-bonus");

const DEFAULT_HOURS_PER_DAY = 8;

function pickStoredMoney(stored, fallback = 0) {
  if (stored == null || stored === "") return fallback;
  const n = Number(stored);
  return Number.isFinite(n) ? round2(n) : fallback;
}

function preferPositive(stored, fallback) {
  const n = pickStoredMoney(stored, NaN);
  if (Number.isFinite(n) && n > 0) return n;
  const f = round2(fallback);
  return f > 0 ? f : round2(stored === 0 || stored === "0" ? 0 : fallback);
}

function sumReportDays(reports) {
  if (!Array.isArray(reports)) return 0;
  return round2(reports.reduce((s, r) => s + num(r?.days, 0), 0));
}

function sumReportHours(reports) {
  if (!Array.isArray(reports)) return 0;
  return round2(reports.reduce((s, r) => s + num(r?.hours, 0), 0));
}

function maxPlanWorkerDays(quotedLaborPlan) {
  if (!Array.isArray(quotedLaborPlan)) return 0;
  let mx = 0;
  for (const w of quotedLaborPlan) {
    if (!w || typeof w !== "object") continue;
    const days = num(w.budget_days ?? w.days, 0);
    mx = Math.max(mx, days);
  }
  return round2(mx);
}

function sumPlanBudgetHours(quotedLaborPlan, hoursPerDay) {
  if (!Array.isArray(quotedLaborPlan)) return 0;
  const hpd = Math.max(num(hoursPerDay, DEFAULT_HOURS_PER_DAY), 0.25);
  let sum = 0;
  for (const w of quotedLaborPlan) {
    if (!w || typeof w !== "object") continue;
    const hours = num(w.budget_hours, NaN);
    if (Number.isFinite(hours) && hours > 0) {
      sum += hours;
    } else {
      sum += num(w.budget_days ?? w.days, 0) * hpd;
    }
  }
  return round2(sum);
}

function laborDeviationLabel(deviationDays) {
  const d = num(deviationDays, 0);
  if (Math.abs(d) < 0.01) return "On budget";
  if (d > 0) return `${d.toFixed(2)} day(s) over budget`;
  return `${Math.abs(d).toFixed(2)} day(s) under budget`;
}

/**
 * Operational risk from labor/schedule only (no profit or margin).
 * @returns {"low"|"medium"|"high"}
 */
function computeOperationalRisk({ estimatedDays, actualDays, laborDeviationDays }) {
  const est = num(estimatedDays, 0);
  const actual = num(actualDays, 0);
  const dev = num(laborDeviationDays, 0);

  if (est > 0 && actual > est + 2) return "high";
  if (dev > 2) return "high";
  if (est > 0 && actual > est) return "medium";
  if (dev > 0.25) return "medium";
  return "low";
}

/**
 * Explicit allowlist — only these keys may be returned to Supervisor clients.
 */
const OPERATIONAL_SNAPSHOT_KEYS = [
  "labor_budget",
  "actual_labor",
  "remaining_labor_budget",
  "estimated_days",
  "actual_days",
  "days_remaining",
  "estimated_hours",
  "actual_hours",
  "labor_deviation_days",
  "labor_deviation_label",
  "operational_risk",
  "supervisor_bonus_amount",
  "supervisor_bonus_status",
  "supervisor_bonus_pct_of_potential",
  "report_count",
  "expense_count",
  "completion_pace_pct",
];

function pickAllowlistedOperational(raw) {
  const out = Object.create(null);
  for (const key of OPERATIONAL_SNAPSHOT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) {
      out[key] = raw[key];
    }
  }
  return out;
}

/**
 * @param {object} params
 * @param {object} params.project
 * @param {Array} [params.reports]
 * @param {Array} [params.expenses]
 * @param {number} [params.supervisorBonusPctPoints]
 * @param {number} [params.hoursPerDay]
 */
function computeProjectOperationalSnapshot({
  project,
  reports,
  expenses,
  supervisorBonusPctPoints = 1,
  hoursPerDay = DEFAULT_HOURS_PER_DAY,
}) {
  const proj = project && typeof project === "object" ? project : {};
  const reps = Array.isArray(reports) ? reports : [];
  const exps = Array.isArray(expenses) ? expenses : [];

  const laborBudget = preferPositive(
    proj.estimated_labor_cost,
    num(proj.labor_budget, 0)
  );

  const storedLaborConsumed = pickStoredMoney(proj.labor_consumed_total, NaN);
  const derivedLabor = deriveLaborConsumedFromReports(proj, reps);
  const actualLabor = Number.isFinite(storedLaborConsumed)
    ? round2(Math.max(0, storedLaborConsumed))
    : round2(Math.max(0, derivedLabor));

  const remainingLaborBudget = round2(Math.max(0, laborBudget - actualLabor));

  const plan = Array.isArray(proj.quoted_labor_plan) ? proj.quoted_labor_plan : [];
  const maxPlanDays = maxPlanWorkerDays(plan);
  const estimatedDays = round2(
    maxPlanDays > 0 ? maxPlanDays : num(proj.estimated_days, 0)
  );
  const actualDays = sumReportDays(reps);

  const hpd = Math.max(num(hoursPerDay, DEFAULT_HOURS_PER_DAY), 0.25);
  const planHours = sumPlanBudgetHours(plan, hpd);
  const estimatedHours =
    planHours > 0 ? planHours : round2(estimatedDays * hpd);
  const actualHours = sumReportHours(reps);

  const laborDeviationDays = round2(actualDays - estimatedDays);

  const effectiveDaysForBonus =
    maxPlanDays > 0 ? maxPlanDays : estimatedDays;

  const bonusCalc = computeSupervisorExecutionBonus({
    laborBudget,
    effectiveDays: effectiveDaysForBonus,
    daysSpent: actualDays,
    supervisorBonusPctPoints: num(supervisorBonusPctPoints, 1),
  });

  const completionPacePct =
    estimatedDays > 0 ? Math.round((actualDays / estimatedDays) * 100) : null;

  const daysRemaining = round2(Math.max(0, estimatedDays - actualDays));

  const raw = {
    labor_budget: laborBudget,
    actual_labor: actualLabor,
    remaining_labor_budget: remainingLaborBudget,
    estimated_days: estimatedDays,
    actual_days: actualDays,
    days_remaining: daysRemaining,
    estimated_hours: estimatedHours,
    actual_hours: actualHours,
    labor_deviation_days: laborDeviationDays,
    labor_deviation_label: laborDeviationLabel(laborDeviationDays),
    operational_risk: computeOperationalRisk({
      estimatedDays,
      actualDays,
      laborDeviationDays,
    }),
    supervisor_bonus_amount: bonusCalc.bonusActual,
    supervisor_bonus_status: supervisorBonusStatusFromCalc(bonusCalc, laborBudget),
    supervisor_bonus_pct_of_potential: bonusCalc.pctOfPotential,
    report_count: reps.length,
    expense_count: exps.length,
    completion_pace_pct: completionPacePct,
  };

  return pickAllowlistedOperational(raw);
}

module.exports = {
  computeProjectOperationalSnapshot,
  pickAllowlistedOperational,
  OPERATIONAL_SNAPSHOT_KEYS,
  computeOperationalRisk,
};
