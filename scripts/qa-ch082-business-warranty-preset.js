/**
 * CH-082 — Business Settings standard warranty preset (no live data).
 * Run: node scripts/qa-ch082-business-warranty-preset.js
 */
"use strict";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET || "mg-ch082-warranty-preset-test-secret";
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "mg-ch082-warranty-preset-test-key";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const sqlPath = path.join(ROOT, "SUPABASE_CH082_TENANT_WARRANTY_PRESET.sql");
const apiPath = path.join(ROOT, "netlify/functions/tenant-contract-preferences.js");
const assemblerPath = path.join(ROOT, "netlify/functions/_lib/contract-source-assembler.js");
const helperPath = path.join(ROOT, "public/js/business-warranty-defaults.js");
const htmlPath = path.join(ROOT, "public/business-settings.html");
const builderJsPath = path.join(ROOT, "public/js/contract-builder.js");
const builderHtmlPath = path.join(ROOT, "public/contract-builder.html");
const setupPath = path.join(ROOT, "netlify/functions/project-contract-setup.js");
const ch001Path = path.join(ROOT, "SUPABASE_CH001A_CONTRACT_FOUNDATION.sql");

const helper = require("../public/js/business-warranty-defaults.js");
const assembler = require("../netlify/functions/_lib/contract-source-assembler.js");
const prefsApi = require("../netlify/functions/tenant-contract-preferences.js");

const sql = fs.readFileSync(sqlPath, "utf8");
const apiSrc = fs.readFileSync(apiPath, "utf8");
const assemblerSrc = fs.readFileSync(assemblerPath, "utf8");
const helperSrc = fs.readFileSync(helperPath, "utf8");
const html = fs.readFileSync(htmlPath, "utf8");
const builderJs = fs.readFileSync(builderJsPath, "utf8");
const builderHtml = fs.readFileSync(builderHtmlPath, "utf8");
const setupSrc = fs.readFileSync(setupPath, "utf8");
const ch001 = fs.readFileSync(ch001Path, "utf8");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log("PASS", name);
  } catch (err) {
    failed += 1;
    console.log("FAIL", name, "-", err.message);
  }
}

function check(file) {
  const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || "syntax failed");
}

const EXISTING_PREFS = {
  id: "pref-row",
  primary_trade_module: "flooring",
  custom_trade_label: "",
  default_contract_name: "Service Agreement",
  default_warranty_duration_value: 6,
  default_warranty_duration_unit: "months",
  default_warranty_enabled: false,
  default_warranty_summary: "",
  default_warranty_exclusions: "",
  change_order_requirement: "always",
  require_customer_initials: false,
  default_signer_mode: "all_property_owners",
  default_contract_language: "es",
  dispute_resolution_preference: "mediation",
  default_signature_order: "contractor_first",
  automatically_attach_warranty: true,
  automatically_attach_completion_certificate: true,
  updated_at: "2026-01-01T00:00:00.000Z",
};

const WARRANTY_PATCH = {
  default_warranty_enabled: true,
  default_warranty_duration_value: 1,
  default_warranty_duration_unit: "years",
  default_warranty_summary: "qa-preset-summary",
  default_warranty_exclusions: "qa-preset-exclusions",
};

test("syntax helper", () => check(helperPath));
test("syntax preferences API", () => check(apiPath));
test("syntax assembler", () => check(assemblerPath));
test("syntax this QA file", () => check(path.join(__dirname, "qa-ch082-business-warranty-preset.js")));

test("1. migration contains the three columns", () => {
  assert.match(sql, /default_warranty_enabled boolean not null default false/);
  assert.match(sql, /default_warranty_summary text not null default ''/);
  assert.match(sql, /default_warranty_exclusions text not null default ''/);
});

test("2. migration is additive and idempotent", () => {
  assert.match(sql, /add column if not exists default_warranty_enabled/);
  assert.match(sql, /add column if not exists default_warranty_summary/);
  assert.match(sql, /add column if not exists default_warranty_exclusions/);
  assert.match(sql, /if not exists/i);
  const executable = sql.replace(/--[^\n]*/g, "");
  assert.doesNotMatch(executable, /\bdrop table\b/i);
  assert.doesNotMatch(executable, /\bdrop column\b/i);
  assert.doesNotMatch(executable, /\brename column\b/i);
  assert.doesNotMatch(executable, /\bupdate\s+public\./i);
  assert.doesNotMatch(executable, /\binsert into\b/i);
});

