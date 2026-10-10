/**
 * Labor area allocation and compatibility. No database.
 * node scripts/test-labor-area-breakdown.js
 */

const assert = require("assert");
const {
  calculateQuotePublishFinancials,
} = require("../netlify/functions/_lib/pricing-engine");
const {
  allocateSellCents,
  buildLaborAreaBreakdown,
  publicAreasFromBreakdown,
} = require("../netlify/functions/_lib/labor-area-breakdown");

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log("ok", name);
}

const settings = {
  hoursPerDay: 8,
  baseInstaller: 10,
  baseHelper: 5,
  wcPct: 0,
  ficaPct: 0,
  futaPct: 0,
  casuiPct: 0,
  stdHours: 0,
  overheadMonthly: 0,
  profitPct: 0,
  reservePct: 0,
  minimumMarginPct: 15,
};

test("quote without areas stays a single total", () => {
  const workers = [{ type: "installer", days: 1 }];
  const financials = calculateQuotePublishFinancials(
    { workers, pricing_stage: 2 },
    settings
  );
  const built = buildLaborAreaBreakdown({
    areasInput: [],
    workers,
    tenantSettings: settings,
    total: financials.total,
  });
  assert.strictEqual(built.ok, true);
  assert.strictEqual(built.breakdown, null);
  assert.strictEqual(financials.total, 80);
});

test("area subtotals sum to the protected total", () => {
  const workers = [
    { type: "installer", days: 1, area_id: "11111111-1111-4111-8111-111111111111" },
    { type: "helper", days: 1, area_id: "22222222-2222-4222-8222-222222222222" },
  ];
  const financials = calculateQuotePublishFinancials(
    { workers, pricing_stage: 2 },
    settings
  );
  const built = buildLaborAreaBreakdown({
    areasInput: [
      { id: workers[0].area_id, name: "Room A", scope: "Prep and finish", sort_order: 0 },
      { id: workers[1].area_id, name: "Room B", scope: "Second area", sort_order: 1 },
    ],
    workers,
    tenantSettings: settings,
    total: financials.total,
  });
  assert.strictEqual(built.ok, true);
  const sum = built.publicAreas.reduce((s, area) => s + area.sell_subtotal, 0);
  assert.strictEqual(Math.round(sum * 100), Math.round(financials.total * 100));
  assert.strictEqual(built.publicAreas[0].sell_subtotal, 80);
  assert.strictEqual(built.publicAreas[1].sell_subtotal, 40);
  assert.ok(!JSON.stringify(built.publicAreas).match(/overhead|reserve|profit|rate|cost/i));
});

test("cent split stays exact when halves would drift", () => {
  const areas = [
    { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", sort_order: 0 },
    { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", sort_order: 1 },
  ];
  const cents = allocateSellCents(areas, [1, 1], 1001);
  assert.deepStrictEqual(cents.reduce((s, n) => s + n, 0), 1001);
  assert.deepStrictEqual(cents.slice().sort((a, b) => a - b), [500, 501]);
});

test("client subtotals and unassigned labor are rejected", () => {
  const money = buildLaborAreaBreakdown({
    areasInput: [{ name: "Area", scope: "Work", sell_subtotal: 1 }],
    workers: [{ type: "installer", days: 1 }],
    tenantSettings: settings,
    total: 80,
  });
  assert.strictEqual(money.ok, false);
  assert.strictEqual(money.code, "invalid_labor_areas");

  const missing = buildLaborAreaBreakdown({
    areasInput: [{ name: "Area", scope: "Work" }],
    workers: [{ type: "installer", days: 1 }],
    tenantSettings: settings,
    total: 80,
  });
  assert.strictEqual(missing.ok, false);
  assert.strictEqual(missing.code, "labor_area_required");
});

test("public projection hides stored worker rows", () => {
  const breakdown = {
    version: 1,
    areas: [{ id: "11111111-1111-4111-8111-111111111111", name: "Circuit", scope: "Lighting", sort_order: 0 }],
    workers: [{ type: "installer", days: 2, area_id: "11111111-1111-4111-8111-111111111111" }],
    public_subtotals: [{ area_id: "11111111-1111-4111-8111-111111111111", sell_cents: 16000 }],
  };
  const pub = publicAreasFromBreakdown(breakdown);
  assert.strictEqual(pub.length, 1);
  assert.strictEqual(pub[0].sell_subtotal, 160);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(pub[0], "workers"), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(pub[0], "id"), false);
});

test("minimum stage still prices the whole quote once", () => {
  const workers = [
    { type: "installer", days: 2, area_id: "11111111-1111-4111-8111-111111111111" },
  ];
  const plain = calculateQuotePublishFinancials({ workers, pricing_stage: 0 }, settings);
  const built = buildLaborAreaBreakdown({
    areasInput: [{ id: workers[0].area_id, name: "Roof section", scope: "Tear off" }],
    workers,
    tenantSettings: settings,
    total: plain.total,
  });
  assert.strictEqual(built.ok, true);
  assert.strictEqual(built.publicAreas[0].sell_subtotal, plain.total);
  assert.ok(plain.total >= plain.minimum_price);
});

console.log(passed + " passed");
