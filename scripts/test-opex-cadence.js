"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const html = fs.readFileSync(
  path.join(__dirname, "..", "public", "business-settings.html"),
  "utf8"
);

assert(html.includes("{ id: 'month', months: 1, label: 'Monthly' }"));
assert(html.includes("{ id: 'year', months: 12, label: '1 year' }"));
assert(html.includes("{ id: 'two_year', months: 24, label: '2 years' }"));
assert(html.includes("{ id: 'three_year', months: 36, label: '3 years' }"));
assert(html.includes("return amount / opexCycleById(cycleId).months"));
assert(html.includes("operatingExpenseLines: currentOperatingExpenseLines()"));

function roundCents(value) {
  return Math.round(Number(value) * 100) / 100;
}

function monthlyShare(amount, months) {
  return amount / months;
}

assert.strictEqual(roundCents(monthlyShare(30000, 12)), 2500);
assert.strictEqual(roundCents(monthlyShare(30000, 24)), 1250);
assert.strictEqual(roundCents(monthlyShare(30000, 36)), 833.33);
assert.strictEqual(roundCents(monthlyShare(2800, 1)), 2800);
assert.strictEqual(
  roundCents(monthlyShare(2800, 1) + monthlyShare(30000, 12) + monthlyShare(450, 24)),
  5318.75
);

const script = html.match(/<script>\s*(\(function \(\) \{[\s\S]*\}\)\(\);)\s*<\/script>\s*<\/body>/);
assert(script, "business settings script");
new Function(script[1].replace(/^\(function \(\) \{/, "function safeTrim(v){return String(v==null?'':v).trim();} (function () {"));

console.log("ok opex cadence divides a bill into a monthly cost");