test("3. summary/exclusions have 4000-character checks", () => {
  assert.match(sql, /char_length\(default_warranty_summary\) <= 4000/);
  assert.match(sql, /char_length\(default_warranty_exclusions\) <= 4000/);
  assert.strictEqual(helper.WARRANTY_TEXT_MAX, 4000);
  assert.strictEqual(prefsApi._test.WARRANTY_TEXT_MAX, 4000);
});

test("4. API accepts valid warranty fields", () => {
  const keys = prefsApi._test.ALLOWED_BODY_KEYS;
  assert.ok(keys.has("default_warranty_enabled"));
  assert.ok(keys.has("default_warranty_summary"));
  assert.ok(keys.has("default_warranty_exclusions"));
  assert.ok(keys.has("default_warranty_duration_value"));
  assert.ok(keys.has("default_warranty_duration_unit"));
  const ok = prefsApi._test.normalizePreferencesInput({
    primary_trade_module: "flooring",
    custom_trade_label: "",
    default_contract_name: "Service Agreement",
    default_warranty_duration_value: 1,
    default_warranty_duration_unit: "years",
    default_warranty_enabled: true,
    default_warranty_summary: "qa-preset-summary",
    default_warranty_exclusions: "qa-preset-exclusions",
    change_order_requirement: "always",
    require_customer_initials: false,
    default_signer_mode: "all_property_owners",
    default_contract_language: "es",
    dispute_resolution_preference: "mediation",
    default_signature_order: "contractor_first",
    automatically_attach_warranty: true,
    automatically_attach_completion_certificate: true,
  });
  assert.ok(!ok.error, ok.error);
  assert.strictEqual(ok.preferences.default_warranty_enabled, true);
  assert.strictEqual(ok.preferences.default_warranty_summary, "qa-preset-summary");
  assert.strictEqual(ok.preferences.default_warranty_exclusions, "qa-preset-exclusions");
  assert.strictEqual(ok.preferences.default_warranty_duration_value, 1);
  assert.strictEqual(ok.preferences.default_warranty_duration_unit, "years");
  assert.strictEqual(ok.preferences.primary_trade_module, "flooring");
  assert.strictEqual(ok.preferences.automatically_attach_warranty, true);
});

test("5. API rejects unknown fields", () => {
  const unknown = prefsApi._test.findUnknownBodyKeys({
    primary_trade_module: "flooring",
    warranty_notice: "do not accept",
  });
  assert.ok(unknown.includes("warranty_notice"));
  const alsoUnknown = prefsApi._test.findUnknownBodyKeys({
    default_warranty_template: "nope",
  });
  assert.ok(alsoUnknown.includes("default_warranty_template"));
});

test("6. GET serializes the new fields", () => {
  const serialized = assembler.serializePreferencesForApi({
    ...EXISTING_PREFS,
    default_warranty_enabled: true,
    default_warranty_summary: "qa-preset-summary",
    default_warranty_exclusions: "qa-preset-exclusions",
    default_warranty_duration_value: 2,
    default_warranty_duration_unit: "years",
  });
  assert.strictEqual(serialized.default_warranty_enabled, true);
  assert.strictEqual(serialized.default_warranty_summary, "qa-preset-summary");
  assert.strictEqual(serialized.default_warranty_exclusions, "qa-preset-exclusions");
  assert.strictEqual(serialized.default_warranty_duration_value, 2);
  assert.strictEqual(serialized.default_warranty_duration_unit, "years");
  const missingCols = assembler.serializePreferencesForApi({
    primary_trade_module: "tile_installation",
    default_contract_name: "Agreement",
  });
  assert.strictEqual(missingCols.default_warranty_enabled, false);
  assert.strictEqual(missingCols.default_warranty_summary, "");
  assert.strictEqual(missingCols.default_warranty_exclusions, "");
});

