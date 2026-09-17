/**
 * CH-084 — Contractor + Customer signing policy (no live data).
 * Run: node scripts/qa-ch084-contractor-customer-signing.js
 */
"use strict";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET || "mg-ch084-contractor-customer-test-secret";
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "mg-ch084-contractor-customer-test-key";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const sqlPath = path.join(ROOT, "SUPABASE_CH084_REQUIRE_CONTRACTOR_SIGNATURE.sql");
const sqlVerifyPath = path.join(
  ROOT,
  "SUPABASE_CH084_REQUIRE_CONTRACTOR_SIGNATURE_VERIFY.sql"
);
const policyPath = path.join(ROOT, "netlify/functions/_lib/contract-signing-policy.js");
const prefsPath = path.join(ROOT, "netlify/functions/tenant-contract-preferences.js");
const freezePath = path.join(ROOT, "netlify/functions/_lib/contract-package.js");
const sendPath = path.join(ROOT, "netlify/functions/_lib/contract-envelope-send.js");
const signPath = path.join(ROOT, "netlify/functions/_lib/contract-sign.js");
const publicSignPath = path.join(ROOT, "netlify/functions/contract-sign.js");
const contractorPath = path.join(ROOT, "netlify/functions/contract-sign-contractor.js");
const tokenPath = path.join(ROOT, "netlify/functions/_lib/contract-signing-token.js");
const assemblerPath = path.join(ROOT, "netlify/functions/_lib/contract-source-assembler.js");
const warrantyHelperPath = path.join(ROOT, "public/js/business-warranty-defaults.js");
const signingHelperPath = path.join(ROOT, "public/js/business-signing-policy.js");
const bsHtmlPath = path.join(ROOT, "public/business-settings.html");
const builderHtmlPath = path.join(ROOT, "public/contract-builder.html");
const builderJsPath = path.join(ROOT, "public/js/contract-builder.js");
const swHtmlPath = path.join(ROOT, "public/signature-workspace.html");
const swJsPath = path.join(ROOT, "public/js/signature-workspace.js");
const certPath = path.join(ROOT, "netlify/functions/_lib/contract-certificate.js");
const pdfPath = path.join(ROOT, "netlify/functions/_lib/contract-signed-pdf.js");

const policy = require("../netlify/functions/_lib/contract-signing-policy");
const prefsApi = require("../netlify/functions/tenant-contract-preferences.js");
const freeze = require("../netlify/functions/_lib/contract-package");
const sendLib = require("../netlify/functions/_lib/contract-envelope-send");
const signLib = require("../netlify/functions/_lib/contract-sign");
const assembler = require("../netlify/functions/_lib/contract-source-assembler");
const warrantyHelper = require("../public/js/business-warranty-defaults.js");
const { buildSessionPayload, createSessionCookie } = require("../netlify/functions/_lib/session");

const sql = fs.readFileSync(sqlPath, "utf8");
const sqlVerify = fs.readFileSync(sqlVerifyPath, "utf8");
const policySrc = fs.readFileSync(policyPath, "utf8");
const prefsSrc = fs.readFileSync(prefsPath, "utf8");
const freezeSrc = fs.readFileSync(freezePath, "utf8");
const sendSrc = fs.readFileSync(sendPath, "utf8");
const signSrc = fs.readFileSync(signPath, "utf8");
const publicSignSrc = fs.readFileSync(publicSignPath, "utf8");
const contractorSrc = fs.readFileSync(contractorPath, "utf8");
const tokenSrc = fs.readFileSync(tokenPath, "utf8");
const warrantySrc = fs.readFileSync(warrantyHelperPath, "utf8");
const signingHelperSrc = fs.readFileSync(signingHelperPath, "utf8");
const bsHtml = fs.readFileSync(bsHtmlPath, "utf8");
const builderHtml = fs.readFileSync(builderHtmlPath, "utf8");
const builderJs = fs.readFileSync(builderJsPath, "utf8");
const swHtml = fs.readFileSync(swHtmlPath, "utf8");
const swJs = fs.readFileSync(swJsPath, "utf8");
const certSrc = fs.readFileSync(certPath, "utf8");
const pdfSrc = fs.readFileSync(pdfPath, "utf8");

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

