#!/usr/bin/env node
"use strict";

const assert = require("assert");
const {
  calculateQuotePublishFinancials,
  OVERHEAD_WORKING_DAYS,
} = require("../netlify/functions/_lib/pricing-engine");

const settings = {
  hoursPerDay: 8,
  baseInstaller: 75,
  baseHelper: 45,
  wcPct: 0,
  ficaPct: 0,
  futaPct: 0,
  casuiPct: 0,
  overheadMonthly: 10000,
  stdHours: 160,
  profitPct: 0,
  reservePct: 0,
  minimumMarginPct: 0,
};

function quote(workers, extra) {
  return calculateQuotePublishFinancials(
    Object.assign({ workers, pricing_stage: 2, price: "", _manualPriceTouched: false }, extra || {}),
    settings
  );
}

assert.strictEqual(OVERHEAD_WORKING_DAYS, 20);

const oneCrew = quote([{ type: "installer", days: 15 }]);
assert.strictEqual(oneCrew.exclusive_days, 15);
assert.strictEqual(oneCrew.overhead, 7500);

const sameCrewTwoPeople = quote([
  { type: "installer", days: 15 },
  { type: "helper", days: 15 },
]);
assert.strictEqual(sameCrewTwoPeople.exclusive_days, 15);
assert.strictEqual(sameCrewTwoPeople.overhead, 7500);
assert.ok(sameCrewTwoPeople.labor > oneCrew.labor);

const secondCrew = quote([{ type: "installer", days: 22 }]);
assert.strictEqual(secondCrew.exclusive_days, 22);
assert.strictEqual(secondCrew.overhead, 11000);
assert.notStrictEqual(secondCrew.overhead, oneCrew.overhead);

const plan = [];
for (let day = 1; day <= 15; day += 1) {
  plan.push({
    day_number: day,
    workers: [
      { worker_type: "installer", estimated_hours: 8 },
      { worker_type: "installer", estimated_hours: 8 },
    ],
  });
}
const aggregated = quote([{ type: "installer", days: 30 }], { operational_plan: plan });
assert.strictEqual(aggregated.exclusive_days, 15);
assert.strictEqual(aggregated.overhead, 7500);
assert.strictEqual(aggregated.totalHours, 240);

console.log("PASS overhead charges exclusive crew days, not worker hours");
