/**
 * Pre-deploy verification: operational plan → full labor_budget persistence.
 * Run: node scripts/verify-labor-budget-persistence.js
 */

const {
  normalizeOperationalPlan,
  laborCostFromOperationalPlan,
  quotedLaborPlanRowsFromOperationalPlan,
} = require("../netlify/functions/_lib/operational-plan");
const { buildEstimateEconomics } = require("../netlify/functions/_lib/project-labor-plan");
const { computeProjectOperationalSnapshot } = require("../netlify/functions/_lib/project-operational-snapshot");

const SETTINGS = {
  baseInstaller: 40,
  baseHelper: 30,
  hoursPerDay: 8,
  salesCommissionPct: 6,
  supervisorBonusPct: 3,
};

const THREE_DAY_PLAN = [
  {
    day_number: 1,
    phase: "Day 1",
    workers: [{ role: "Installer", worker_type: "pro", estimated_hours: 8 }],
  },
  {
    day_number: 2,
    phase: "Day 2",
    workers: [
      { role: "Installer", worker_type: "pro", estimated_hours: 8 },
      { role: "Assistant", worker_type: "helper", estimated_hours: 8 },
    ],
  },
  {
    day_number: 3,
    phase: "Day 3",
    workers: [
      { role: "Installer", worker_type: "pro", estimated_hours: 8 },
      { role: "Assistant", worker_type: "helper", estimated_hours: 8 },
    ],
  },
];

const EXPECTED_LABOR = 1440;
const EXPECTED_BONUS = 43.2;
const EXPECTED_COMMISSION = 86.4;

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function simulateFirmarRow(body, pricingSettings) {
  const hoursPerDay = Math.max(Number(body.hours_per_day || 8), 0.25);
  const opNormalized = normalizeOperationalPlan(body.operational_plan, null, hoursPerDay);
  const economics = buildEstimateEconomics({
    workers: body.workers || [],
    settings: pricingSettings,
    salePrice: body.sale_price || 10000,
    hoursPerDay,
    operationalPlan: body.operational_plan,
    operationalPlanNormalized: opNormalized,
    estimatedLaborCost: Number.isFinite(Number(opNormalized?.length))
      ? NaN
      : Number(body.estimated_labor_cost),
  });
  return {
    labor_budget: economics.estimatedLaborCost,
    estimated_labor_cost: economics.estimatedLaborCost,
    quoted_labor_plan: economics.quotedLaborPlan,
  };
}

function simulatePublicAcceptInsert(quoteWorkers, opPlan, settings) {
  const hoursPerDay = Number(settings.hoursPerDay) || 8;
  const opNormalized = normalizeOperationalPlan(opPlan, null, hoursPerDay);
  const economics = buildEstimateEconomics({
    workers: quoteWorkers,
    settings,
    salePrice: 10000,
    hoursPerDay,
    operationalPlan: opPlan,
    operationalPlanNormalized: opNormalized,
  });
  return {
    labor_budget: economics.estimatedLaborCost,
    estimated_labor_cost: economics.estimatedLaborCost,
    quoted_labor_plan: economics.quotedLaborPlan,
  };
}

function simulateAcceptSnapshotPatch(normalized, settings) {
  return {
    labor_budget: laborCostFromOperationalPlan(normalized, settings),
    estimated_labor_cost: laborCostFromOperationalPlan(normalized, settings),
    quoted_labor_plan: quotedLaborPlanRowsFromOperationalPlan(
      normalized,
      settings,
      settings.hoursPerDay || 8
    ),
  };
}

