#!/usr/bin/env node
"use strict";

const assert = require("assert");
const {
  acceptedProposalProfit,
  buildOwnerProfitBreakdown,
} = require("../netlify/functions/_lib/project-financial-detail");

const bs = {
  burden_ok: true,
  fica_pct: 18.65,
  futa_pct: 0,
  casui_pct: 0,
  wc_pct: 0,
  overhead_ok: true,
  overhead_per_hour: 26.76,
  reserve_ok: true,
  reserve_pct: 5,
  commission_ok: true,
  sales_commission_pct: 10,
  supervisor_bonus_ok: true,
  supervisor_bonus_pct: 10,
};

const proposal = acceptedProposalProfit({
  bs,
  proposalTotal: 9114.61,
  estimatedLabor: 2560,
  estimatedHours: 64,
  estimatedDays: 8,
  materialCost: 0,
});
assert.strictEqual(proposal, 3396.8);

const detail = buildOwnerProfitBreakdown({
  project: {
    sale_price: 9114.61,
    estimated_profit: 0,
    estimated_labor_cost: 2560,
    labor_budget: 2560,
    estimated_material_cost: 0,
  },
  collection: { current_contract_total: 9114.61 },
  laborSection: {
    estimated: { labor_cost: 2560, hours: 64, days: 8 },
    actual: { hours: 80, days: 10, labor_cost: 2680 },
    labor_rates_missing: false,
  },
  expenses: [],
  operational: { estimated_days: 8, actual_days: 10 },
  mgSettings: {
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
  },
  acceptedQuote: { total: 9114.61, status: "accepted" },
});
assert.strictEqual(detail.projected_profit, 3396.8);
assert.notStrictEqual(detail.projected_profit, 0);

console.log("PASS projected profit comes from the accepted proposal");
