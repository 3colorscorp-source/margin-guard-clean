#!/usr/bin/env node
/**
 * Labor Cost Control: quote plan → supervisor crew reports → Result.
 * Run: node scripts/test-labor-cost-chain.js
 */
"use strict";

const assert = require("assert");
const {
  computeLaborCostSection,
  buildOwnerProfitBreakdown,
} = require("../netlify/functions/_lib/project-financial-detail");

const settings = {
  baseInstaller: 40,
  baseHelper: 30,
  ficaPct: 18.65,
  futaPct: 0,
  casuiPct: 0,
  wcPct: 0,
  overheadMonthly: 2676,
  stdHours: 100,
  salesCommissionPct: 10,
  supervisorBonusPct: 10,
  reservePct: 5,
  profitPct: 30,
  hoursPerDay: 8,
};

const quotePlan = [
  { day_number: 1, phase: "Demo", workers: [{ role: "Installer", worker_type: "pro", estimated_hours: 8, hourly_rate: 75 }] },
  { day_number: 2, phase: "Set", workers: [{ role: "Installer", worker_type: "pro", estimated_hours: 8, hourly_rate: 75 }] },
];

const project = {
  id: "p-labor",
  estimated_days: 2,
  labor_budget: 9000,
  estimated_labor_cost: 9000,
  sale_price: 5000,
  quoted_labor_plan: [{ type: "installer", budget_hours: 64, budget_days: 8 }],
};

function crewNote(people) {
  return "\n[[mg-crew:v1]]" + JSON.stringify(people);
}

const reports = [
  {
    hours: 8,
    days: 1,
    day_number: 1,
    note: crewNote([
      { role: "pro", name: "A" },
      { role: "assistant", name: "B" },
    ]),
  },
];

const dayProgressRows = [
  { day_number: 1, status: "completed" },
  { day_number: 2, status: "completed" },
];

const labor = computeLaborCostSection({
  project,
  reports,
  mgSettings: settings,
  operationalPlanRaw: quotePlan,
  dayProgressRows,
});

assert.strictEqual(labor.cost_method, "business_settings_rates");
assert.strictEqual(labor.estimated.hours, 16);
assert.strictEqual(labor.estimated.days, 2);
assert.strictEqual(labor.estimated.labor_cost, 640);
assert.strictEqual(labor.actual.hours, 8);
assert.strictEqual(labor.actual.days, 1);
assert.strictEqual(labor.actual.pro_hours, 4);
assert.strictEqual(labor.actual.assistant_hours, 4);
assert.strictEqual(labor.actual.labor_cost, 280);
assert.strictEqual(labor.actual.pro_cost, 160);
assert.strictEqual(labor.actual.assistant_cost, 120);
assert.strictEqual(labor.variance.cost, -360);

const profit = buildOwnerProfitBreakdown({
  project,
  collection: { current_contract_total: 5000 },
  laborSection: labor,
  expenses: [],
  operational: { estimated_days: 2, actual_days: 9 },
  mgSettings: settings,
  acceptedQuote: { total: 5000, status: "accepted" },
});

assert.strictEqual(profit.owner_profit_breakdown.direct_labor_cost, 280);
assert.strictEqual(profit.owner_profit_breakdown.employer_burden, 52.22);
assert.strictEqual(profit.owner_profit_breakdown.operating_cost_allocation, 214.08);
assert.strictEqual(profit.owner_profit_breakdown.seller_commission, 64);
assert.strictEqual(profit.profit_is_incomplete, false);

const uncrewed = computeLaborCostSection({
  project,
  reports: [{ hours: 8, days: 1, note: "no crew" }],
  mgSettings: settings,
  operationalPlanRaw: quotePlan,
});
assert.strictEqual(uncrewed.actual.labor_cost, null);
assert.strictEqual(uncrewed.labor_rates_missing, true);
assert.match(uncrewed.labor_rates_message, /who worked/);

const notReported = computeLaborCostSection({
  project,
  reports: [],
  mgSettings: settings,
  operationalPlanRaw: quotePlan,
});
assert.strictEqual(notReported.labor_not_reported, true);
assert.strictEqual(notReported.actual.labor_cost, null);
const held = buildOwnerProfitBreakdown({
  project,
  collection: { current_contract_total: 5000 },
  laborSection: notReported,
  expenses: [],
  operational: { estimated_days: 2, actual_days: 0 },
  mgSettings: settings,
});
assert.strictEqual(held.profit_is_incomplete, true);
assert.strictEqual(held.owner_profit_breakdown.direct_labor_cost, null);
assert.match(held.profit_incomplete_message, /not reported labor/);

console.log("PASS labor cost follows the quote plan and supervisor reports");
