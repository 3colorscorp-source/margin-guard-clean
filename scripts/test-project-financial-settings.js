#!/usr/bin/env node
/**
 * Project financial detail prices labor from Business Settings when the project has no labor budget.
 * Run: node scripts/test-project-financial-settings.js
 */
"use strict";

const assert = require("assert");
const {
  computeLaborCostSection,
  buildOwnerProfitBreakdown,
  businessSettingsForReport,
} = require("../netlify/functions/_lib/project-financial-detail");

const settings = {
  baseInstaller: 50,
  baseHelper: 30,
  ficaPct: 7.65,
  futaPct: 0.6,
  casuiPct: 3.4,
  wcPct: 2,
  overheadMonthly: 4000,
  stdHours: 160,
  salesCommissionPct: 8,
  supervisorBonusPct: 2,
  reservePct: 5,
  profitPct: 30,
  hoursPerDay: 8,
};

const project = {
  id: "p1",
  estimated_days: 8,
  labor_budget: 0,
  estimated_labor_cost: 0,
  sale_price: 9114.61,
  quoted_labor_plan: [],
};

const reports = [
  {
    hours: 8,
    days: 1,
    note:
      "Day 2 — Demolition of walls\n[[mg-crew:v1]]" +
      JSON.stringify([
        { role: "pro", name: "" },
        { role: "assistant", name: "" },
      ]),
  },
  {
    hours: 8,
    days: 1,
    note:
      "Day 1 — Cover floors and walls\n[[mg-crew:v1]]" +
      JSON.stringify([{ role: "assistant", name: "" }]),
  },
];

const labor = computeLaborCostSection({
  project,
  reports,
  mgSettings: settings,
});

assert.strictEqual(labor.cost_method, "business_settings_rates");
assert.strictEqual(labor.labor_rates_missing, false);
assert.strictEqual(labor.actual.labor_cost, 560);
assert.strictEqual(labor.actual.pro_hours, 4);
assert.strictEqual(labor.actual.assistant_hours, 12);
assert.strictEqual(labor.estimated.labor_cost, 3200);
assert.ok(String(labor.rate_basis).includes("50"));

const missing = computeLaborCostSection({
  project,
  reports,
  mgSettings: { ...settings, baseInstaller: 0, baseHelper: 0 },
});
assert.strictEqual(missing.labor_rates_missing, true);
assert.ok(String(missing.labor_rates_message).includes("Business Settings"));

const profit = buildOwnerProfitBreakdown({
  project,
  collection: { current_contract_total: 9114.61 },
  laborSection: labor,
  expenses: [{ amount: 302 }],
  operational: { estimated_days: 8, actual_days: 2 },
  mgSettings: settings,
});

assert.strictEqual(profit.owner_profit_breakdown.direct_labor_cost, 560);
assert.strictEqual(profit.profit_is_incomplete, false);
assert.ok(Number.isFinite(profit.current_profit));
assert.ok(Number.isFinite(profit.margin_pct));

const shown = businessSettingsForReport(settings);
assert.strictEqual(shown.pro_rate, 50);
assert.strictEqual(shown.assistant_rate, 30);
assert.strictEqual(shown.labor_rates_ok, true);
assert.strictEqual(shown.target_margin_pct, 30);
assert.ok(shown.burden_ok);
assert.ok(shown.overhead_per_hour > 0);

console.log("PASS business settings price the project report");