function check(file) {
  const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || "syntax failed");
}

function executableSql(src) {
  return src.replace(/--[^\n]*/g, "");
}

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER_A = "owner-a@example.com";
const USER_A = "11111111-1111-4111-8111-111111111111";
const ENV_A = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const PKG_A = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TOKEN_A = "tok-customer-raw";
const UPDATED_AT = "2026-09-17T18:00:00.000Z";

function jsonRes(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return typeof body === "string" ? body : JSON.stringify(body);
    },
    async json() {
      return typeof body === "string" ? JSON.parse(body) : body;
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
    body: body == null ? null : JSON.stringify(body),
  };
}

function snapshotArgs(overrides) {
  return {
    tenantId: TENANT_A,
    project: {
      id: "p1",
      project_name: "Test",
      status: "active",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
    quote: {
      id: "q1",
      client_name: "Cust",
      client_email: "c@example.com",
      client_phone: "555",
      project_address: "1 Main",
      job_site: "",
      status: "accepted",
      total: 1000,
      currency: "USD",
      deposit_required: 100,
      quote_number_display: "2026-1",
      title: "T",
      notes: "n",
      terms: "Terms",
      start_date: "2026-08-10",
      due_date: "2026-08-14",
      scope_of_work: "Scope",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
    setup: {
      id: "s1",
      property_address_line1: "1 Main",
      property_address_line2: "",
      property_city: "Hayward",
      property_state: "CA",
      property_postal_code: "94544",
      property_confirmed_at: "2026-01-02T00:00:00.000Z",
      warranty_duration_value: 1,
      warranty_duration_unit: "years",
      warranty_summary: "Workmanship",
      warranty_exclusions: "Abuse",
      warranty_confirmed_at: "2026-01-02T00:00:00.000Z",
      signature_method: "email_link",
      updated_at: "2026-01-02T00:00:00.000Z",
    },
    setupReadiness: {
      project_address: "confirmed",
      warranty: "configured",
      signature_method: "configured",
    },
    schedule: {
      id: "sch1",
      currency: "USD",
      contract_total: 1000,
      status: "confirmed",
      confirmed_at: "2026-01-02T00:00:00.000Z",
    },
    items: [],
    paymentReadiness: { status: "configured" },
    legalEffective: { notices: {}, enabled: {}, confirmed_at: "2026-01-02T00:00:00.000Z" },
    legalProfile: {
      id: "lp1",
      legal_business_name: "Three Colors Corp",
      authorized_signer_name: "Owner Name",
      authorized_signer_title: "Owner",
      business_email: "owner@example.com",
    },
    brandingRow: { business_email: "biz@example.com" },
    frozenAt: "2026-09-17T12:00:00.000Z",
    contractSchedule: {
      start_date: "2026-08-10",
      due_date: "2026-08-14",
      source: "approved_quote",
    },
    ...(overrides || {}),
  };
}

test("syntax SQL + JS surfaces", () => {
  [
    policyPath,
    prefsPath,
    freezePath,
    sendPath,
    signPath,
    publicSignPath,
    contractorPath,
    tokenPath,
    assemblerPath,
    warrantyHelperPath,
    signingHelperPath,
    builderJsPath,
    swJsPath,
    path.join(__dirname, "qa-ch084-contractor-customer-signing.js"),
  ].forEach(check);
});

test("SQL is additive, idempotent, default false, no backfill", () => {
  assert.match(sql, /add column if not exists require_contractor_signature boolean not null default false/);
  const exec = executableSql(sql);
  assert.doesNotMatch(exec, /\bdrop table\b/i);
  assert.doesNotMatch(exec, /\bdrop column\b/i);
  assert.doesNotMatch(exec, /\bupdate\s+public\./i);
  assert.doesNotMatch(exec, /\binsert into\b/i);
  assert.doesNotMatch(exec, /tenant_contract_packages/);
  assert.doesNotMatch(exec, /tenant_contract_envelopes/);
  assert.doesNotMatch(exec, /snapshot_json/);
  assert.match(sql, /Existing rows stay false/i);
  assert.match(sql, /not a backfill/i);
});

test("VERIFY is separate and returns PASS only after checks", () => {
  assert.ok(sqlPath !== sqlVerifyPath);
  assert.match(sqlVerify, /ch084_verify_result/);
  assert.match(sqlVerify, /select 'PASS'::text as ch084_verify_result/i);
  assert.ok(
    sqlVerify.lastIndexOf("select 'PASS'::text as ch084_verify_result") >
      sqlVerify.indexOf("raise exception")
  );
  assert.match(sqlVerify, /default must be false/);
  assert.doesNotMatch(executableSql(sqlVerify), /\bupdate\s+public\./i);
});

test("customer-only is the missing-field default", () => {
  const missing = policy.resolveSigningPolicyFromSnapshot({});
  assert.strictEqual(missing.require_contractor_signature, false);
  assert.strictEqual(missing.parties, "customer_only");
  assert.strictEqual(missing.signature_order, "customer_first");
  const falsePref = policy.signingPolicyFromPreferences({
    require_contractor_signature: false,
  });
  assert.strictEqual(falsePref.parties, "customer_only");
  const none = policy.signingPolicyFromPreferences(null);
  assert.strictEqual(none.require_contractor_signature, false);
});

test("dual freeze writes contractor_first Contractor + Customer", () => {
  const dual = policy.signingPolicyFromPreferences({
    require_contractor_signature: true,
    default_signature_order: "customer_first",
  });
  assert.strictEqual(dual.require_contractor_signature, true);
  assert.strictEqual(dual.signature_order, "contractor_first");
  assert.strictEqual(dual.parties, "contractor_and_customer");
  assert.strictEqual(policy.partiesLabel(dual), "Contractor + Customer");
  const snap = freeze.buildSnapshot(
    snapshotArgs({ signingPolicy: { require_contractor_signature: true } })
  );
  assert.strictEqual(snap.signing_policy.require_contractor_signature, true);
  assert.strictEqual(snap.signing_policy.signature_order, "contractor_first");
  const customerOnly = freeze.buildSnapshot(snapshotArgs({}));
  assert.strictEqual(customerOnly.signing_policy.require_contractor_signature, false);
  assert.notStrictEqual(
    freeze.contentHashForSnapshot(snap),
    freeze.contentHashForSnapshot(customerOnly)
  );
});

test("Both remains a customer signing method, not two parties", () => {
  assert.match(builderHtml, /Customer signing method/);
  assert.match(builderHtml, /Signing parties/);
  assert.match(builderHtml, /<option value="both">Both<\/option>/);
  assert.match(
    builderHtml,
    /Both means email link and sign on device for the customer/
  );
  assert.ok(builderJs.includes('SIGNATURE_METHOD_OPTIONS = new Set(["sign_on_device", "email_link", "both"])'));
  assert.ok(!builderJs.includes('both") === "contractor'));
});

test("never auto-sign authorized_signer_name / Legal Profile", () => {
  assert.ok(!signSrc.includes("authorized_signer_name"));
  assert.ok(!contractorSrc.includes("typed_name: proposal"));
  assert.ok(contractorSrc.includes("authorized_signer_name"));
  assert.ok(contractorSrc.includes("_forbidden"));
  assert.match(swJs, /Legal Profile is identity only/);
  assert.match(swJs, /this is not a signature/);
  assert.ok(!swJs.includes("typed_name: proposal"));
  const proposal = policy.contractorProposalFromSnapshot({
    business_settings: {
      legal_profile: { authorized_signer_name: "Owner Name" },
    },
  });
  assert.strictEqual(proposal.party_name, "Owner Name");
  assert.ok(!signSrc.includes(proposal.party_name));
});

test("contractor in-app uses a dedicated token and never returns it", () => {
  assert.match(tokenSrc, /async function mintFreshSigningToken/);
  assert.match(signSrc, /mintFreshSigningToken/);
  assert.match(signSrc, /delete captured.token/);
  assert.match(contractorSrc, /does not return it/i);
  assert.ok(!/signing_token:/.test(contractorSrc));
  assert.ok(contractorSrc.includes("authorized_signer_name"));
  assert.ok(contractorSrc.includes("is not accepted from client"));
  assert.match(publicSignSrc, /signing_token/);
  assert.match(signSrc, /owner_session_required/);
  assert.match(contractorSrc, /requireOwnerOrAdmin/);
  assert.ok(!publicSignSrc.includes("sessionOwnerCapture: true"));
  assert.ok(!publicSignSrc.includes("allowDraftEnvelope: true"));
});

test("order: customer cannot sign before contractor; send waits", () => {
  const dual = policy.CONTRACTOR_AND_CUSTOMER;
  const unsigned = [
    { id: "o1", role: "owner", is_required: true, status: "pending" },
    { id: "c1", role: "customer", is_required: true, status: "pending" },
  ];
  assert.strictEqual(
    policy.customerBlockedUntilContractor({
      policy: dual,
      signerRole: "customer",
      signers: unsigned,
    }),
    true
  );
  assert.strictEqual(
    policy.customerBlockedUntilContractor({
      policy: dual,
      signerRole: "owner",
      signers: unsigned,
    }),
    false
  );
  const signed = [
    { id: "o1", role: "owner", is_required: true, status: "signed" },
    { id: "c1", role: "customer", is_required: true, status: "pending" },
  ];
  assert.strictEqual(
    policy.customerBlockedUntilContractor({
      policy: dual,
      signerRole: "customer",
      signers: signed,
    }),
    false
  );
  const blockers = policy.contractorSendBlockers(dual, unsigned);
  assert.strictEqual(blockers[0].code, "contractor_not_signed");
  assert.strictEqual(policy.contractorSendBlockers(policy.CUSTOMER_ONLY, unsigned).length, 0);
  assert.match(sendSrc, /contractorSendBlockers/);
  assert.match(signSrc, /not_your_turn/);
  assert.ok(!sendLib.signersNeedingTokens([
    { id: "o1", role: "owner", auth_method: "in_app", is_required: true, status: "signed", party_name: "O" },
    { id: "c1", role: "customer", auth_method: "email_link", is_required: true, email: "c@x.com", party_name: "C" },
  ]).some((s) => s.role === "owner"));
});

test("customer-only send still requires a customer and not a contractor", () => {
  assert.match(sendSrc, /no_required_customer/);
  const need = sendLib.signersNeedingTokens([
    {
      id: "1",
      role: "customer",
      is_required: true,
      auth_method: "email_link",
      email: "a@b.com",
      party_name: "A",
    },
  ]);
  assert.strictEqual(need.length, 1);
});

test("complete/cert/PDF still wait for all required signatures; no invented contractor", () => {
  assert.match(signSrc, /allRequiredSigned/);
  assert.strictEqual(
    signLib.allRequiredSigned([
      { is_required: true, role: "owner", status: "signed" },
      { is_required: true, role: "customer", status: "pending" },
    ]),
    false
  );
  assert.strictEqual(
    signLib.allRequiredSigned([
      { is_required: true, role: "owner", status: "signed" },
      { is_required: true, role: "customer", status: "signed" },
    ]),
    true
  );
  assert.ok(!certSrc.includes("authorized_signer_name"));
  assert.ok(!pdfSrc.includes("invented contractor"));
});

test("idempotent capture / freeze hashes / no completed rewrite", () => {
  assert.match(signSrc, /signature_already_recorded/);
  assert.match(signSrc, /unique|23505|duplicate/i);
  const a = freeze.buildSnapshot(snapshotArgs({ signingPolicy: { require_contractor_signature: true } }));
  const b = freeze.buildSnapshot(snapshotArgs({ signingPolicy: { require_contractor_signature: true } }));
  assert.strictEqual(freeze.contentHashForSnapshot(a), freeze.contentHashForSnapshot(b));
  assert.doesNotMatch(executableSql(sql), /status\s*=\s*'completed'/i);
});

test("GET serializes require_contractor_signature; warranty PATCH stays five keys", () => {
  const serialized = assembler.serializePreferencesForApi({
    primary_trade_module: "custom",
    require_contractor_signature: true,
  });
  assert.strictEqual(serialized.require_contractor_signature, true);
  const missing = assembler.serializePreferencesForApi({ primary_trade_module: "custom" });
  assert.strictEqual(missing.require_contractor_signature, false);
  assert.strictEqual(prefsApi._test.ALLOWED_PATCH_KEYS.size, 5);
  assert.ok(!prefsApi._test.ALLOWED_PATCH_KEYS.has("require_contractor_signature"));
  assert.ok(prefsApi._test.SIGNING_PATCH_KEY_SET.has("require_contractor_signature"));
  assert.ok(prefsApi._test.isSigningPolicyPatch({ require_contractor_signature: true }));
  assert.ok(!prefsApi._test.isSigningPolicyPatch({
    require_contractor_signature: true,
    default_warranty_enabled: true,
  }));
  assert.ok(warrantyHelper.PRESERVED_PREFERENCE_KEYS.includes("require_contractor_signature"));
});

test("Business Settings + Contract Builder + workspace UX", () => {
  assert.match(bsHtml, /Require contractor signature/);
  assert.match(bsHtml, /id="bsRequireContractorSignature"/);
  assert.match(signingHelperSrc, /require_contractor_signature/);
  assert.match(builderHtml, /Signing parties/);
  assert.match(builderHtml, /Customer signing method/);
  assert.match(builderHtml, /Signing parties were locked at freeze/);
  assert.match(builderJs, /Contractor \+ Customer/);
  assert.match(swJs, /Sign as Contractor/);
  assert.match(swJs, /Send to Customer/);
  assert.match(swHtml, /id="swSignContractorBtn"/);
  assert.match(swHtml, /Contract Signing Complete/);
  assert.ok(!swHtml.includes("Project Completed"));
  assert.ok(!swJs.includes("Project Completed"));
  assert.match(warrantySrc, /bsWarDurationValue/);
  assert.match(warrantySrc, /addEventListener\("input", refreshReadiness\)/);
  assert.match(warrantySrc, /addEventListener\("change", refreshReadiness\)/);
});

test("public capture stays token-only; contractor capture is session-gated", () => {
  assert.match(publicSignSrc, /Auth = signing_token only/);
  assert.ok(!publicSignSrc.includes("requireOwnerOrAdmin"));
  assert.match(contractorSrc, /require\("\.\/_lib\/require-owner-or-admin"\)/);
  assert.match(contractorSrc, /envelope_id/);
  assert.ok(!contractorSrc.includes("raw_token"));
});

const EXISTING_PREFS = {
  id: "pref-row",
  tenant_id: TENANT_A,
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
  default_signer_mode: "one_customer",
  default_contract_language: "en",
  dispute_resolution_preference: "unset",
  default_signature_order: "customer_first",
  automatically_attach_warranty: false,
  automatically_attach_completion_certificate: false,
  require_contractor_signature: false,
  updated_at: "2026-01-01T00:00:00.000Z",
};

async function withPrefsHandler(store, fn) {
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const method = String((opts && opts.method) || "GET").toUpperCase();
    const restPath = String(url).split("/rest/v1/")[1] || String(url);
    const table = restPath.split("?")[0];
    const parsedBody = opts && opts.body ? JSON.parse(opts.body) : null;
    store.writes = store.writes || [];
    if (table === "profiles") {
      return jsonRes(200, [
        {
          id: "p1",
          tenant_id: TENANT_A,
          email: OWNER_A,
          role: "owner",
          status: "active",
          auth_user_id: USER_A,
        },
      ]);
    }
    if (table === "tenants") {
      return jsonRes(200, [
        { id: TENANT_A, owner_email: OWNER_A, plan_status: "active" },
      ]);
    }
    if (table === "tenant_contract_preferences") {
      if (method === "GET") return jsonRes(200, store.row ? [store.row] : []);
      if (method === "PATCH") {
        store.writes.push({ table, method, body: parsedBody });
        Object.assign(store.row, parsedBody);
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
    globalThis.fetch = prev;
  }
}

async function withSignLib(store, fn) {
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const method = String((opts && opts.method) || "GET").toUpperCase();
    const restPath = String(url).split("/rest/v1/")[1] || String(url);
    const table = restPath.split("?")[0];
    store.writes = store.writes || [];
    if (opts && opts.body && method !== "GET") {
      store.writes.push({ table, method, body: JSON.parse(opts.body) });
    }
    if (table === "tenant_contract_signing_tokens" && method === "GET") {
      return jsonRes(200, store.token ? [store.token] : []);
    }
    if (table === "tenant_contract_signers" && /id=eq\./.test(restPath)) {
      return jsonRes(200, store.signer ? [store.signer] : []);
    }
    if (table === "tenant_contract_signers") {
      return jsonRes(200, store.signers || []);
    }
    if (table === "tenant_contract_envelopes") {
      return jsonRes(200, store.envelope ? [store.envelope] : []);
    }
    if (table === "tenant_contract_packages") {
      return jsonRes(200, store.package ? [store.package] : []);
    }
    if (table === "tenant_contract_signature_events") {
      return jsonRes(201, [{ id: "evt-1" }]);
    }
    return jsonRes(200, []);
  };
  [
    "../netlify/functions/_lib/supabase-admin",
    "../netlify/functions/_lib/contract-signing-token",
    "../netlify/functions/_lib/contract-signing-policy",
    "../netlify/functions/_lib/contract-sign",
  ].forEach((rel) => {
    try {
      delete require.cache[require.resolve(rel)];
    } catch (_err) {
      /* ignore */
    }
  });
  const mod = require("../netlify/functions/_lib/contract-sign");
  try {
    await fn(mod);
  } finally {
    globalThis.fetch = prev;
  }
}

async function runAsync() {
  await testAsync("PATCH signing policy does not write warranty columns", async () => {
    const store = { row: { ...EXISTING_PREFS }, writes: [] };
    await withPrefsHandler(store, async (mod) => {
      const res = await mod.handler(
        ownerEvent("PATCH", { require_contractor_signature: true })
      );
      const data = JSON.parse(res.body || "{}");
      assert.strictEqual(res.statusCode, 200, data.error);
      assert.strictEqual(data.preferences.require_contractor_signature, true);
      assert.strictEqual(store.writes.length, 1);
      assert.deepStrictEqual(Object.keys(store.writes[0].body), [
        "require_contractor_signature",
      ]);
      assert.strictEqual(store.row.default_warranty_summary, "");
      assert.strictEqual(store.row.primary_trade_module, "flooring");
    });
  });

  await testAsync("mixed warranty + signing PATCH is rejected", async () => {
    const store = { row: { ...EXISTING_PREFS }, writes: [] };
    await withPrefsHandler(store, async (mod) => {
      const res = await mod.handler(
        ownerEvent("PATCH", {
          require_contractor_signature: true,
          default_warranty_enabled: true,
        })
      );
      const data = JSON.parse(res.body || "{}");
      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual(data.code, "unknown_fields");
      assert.strictEqual(store.writes.length, 0);
    });
  });

  await testAsync("warranty PATCH still does not touch signing policy", async () => {
    const store = {
      row: { ...EXISTING_PREFS, require_contractor_signature: true },
      writes: [],
    };
    await withPrefsHandler(store, async (mod) => {
      const res = await mod.handler(
        ownerEvent("PATCH", {
          default_warranty_enabled: true,
          default_warranty_duration_value: 1,
          default_warranty_duration_unit: "years",
          default_warranty_summary: "summary",
          default_warranty_exclusions: "exclusions",
        })
      );
      const data = JSON.parse(res.body || "{}");
      assert.strictEqual(res.statusCode, 200, data.error);
      assert.ok(!Object.prototype.hasOwnProperty.call(store.writes[0].body, "require_contractor_signature"));
      assert.strictEqual(store.row.require_contractor_signature, true);
    });
  });

  await testAsync("customer token is blocked until contractor signed", async () => {
    await withSignLib(
      {
        token: {
          id: "tok-1",
          tenant_id: TENANT_A,
          envelope_id: ENV_A,
          signer_id: "sig-c",
          status: "active",
          token_hash: require("crypto").createHash("sha256").update(TOKEN_A, "utf8").digest("hex"),
          expires_at: "2099-01-01T00:00:00.000Z",
        },
        signer: {
          id: "sig-c",
          role: "customer",
          party_name: "Customer",
          status: "pending",
          envelope_id: ENV_A,
          package_id: PKG_A,
          is_required: true,
        },
        envelope: {
          id: ENV_A,
          package_id: PKG_A,
          status: "sent",
          updated_at: UPDATED_AT,
        },
        package: {
          id: PKG_A,
          version: 1,
          status: "ready",
          snapshot_json: {
            signing_policy: policy.CONTRACTOR_AND_CUSTOMER,
          },
        },
        signers: [
          { id: "sig-o", role: "owner", is_required: true, status: "pending" },
          { id: "sig-c", role: "customer", is_required: true, status: "pending" },
        ],
      },
      async (mod) => {
        const result = await mod.captureContractSignature({
          rawToken: TOKEN_A,
          signatureMethod: "typed",
          signaturePayload: { typed_name: "Customer Person" },
          consentEsign: true,
          expectedUpdatedAt: UPDATED_AT,
        });
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.code, "not_your_turn");
        assert.strictEqual(result.status, 409);
      }
    );
  });

  await testAsync("public capture cannot use an owner signer", async () => {
    await withSignLib(
      {
        token: {
          id: "tok-o",
          tenant_id: TENANT_A,
          envelope_id: ENV_A,
          signer_id: "sig-o",
          status: "active",
          token_hash: require("crypto").createHash("sha256").update(TOKEN_A, "utf8").digest("hex"),
          expires_at: "2099-01-01T00:00:00.000Z",
        },
        signer: {
          id: "sig-o",
          role: "owner",
          party_name: "Owner",
          status: "pending",
          envelope_id: ENV_A,
          package_id: PKG_A,
          is_required: true,
        },
        envelope: {
          id: ENV_A,
          package_id: PKG_A,
          status: "draft",
          updated_at: UPDATED_AT,
        },
        package: {
          id: PKG_A,
          version: 1,
          status: "ready",
          snapshot_json: { signing_policy: policy.CONTRACTOR_AND_CUSTOMER },
        },
        signers: [
          { id: "sig-o", role: "owner", is_required: true, status: "pending" },
        ],
      },
      async (mod) => {
        const result = await mod.captureContractSignature({
          rawToken: TOKEN_A,
          signatureMethod: "typed",
          signaturePayload: { typed_name: "Owner Name" },
          consentEsign: true,
          expectedUpdatedAt: UPDATED_AT,
        });
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.code, "owner_session_required");
        assert.strictEqual(result.status, 403);
      }
    );
  });

  await testAsync("contractor handler rejects missing session", async () => {
    const prev = globalThis.fetch;
    globalThis.fetch = async () => jsonRes(200, []);
    [
      "../netlify/functions/_lib/supabase-admin",
      "../netlify/functions/_lib/require-owner-or-admin",
      "../netlify/functions/contract-sign-contractor",
    ].forEach((rel) => {
      try {
        delete require.cache[require.resolve(rel)];
      } catch (_err) {
        /* ignore */
      }
    });
    const handler = require("../netlify/functions/contract-sign-contractor");
    try {
      const res = await handler.handler({
        httpMethod: "POST",
        headers: {},
        body: JSON.stringify({
          envelope_id: ENV_A,
          expected_updated_at: UPDATED_AT,
          signature_method: "typed",
          signature_payload: { typed_name: "Owner" },
          consent_esign: true,
        }),
      });
      const data = JSON.parse(res.body || "{}");
      assert.strictEqual(res.statusCode, 401);
      assert.strictEqual(data.code, "no_session");
    } finally {
      globalThis.fetch = prev;
    }
  });
}

test("compatibility: freeze snapshot field is additive for old packages", () => {
  const row = freeze.serializePackageRow({
    id: PKG_A,
    tenant_id: TENANT_A,
    project_id: "p1",
    quote_id: "q1",
    version: 3,
    status: "executed",
    content_hash: "abc",
    snapshot_json: { schema: "ch-011a-v1" },
  });
  assert.strictEqual(row.signing_policy.require_contractor_signature, false);
  assert.strictEqual(row.status, "executed");
});

runAsync()
  .then(() => {
    console.log("");
    console.log(`CH-084 contractor+customer QA: ${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
