#!/usr/bin/env node
/**
 * Invoice Hub record-payment amount choice.
 * Run: node scripts/test-invoice-hub-record-payment-amount.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "public/estimates-invoices.html"), "utf8");
const app = fs.readFileSync(path.join(root, "public/js/app.js"), "utf8");

let passed = 0;
function ok(label, cond) {
  assert.ok(cond, label);
  passed += 1;
  console.log("PASS " + label);
}

ok("amount mode offers full amount", html.includes('<option value="full">Full amount</option>'));
ok("amount mode offers custom amount", html.includes('<option value="custom">Custom amount</option>'));
ok("custom amount still has an amount input", html.includes('id="hubRecordPayAmount"'));
ok("balance hint is visible in the modal", html.includes('id="hubRecordPayBalanceHint"'));
ok("full amount uses the remaining balance", app.includes("Records the remaining balance"));
ok("custom amount tells the tenant to enter what was paid", app.includes("Enter only what the customer paid."));
ok("opening the modal can start on full amount", app.includes('setVal("hubRecordPayAmountMode", hubRecordPayModalCtx.remaining > 0 ? "full" : "custom")'));
ok("saving a full amount posts the remaining balance", app.includes("amount = finiteNumber(hubRecordPayModalCtx.remaining, 0)"));
ok("adjustment stays a custom amount", app.includes('if (t === "adjustment" && $("hubRecordPayAmountMode")) setVal("hubRecordPayAmountMode", "custom")'));

console.log("\n" + passed + " passed");
