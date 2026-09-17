/**
 * CH-083 — Contract Builder "Use standard warranty" (no live data).
 * Run: node scripts/qa-ch083-use-standard-warranty.js
 */
"use strict";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET || "mg-ch083-use-standard-warranty-test-secret";
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "mg-ch083-use-standard-warranty-test-key";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const helperPath = path.join(ROOT, "public/js/contract-warranty-defaults.js");
const jsPath = path.join(ROOT, "public/js/contract-builder.js");
const htmlPath = path.join(ROOT, "public/contract-builder.html");
const setupPath = path.join(ROOT, "netlify/functions/project-contract-setup.js");
const freezePath = path.join(ROOT, "netlify/functions/_lib/contract-package.js");
const pdfPath = path.join(ROOT, "netlify/functions/_lib/contract-signed-pdf.js");
const payHelperPath = path.join(ROOT, "public/js/contract-payment-defaults.js");
const prefsPath = path.join(ROOT, "netlify/functions/tenant-contract-preferences.js");
const sqlPath = path.join(ROOT, "SUPABASE_CH083_PROJECT_CONTRACT_XACT_LOCK.sql");
const sqlVerifyPath = path.join(ROOT, "SUPABASE_CH083_PROJECT_CONTRACT_XACT_LOCK_VERIFY.sql");

const helper = require("../public/js/contract-warranty-defaults.js");
const setupApi = require("../netlify/functions/project-contract-setup.js");
const { buildSessionPayload, createSessionCookie } = require("../netlify/functions/_lib/session");

const js = fs.readFileSync(jsPath, "utf8");
const html = fs.readFileSync(htmlPath, "utf8");
const setupSrc = fs.readFileSync(setupPath, "utf8");
const freezeSrc = fs.readFileSync(freezePath, "utf8");
const pdfSrc = fs.readFileSync(pdfPath, "utf8");
const helperSrc = fs.readFileSync(helperPath, "utf8");
const payHelperSrc = fs.readFileSync(payHelperPath, "utf8");
const prefsSrc = fs.readFileSync(prefsPath, "utf8");
const sql = fs.readFileSync(sqlPath, "utf8");
const sqlVerify = fs.readFileSync(sqlVerifyPath, "utf8");

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

const COMPLETE_PRESET = {
  default_warranty_enabled: true,
  default_warranty_duration_value: 1,
  default_warranty_duration_unit: "years",
  default_warranty_summary: "qa-preset-summary",
  default_warranty_exclusions: "qa-preset-exclusions",
};

const EMPTY_FIELDS = {
  durationValue: "",
  durationUnit: "years",
  summary: "",
  exclusions: "",
};

test("syntax helper, builder, setup, freeze lib, this QA file", () => {
  check(helperPath);
  check(jsPath);
  check(setupPath);
  check(freezePath);
  check(path.join(__dirname, "qa-ch083-use-standard-warranty.js"));
});

test("complete enabled preset exposes Use standard warranty", () => {
  const action = helper.evaluateUseStandardWarrantyAction({
    preferences: COMPLETE_PRESET,
    existingFields: EMPTY_FIELDS,
    packages: [],
  });
  assert.strictEqual(action.presetStatus, "complete");
  assert.strictEqual(action.showPrimaryApply, true);
  assert.strictEqual(action.showReplace, false);
  assert.strictEqual(action.showSettingsHint, false);
  assert.match(html, />\s*Use standard warranty\s*</);
  assert.match(html, /id="cbWarUseStandardBtn"/);
});

