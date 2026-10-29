/**
 * Edit Quote must recover published labor lines when pricing_workers is empty.
 * Run: node scripts/test-quote-edit-price-anchors.js
 */
"use strict";

const assert = require("assert");
const { serializeRepriceState } = require("../netlify/functions/_lib/quote-reprice-helpers");

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log("ok", name);
}

const areaId = "11111111-1111-4111-8111-111111111111";
const publishedWorker = { type: "installer", days: 4, area_id: areaId };

test("published quote uses labor stored on the area breakdown", () => {
  const state = serializeRepriceState({
    pricing_workers: null,
    pricing_stage: null,
    labor_area_breakdown: {
      version: 1,
      areas: [{ id: areaId, name: "Restroom 203", scope: "Floor tile", sort_order: 0 }],
      workers: [publishedWorker],
      public_subtotals: [{ area_id: areaId, sell_cents: 657311 }],
    },
  });
  assert.deepStrictEqual(state.pricing_workers, [publishedWorker]);
  assert.strictEqual(state.labor_areas[0].name, "Restroom 203");
  assert.strictEqual(state.labor_area_public[0].sell_subtotal, 6573.11);
});

test("a later reprice keeps the pricing_workers column", () => {
  const repriced = { type: "helper", days: 2, area_id: areaId };
  const state = serializeRepriceState({
    pricing_workers: [repriced],
    labor_area_breakdown: {
      workers: [publishedWorker],
    },
  });
  assert.deepStrictEqual(state.pricing_workers, [repriced]);
});

test("empty worker stubs do not hide the published labor lines", () => {
  const state = serializeRepriceState({
    pricing_workers: [{ type: "installer", days: 0 }],
    labor_area_breakdown: JSON.stringify({ workers: [publishedWorker] }),
  });
  assert.deepStrictEqual(state.pricing_workers, [publishedWorker]);
});

console.log(passed + " passed");