test("7. enabled requires a complete preset in UI validation", () => {
  const incomplete = helper.validateWarrantyDraft({
    default_warranty_enabled: true,
    default_warranty_duration_value: "",
    default_warranty_duration_unit: "years",
    default_warranty_summary: "",
    default_warranty_exclusions: "",
  });
  assert.strictEqual(incomplete.ok, false);
  const status = helper.evaluateWarrantyPresetStatus({
    default_warranty_enabled: true,
    default_warranty_duration_value: 1,
    default_warranty_duration_unit: "years",
    default_warranty_summary: "",
    default_warranty_exclusions: "qa-preset-exclusions",
  });
  assert.strictEqual(status.status, "incomplete");
  assert.match(status.label, /Incomplete — add duration, summary, and exclusions/);
  const complete = helper.validateWarrantyDraft(WARRANTY_PATCH);
  assert.strictEqual(complete.ok, true);
  assert.strictEqual(helper.evaluateWarrantyPresetStatus(WARRANTY_PATCH).status, "complete");
  assert.strictEqual(helper.evaluateWarrantyPresetStatus(WARRANTY_PATCH).label, "Complete");
  const enabledZero = prefsApi._test.normalizePreferencesInput({
    primary_trade_module: "flooring",
    default_warranty_enabled: true,
    default_warranty_duration_value: 0,
    default_warranty_duration_unit: "years",
    default_warranty_summary: "qa-preset-summary",
    default_warranty_exclusions: "qa-preset-exclusions",
  });
  assert.strictEqual(enabledZero.code, "warranty_preset_incomplete");
});

test("8. disabled allows an incomplete tenant draft", () => {
  const draft = helper.validateWarrantyDraft({
    default_warranty_enabled: false,
    default_warranty_duration_value: "",
    default_warranty_duration_unit: "months",
    default_warranty_summary: "",
    default_warranty_exclusions: "",
  });
  assert.strictEqual(draft.ok, true);
  assert.strictEqual(
    helper.evaluateWarrantyPresetStatus({ default_warranty_enabled: false }).status,
    "disabled"
  );
  assert.strictEqual(
    helper.evaluateWarrantyPresetStatus({ default_warranty_enabled: false }).label,
    "Disabled"
  );
  const apiDraft = prefsApi._test.normalizePreferencesInput({
    primary_trade_module: "flooring",
    default_warranty_enabled: false,
    default_warranty_duration_value: null,
    default_warranty_duration_unit: "months",
    default_warranty_summary: "",
    default_warranty_exclusions: "",
    default_contract_name: "Service Agreement",
    change_order_requirement: "always",
    default_signer_mode: "one_customer",
    default_contract_language: "en",
    default_signature_order: "customer_first",
  });
  assert.ok(!apiDraft.error, apiDraft.error);
  assert.strictEqual(apiDraft.preferences.default_warranty_enabled, false);
  assert.strictEqual(apiDraft.preferences.default_warranty_summary, "");
});

test("9. GET-merge-POST keeps non-warranty preferences", () => {
  const merged = helper.mergeWarrantyIntoPreferences(EXISTING_PREFS, WARRANTY_PATCH);
  assert.strictEqual(merged.primary_trade_module, "flooring");
  assert.strictEqual(merged.default_contract_name, "Service Agreement");
  assert.strictEqual(merged.default_contract_language, "es");
  assert.strictEqual(merged.change_order_requirement, "always");
  assert.strictEqual(merged.default_signer_mode, "all_property_owners");
  assert.strictEqual(merged.default_signature_order, "contractor_first");
  assert.strictEqual(merged.require_customer_initials, false);
  assert.strictEqual(merged.dispute_resolution_preference, "mediation");
  assert.strictEqual(merged.automatically_attach_warranty, true);
  assert.strictEqual(merged.automatically_attach_completion_certificate, true);
  assert.strictEqual(merged.custom_trade_label, "");
  assert.strictEqual(merged.default_warranty_enabled, true);
  assert.strictEqual(merged.default_warranty_summary, "qa-preset-summary");
  assert.strictEqual(merged.default_warranty_exclusions, "qa-preset-exclusions");
  assert.strictEqual(merged.default_warranty_duration_value, 1);
  assert.strictEqual(merged.default_warranty_duration_unit, "years");
  assert.ok(!Object.prototype.hasOwnProperty.call(merged, "id"));
  assert.ok(!Object.prototype.hasOwnProperty.call(merged, "updated_at"));
  helper.PRESERVED_PREFERENCE_KEYS.forEach((key) => {
    assert.strictEqual(merged[key], EXISTING_PREFS[key], "preserved " + key);
  });
  const keys = Object.keys(merged).sort();
  const expected = helper.PREFERENCE_POST_KEYS.slice().sort();
  assert.deepStrictEqual(keys, expected);
  helper.PREFERENCE_POST_KEYS.forEach((key) => {
    assert.ok(prefsApi._test.ALLOWED_BODY_KEYS.has(key), "API allows " + key);
  });
});

