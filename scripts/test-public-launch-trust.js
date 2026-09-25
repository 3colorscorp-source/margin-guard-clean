/**
 * Public-launch trust: visual money, English customer/dashboard chrome, refunds.
 * Isolated source assertions. No live Netlify/Supabase.
 * Run: node scripts/test-public-launch-trust.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

let passed = 0;
function ok(label, cond) {
  assert.ok(cond, label);
  passed += 1;
  console.log("PASS " + label);
}

const appJs = read("public/js/app.js");
const sellersJs = read("public/js/sales-admin-sellers.js");
const dashboardHtml = read("public/dashboard.html");
const estimateHtml = read("public/estimate-public.html");
const terms = read("public/terms.html");

const moneyFn = appJs.slice(appJs.indexOf("function money(value, _currency)"), appJs.indexOf("function clamp("));
const saMoneyFn = appJs.slice(
  appJs.indexOf("function saFormatSummaryMoney(value, _currency)"),
  appJs.indexOf("let saPerfTipTimer")
);

ok("app.js money() formats grouped $ without ISO prefix", moneyFn.includes('toLocaleString("en-US"') && moneyFn.includes('"$"'));
ok("app.js money() does not glue currency codes to toFixed", !moneyFn.includes("currency || \"$\""));
ok("Sales Admin KPI money uses visual $", saMoneyFn.includes('"$"') && !saMoneyFn.includes("USD"));
ok("Sales Admin seller money uses visual $", sellersJs.includes('return (n < 0 ? "-$" : "$") + formatted'));
ok("hidden test sellers are dropped from summary cards", sellersJs.includes("computeSummaryFromRows(visibleRows"));
ok("Dashboard page language is English", dashboardHtml.includes('<html lang="en">'));
ok("Dashboard placeholder is Active account", dashboardHtml.includes(">Active account<"));
ok("public estimate page language is English", estimateHtml.includes('<html lang="en">'));
ok("public estimate share copy is English", estimateHtml.includes("Share this link to review and approve."));
ok("Terms include a Refunds section", terms.includes("<h2>20. Refunds</h2>") && /non-refundable/.test(terms));

console.log("Passed " + passed + " assertions.");