test("click copies the four fields exactly and does not confirm", () => {
  const result = helper.applyStandardWarrantyToDraft(COMPLETE_PRESET, {
    existingFields: EMPTY_FIELDS,
    packages: [],
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.applied, true);
  assert.strictEqual(result.confirm, false);
  assert.deepStrictEqual(result.fields, {
    durationValue: "1",
    durationUnit: "years",
    summary: "qa-preset-summary",
    exclusions: "qa-preset-exclusions",
  });
  assert.match(js, /applyStandardWarrantyToLocalDraft/);
  assert.match(js, /warrantyPresetAppliedToDraft = true/);
  assert.doesNotMatch(
    js.slice(js.indexOf("function applyStandardWarrantyToLocalDraft"), js.indexOf("function onUseStandardWarrantyClick")),
    /confirm_warranty/
  );
});

test("load uses GET preferences and packages; zero POST/PATCH during load", () => {
  assert.match(js, /PREFERENCES_API = "\/.netlify\/functions\/tenant-contract-preferences"/);
  assert.match(js, /PACKAGES_API = "\/.netlify\/functions\/contract-packages"/);
  const initStart = js.indexOf("async function init()");
  const initBody = js.slice(initStart, js.indexOf("void init();"));
  assert.match(initBody, /fetchJson\(PREFERENCES_API\)/);
  assert.match(initBody, /fetchJson\(`\$\{PACKAGES_API\}\?project_id=/);
  assert.doesNotMatch(initBody, /postJson/);
  assert.doesNotMatch(initBody, /method:\s*"POST"/);
  assert.doesNotMatch(initBody, /method:\s*"PATCH"/);
  assert.doesNotMatch(initBody, /applyStandardWarrantyToLocalDraft/);
  assert.doesNotMatch(initBody, /confirm_warranty:\s*true/);
});

test("zero automatic warranty confirmation", () => {
  assert.match(js, /saveLabel:\s*"Confirm Warranty"/);
  assert.match(js, /confirm_warranty:\s*true/);
  const saveFn = js.slice(
    js.indexOf("async function saveWarrantyWorkspace()"),
    js.indexOf("function warrantyConfigured")
  );
  assert.match(saveFn, /confirm_warranty:\s*true/);
  const applyFn = js.slice(
    js.indexOf("function applyStandardWarrantyToLocalDraft"),
    js.indexOf("function onUseStandardWarrantyClick")
  );
  assert.doesNotMatch(applyFn, /postJson/);
  assert.doesNotMatch(applyFn, /CONTRACT_SETUP_API/);
  assert.doesNotMatch(helperSrc, /confirm_warranty/);
});

test("disabled preset is not applied", () => {
  const result = helper.applyStandardWarrantyToDraft(
    { ...COMPLETE_PRESET, default_warranty_enabled: false },
    { existingFields: EMPTY_FIELDS, packages: [] }
  );
  assert.strictEqual(result.applied, false);
  assert.strictEqual(result.reason, "disabled");
  const action = helper.evaluateUseStandardWarrantyAction({
    preferences: { ...COMPLETE_PRESET, default_warranty_enabled: false },
    existingFields: EMPTY_FIELDS,
    packages: [],
  });
  assert.strictEqual(action.showPrimaryApply, false);
  assert.strictEqual(action.showSettingsHint, true);
});

test("incomplete preset is not applied", () => {
  const incomplete = {
    default_warranty_enabled: true,
    default_warranty_duration_value: 1,
    default_warranty_duration_unit: "years",
    default_warranty_summary: "",
    default_warranty_exclusions: "qa-preset-exclusions",
  };
  const result = helper.applyStandardWarrantyToDraft(incomplete, {
    existingFields: EMPTY_FIELDS,
    packages: [],
  });
  assert.strictEqual(result.applied, false);
  assert.strictEqual(result.reason, "incomplete");
  const zeroDuration = helper.applyStandardWarrantyToDraft(
    { ...COMPLETE_PRESET, default_warranty_duration_value: 0 },
    { existingFields: EMPTY_FIELDS, packages: [] }
  );
  assert.strictEqual(zeroDuration.applied, false);
});

test("missing preferences / 404 still leaves Contract Builder usable", () => {
  const missing = helper.applyStandardWarrantyToDraft(null, {
    existingFields: EMPTY_FIELDS,
    packages: [],
  });
  assert.strictEqual(missing.applied, false);
  assert.strictEqual(missing.reason, "missing");
  const empty = helper.applyStandardWarrantyToDraft(undefined, {
    existingFields: EMPTY_FIELDS,
    packages: [],
  });
  assert.strictEqual(empty.applied, false);
  const initStart = js.indexOf("async function init()");
  const initBody = js.slice(initStart, js.indexOf("void init();"));
  assert.match(initBody, /tenantPreferences = preferencesRes\.data\.preferences \|\| null/);
  assert.doesNotMatch(initBody, /preferencesRes\.status === 404[\s\S]{0,80}showError/);
  assert.match(js, /Only accepted or approved quotes can open a contract draft preview/);
});

test("existing warranty content is not overwritten silently", () => {
  const blocked = helper.applyStandardWarrantyToDraft(COMPLETE_PRESET, {
    existingFields: { durationValue: "2", durationUnit: "years", summary: "old", exclusions: "" },
    packages: [],
  });
  assert.strictEqual(blocked.applied, false);
  assert.strictEqual(blocked.needsConfirm, true);
  assert.strictEqual(blocked.reason, "existing_content");
  const replaced = helper.applyStandardWarrantyToDraft(COMPLETE_PRESET, {
    existingFields: { durationValue: "2", durationUnit: "years", summary: "old", exclusions: "old-ex" },
    packages: [],
    replaceConfirmed: true,
  });
  assert.strictEqual(replaced.applied, true);
  const action = helper.evaluateUseStandardWarrantyAction({
    preferences: COMPLETE_PRESET,
    existingFields: { summary: "already" },
    packages: [],
  });
  assert.strictEqual(action.showPrimaryApply, false);
  assert.strictEqual(action.showReplace, true);
  assert.match(html, /id="cbWarReplaceStandardBtn"/);
  assert.match(js, /REPLACE_CONFIRM_MESSAGE/);
});

test("helper locks ready/executed/superseded/frozen and allows draft/void", () => {
  ["ready", "executed", "superseded", "frozen"].forEach((status) => {
    const result = helper.applyStandardWarrantyToDraft(COMPLETE_PRESET, {
      existingFields: EMPTY_FIELDS,
      packages: [{ id: "pkg-" + status, status }],
    });
    assert.strictEqual(result.applied, false, status);
    assert.strictEqual(result.code, "warranty_locked_by_package", status);
  });
  const draft = helper.applyStandardWarrantyToDraft(COMPLETE_PRESET, {
    existingFields: EMPTY_FIELDS,
    packages: [],
  });
  assert.strictEqual(draft.applied, true);
  const voidOnly = helper.applyStandardWarrantyToDraft(COMPLETE_PRESET, {
    existingFields: EMPTY_FIELDS,
    packages: [{ id: "pkg-void", status: "void" }],
  });
  assert.strictEqual(voidOnly.applied, true);
});

test("server warranty lock uses the same package statuses", () => {
  const statuses = setupApi._test.WARRANTY_LOCK_PACKAGE_STATUSES;
  assert.ok(statuses.has("ready"));
  assert.ok(statuses.has("executed"));
  assert.ok(statuses.has("superseded"));
  assert.ok(statuses.has("frozen"));
  assert.ok(!statuses.has("void"));
  assert.ok(
    setupApi._test.findWarrantyLockingPackage([{ status: "ready" }])
  );
  assert.ok(
    setupApi._test.findWarrantyLockingPackage([{ status: "executed" }])
  );
  assert.ok(
    setupApi._test.findWarrantyLockingPackage([{ status: "superseded" }])
  );
  assert.ok(
    setupApi._test.findWarrantyLockingPackage([{ status: "frozen" }])
  );
  assert.strictEqual(
    setupApi._test.findWarrantyLockingPackage([{ status: "void" }]),
    null
  );
  assert.strictEqual(setupApi._test.findWarrantyLockingPackage([]), null);
  const touches = setupApi._test.requestTouchesWarranty({
    changes: { warranty_summary: "x" },
  });
  assert.strictEqual(touches, true);
  const signatureOnly = setupApi._test.requestTouchesWarranty({
    changes: { signature_method: "email_link" },
  });
  assert.strictEqual(signatureOnly, false);
  assert.doesNotMatch(setupSrc, /listPackagesForProject/);
  assert.doesNotMatch(setupSrc, /rejectWarrantyIfPackageLocked/);
  assert.match(setupSrc, /rpc\/save_project_contract_warranty/);
  assert.match(setupSrc, /warranty_locked_by_package/);
});

test("warranty and freeze share one advisory xact lock; no REST TOCTOU", () => {
  const lockExpr = "hashtext(p_tenant_id::text || ':' || p_project_id::text)";
  assert.match(sql, /create or replace function public\.project_contract_xact_lock/);
  assert.match(sql, /create or replace function public\.save_project_contract_warranty/);
  assert.match(sql, /create or replace function public\.freeze_tenant_contract_package/);
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.ok(sql.includes(lockExpr));
  assert.match(sql, /perform public\.project_contract_xact_lock\(p_tenant_id, p_project_id\)/);
  assert.strictEqual(
    (sql.match(/perform public\.project_contract_xact_lock\(p_tenant_id, p_project_id\)/g) || []).length >= 3,
    true
  );
  assert.match(sql, /in \('ready', 'executed', 'superseded', 'frozen'\)/);
  assert.doesNotMatch(sql, /in \('ready', 'executed', 'superseded', 'frozen', 'void'\)/);
  assert.match(sql, /MG_ERR:warranty_locked_by_package/);
  assert.doesNotMatch(sql, /drop table/i);
  assert.match(sql, /grant execute on function public\.save_project_contract_warranty/);
  assert.match(sql, /grant execute on function public\.freeze_tenant_contract_package/);
  assert.match(sqlVerify, /CH-083 VERIFY PASS/);
  assert.match(sqlVerify, /to_regprocedure\(v_ident\)/);
  assert.match(sqlVerify, /public\.project_contract_xact_lock\(uuid, uuid\)/);
  assert.match(sqlVerify, /public\.tenant_contract_packages_next_version\(uuid, uuid\)/);
  assert.match(sqlVerify, /public\.save_project_contract_warranty\(uuid, uuid, uuid, jsonb\)/);
  assert.match(
    sqlVerify,
    /public\.freeze_tenant_contract_package\(uuid, uuid, uuid, jsonb, text, jsonb, uuid, timestamptz\)/
  );
  assert.match(sqlVerify, /prosecdef is not true/);
  assert.match(sqlVerify, /p\.prosecdef/);
  assert.match(sqlVerify, /p\.proconfig/);
  assert.match(sqlVerify, /search_path is not safe/);
  assert.match(sqlVerify, /PUBLIC has EXECUTE/);
  assert.match(sqlVerify, /has_function_privilege\('anon'/);
  assert.match(sqlVerify, /has_function_privilege\('authenticated'/);
  assert.match(sqlVerify, /has_function_privilege\('service_role'/);
  assert.match(sqlVerify, /unexpected executable overload/);
  assert.match(sqlVerify, /select 'PASS'::text as ch083_verify_result/i);
  assert.ok(
    sqlVerify.lastIndexOf("select 'PASS'::text as ch083_verify_result") >
      sqlVerify.lastIndexOf("end;"),
    "PASS row must come after the VERIFY block, not before failed checks"
  );
  assert.match(setupSrc, /saveWarrantyAtomically/);
  assert.match(freezeSrc, /rpc\/freeze_tenant_contract_package/);
  assert.match(freezeSrc, /freezePackageAtomically/);
  const freezeFn = freezeSrc.slice(
    freezeSrc.indexOf("async function freezeContractPackage"),
    freezeSrc.indexOf("module.exports")
  );
  assert.doesNotMatch(freezeFn, /supabaseRequest\(`tenant_contract_packages`/);
  assert.doesNotMatch(freezeFn, /loadLatestReadyPackage\(/);
  assert.doesNotMatch(freezeFn, /nextPackageVersion\(/);
  assert.match(freezeFn, /decision\.idempotent/);
  assert.doesNotMatch(setupSrc, /listPackagesForProject\([\s\S]*saveSetup\(/);
});

test("snapshot/PDF still read project setup warranty, not the tenant preset", () => {
  assert.match(freezeSrc, /warranty: \{[\s\S]*duration_value: setup\?\.warranty_duration_value/);
  assert.match(freezeSrc, /summary: setup\?\.warranty_summary/);
  assert.match(freezeSrc, /exclusions: setup\?\.warranty_exclusions/);
  assert.doesNotMatch(freezeSrc, /default_warranty_summary/);
  assert.doesNotMatch(pdfSrc, /default_warranty_summary/);
  assert.doesNotMatch(setupSrc, /default_warranty_enabled/);
  assert.doesNotMatch(setupSrc, /automatically_attach_warranty/);
});

test("PR #81 payment/signature defaults remain", () => {
  assert.match(html, /contract-payment-defaults\.js/);
  assert.match(js, /applyLocalPaymentDefaults/);
  assert.match(js, /DEFAULT_SIGNATURE_METHOD_UI\s*=\s*"email_link"/);
  assert.match(payHelperSrc, /function buildDefaultPaymentSchedule/);
  assert.match(payHelperSrc, /isUnsafePackageStatus/);
});

test("does not invent legal text, fixtures, or warranty_notice", () => {
  assert.doesNotMatch(helperSrc, /warranty_notice/);
  assert.doesNotMatch(helperSrc, /Workmanship/);
  assert.doesNotMatch(helperSrc, /Acts of God/);
  const editor = html.slice(html.indexOf('id="art-warranty"'), html.indexOf('id="art-terms"'));
  assert.doesNotMatch(editor, /Workmanship/);
  assert.doesNotMatch(editor, /Acts of God/);
  assert.match(html, /id="cbWarEditSummary"/);
  assert.match(html, /id="cbWarEditExclusions"/);
  assert.match(html, /id="cbWarEditDurationValue"/);
  assert.match(html, /id="cbWarEditDurationUnit"/);
});

test("advanced four-field editing remains; Confirm Warranty still saves", () => {
  assert.match(js, /"art-warranty":[\s\S]*?saveLabel:\s*"Confirm Warranty"/);
  assert.match(js, /function saveWarrantyWorkspace/);
  assert.match(js, /warranty_duration_value: Number\(fields\.durationValue\)/);
  assert.match(js, /warranty_duration_unit: fields\.durationUnit/);
  assert.match(js, /warranty_summary: fields\.summary/);
  assert.match(js, /warranty_exclusions: fields\.exclusions/);
});

test("auth and other articles stay on the setup API", () => {
  assert.match(setupSrc, /requireOwnerOrAdmin/);
  assert.match(setupSrc, /tenant_id must not be sent by client/);
  assert.match(setupSrc, /confirm_property_address/);
  assert.match(setupSrc, /signature_method/);
  assert.match(prefsSrc, /method !== "GET" && method !== "POST" && method !== "PATCH"/);
});

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER_A = "owner-a@example.com";
const USER_A = "11111111-1111-4111-8111-111111111111";
const CUS_A = "cus_legacyOwnerA123";
const PROJECT_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const QUOTE_A = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

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

function ownerEvent(method, body, query) {
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
    queryStringParameters: query || {},
    body: body != null ? JSON.stringify(body) : undefined,
  };
}

function draftSetupRow() {
  return {
    id: "setup-1",
    tenant_id: TENANT_A,
    project_id: PROJECT_A,
    quote_id: QUOTE_A,
    property_address_line1: "1 Main",
    property_address_line2: "",
    property_city: "Hayward",
    property_state: "CA",
    property_postal_code: "94544",
    property_confirmed_at: "2026-01-01T00:00:00.000Z",
    warranty_duration_value: null,
    warranty_duration_unit: "months",
    warranty_summary: "",
    warranty_exclusions: "",
    warranty_confirmed_at: null,
    signature_method: "email_link",
    state_module_code: "",
    state_notice_pack_status: "unsupported",
    state_notice_pack_version: "",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

async function withSetupHandler(store, fn) {
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
      writes.push({ method, table, restPath, body: parsedBody });
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

    if (table === "tenant_projects") {
      return jsonRes(200, [{ id: PROJECT_A, quote_id: QUOTE_A }]);
    }

    if (table === "quotes") {
      return jsonRes(200, [{ id: QUOTE_A, project_address: "1 Main", job_site: "" }]);
    }

    async function withStoreLock(work) {
      const prev = store.mutex || Promise.resolve();
      let release;
      store.mutex = new Promise((resolve) => {
        release = resolve;
      });
      await prev;
      try {
        return await work();
      } finally {
        release();
      }
    }

    function lockingPackage() {
      const list = Array.isArray(store.packages) ? store.packages : [];
      return (
        list.find((pkg) =>
          ["ready", "executed", "superseded", "frozen"].includes(
            String(pkg.status || "").toLowerCase()
          )
        ) || null
      );
    }

    if (table === "rpc/save_project_contract_warranty") {
      return withStoreLock(async () => {
        const blocking = lockingPackage();
        if (blocking) {
          store.rpcCalls = (store.rpcCalls || []).concat(["save_project_contract_warranty"]);
          return jsonRes(400, {
            message:
              "MG_ERR:warranty_locked_by_package:Warranty terms cannot be changed after the contract package is frozen.",
            details: JSON.stringify({
              package_id: blocking.id,
              package_status: blocking.status,
            }),
          });
        }
        const updates = (parsedBody && parsedBody.p_updates) || {};
        store.setup = {
          ...(store.setup || draftSetupRow()),
          ...updates,
          tenant_id: TENANT_A,
          project_id: PROJECT_A,
          quote_id: QUOTE_A,
          updated_at: "2026-09-17T18:00:00.000Z",
        };
        store.rpcCalls = (store.rpcCalls || []).concat(["save_project_contract_warranty"]);
        return jsonRes(200, store.setup);
      });
    }

    if (table === "rpc/freeze_tenant_contract_package") {
      return withStoreLock(async () => {
        if (store.freezeDelayMs) {
          await new Promise((resolve) => setTimeout(resolve, store.freezeDelayMs));
        }
        const snapWar = (parsedBody && parsedBody.p_snapshot_json && parsedBody.p_snapshot_json.warranty) || {};
        const setup = store.setup || {};
        const snapDuration =
          snapWar.duration_value == null || snapWar.duration_value === ""
            ? null
            : Number(snapWar.duration_value);
        const setupDuration =
          setup.warranty_duration_value == null ? null : Number(setup.warranty_duration_value);
        if (
          snapDuration !== setupDuration ||
          String(snapWar.summary || "") !== String(setup.warranty_summary || "") ||
          String(snapWar.exclusions || "") !== String(setup.warranty_exclusions || "")
        ) {
          return jsonRes(400, {
            message:
              "MG_ERR:setup_version_conflict:Contract setup changed. Reload before freezing.",
          });
        }
        const hash = String((parsedBody && parsedBody.p_content_hash) || "");
        const ready = (store.packages || []).find((pkg) => pkg.status === "ready");
        if (ready && String(ready.content_hash) === hash) {
          store.rpcCalls = (store.rpcCalls || []).concat(["freeze_tenant_contract_package"]);
          return jsonRes(200, { ok: true, idempotent: true, package: ready });
        }
        const inserted = {
          id: "pkg-frozen-" + String((store.packages || []).length + 1),
          tenant_id: TENANT_A,
          project_id: PROJECT_A,
          quote_id: QUOTE_A,
          version: (store.packages || []).length + 1,
          status: "ready",
          content_hash: hash,
          snapshot_json: parsedBody && parsedBody.p_snapshot_json,
        };
        store.packages = (store.packages || []).map((pkg) =>
          pkg.status === "ready" ? { ...pkg, status: "superseded" } : pkg
        );
        store.packages.push(inserted);
        store.rpcCalls = (store.rpcCalls || []).concat(["freeze_tenant_contract_package"]);
        return jsonRes(200, { ok: true, idempotent: false, package: inserted });
      });
    }

    if (table === "tenant_contract_packages") {
      return jsonRes(200, store.packages || []);
    }

    if (table === "project_contract_setups") {
      if (method === "GET") {
        return jsonRes(200, store.setup ? [store.setup] : []);
      }
      if (method === "PATCH") {
        store.setup = { ...store.setup, ...parsedBody, updated_at: "2026-09-17T18:00:00.000Z" };
        return jsonRes(200, [store.setup]);
      }
      if (method === "POST") {
        store.setup = { ...draftSetupRow(), ...parsedBody, id: "setup-new" };
        return jsonRes(200, [store.setup]);
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
    "../netlify/functions/_lib/contract-package",
    "../netlify/functions/project-contract-setup",
  ].forEach((rel) => {
    try {
      delete require.cache[require.resolve(rel)];
    } catch (_err) {
      /* ignore */
    }
  });
  const mod = require("../netlify/functions/project-contract-setup.js");
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

const WARRANTY_POST = {
  project_id: PROJECT_A,
  quote_id: QUOTE_A,
  warranty_duration_value: 1,
  warranty_duration_unit: "years",
  warranty_summary: "qa-preset-summary",
  warranty_exclusions: "qa-preset-exclusions",
  confirm_warranty: true,
};

async function runHandlerTests() {
  await testAsync("draft package allows warranty mutation", async () => {
    const store = { setup: draftSetupRow(), packages: [], writes: [] };
    await withSetupHandler(store, async (mod) => {
      const res = await mod.handler(ownerEvent("POST", WARRANTY_POST));
      const data = parseHandler(res);
      assert.strictEqual(res.statusCode, 200, data.error);
      assert.strictEqual(data.ok, true);
      assert.strictEqual(data.setup.warranty_summary, "qa-preset-summary");
      assert.ok(data.setup.warranty_confirmed_at);
      assert.ok(
        (store.rpcCalls || []).includes("save_project_contract_warranty"),
        "expected warranty RPC"
      );
      assert.strictEqual(
        store.writes.filter((w) => w.table === "project_contract_setups").length,
        0
      );
    });
  });

  await testAsync("void-only packages still allow warranty mutation", async () => {
    const store = {
      setup: draftSetupRow(),
      packages: [
        {
          id: "pkg-void",
          tenant_id: TENANT_A,
          project_id: PROJECT_A,
          quote_id: QUOTE_A,
          version: 1,
          status: "void",
        },
      ],
      writes: [],
    };
    await withSetupHandler(store, async (mod) => {
      const res = await mod.handler(ownerEvent("POST", WARRANTY_POST));
      const data = parseHandler(res);
      assert.strictEqual(res.statusCode, 200, data.error);
      assert.strictEqual(data.ok, true);
    });
  });

  for (const status of ["ready", "executed", "superseded", "frozen"]) {
    await testAsync(status + " package rejects warranty mutation", async () => {
      const store = {
        setup: draftSetupRow(),
        packages: [
          {
            id: "pkg-" + status,
            tenant_id: TENANT_A,
            project_id: PROJECT_A,
            quote_id: QUOTE_A,
            version: 1,
            status,
          },
        ],
        writes: [],
      };
      await withSetupHandler(store, async (mod) => {
        const res = await mod.handler(ownerEvent("POST", WARRANTY_POST));
        const data = parseHandler(res);
        assert.strictEqual(res.statusCode, 409, data.error);
        assert.strictEqual(data.code, "warranty_locked_by_package");
        assert.strictEqual(data.package_status, status);
        assert.strictEqual(
          store.writes.filter((w) => w.table === "project_contract_setups").length,
          0
        );
        assert.ok((store.rpcCalls || []).includes("save_project_contract_warranty"));
      });
    });
  }

  await testAsync("frozen package still allows signature_method mutation", async () => {
    const store = {
      setup: draftSetupRow(),
      packages: [
        {
          id: "pkg-ready",
          tenant_id: TENANT_A,
          project_id: PROJECT_A,
          quote_id: QUOTE_A,
          version: 1,
          status: "ready",
        },
      ],
      writes: [],
    };
    await withSetupHandler(store, async (mod) => {
      const res = await mod.handler(
        ownerEvent("POST", {
          project_id: PROJECT_A,
          quote_id: QUOTE_A,
          signature_method: "both",
        })
      );
      const data = parseHandler(res);
      assert.strictEqual(res.statusCode, 200, data.error);
      assert.strictEqual(data.setup.signature_method, "both");
    });
  });

  await testAsync("freeze holds the lock so concurrent warranty cannot diverge", async () => {
    const oldSetup = {
      ...draftSetupRow(),
      warranty_duration_value: 1,
      warranty_duration_unit: "years",
      warranty_summary: "old",
      warranty_exclusions: "old-ex",
      warranty_confirmed_at: "2026-01-01T00:00:00.000Z",
    };
    const store = {
      setup: oldSetup,
      packages: [],
      writes: [],
      freezeDelayMs: 50,
    };
    await withSetupHandler(store, async (mod) => {
      const freezeMod = require("../netlify/functions/_lib/contract-package.js");
      const freezePromise = freezeMod.freezePackageAtomically({
        tenantId: TENANT_A,
        projectId: PROJECT_A,
        quoteId: QUOTE_A,
        snapshot: {
          warranty: {
            duration_value: 1,
            duration_unit: "years",
            summary: "old",
            exclusions: "old-ex",
          },
        },
        contentHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        sourceReadiness: { warranty: "configured" },
      });
      await new Promise((resolve) => setTimeout(resolve, 15));
      const war = await mod.handler(ownerEvent("POST", WARRANTY_POST));
      const freeze = await freezePromise;
      const warData = parseHandler(war);
      assert.strictEqual(war.statusCode, 409, warData.error);
      assert.strictEqual(warData.code, "warranty_locked_by_package");
      assert.strictEqual(freeze.idempotent, false);
      assert.ok(freeze.package && freeze.package.status === "ready");
      assert.strictEqual(store.setup.warranty_summary, "old");
      assert.strictEqual(
        store.packages.filter((pkg) => pkg.status === "ready").length,
        1
      );
    });
  });

  await testAsync("warranty first then freeze with stale snapshot is rejected", async () => {
    const store = {
      setup: {
        ...draftSetupRow(),
        warranty_duration_value: 1,
        warranty_duration_unit: "years",
        warranty_summary: "old",
        warranty_exclusions: "old-ex",
        warranty_confirmed_at: "2026-01-01T00:00:00.000Z",
      },
      packages: [],
      writes: [],
    };
    await withSetupHandler(store, async (mod) => {
      const freezeMod = require("../netlify/functions/_lib/contract-package.js");
      const war = await mod.handler(ownerEvent("POST", WARRANTY_POST));
      assert.strictEqual(war.statusCode, 200, parseHandler(war).error);
      let freezeErr = null;
      try {
        await freezeMod.freezePackageAtomically({
          tenantId: TENANT_A,
          projectId: PROJECT_A,
          quoteId: QUOTE_A,
          snapshot: {
            warranty: {
              duration_value: 1,
              duration_unit: "years",
              summary: "old",
              exclusions: "old-ex",
            },
          },
          contentHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          sourceReadiness: { warranty: "configured" },
        });
      } catch (err) {
        freezeErr = err;
      }
      assert.ok(freezeErr, "stale freeze must fail");
      assert.match(String(freezeErr.message || freezeErr.supabaseRaw || ""), /setup_version_conflict/);
      assert.strictEqual(store.setup.warranty_summary, "qa-preset-summary");
      assert.strictEqual((store.packages || []).length, 0);
    });
  });
}

runHandlerTests()
  .then(() => {
    console.log("");
    console.log(`CH-083 Use standard warranty: ${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