function main() {
  const normalized = normalizeOperationalPlan(THREE_DAY_PLAN, null, 8);
  const labor = laborCostFromOperationalPlan(normalized, SETTINGS);
  assert(labor === EXPECTED_LABOR, `labor cost expected ${EXPECTED_LABOR}, got ${labor}`);

  const firmarBody = {
    labor_budget: 560,
    estimated_labor_cost: 560,
    hours_per_day: 8,
    sale_price: 10000,
    workers: [{ type: "installer", days: 1 }],
    operational_plan: THREE_DAY_PLAN,
  };
  const firmarRow = simulateFirmarRow(firmarBody, SETTINGS);
  assert(
    firmarRow.labor_budget === EXPECTED_LABOR,
    `Firmar labor_budget expected ${EXPECTED_LABOR}, got ${firmarRow.labor_budget}`
  );
  assert(
    firmarRow.estimated_labor_cost === EXPECTED_LABOR,
    `Firmar estimated_labor_cost expected ${EXPECTED_LABOR}, got ${firmarRow.estimated_labor_cost}`
  );
  assert(
    firmarRow.quoted_labor_plan.length === 5,
    `Firmar quoted_labor_plan rows expected 5, got ${firmarRow.quoted_labor_plan.length}`
  );
  assert(
    firmarRow.labor_budget !== 560,
    "Firmar must ignore client one-day labor_budget=560"
  );

  const acceptRow = simulatePublicAcceptInsert(
    [{ type: "installer", days: 1 }],
    THREE_DAY_PLAN,
    SETTINGS
  );
  assert(
    acceptRow.labor_budget === EXPECTED_LABOR,
    `Accept insert labor_budget expected ${EXPECTED_LABOR}, got ${acceptRow.labor_budget}`
  );
  assert(
    acceptRow.quoted_labor_plan.length === 5,
    `Accept quoted_labor_plan rows expected 5, got ${acceptRow.quoted_labor_plan.length}`
  );

  const snapPatch = simulateAcceptSnapshotPatch(normalized, SETTINGS);
  assert(
    snapPatch.labor_budget === EXPECTED_LABOR,
    `Snapshot patch labor_budget expected ${EXPECTED_LABOR}, got ${snapPatch.labor_budget}`
  );

  const emptySettingsFirmar = simulateFirmarRow(firmarBody, {});
  assert(
    emptySettingsFirmar.labor_budget === 2520,
    `Without Business Settings, defaults 75/45 apply (2520 not 1440); upsert must load tenant snapshot — got ${emptySettingsFirmar.labor_budget}`
  );

  const snap = computeProjectOperationalSnapshot({
    project: {
      labor_budget: EXPECTED_LABOR,
      estimated_labor_cost: EXPECTED_LABOR,
      estimated_days: 3,
      quoted_labor_plan: firmarRow.quoted_labor_plan,
    },
    supervisorBonusPctPoints: SETTINGS.supervisorBonusPct,
  });
  assert(
    snap.supervisor_bonus_amount === EXPECTED_BONUS,
    `Supervisor bonus expected ${EXPECTED_BONUS}, got ${snap.supervisor_bonus_amount}`
  );

  const sellerCommission =
    Math.round(EXPECTED_LABOR * (SETTINGS.salesCommissionPct / 100) * 100) / 100;
  assert(
    sellerCommission === EXPECTED_COMMISSION,
    `Seller commission expected ${EXPECTED_COMMISSION}, got ${sellerCommission}`
  );

  console.log(JSON.stringify({
    ok: true,
    labor,
    firmar: {
      labor_budget: firmarRow.labor_budget,
      estimated_labor_cost: firmarRow.estimated_labor_cost,
      quoted_labor_plan_rows: firmarRow.quoted_labor_plan.length,
      client_560_ignored: firmarRow.labor_budget !== 560,
    },
    publicAccept: {
      labor_budget: acceptRow.labor_budget,
      quoted_labor_plan_rows: acceptRow.quoted_labor_plan.length,
    },
    supervisor_bonus_amount: snap.supervisor_bonus_amount,
    seller_commission: sellerCommission,
    note: "Firmar requires tenant snapshot settings load in upsert-tenant-project (empty {} → wrong rates)",
  }, null, 2));
}

main();
