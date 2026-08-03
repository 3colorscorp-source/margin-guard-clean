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

test("edit surface present", () => {
  assert.ok(html.includes('id="cbPayEditGrid"'));
  assert.ok(html.includes('id="cbPayAddStage"'));
  assert.ok(html.includes("Add payment"));
  assert.ok(html.includes('id="cbPayEditDifference"'));
});

test("art-payment supports save + edit", () => {
  assert.ok(/"art-payment":\s*defaultWorkspaceCaps\(\{[\s\S]*?supportsEdit:\s*true/.test(js));
  assert.ok(/"art-payment":\s*defaultWorkspaceCaps\(\{[\s\S]*?supportsSave:\s*true/.test(js));
  assert.ok(js.includes('saveLabel: "Save Draft"'));
});

test("CRUD + reorder actions", () => {
  assert.ok(js.includes('data-pay-action="delete"'));
  assert.ok(js.includes('data-pay-action="up"'));
  assert.ok(js.includes('data-pay-action="down"'));
  assert.ok(js.includes('data-pay-action="insert"'));
  assert.ok(js.includes("cbPayAddStage"));
});

test("live totals + confirm balance", () => {
  assert.ok(js.includes("computePaymentDraftTotals"));
  assert.ok(js.includes("validatePaymentDraftForConfirm"));
  assert.ok(js.includes("Scheduled must equal contract total") || js.includes("must equal"));
});

test("Save Draft + Confirm Schedule + POST existing API", () => {
  assert.ok(js.includes("savePaymentScheduleDraft"));
  assert.ok(js.includes("workspaceConfirmPayment"));
  assert.ok(js.includes("confirm_schedule"));
  assert.ok(js.includes("PAYMENT_SCHEDULE_API"));
  assert.ok(!/project-payment-intent/.test(js));
});

test("read-only after confirm", () => {
  assert.ok(js.includes("paymentScheduleAllowsOwnerEdit"));
  assert.ok(js.includes("Confirmed payment schedules are read-only"));
});

test("no invoice hub / stripe / ledger / payment intent writes", () => {
  assert.ok(!/record-tenant-payment|upsert-tenant-invoice|stripe\.com|project-payment-intent/i.test(js));
});

test("reload / conflict handling", () => {
  assert.ok(js.includes("reloadPaymentScheduleFromServer"));
  assert.ok(js.includes("schedule_version_conflict") || js.includes("offerPaymentScheduleConflictReload"));
});

console.log("");
console.log(`CH-007D-P2 QA: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
