#!/usr/bin/env node
"use strict";

const assert = require("assert");
const {
  calculateQuotePublishFinancials,
  OVERHEAD_MONTH_DAYS,
  overheadPerWorkerHour,
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

function quote(workers, extra, tenantSettings) {
  return calculateQuotePublishFinancials(
    Object.assign({ workers, pricing_stage: 2, price: "", _manualPriceTouched: false }, extra || {}),
    tenantSettings || settings
  );
}

assert.strictEqual(OVERHEAD_MONTH_DAYS, 24);
assert.strictEqual(overheadPerWorkerHour(10000, 8), 10000 / 24 / 8);

const onePerson = quote([{ type: "installer", days: 15 }]);
assert.strictEqual(onePerson.totalHours, 120);
assert.strictEqual(onePerson.overhead, 6250);

const twoPeople = quote([
  { type: "installer", days: 15 },
  { type: "helper", days: 15 },
]);
assert.strictEqual(twoPeople.totalHours, 240);
assert.strictEqual(twoPeople.overhead, 12500);
assert.ok(twoPeople.labor > onePerson.labor);

const secondProject = quote([{ type: "installer", days: 22 }]);
assert.strictEqual(secondProject.overhead, 9166.67);
assert.notStrictEqual(secondProject.overhead, onePerson.overhead);

const fullMonth = quote([{ type: "installer", days: 24 }]);
assert.strictEqual(fullMonth.overhead, 10000);

const stdHoursIgnored = quote([{ type: "installer", days: 15 }], null, Object.assign({}, settings, { stdHours: 40 }));
assert.strictEqual(stdHoursIgnored.overhead, onePerson.overhead);

const live = {
  hoursPerDay: 8,
  baseInstaller: 45,
  baseHelper: 45,
  wcPct: 8,
  ficaPct: 7.65,
  futaPct: 0.6,
  casuiPct: 3.4,
  overheadMonthly: 4281,
  stdHours: 160,
  profitPct: 30,
  reservePct: 5,
  minimumMarginPct: 15,
};
const sample = quote(
  [
    { type: "helper", days: 1 },
    { type: "helper", days: 1 },
  ],
  null,
  live
);
assert.strictEqual(sample.totalHours, 16);
assert.strictEqual(sample.labor, 720);
assert.strictEqual(sample.overhead, 356.75);
assert.strictEqual(sample.overhead_per_hour, 22.3);
assert.strictEqual(sample.recommended_price, 1644.61);

console.log("PASS overhead is the same dollar on every worker hour");