test("10. no legal fixture is used as a product default", () => {
  const cardStart = html.indexOf('id="bsStandardWarrantyCard"');
  const card = cardStart >= 0 ? html.slice(cardStart, html.indexOf("bs-order-financial", cardStart)) : "";
  assert.ok(card.length > 0, "warranty card html");
  const scanned = sql + "\n" + apiSrc + "\n" + helperSrc + "\n" + card;
  assert.doesNotMatch(scanned, /Workmanship/);
  assert.doesNotMatch(scanned, /Acts of God/);
  assert.doesNotMatch(scanned, /\bAbuse\b/);
  assert.doesNotMatch(card, /placeholder=/);
  assert.match(card, /<textarea id="bsWarSummary" maxlength="4000" rows="4"><\/textarea>/);
  assert.match(card, /<textarea id="bsWarExclusions" maxlength="4000" rows="5"><\/textarea>/);
});

test("11. does not use warranty_notice as summary", () => {
  assert.doesNotMatch(helperSrc, /warranty_notice/);
  assert.doesNotMatch(apiSrc, /warranty_notice/);
  assert.ok(!prefsApi._test.ALLOWED_BODY_KEYS.has("warranty_notice"));
  assert.doesNotMatch(helperSrc, /Warranty coverage, if any/);
  assert.match(sql, /warranty_notice legal-notice text/);
});

test("12. does not touch Contract Builder", () => {
  assert.doesNotMatch(builderJs, /default_warranty_enabled/);
  assert.doesNotMatch(builderJs, /tenant-contract-preferences/);
  assert.doesNotMatch(builderJs, /Use standard warranty/);
  assert.doesNotMatch(builderJs, /business-warranty-defaults/);
  assert.doesNotMatch(builderHtml, /Use standard warranty/);
  assert.doesNotMatch(builderHtml, /bsStandardWarrantyCard/);
  assert.doesNotMatch(helperSrc, /contract-builder/);
  assert.doesNotMatch(helperSrc, /Confirm Warranty/);
});

test("13. does not touch project contract setup", () => {
  assert.doesNotMatch(setupSrc, /default_warranty_enabled/);
  assert.doesNotMatch(setupSrc, /default_warranty_summary/);
  assert.doesNotMatch(helperSrc, /project-contract-setup/);
  const executable = sql.replace(/--[^\n]*/g, "");
  assert.doesNotMatch(executable, /project_contract_setups/);
});

