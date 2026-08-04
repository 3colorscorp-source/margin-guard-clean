/**
 * CH-012D — Guided Contract Workflow UX (static QA).
 * Run: node scripts/qa-ch012d-guided-workflow.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");

const hubHtml = fs.readFileSync(path.join(ROOT, "public/contract-hub.html"), "utf8");
const hubJs = fs.readFileSync(path.join(ROOT, "public/js/contract-hub.js"), "utf8");
const builderHtml = fs.readFileSync(path.join(ROOT, "public/contract-builder.html"), "utf8");
const builderJs = fs.readFileSync(path.join(ROOT, "public/js/contract-builder.js"), "utf8");
const swHtml = fs.readFileSync(path.join(ROOT, "public/signature-workspace.html"), "utf8");
const swJs = fs.readFileSync(path.join(ROOT, "public/js/signature-workspace.js"), "utf8");
const estimateJs = fs.readFileSync(path.join(ROOT, "public/js/estimate-builder.js"), "utf8");
const salesHtml = fs.readFileSync(path.join(ROOT, "public/sales-admin.html"), "utf8");

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

function check(file) {
  const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  assert.strictEqual(r.status, 0, r.stderr || r.stdout);
}

test("syntax hub/builder/workspace", () => {
  check(path.join(ROOT, "public/js/contract-hub.js"));
  check(path.join(ROOT, "public/js/contract-builder.js"));
  check(path.join(ROOT, "public/js/signature-workspace.js"));
});

test("1 hub workflow stages", () => {
  for (const stage of [
    "Approved Quote",
    "Complete Contract",
    "Freeze Contract",
    "Configure Signing",
    "Customer Signs",
    "Signed Contract",
  ]) {
    assert.ok(hubJs.includes(stage), `missing stage ${stage}`);
  }
});

test("2 hub incomplete readiness CTA", () => {
  assert.ok(hubJs.includes('label: "Open Contract Builder"'));
  assert.ok(hubHtml.includes("chPrimaryCta"));
  assert.ok(hubHtml.includes("chMissingList"));
  assert.ok(hubHtml.includes("chStageCurrent"));
  assert.ok(hubHtml.includes("chBlocker"));
});

test("3-4 hub next blocker + builder article path", () => {
  assert.ok(builderJs.includes("resolveNextBlocker"));
  assert.ok(builderJs.includes("Confirm Project Address"));
  assert.ok(builderJs.includes("Complete Payment Schedule"));
  assert.ok(builderJs.includes("Confirm Warranty"));
  assert.ok(builderJs.includes("Configure Signature Method"));
  assert.ok(builderJs.includes('dataset.article'));
  assert.ok(builderHtml.includes("cbNextActionBtn"));
});

test("5-8 readiness 100% freeze + continue", () => {
  assert.ok(hubJs.includes('label: "Freeze Contract"'));
  assert.ok(builderHtml.includes("cbFreezeBtn"));
  assert.ok(builderJs.includes("contract-package-freeze"));
  assert.ok(builderJs.includes("Freeze Contract"));
  assert.ok(builderJs.includes("Continue to Signature Workspace"));
  assert.ok(builderHtml.includes("cbContinueSigning"));
  assert.ok(builderJs.includes("idempotent"));
});

test("9-10 signature workspace no package", () => {
  assert.ok(swJs.includes("Contract setup is not complete."));
  assert.ok(swJs.includes("Open Contract Builder"));
  assert.ok(swHtml.includes("swCreateEnvelopeReason"));
  assert.ok(swHtml.includes("swAddSignerReason"));
  assert.ok(swHtml.includes("swSendReason"));
  assert.ok(swJs.includes("swCreateEnvelopeReason"));
});

test("11-15 package/envelope/signer/send/completed guidance", () => {
  assert.ok(swJs.includes("Create a Signing Request") || swJs.includes("Create Signing Request"));
  assert.ok(swJs.includes("Add Customer Signer"));
  assert.ok(swJs.includes("Send For Signature"));
  assert.ok(swJs.includes("Waiting for signatures"));
  assert.ok(swJs.includes("Generate Certificate"));
  assert.ok(swHtml.includes("Generate Signed PDF"));
});

test("16-17 no developer language in main UI; IDs in developer", () => {
  assert.ok(!/delivery_status\s*=\s*prepared/.test(swHtml));
  assert.ok(!swHtml.includes("Prepare signing tokens"));
  assert.ok(swHtml.includes("secure signing link"));
  assert.ok(swHtml.includes("Developer"));
  assert.ok(swJs.includes("package_id:"));
  assert.ok(swJs.includes("envelope_id:"));
  assert.ok(swHtml.includes("swDevIds"));
});

test("18 Initial Scheduling Payment terminology", () => {
  assert.ok(estimateJs.includes("Initial Scheduling Payment"));
  assert.ok(!/Deposits are non-refundable if you cancel/.test(estimateJs));
  assert.ok(salesHtml.includes("Open Contract Hub"));
  assert.ok(!salesHtml.includes("Contract creation will be enabled in the next Contract Hub phase."));
});

test("19-20 desktop + mobile shell markers", () => {
  assert.ok(hubHtml.includes("max-width: 560px") || hubHtml.includes("@media"));
  assert.ok(swHtml.includes("390px") || swHtml.includes("@media"));
  assert.ok(builderHtml.includes("@media"));
});

test("21 no backend / SQL regression markers", () => {
  assert.ok(!hubJs.includes("stripe"));
  assert.ok(!builderJs.includes("project-payment-intent"));
  assert.ok(!swJs.includes("stripe"));
  assert.ok(!fs.existsSync(path.join(ROOT, "SUPABASE_CH012D.sql")));
});

test("22 Invoice Hub untouched marker", () => {
  assert.ok(!hubJs.includes("invoice-hub"));
  assert.ok(!builderJs.includes("Invoice Hub"));
  assert.ok(!swJs.includes("Invoice Hub"));
});

test("builder draft language", () => {
  assert.ok(builderHtml.includes("Draft Contract"));
  assert.ok(!builderHtml.includes("Unsaved meeting draft"));
  assert.ok(builderHtml.includes("not ready for signature"));
  assert.ok(builderJs.includes("BUSINESS"));
  assert.ok(builderJs.includes("CUSTOMER"));
  assert.ok(builderJs.includes("PROJECT"));
  assert.ok(builderJs.includes("COMMERCIAL"));
  assert.ok(builderJs.includes("LEGAL"));
  assert.ok(builderJs.includes("SIGNATURE"));
  assert.ok(builderJs.includes('return "Complete"') || builderJs.includes('return "Complete";'));
});

test("copy: Package/Envelope owner labels", () => {
  assert.ok(swHtml.includes("Frozen Contract Version"));
  assert.ok(swHtml.includes("Signing Request"));
  assert.ok(swJs.includes("Fully Signed") || swHtml.includes("Fully Signed"));
  assert.ok(swJs.includes("Link Ready"));
});

test("approved estimate workflow does not keep done steps current", () => {
  assert.ok(estimateJs.includes("else if (done) state = \"complete\""));
  assert.ok(!/done && urlStep === i\) state = \"current\"/.test(estimateJs));
});

console.log("");
console.log(`CH-012D QA: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
