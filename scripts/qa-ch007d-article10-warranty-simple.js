/**
 * CH-007D — Article 10 Warranty: 1–5 Year selector + protective exclusions.
 * Isolated static/behavioral QA. Does not modify live projects or frozen snapshots.
 * Run: node scripts/qa-ch007d-article10-warranty-simple.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const htmlPath = path.join(ROOT, "public/contract-builder.html");
const jsPath = path.join(ROOT, "public/js/contract-builder.js");
const helperPath = path.join(ROOT, "public/js/contract-warranty-defaults.js");
const bsHtmlPath = path.join(ROOT, "public/business-settings.html");
const bsJsPath = path.join(ROOT, "public/js/business-warranty-defaults.js");
const freezePath = path.join(ROOT, "netlify/functions/_lib/contract-package.js");
const pdfPath = path.join(ROOT, "netlify/functions/_lib/contract-signed-pdf.js");
const signPath = path.join(ROOT, "public/js/contract-sign-portal.js");
const sigWsPath = path.join(ROOT, "public/js/signature-workspace.js");
const signingPolicyPath = path.join(ROOT, "public/js/business-signing-policy.js");

const html = fs.readFileSync(htmlPath, "utf8");
const js = fs.readFileSync(jsPath, "utf8");
const helperSrc = fs.readFileSync(helperPath, "utf8");
const bsHtml = fs.readFileSync(bsHtmlPath, "utf8");
const freezeSrc = fs.readFileSync(freezePath, "utf8");
const pdfSrc = fs.readFileSync(pdfPath, "utf8");
const signSrc = fs.readFileSync(signPath, "utf8");
const sigWsSrc = fs.readFileSync(sigWsPath, "utf8");
const signingPolicySrc = fs.readFileSync(signingPolicyPath, "utf8");
const Warranty = require("../public/js/contract-warranty-defaults.js");

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
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || "syntax failed");
}

function slice(src, startToken, endToken) {
  const start = src.indexOf(startToken);
  const end = src.indexOf(endToken, start + startToken.length);
  assert.ok(start >= 0 && end > start, `missing slice ${startToken}`);
  return src.slice(start, end);
}

const art10 = slice(html, 'id="art-warranty"', 'id="art-terms"');

test("0 syntax helper, builder, business, pdf, sign portal", () => {
  check(helperPath);
  check(jsPath);
  check(bsJsPath);
  check(pdfPath);
  check(signPath);
});

test("selector contains exactly 1–5 years", () => {
  assert.deepStrictEqual(Warranty.YEAR_OPTIONS, [1, 2, 3, 4, 5]);
  assert.strictEqual(Warranty.YEAR_OPTION_LABELS[1], "1 Year");
  assert.strictEqual(Warranty.YEAR_OPTION_LABELS[5], "5 Years");
  assert.match(art10, /<option value="1">1 Year<\/option>/);
  assert.match(art10, /<option value="2">2 Years<\/option>/);
  assert.match(art10, /<option value="3">3 Years<\/option>/);
  assert.match(art10, /<option value="4">4 Years<\/option>/);
  assert.match(art10, /<option value="5">5 Years<\/option>/);
  assert.doesNotMatch(art10, /<option value="days">/);
  assert.doesNotMatch(art10, /<option value="months">/);
  assert.match(bsHtml, /<option value="1" selected>1 Year<\/option>/);
  assert.match(bsHtml, /<option value="5">5 Years<\/option>/);
  assert.doesNotMatch(bsHtml, /<option value="days">Days<\/option>/);
});

test("1 Year is the system fallback", () => {
  const system = Warranty.systemDefaultFields();
  assert.strictEqual(system.durationValue, "1");
  assert.strictEqual(system.durationUnit, "years");
  assert.strictEqual(Warranty.formatDurationLabel(system), "1 Year");
  const resolved = Warranty.resolveWarrantyDraft({ setup: {}, preferences: null });
  assert.strictEqual(resolved.durationValue, "1");
  assert.strictEqual(resolved.source, "system");
  assert.ok(resolved.summary);
  assert.ok(resolved.exclusions);
});

test("tenant preference replaces the fallback", () => {
  const resolved = Warranty.resolveWarrantyDraft({
    setup: {},
    preferences: {
      default_warranty_enabled: true,
      default_warranty_duration_value: 3,
      default_warranty_duration_unit: "years",
      default_warranty_summary: "Tenant covers installation for three years.",
      default_warranty_exclusions: "Tenant exclusion A\nTenant exclusion B",
    },
  });
  assert.strictEqual(resolved.durationValue, "3");
  assert.strictEqual(Warranty.formatDurationLabel(resolved), "3 Years");
  assert.strictEqual(resolved.summary, "Tenant covers installation for three years.");
  assert.match(resolved.exclusions, /Tenant exclusion A/);
  assert.strictEqual(resolved.source, "tenant");
});

test("exclusions appear automatically and stay protective", () => {
  const lines = Warranty.formatExclusionDisplayLines(Warranty.systemDefaultFields().exclusions);
  assert.strictEqual(lines.length, 5);
  assert.match(lines[0], /^1\. Work outside the approved Scope of Work/);
  assert.match(lines[1], /^2\. Concealed or unforeseen conditions/);
  assert.match(lines[2], /^3\. Owner-supplied materials/);
  assert.match(lines[3], /^4\. Pre-existing/);
  assert.match(lines[4], /^5\. Damage, alteration, misuse, improper maintenance/);
  assert.match(Warranty.SYSTEM_SUMMARY, /does not reduce any duty the law does not allow/);
  assert.doesNotMatch(helperSrc, /Three Colors/);
  assert.doesNotMatch(js, /Three Colors/);
  assert.doesNotMatch(html, /selectable exclusion/i);
  assert.doesNotMatch(art10, /type="checkbox"/);
});

test("owner can edit duration, summary, and exclusions", () => {
  assert.match(art10, /id="cbWarEditDurationValue"/);
  assert.match(art10, /id="cbWarEditSummary"/);
  assert.match(art10, /id="cbWarEditExclusions"/);
  assert.match(js, /function saveWarrantyWorkspace/);
  assert.match(js, /warranty_duration_value: Number\(fields\.durationValue\)/);
  assert.match(js, /warranty_summary: fields\.summary/);
  assert.match(js, /warranty_exclusions: fields\.exclusions/);
});

test("nothing is confirmed automatically", () => {
  const resolved = Warranty.resolveWarrantyDraft({ setup: {}, preferences: null });
  assert.ok(Warranty.warrantyFieldsComplete(resolved));
  const apply = Warranty.applyStandardWarrantyToDraft(
    {
      default_warranty_enabled: true,
      default_warranty_duration_value: 2,
      default_warranty_duration_unit: "years",
      default_warranty_summary: "qa-summary",
      default_warranty_exclusions: "qa-exclusions",
    },
    { existingFields: {}, packages: [] }
  );
  assert.strictEqual(apply.confirm, false);
  assert.doesNotMatch(
    js.slice(js.indexOf("function resolveWarrantyDraftFields"), js.indexOf("function warrantyFieldsFromSetup")),
    /confirm_warranty:\s*true/
  );
  const hydrate = js.slice(js.indexOf("const resolvedWarranty"), js.indexOf("draftEdits.sigMethod"));
  assert.doesNotMatch(hydrate, /confirm_warranty:\s*true/);
  assert.match(js, /confirm_warranty:\s*true/);
  assert.match(js, /id: "cbWsConfirmWarranty"/);
});

test("one primary CTA: Confirm Warranty; readiness navigates", () => {
  const unconfirmed = Warranty.warrantyFooterPlan({ configured: false });
  assert.strictEqual(unconfirmed.primaryLabel, "Confirm Warranty");
  assert.strictEqual(unconfirmed.primaryEnabledCount, 1);
  assert.strictEqual(unconfirmed.confirmVisible, true);
  assert.strictEqual(unconfirmed.continueVisible, false);
  const confirmed = Warranty.warrantyFooterPlan({ configured: true });
  assert.strictEqual(confirmed.primaryLabel, "Continue");
  assert.strictEqual(confirmed.continueVisible, true);
  assert.ok(js.includes('cta: "Open Warranty"'));
  const start = js.indexOf("function resolveNextBlocker");
  const blocker = js.slice(start, start + 2200);
  assert.ok(blocker.includes('cta: "Open Warranty"'));
  assert.ok(!blocker.includes('cta: "Confirm Warranty"'));
  assert.match(js, /saveLabel:\s*"Confirm Warranty"/);
  assert.match(js, /editLabel:\s*"Edit Warranty"/);
  assert.match(js, /"Edit Warranty"/);
});

test("preview copy shows Duration, Summary, and numbered exclusions", () => {
  assert.match(art10, /id="cbWarrantyDuration"/);
  assert.match(html, /Duration: 1 Year/);
  assert.match(art10, />Summary</);
  assert.match(art10, />Exclusions</);
  assert.match(js, /setText\("cbWarrantyDuration"/);
  assert.match(html, /is-preview/);
  assert.match(html, /is-printing/);
});

test("freeze snapshot stores confirmed setup fields, not tenant live defaults", () => {
  assert.match(freezeSrc, /warranty: \{[\s\S]*duration_value: setup\?\.warranty_duration_value/);
  assert.match(freezeSrc, /summary: setup\?\.warranty_summary/);
  assert.match(freezeSrc, /exclusions: setup\?\.warranty_exclusions/);
  assert.doesNotMatch(freezeSrc, /default_warranty_summary/);
  assert.doesNotMatch(freezeSrc, /SYSTEM_EXCLUSIONS/);
  assert.match(helperSrc, /isUnsafePackageStatus/);
  assert.match(helperSrc, /frozen: true/);
});

test("Preview, Print, and signed PDF use the same duration and numbered exclusions", () => {
  const fields = Warranty.systemDefaultFields();
  const duration = Warranty.formatDurationLabel(fields);
  const excl = Warranty.formatExclusionDisplayLines(fields.exclusions);
  assert.strictEqual(duration, "1 Year");
  assert.strictEqual(excl[0].slice(0, 2), "1.");
  assert.match(pdfSrc, /formatDurationLabel/);
  assert.match(pdfSrc, /formatExclusionDisplayLines/);
  assert.match(pdfSrc, /Duration: \$\{durLabel/);
  assert.match(signSrc, /Duration: /);
  assert.match(signSrc, /formatSignWarrantyExclusions/);
  assert.match(js, /formatWarrantyDurationShort/);
  assert.match(js, /formatExclusionDisplayLines/);
});

test("customer-only and dual signing still work", () => {
  assert.match(js, /Customer only/);
  assert.match(js, /require_contractor_signature/);
  assert.match(signingPolicySrc, /require_contractor_signature/);
  assert.match(sigWsSrc, /isDualSigning/);
  assert.match(sigWsSrc, /require_contractor_signature/);
  assert.doesNotMatch(
    js.slice(js.indexOf("function saveWarrantyWorkspace"), js.indexOf("function warrantyConfigured")),
    /signature_method/
  );
});

test("complete saved setup is not overwritten by later tenant defaults", () => {
  const resolved = Warranty.resolveWarrantyDraft({
    configured: true,
    setup: {
      warranty_duration_value: 1,
      warranty_duration_unit: "years",
      warranty_summary: "Frozen summary",
      warranty_exclusions: "Frozen exclusion",
    },
    preferences: {
      default_warranty_enabled: true,
      default_warranty_duration_value: 5,
      default_warranty_duration_unit: "years",
      default_warranty_summary: "New tenant summary",
      default_warranty_exclusions: "New tenant exclusion",
    },
  });
  assert.strictEqual(resolved.summary, "Frozen summary");
  assert.strictEqual(resolved.exclusions, "Frozen exclusion");
  assert.strictEqual(resolved.durationValue, "1");
  assert.strictEqual(resolved.source, "setup");
});

console.log("");
console.log("CH-007D Article 10 warranty simple:", passed, "passed,", failed, "failed");
process.exit(failed === 0 ? 0 : 1);
