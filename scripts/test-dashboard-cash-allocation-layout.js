#!/usr/bin/env node
/**
 * Executive snapshot shows Cash On Hand once, four account cards,
 * and a safety-reserve band that does not repeat the savings balance.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "public/dashboard.html"), "utf8");
const js = fs.readFileSync(path.join(ROOT, "public/js/app.js"), "utf8");

let failed = 0;
let passed = 0;

function assert(name, cond) {
  if (cond) {
    passed += 1;
    console.log("PASS  " + name);
  } else {
    failed += 1;
    console.log("FAIL  " + name);
  }
}

const primaryStart = js.indexOf("const kpisPrimary = [");
const primaryEnd = js.indexOf("];", primaryStart);
const primary = js.slice(primaryStart, primaryEnd);
const reserveStart = js.indexOf("function renderSafetyReserveProgress");
const reserveEnd = js.indexOf("function renderDashboard");
const reserveFn = js.slice(reserveStart, reserveEnd);

assert(
  "Cash On Hand stays on the executive strip",
  html.includes('id="executiveStrip"') && js.includes('["Cash On Hand"')
);
assert("kpisPrimary does not include Total Cash", primaryStart > 0 && !primary.includes("Total Cash"));
assert("kpisPrimary includes Operating / Expenses", primary.includes("Operating / Expenses"));
assert("kpisPrimary includes Profit", primary.includes('label: "Profit"'));
assert("kpisPrimary includes Tax Reserve", primary.includes("Tax Reserve"));
assert("kpisPrimary includes Savings", primary.includes('label: "Savings"'));
assert(
  "Savings uses the primary tier",
  /label: "Savings"[\s\S]{0,500}tier: "primary"/.test(primary)
);
assert("safety reserve band exists", html.includes('class="fcc-reserve-progress"'));
assert(
  "reserve band uses an accessible progress bar",
  reserveFn.includes('role="progressbar"') && reserveFn.includes('aria-valuemax="100"')
);
assert(
  "reserve band shows remaining without repeating savingsBalance",
  reserveFn.includes("remaining") && !reserveFn.includes("savingsBalance")
);
assert(
  "allocation title and subtitle are present",
  html.includes(">Cash allocation<") &&
    html.includes("Distribution across four protected business accounts.")
);
assert(
  "fccBarChartHeadline is removed",
  !html.includes("fccBarChartHeadline") && !js.includes("fccBarChartHeadline")
);
assert(
  "fccProfitLegend is removed",
  !html.includes("fccProfitLegend") && !js.includes("fccProfitLegend")
);
assert(
  "four allocation bars remain",
  html.includes('id="fccAccountBarsHost"') &&
    js.includes('label: "Operating"') &&
    js.includes('label: "Profit"') &&
    js.includes('label: "Tax Reserve"') &&
    js.includes('label: "Savings"') &&
    js.includes("fcc-skyline-bar")
);
assert(
  "desktop account row uses four columns",
  /grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/.test(html)
);
assert(
  "tablet account row uses two columns",
  /max-width:\s*900px\)\{[\s\S]{0,220}repeat\(2,\s*1fr\)/.test(html)
);
assert(
  "mobile account row uses one column",
  /max-width:\s*600px\)\{[\s\S]{0,220}grid-template-columns:\s*1fr/.test(html)
);
assert(
  "account cards do not render clipped KPI icons",
  !js.includes('icon: "OP"') && !js.includes("fcc-kpi-icon") && !html.includes(".fcc-kpi-icon")
);

if (failed) {
  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(1);
}
console.log("\n" + passed + " passed, 0 failed");