test("14. load path is GET-only; save merges then POSTs", () => {
  assert.match(helperSrc, /async function loadWarranty\(doc\)/);
  const loadFn = helperSrc.slice(
    helperSrc.indexOf("async function loadWarranty(doc)"),
    helperSrc.indexOf("async function saveWarranty(doc)")
  );
  assert.match(loadFn, /apiJson\("GET"\)/);
  assert.doesNotMatch(loadFn, /apiJson\("POST"/);
  assert.doesNotMatch(loadFn, /method !== "GET"/);
  const saveFn = helperSrc.slice(helperSrc.indexOf("async function saveWarranty(doc)"));
  assert.match(saveFn, /apiJson\("GET"\)/);
  assert.match(saveFn, /mergeWarrantyIntoPreferences/);
  assert.match(saveFn, /apiJson\("POST", body\)/);
});

test("15. Owner/Admin auth remains on the preferences API", () => {
  assert.match(apiSrc, /require\("\.\/_lib\/require-owner-or-admin"\)/);
  assert.match(apiSrc, /await requireOwnerOrAdmin\(event\)/);
  assert.doesNotMatch(apiSrc, /async function requireOwnerOrAdmin/);
});

test("16. RLS is unchanged", () => {
  assert.doesNotMatch(sql, /row level security/i);
  assert.doesNotMatch(sql, /create policy/i);
  assert.doesNotMatch(sql, /drop policy/i);
  assert.doesNotMatch(sql, /enable row level security/i);
  assert.match(ch001, /alter table public\.tenant_contract_preferences enable row level security;/);
  assert.match(
    ch001,
    /create policy "service role full access tenant_contract_preferences"/
  );
});

test("warranty is not in global preferences readiness", () => {
  const required = assembler.PREFERENCES_READINESS_REQUIRED;
  assert.ok(!required.includes("default_warranty_enabled"));
  assert.ok(!required.includes("default_warranty_summary"));
  assert.ok(!required.includes("default_warranty_exclusions"));
  assert.ok(!required.includes("default_warranty_duration_value"));
  const ready = assembler.evaluateContractPreferencesReadiness({
    primary_trade_module: "flooring",
    default_contract_name: "Service Agreement",
    default_contract_language: "en",
    change_order_requirement: "always",
    default_signer_mode: "one_customer",
    default_signature_order: "customer_first",
    default_warranty_enabled: false,
    default_warranty_summary: "",
    default_warranty_exclusions: "",
  });
  assert.strictEqual(ready.status, "ready");
});

test("API rejects summary over 4000 characters", () => {
  const tooLong = "x".repeat(4001);
  const res = prefsApi._test.normalizePreferencesInput({
    primary_trade_module: "flooring",
    default_warranty_enabled: false,
    default_warranty_summary: tooLong,
    default_warranty_exclusions: "",
  });
  assert.strictEqual(res.code, "warranty_text_too_long");
  const ui = helper.validateWarrantyDraft({
    default_warranty_enabled: false,
    default_warranty_summary: tooLong,
    default_warranty_exclusions: "",
  });
  assert.strictEqual(ui.ok, false);
});

test("automatically_attach_warranty is not the enabled flag", () => {
  assert.ok(prefsApi._test.ALLOWED_BODY_KEYS.has("automatically_attach_warranty"));
  assert.ok(helper.PRESERVED_PREFERENCE_KEYS.includes("automatically_attach_warranty"));
  assert.ok(!helper.WARRANTY_PATCH_KEYS.includes("automatically_attach_warranty"));
  assert.match(sql, /Distinct from automatically_attach_warranty/);
});

test("Business Settings card copy and controls", () => {
  assert.match(html, /id="bsStandardWarrantyCard"/);
  assert.match(html, />Standard Warranty</);
  assert.match(html, /Save your business.s standard warranty once/);
  assert.match(html, /Enable standard warranty/);
  assert.match(html, /What the warranty covers/);
  assert.match(html, /What the warranty does not cover/);
  assert.match(html, /Margin Guard does not provide legal advice/);
  assert.match(html, /id="btnSaveStandardWarranty"/);
  assert.match(html, /Save Standard Warranty/);
  assert.match(html, /id="btnReloadStandardWarranty"/);
  assert.match(html, /business-warranty-defaults\.js/);
  assert.match(html, /id="bsWarEnabled"/);
  assert.match(html, /id="bsWarDurationValue"/);
  assert.match(html, /<option value="days">Days<\/option>/);
  assert.match(html, /<option value="months" selected>Months<\/option>/);
  assert.match(html, /<option value="years">Years<\/option>/);
});

test("CH-001A duration columns remain; new migration does not rewrite them", () => {
  assert.match(ch001, /default_warranty_duration_value integer null/);
  assert.match(ch001, /default_warranty_duration_unit text not null default 'months'/);
  assert.doesNotMatch(sql, /default_warranty_duration_value integer/);
  assert.doesNotMatch(sql, /drop table if exists public\.tenant_contract_preferences/i);
});

console.log(`CH-082 business warranty preset QA: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
