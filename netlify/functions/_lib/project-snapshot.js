/**
 * Supervisor Project Snapshot — server-side financial read model (Phase 2).
 * Pure calculations; no I/O. Never trust browser-supplied numbers for display.
 */

function round2(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 100) / 100;
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

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

function sumReportHours(reports) {
  if (!Array.isArray(reports)) return 0;
  return round2(reports.reduce((s, r) => s + num(r?.hours, 0), 0));
}

function sumExpenseAmounts(expenses) {
  if (!Array.isArray(expenses)) return 0;
  return round2(expenses.reduce((s, r) => s + num(r?.amount, 0), 0));
}

function sumAppliedChangeOrders(changeOrders) {
  if (!Array.isArray(changeOrders)) return 0;
  return round2(
    changeOrders.reduce((s, row) => {
      if (!row || typeof row !== "object") return s;
      const st = String(row.status || "")
        .trim()
        .toLowerCase();
      if (st !== "applied") return s;
      return s + Math.max(0, num(row.client_price, 0));
    }, 0)
  );
}

/**
 * Same blended hourly rate as recalc-project-profit (fallback only).
 */
function deriveLaborConsumedFromReports(project, reports) {
  const estDays = num(project?.estimated_days, 0);
  const laborBudget = num(project?.labor_budget, 0);
  let hourlyRate = 0;
  if (estDays > 0 && laborBudget > 0) {
    hourlyRate = laborBudget / (estDays * 8);
  }
  const hoursSum = sumReportHours(reports);
  return round2(hoursSum * hourlyRate);
}

/**
 * @param {object} params
 * @param {object} params.project - tenant_projects row
 * @param {Array} [params.reports]
 * @param {Array} [params.expenses]
 * @param {Array} [params.changeOrders]
 * @returns {object} snapshot fields (snake_case)
 */
function computeProjectSnapshot({ project, reports, expenses, changeOrders }) {
  const proj = project && typeof project === "object" ? project : {};

  const originalContract = round2(Math.max(0, num(proj.sale_price, 0)));

  const appliedFromProject = pickStoredMoney(proj.applied_change_order_total, NaN);
  const appliedFromRows = sumAppliedChangeOrders(changeOrders);
  const approvedChangeOrders = Number.isFinite(appliedFromProject)
    ? round2(Math.max(0, appliedFromProject))
    : appliedFromRows;

  const storedProjectedRevenue = pickStoredMoney(proj.projected_revenue_total, NaN);
  const currentContractTotal =
    Number.isFinite(storedProjectedRevenue) && storedProjectedRevenue > 0
      ? round2(storedProjectedRevenue)
      : round2(originalContract + approvedChangeOrders);

  const laborBudget = preferPositive(
    proj.estimated_labor_cost,
    num(proj.labor_budget, 0)
  );

  const storedLaborConsumed = pickStoredMoney(proj.labor_consumed_total, NaN);
  const derivedLabor = deriveLaborConsumedFromReports(proj, reports);
  const actualLabor = Number.isFinite(storedLaborConsumed)
    ? round2(Math.max(0, storedLaborConsumed))
    : round2(Math.max(0, derivedLabor));

  const materialBudget = round2(Math.max(0, num(proj.estimated_material_cost, 0)));
  const actualMaterials = 0;

  const storedUnexpected = pickStoredMoney(proj.unexpected_expense_total, NaN);
  const derivedUnexpected = sumExpenseAmounts(expenses);
  const unexpectedExpenses = Number.isFinite(storedUnexpected)
    ? round2(Math.max(0, storedUnexpected))
    : round2(Math.max(0, derivedUnexpected));

  const projectedProfit = round2(num(proj.estimated_profit, 0));

  const storedRealProfit = pickStoredMoney(proj.real_profit_total, NaN);
  let currentProfit = Number.isFinite(storedRealProfit)
    ? round2(storedRealProfit)
    : round2(
        currentContractTotal - actualLabor - actualMaterials - unexpectedExpenses
      );

  const storedMargin = num(proj.real_margin_pct, NaN);
  let currentMarginPct = Number.isFinite(storedMargin)
    ? round2(storedMargin)
    : currentContractTotal > 0
      ? round2(currentProfit / currentContractTotal)
      : 0;

  const estimatedMarginPct = round2(num(proj.estimated_profit_margin, 0));

  const marginRisk = computeMarginRisk({
    currentProfit,
    currentMarginPct,
    estimatedMarginPct,
    projectedProfit,
  });

  return {
    original_contract: originalContract,
    approved_change_orders: approvedChangeOrders,
    current_contract_total: currentContractTotal,
    labor_budget: laborBudget,
    actual_labor: actualLabor,
    material_budget: materialBudget,
    actual_materials: actualMaterials,
    unexpected_expenses: unexpectedExpenses,
    projected_profit: projectedProfit,
    current_profit: currentProfit,
    current_margin_pct: currentMarginPct,
    margin_risk: marginRisk,
  };
}

/**
 * @returns {"low"|"medium"|"high"}
 */
function computeMarginRisk({ currentProfit, currentMarginPct, estimatedMarginPct, projectedProfit }) {
  const curP = num(currentProfit, 0);
  const curM = num(currentMarginPct, 0);
  const estM = num(estimatedMarginPct, 0);
  const projP = num(projectedProfit, 0);

  if (curP < 0 || curM < 0) return "high";

  if (estM > 0 && curM < estM - 0.12) return "high";

  if (projP > 0 && curP < projP * 0.75) return "high";

  if (estM > 0 && curM < estM - 0.05) return "medium";

  if (projP > 0 && curP < projP * 0.9) return "medium";

  if (curM < 0.1 && estM >= 0.2) return "medium";

  return "low";
}

module.exports = {
  computeProjectSnapshot,
  computeMarginRisk,
  deriveLaborConsumedFromReports,
  round2,
  num,
};
