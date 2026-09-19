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
  const patchUnknown = prefsApi._test.findUnknownBodyKeys(
    {
      default_warranty_enabled: true,
      primary_trade_module: "flooring",
    },
    prefsApi._test.ALLOWED_PATCH_KEYS
  );
  assert.ok(patchUnknown.includes("primary_trade_module"));
  assert.ok(!prefsApi._test.ALLOWED_PATCH_KEYS.has("custom_trade_label"));
  assert.ok(!prefsApi._test.ALLOWED_PATCH_KEYS.has("primary_trade_module"));
  prefsApi._test.WARRANTY_PATCH_KEYS.forEach((key) => {
    assert.ok(prefsApi._test.ALLOWED_PATCH_KEYS.has(key));
  });
  assert.strictEqual(prefsApi._test.ALLOWED_PATCH_KEYS.size, 5);
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

test("9. PATCH body is warranty-only and preserves other preferences", () => {
  const body = helper.buildWarrantyPatchBody(WARRANTY_PATCH);
  assert.deepStrictEqual(Object.keys(body).sort(), helper.WARRANTY_PATCH_KEYS.slice().sort());
  helper.PRESERVED_PREFERENCE_KEYS.forEach((key) => {
    assert.ok(!Object.prototype.hasOwnProperty.call(body, key), "patch omits " + key);
  });
  assert.ok(!Object.prototype.hasOwnProperty.call(body, "id"));
  assert.ok(!Object.prototype.hasOwnProperty.call(body, "tenant_id"));
  assert.ok(!Object.prototype.hasOwnProperty.call(body, "custom_trade_label"));
  const next = helper.applyWarrantyPatchToRow(EXISTING_PREFS, WARRANTY_PATCH);
  helper.PRESERVED_PREFERENCE_KEYS.forEach((key) => {
    assert.strictEqual(next[key], EXISTING_PREFS[key], "preserved " + key);
  });
  assert.strictEqual(next.default_warranty_enabled, true);
  assert.strictEqual(next.default_warranty_summary, "qa-preset-summary");
  assert.strictEqual(next.default_warranty_exclusions, "qa-preset-exclusions");
  assert.strictEqual(next.default_warranty_duration_value, 1);
  assert.strictEqual(next.default_warranty_duration_unit, "years");
  const patchNorm = prefsApi._test.normalizeWarrantyPatchInput(WARRANTY_PATCH);
  assert.ok(!patchNorm.error, patchNorm.error);
  assert.deepStrictEqual(Object.keys(patchNorm.warranty).sort(), helper.WARRANTY_PATCH_KEYS.slice().sort());
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

test("12. CH-082 Business Settings helper does not wire Contract Builder", () => {
  assert.doesNotMatch(helperSrc, /contract-builder/);
  assert.doesNotMatch(helperSrc, /Confirm Warranty/);
  assert.doesNotMatch(helperSrc, /Use standard warranty/);
  assert.doesNotMatch(html, /Use standard warranty/);
  assert.doesNotMatch(builderHtml, /bsStandardWarrantyCard/);
  assert.doesNotMatch(apiSrc, /project-contract-setup/);
});

test("13. does not touch project contract setup", () => {
  assert.doesNotMatch(setupSrc, /default_warranty_enabled/);
  assert.doesNotMatch(setupSrc, /default_warranty_summary/);
  assert.doesNotMatch(helperSrc, /project-contract-setup/);
  const executable = sql.replace(/--[^\n]*/g, "");
  assert.doesNotMatch(executable, /project_contract_setups/);
});

test("14. load is GET-only; save uses PATCH without merge-POST", () => {
  assert.match(helperSrc, /async function loadWarranty\(doc\)/);
  const loadFn = helperSrc.slice(
    helperSrc.indexOf("async function loadWarranty(doc)"),
    helperSrc.indexOf("async function saveWarranty(doc)")
  );
  assert.match(loadFn, /apiJson\("GET"\)/);
  assert.doesNotMatch(loadFn, /apiJson\("POST"/);
  assert.doesNotMatch(loadFn, /apiJson\("PATCH"/);
  const saveFn = helperSrc.slice(helperSrc.indexOf("async function saveWarranty(doc)"));
  assert.doesNotMatch(saveFn, /apiJson\("GET"\)/);
  assert.doesNotMatch(saveFn, /apiJson\("POST"/);
  assert.doesNotMatch(saveFn, /mergeWarrantyIntoPreferences/);
  assert.match(saveFn, /buildWarrantyPatchBody/);
  assert.match(saveFn, /apiJson\("PATCH", body\)/);
  assert.match(apiSrc, /method !== "GET" && method !== "POST" && method !== "PATCH"/);
  assert.match(apiSrc, /on_conflict=tenant_id/);
  assert.match(apiSrc, /async function patchWarrantyPreferences/);
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
  assert.match(html, /<option value="1" selected>1 Year<\/option>/);
  assert.match(html, /<option value="2">2 Years<\/option>/);
  assert.match(html, /<option value="5">5 Years<\/option>/);
  assert.doesNotMatch(html, /<option value="days">Days<\/option>/);
  assert.doesNotMatch(html, /<option value="months" selected>Months<\/option>/);
});

test("POST replace-all still requires custom_trade_label for custom trade", () => {
  const res = prefsApi._test.normalizePreferencesInput({
    primary_trade_module: "custom",
    custom_trade_label: "",
    default_warranty_enabled: false,
    default_warranty_duration_value: null,
    default_warranty_duration_unit: "months",
    default_warranty_summary: "",
    default_warranty_exclusions: "",
  });
  assert.strictEqual(res.code, "custom_trade_label_required");
  const patch = prefsApi._test.normalizeWarrantyPatchInput({
    default_warranty_enabled: false,
    default_warranty_duration_value: null,
    default_warranty_duration_unit: "months",
    default_warranty_summary: "",
    default_warranty_exclusions: "",
  });
  assert.ok(!patch.error, patch.error);
  assert.ok(!Object.prototype.hasOwnProperty.call(patch.warranty, "custom_trade_label"));
  assert.ok(!Object.prototype.hasOwnProperty.call(patch.warranty, "primary_trade_module"));
});

test("CH-001A duration columns remain; new migration does not rewrite them", () => {
  assert.match(ch001, /default_warranty_duration_value integer null/);
  assert.match(ch001, /default_warranty_duration_unit text not null default 'months'/);
  assert.doesNotMatch(sql, /default_warranty_duration_value integer/);
  assert.doesNotMatch(sql, /drop table if exists public\.tenant_contract_preferences/i);
});

const { buildSessionPayload, createSessionCookie } = require("../netlify/functions/_lib/session");

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER_A = "owner-a@example.com";
const USER_A = "11111111-1111-4111-8111-111111111111";
const CUS_A = "cus_legacyOwnerA123";

function jsonRes(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return typeof body === "string" ? body : JSON.stringify(body);
    },
  };
}

function extractPath(url) {
  const s = String(url);
  const idx = s.indexOf("/rest/v1/");
  return idx >= 0 ? s.slice(idx + "/rest/v1/".length) : s;
}

function qp(restPath, key) {
  const q = restPath.split("?")[1] || "";
  const part = q.split("&").find((p) => p.startsWith(key + "="));
  if (!part) return "";
  return decodeURIComponent(part.slice(key.length + 1).replace(/^eq\./, ""));
}

function ownerEvent(method, body) {
  return {
    httpMethod: method,
    headers: {
      cookie: createSessionCookie(
        buildSessionPayload({
          email: OWNER_A,
          tenantId: TENANT_A,
          userId: USER_A,
          customerId: "",
        })
      ),
    },
    queryStringParameters: {},
    body: body != null ? JSON.stringify(body) : undefined,
  };
}

function dbDefaults(tenantId, warranty) {
  return {
    id: "pref-" + tenantId.slice(0, 8),
    tenant_id: tenantId,
    primary_trade_module: "custom",
    custom_trade_label: "",
    default_contract_name: "",
    change_order_requirement: "price_change_only",
    require_customer_initials: true,
    default_signer_mode: "one_customer",
    default_contract_language: "en",
    dispute_resolution_preference: "unset",
    default_signature_order: "customer_first",
    automatically_attach_warranty: false,
    automatically_attach_completion_certificate: false,
    ...warranty,
  };
}

async function withPrefsHandler(store, fn) {
  const prevFetch = globalThis.fetch;
  const writes = store.writes || (store.writes = []);
  globalThis.fetch = async (url, opts) => {
    const method = String((opts && opts.method) || "GET").toUpperCase();
    const restPath = extractPath(url);
    const table = restPath.split("?")[0];
    let parsedBody = null;
    if (opts && opts.body) {
      try {
        parsedBody = JSON.parse(opts.body);
      } catch (_err) {
        parsedBody = opts.body;
      }
    }
    if (method !== "GET") {
      writes.push({ method, table, restPath, body: parsedBody, prefer: opts && opts.headers && opts.headers.Prefer });
    }

    if (table === "profiles") {
      const email = qp(restPath, "email");
      if (email === OWNER_A) {
        return jsonRes(200, [
          {
            id: "prof-owner-a",
            tenant_id: TENANT_A,
            email: OWNER_A,
            role: "owner",
            status: "active",
            auth_user_id: USER_A,
          },
        ]);
      }
      return jsonRes(200, []);
    }

    if (table === "tenants") {
      const id = qp(restPath, "id");
      if (id === TENANT_A || !id) {
        return jsonRes(200, [
          {
            id: TENANT_A,
            slug: "tenant-a",
            name: "Co A",
            owner_email: OWNER_A,
            plan_status: "active",
            stripe_customer_id: CUS_A,
          },
        ]);
      }
      return jsonRes(200, []);
    }

    if (table === "tenant_contract_preferences") {
      if (method === "GET") {
        return jsonRes(200, store.row ? [store.row] : []);
      }
      if (method === "PATCH") {
        assert.ok(store.row, "PATCH requires an existing row in this mock");
        const keys = Object.keys(parsedBody || {});
        keys.forEach((key) => {
          store.row[key] = parsedBody[key];
        });
        store.row.updated_at = "2026-09-17T18:00:00.000Z";
        return jsonRes(200, [store.row]);
      }
      if (method === "POST") {
        const incoming = parsedBody || {};
        if (store.row && /on_conflict=tenant_id/.test(restPath)) {
          Object.keys(incoming).forEach((key) => {
            if (key !== "tenant_id") store.row[key] = incoming[key];
          });
          return jsonRes(200, [store.row]);
        }
        store.row = dbDefaults(incoming.tenant_id || TENANT_A, incoming);
        return jsonRes(200, [store.row]);
      }
    }

    return jsonRes(200, []);
  };

  [
    "../netlify/functions/_lib/supabase-admin",
    "../netlify/functions/_lib/membership-resolve",
    "../netlify/functions/_lib/owner-access",
    "../netlify/functions/_lib/tenant-for-session",
    "../netlify/functions/_lib/require-owner-or-admin",
    "../netlify/functions/tenant-contract-preferences",
  ].forEach((rel) => {
    try {
      delete require.cache[require.resolve(rel)];
    } catch (_err) {
      /* ignore */
    }
  });
  const mod = require("../netlify/functions/tenant-contract-preferences");
  try {
    await fn(mod);
  } finally {
    globalThis.fetch = prevFetch;
  }
}

function parseHandler(res) {
  return JSON.parse(res.body || "{}");
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log("PASS", name);
  } catch (err) {
    failed += 1;
    console.log("FAIL", name, "-", err.message);
  }
}

async function runHandlerTests() {
  await testAsync("PATCH with existing row updates only warranty columns", async () => {
    const store = {
      row: {
        ...EXISTING_PREFS,
        id: "pref-existing",
        tenant_id: TENANT_A,
      },
      writes: [],
    };
    await withPrefsHandler(store, async (mod) => {
      const res = await mod.handler(ownerEvent("PATCH", WARRANTY_PATCH));
      const data = parseHandler(res);
      assert.strictEqual(res.statusCode, 200, data.error);
      assert.strictEqual(data.ok, true);
      const patchWrites = store.writes.filter((w) => w.table === "tenant_contract_preferences");
      assert.ok(patchWrites.length >= 1);
      const write = patchWrites.find((w) => w.method === "PATCH");
      assert.ok(write, "expected PATCH write");
      assert.deepStrictEqual(Object.keys(write.body).sort(), helper.WARRANTY_PATCH_KEYS.slice().sort());
      assert.ok(!Object.prototype.hasOwnProperty.call(write.body, "custom_trade_label"));
      assert.ok(!Object.prototype.hasOwnProperty.call(write.body, "primary_trade_module"));
      assert.strictEqual(store.row.primary_trade_module, "flooring");
      assert.strictEqual(store.row.default_contract_name, "Service Agreement");
      assert.strictEqual(store.row.default_contract_language, "es");
      assert.strictEqual(store.row.change_order_requirement, "always");
      assert.strictEqual(store.row.default_signer_mode, "all_property_owners");
      assert.strictEqual(store.row.default_signature_order, "contractor_first");
      assert.strictEqual(store.row.automatically_attach_warranty, true);
      assert.strictEqual(store.row.default_warranty_summary, "qa-preset-summary");
      assert.strictEqual(data.preferences.primary_trade_module, "flooring");
    });
  });

  await testAsync("PATCH with no row upserts tenant_id + warranty and keeps DB defaults", async () => {
    const store = { row: null, writes: [] };
    await withPrefsHandler(store, async (mod) => {
      const res = await mod.handler(ownerEvent("PATCH", WARRANTY_PATCH));
      const data = parseHandler(res);
      assert.strictEqual(res.statusCode, 200, data.error);
      assert.strictEqual(data.ok, true);
      const write = store.writes.find(
        (w) => w.table === "tenant_contract_preferences" && w.method === "POST"
      );
      assert.ok(write, "expected insert upsert");
      assert.match(write.restPath, /on_conflict=tenant_id/);
      assert.deepStrictEqual(
        Object.keys(write.body).sort(),
        ["default_warranty_duration_unit", "default_warranty_duration_value", "default_warranty_enabled", "default_warranty_exclusions", "default_warranty_summary", "tenant_id"].sort()
      );
      assert.ok(!Object.prototype.hasOwnProperty.call(write.body, "custom_trade_label"));
      assert.ok(!Object.prototype.hasOwnProperty.call(write.body, "primary_trade_module"));
      assert.strictEqual(store.row.primary_trade_module, "custom");
      assert.strictEqual(store.row.custom_trade_label, "");
      assert.strictEqual(store.row.default_contract_name, "");
      assert.strictEqual(store.row.automatically_attach_warranty, false);
      assert.strictEqual(store.row.default_warranty_enabled, true);
      assert.notStrictEqual(data.code, "custom_trade_label_required");
    });
  });

  await testAsync("PATCH rejects unknown keys including POST replace-all fields", async () => {
    const store = { row: { ...EXISTING_PREFS, tenant_id: TENANT_A }, writes: [] };
    await withPrefsHandler(store, async (mod) => {
      const res = await mod.handler(
        ownerEvent("PATCH", {
          ...WARRANTY_PATCH,
          primary_trade_module: "roofing",
        })
      );
      const data = parseHandler(res);
      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual(data.code, "unknown_fields");
      assert.ok(Array.isArray(data.fields) && data.fields.includes("primary_trade_module"));
      assert.strictEqual(store.writes.filter((w) => w.table === "tenant_contract_preferences").length, 0);
      assert.strictEqual(store.row.primary_trade_module, "flooring");
    });
  });

  await testAsync("concurrent PATCH writes keep non-warranty preferences", async () => {
    const store = {
      row: { ...EXISTING_PREFS, id: "pref-race", tenant_id: TENANT_A },
      writes: [],
    };
    await withPrefsHandler(store, async (mod) => {
      const first = {
        ...WARRANTY_PATCH,
        default_warranty_summary: "qa-race-one",
      };
      const second = {
        ...WARRANTY_PATCH,
        default_warranty_summary: "qa-race-two",
        default_warranty_exclusions: "qa-race-two-exclusions",
      };
      const [a, b] = await Promise.all([
        mod.handler(ownerEvent("PATCH", first)),
        mod.handler(ownerEvent("PATCH", second)),
      ]);
      assert.strictEqual(a.statusCode, 200, parseHandler(a).error);
      assert.strictEqual(b.statusCode, 200, parseHandler(b).error);
      const prefWrites = store.writes.filter(
        (w) => w.table === "tenant_contract_preferences" && w.method === "PATCH"
      );
      assert.ok(prefWrites.length >= 2);
      prefWrites.forEach((write) => {
        assert.deepStrictEqual(Object.keys(write.body).sort(), helper.WARRANTY_PATCH_KEYS.slice().sort());
        helper.PRESERVED_PREFERENCE_KEYS.forEach((key) => {
          assert.ok(!Object.prototype.hasOwnProperty.call(write.body, key));
        });
      });
      assert.strictEqual(store.row.primary_trade_module, "flooring");
      assert.strictEqual(store.row.default_contract_name, "Service Agreement");
      assert.strictEqual(store.row.automatically_attach_warranty, true);
      assert.ok(
        store.row.default_warranty_summary === "qa-race-one" ||
          store.row.default_warranty_summary === "qa-race-two"
      );
    });
  });

  await testAsync("POST replace-all remains available and still rejects incomplete custom trade", async () => {
    const store = { row: { ...EXISTING_PREFS, tenant_id: TENANT_A }, writes: [] };
    await withPrefsHandler(store, async (mod) => {
      const res = await mod.handler(
        ownerEvent("POST", {
          primary_trade_module: "custom",
          custom_trade_label: "",
          default_contract_name: "Service Agreement",
          default_warranty_duration_value: 1,
          default_warranty_duration_unit: "years",
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
        })
      );
      const data = parseHandler(res);
      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual(data.code, "custom_trade_label_required");
    });
  });
}

runHandlerTests()
  .then(() => {
    console.log(`CH-082 business warranty preset QA: ${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

