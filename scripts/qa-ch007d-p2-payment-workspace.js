/**
 * CH-007D-P2 Payment Schedule editor — static QA (Contract Builder only).
 * Run: node scripts/qa-ch007d-p2-payment-workspace.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const jsPath = path.join(ROOT, "public/js/contract-builder.js");
const htmlPath = path.join(ROOT, "public/contract-builder.html");
const js = fs.readFileSync(jsPath, "utf8");
const html = fs.readFileSync(htmlPath, "utf8");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log("PASS", name);
    passed += 1;
  } catch (err) {
    console.log("FAIL", name, "-", err.message);
    failed += 1;
  }
}

test("syntax contract-builder.js", () => {
  const r = spawnSync(process.execPath, ["--check", jsPath], { encoding: "utf8" });
  assert.strictEqual(r.status, 0, r.stderr || r.stdout);
});

test("edit surface is not present for Payment Terms", () => {
  assert.ok(!html.includes("+ Add Payment Stage"));
  assert.ok(!html.includes("Customize Payment Plan"));
  assert.ok(!html.includes('id="cbPayEditDifference"'));
  assert.ok(html.includes("Payment Terms"));
  assert.ok(html.includes("Billing Terms"));
});

test("art-payment is confirm-only", () => {
  const start = js.indexOf('"art-payment": defaultWorkspaceCaps');
  const end = js.indexOf('"art-schedule": defaultWorkspaceCaps');
  const payCaps = start >= 0 && end > start ? js.slice(start, end) : "";
  assert.ok(payCaps.includes("supportsEdit: false"));
  assert.ok(payCaps.includes("supportsSave: false"));
  assert.ok(js.includes("Confirm Payment Terms"));
});

test("no stage CRUD in tenant Payment Terms", () => {
  assert.ok(!html.includes("+ Add Payment Stage"));
  assert.ok(!html.includes("Move up"));
  assert.ok(!html.includes("Move down"));
  assert.ok(js.includes("workspaceConfirmPayment"));
});

test("live totals come from ledger remaining", () => {
  const helper = fs.readFileSync(path.join(ROOT, "public/js/contract-payment-confirm.js"), "utf8");
  assert.ok(helper.includes("Remaining Contract Balance"));
  assert.ok(helper.includes("Balance After Deposit"));
  assert.ok(helper.includes("BILLING_TERMS_COPY"));
});

test("Confirm Payment Terms posts existing API", () => {
  assert.ok(js.includes("workspaceConfirmPayment"));
  assert.ok(js.includes("confirm_schedule") || fs.readFileSync(path.join(ROOT, "public/js/contract-payment-confirm.js"), "utf8").includes("confirm_schedule: true"));
  assert.ok(js.includes("PAYMENT_SCHEDULE_API") || fs.readFileSync(path.join(ROOT, "public/js/contract-payment-confirm.js"), "utf8").includes("project-contract-payment-schedule"));
  assert.ok(!/project-payment-intent/.test(js));
});

test("read-only after confirm", () => {
  assert.ok(js.includes("paymentScheduleAllowsOwnerEdit"));
  assert.ok(js.includes("Confirmed payment terms are read-only"));
});

test("no invoice hub / stripe / ledger / payment intent writes", () => {
  assert.ok(!/record-tenant-payment|upsert-tenant-invoice|stripe\.com|project-payment-intent/i.test(js));
});

test("reload / conflict handling", () => {
  assert.ok(js.includes("reloadPaymentScheduleFromServer"));
  assert.ok(js.includes("schedule_version_conflict") || js.includes("offerPaymentScheduleConflictReload"));
});

test("Payment Terms copy is non-technical", () => {
  assert.ok(!html.includes('id="cbPayAdvancedToggle"'));
  assert.ok(!js.includes("paymentAdvancedEdit"));
  assert.ok(!js.includes('data-pay-field="item_role"'));
  assert.ok(!js.includes("Future obligation — payment is still due"));
  assert.ok(html.includes("Billing Terms"));
  assert.ok(html.includes("Progress invoices are sent every two weeks") || js.includes("BILLING_TERMS_COPY") || fs.readFileSync(path.join(ROOT, "public/js/contract-payment-confirm.js"), "utf8").includes("Progress invoices are sent every two weeks"));
});

test("local defaults helper is loaded before builder", () => {
  assert.ok(html.includes("/js/contract-payment-defaults.js"));
  const helperIdx = html.indexOf("contract-payment-defaults.js");
  const builderIdx = html.indexOf("contract-builder.js");
  assert.ok(helperIdx >= 0 && builderIdx > helperIdx);
});

console.log("");
console.log(`CH-007D-P2 QA: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
