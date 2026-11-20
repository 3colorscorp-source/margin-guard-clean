#!/usr/bin/env node
"use strict";

const assert = require("assert");
const overtime = require("../public/js/overtime-week");
const { calculateQuotePublishFinancials } = require("../netlify/functions/_lib/pricing-engine");

const plain = {
  hoursPerDay: 8,
  baseInstaller: 45,
  baseHelper: 45,
  wcPct: 0,
  ficaPct: 0,
  futaPct: 0,
  casuiPct: 0,
  overheadMonthly: 0,
  stdHours: 160,
  profitPct: 0,
  reservePct: 0,
  minimumMarginPct: 0,
};

function quote(workers, extra) {
  return calculateQuotePublishFinancials(
    Object.assign(
      {
        workers,
        pricing_stage: 2,
        price: "",
        _manualPriceTouched: false,
      },
      extra || {}
    ),
    plain
  );
}

const week = overtime.splitLaborHours(5, 8, { saturday: true });
assert.strictEqual(week.regularHours, 40);
assert.strictEqual(week.overtimeHours, 8);

const shortSaturday = overtime.splitLaborHours(1, 8, { saturday: true });
assert.strictEqual(shortSaturday.regularHours, 16);
assert.strictEqual(shortSaturday.overtimeHours, 0);

const bothWeekend = overtime.splitLaborHours(5, 8, { saturday: true, sunday: true });
assert.strictEqual(bothWeekend.regularHours, 40);
assert.strictEqual(bothWeekend.overtimeHours, 16);

const threeDayWeekend = overtime.splitLaborHours(3, 8, { saturday: true, sunday: true });
assert.strictEqual(threeDayWeekend.regularHours, 40);
assert.strictEqual(threeDayWeekend.overtimeHours, 0);

const fourDayWeekend = overtime.splitLaborHours(4, 8, { saturday: true, sunday: true });
assert.strictEqual(fourDayWeekend.regularHours, 40);
assert.strictEqual(fourDayWeekend.overtimeHours, 8);

const threeWeeks = overtime.splitLaborHours(15, 8, { saturday: true });
assert.strictEqual(threeWeeks.regularHours, 120);
assert.strictEqual(threeWeeks.overtimeHours, 24);

const noWeekend = quote([{ type: "helper", days: 5 }]);
assert.strictEqual(noWeekend.labor, 1800);
assert.strictEqual(noWeekend.overtime_hours, 0);

const oneSaturday = quote([{ type: "helper", days: 5 }], { client_wants_saturday: true });
assert.strictEqual(oneSaturday.labor, 2340);
assert.strictEqual(oneSaturday.overtime_hours, 8);
assert.strictEqual(oneSaturday.totalHours, 48);

const twoPeople = quote(
  [
    { type: "helper", days: 5 },
    { type: "helper", days: 5 },
  ],
  { client_wants_saturday: true }
);
assert.strictEqual(twoPeople.labor, 4680);
assert.strictEqual(twoPeople.overtime_hours, 16);

const loneDay = quote(
  [
    { type: "helper", days: 1 },
    { type: "helper", days: 1 },
  ],
  { client_wants_saturday: true }
);
assert.strictEqual(loneDay.overtime_hours, 0);
assert.strictEqual(loneDay.labor, 1440);
assert.strictEqual(loneDay.totalHours, 32);

console.log("PASS saturday and sunday use time and a half after 40 hours");
