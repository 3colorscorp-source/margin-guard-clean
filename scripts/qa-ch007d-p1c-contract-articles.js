/**
 * CH-007D Phase 1C — non-signature Contract Builder articles (static QA).
 * Run: node scripts/qa-ch007d-p1c-contract-articles.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const jsPath = path.join(ROOT, "public/js/contract-builder.js");
const htmlPath = path.join(ROOT, "public/contract-builder.html");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err && err.message ? err.message : err}`);
  }
}

const js = fs.readFileSync(jsPath, "utf8");
const html = fs.readFileSync(htmlPath, "utf8");

test("syntax contract-builder.js", () => {
  const r = spawnSync(process.execPath, ["--check", jsPath], { encoding: "utf8" });
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || "syntax check failed");
});

test("Property Confirm + persist", () => {
  assert.match(js, /"art-property":[\s\S]*?saveLabel:\s*"Confirm Property"/);
  assert.match(js, /confirm_property_address:\s*true/);
  assert.match(js, /function propertyConfigured/);
  assert.match(html, /id="art-property"/);
  assert.match(html, /id="cbPropEditLine1"/);
});

test("Warranty Confirm + persist", () => {
  assert.match(js, /"art-warranty":[\s\S]*?saveLabel:\s*"Confirm Warranty"/);
  assert.match(js, /confirm_warranty:\s*true/);
  assert.match(js, /function warrantyConfigured/);
  assert.match(html, /id="art-warranty"/);
  assert.match(html, /id="cbWarEditSummary"/);
});

test("Payment Save Draft + Confirm + read-only", () => {
  assert.match(js, /saveLabel:\s*"Save Draft"/);
  assert.match(js, /workspaceConfirmPayment/);
  assert.match(js, /paymentScheduleAllowsOwnerEdit/);
  assert.match(js, /Confirmed payment schedules are read-only/);
});

test("Scope is quote review-only", () => {
  assert.match(js, /"art-scope":[\s\S]*?supportsEdit:\s*false/);
  assert.match(js, /"art-scope":[\s\S]*?supportsSave:\s*false/);
  assert.match(html, /Scope of work is taken from the approved quote/);
  assert.doesNotMatch(html, /id="cbEditScope"/);
});

test("Price is quote review-only", () => {
  assert.match(js, /"art-price":[\s\S]*?supportsEdit:\s*false/);
  assert.match(js, /"art-price":[\s\S]*?supportsSave:\s*false/);
  assert.match(html, /Contract total is locked to the approved quote/);
  assert.match(html, /id="cbPriceLine"/);
});

test("Terms / Legal Notices review + external link", () => {
  assert.match(js, /"art-terms":[\s\S]*?supportsEdit:\s*false/);
  assert.match(js, /"art-terms":[\s\S]*?supportsSave:\s*false/);
  assert.match(js, /externalSourceHref:\s*"\/legal-notices"/);
  assert.match(js, /Open Legal Notices/);
  assert.match(html, /Legal notices are confirmed on the Legal Notices page/);
  assert.doesNotMatch(html, /id="cbEditTerms"/);
  assert.match(html, /id="cbLegalNoticesList"/);
});

test("Preview / print / mobile surfaces present", () => {
  assert.match(html, /is-preview/);
  assert.match(html, /is-printing|@media print|cb-print/);
  assert.match(html, /@media[\s\S]*max-width/);
  assert.match(js, /enterPreviewMode|isPreviewMode/);
});

test("No signature platform wiring in Phase 1C", () => {
  assert.doesNotMatch(js, /public.?contract|signed.?pdf|stripe|payment.?intent/i);
  assert.match(html, /Available after the contract is finalized for signature/);
});

console.log(`CH-007D-P1C QA: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
