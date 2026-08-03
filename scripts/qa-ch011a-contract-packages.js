/**
 * CH-011A — Contract Package foundation QA (static + pure unit).
 * Run: node scripts/qa-ch011a-contract-packages.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const sqlPath = path.join(ROOT, "SUPABASE_CH011A_CONTRACT_PACKAGES.sql");
const verifyPath = path.join(ROOT, "SUPABASE_CH011A_CONTRACT_PACKAGES_VERIFY.sql");
const libPath = path.join(ROOT, "netlify/functions/_lib/contract-package.js");
const freezePath = path.join(ROOT, "netlify/functions/contract-package-freeze.js");
const listPath = path.join(ROOT, "netlify/functions/contract-packages.js");

const sqlSrc = fs.readFileSync(sqlPath, "utf8");
const verifySrc = fs.readFileSync(verifyPath, "utf8");
const libSrc = fs.readFileSync(libPath, "utf8");
const freezeSrc = fs.readFileSync(freezePath, "utf8");
const listSrc = fs.readFileSync(listPath, "utf8");

const lib = require("../netlify/functions/_lib/contract-package");
const freezeMod = require("../netlify/functions/contract-package-freeze");
const listMod = require("../netlify/functions/contract-packages");

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

test("syntax contract-package.js", () => {
  const r = spawnSync(process.execPath, ["--check", libPath], { encoding: "utf8" });
  assert.strictEqual(r.status, 0, r.stderr || r.stdout);
});

test("syntax contract-package-freeze.js", () => {
  const r = spawnSync(process.execPath, ["--check", freezePath], { encoding: "utf8" });
  assert.strictEqual(r.status, 0, r.stderr || r.stdout);
});

test("syntax contract-packages.js", () => {
  const r = spawnSync(process.execPath, ["--check", listPath], { encoding: "utf8" });
  assert.strictEqual(r.status, 0, r.stderr || r.stdout);
});

test("1. no session guard present", () => {
  assert.ok(freezeSrc.includes("no_session"));
  assert.ok(listSrc.includes("no_session"));
});

test("2. seller/supervisor blocked (owner_required)", () => {
  assert.ok(freezeSrc.includes("owner_required"));
  assert.ok(listSrc.includes("owner_required"));
  assert.ok(freezeSrc.includes('OWNER_ADMIN_ROLES'));
});

test("3. missing project handled", () => {
  assert.ok(libSrc.includes("not_found") || libSrc.includes("unavailable"));
  assert.ok(listSrc.includes("Project not found"));
});

test("4. cross-tenant / quote mismatch = 404 path", () => {
  assert.ok(libSrc.includes("quote_project_mismatch"));
  assert.ok(libSrc.includes("tenant_id=eq."));
});

test("5. incomplete readiness blocked", () => {
  assert.ok(libSrc.includes("readiness_incomplete"));
  assert.ok(libSrc.includes("buildFreezeGate"));
  const gate = lib.buildFreezeGate({
    project: { id: "p" },
    quote: { status: "draft" },
    setup: null,
    setupReadiness: {
      project_address: "incomplete",
      warranty: "incomplete",
      signature_method: "incomplete",
    },
    paymentReadiness: { status: "missing" },
    legalEffective: null,
    legalProfile: null,
    legalProfileReadiness: { status: "incomplete" },
  });
  assert.strictEqual(gate.ok, false);
  assert.ok(gate.missing.includes("property"));
  assert.ok(gate.missing.includes("payment_schedule"));
  assert.ok(gate.missing.includes("legal_notices"));
  assert.ok(gate.missing.includes("business_settings"));
});

test("6-8. valid freeze snapshot + version semantics helpers", () => {
  const snapshotA = lib.buildSnapshot({
    tenantId: "t1",
    project: { id: "p1", project_name: "Test", status: "active", updated_at: "2026-01-01T00:00:00.000Z" },
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
      notes: "Scope text",
      terms: "Terms text",
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
      status: "confirmed",
      confirmed_at: "2026-01-03T00:00:00.000Z",
      updated_at: "2026-01-03T00:00:00.000Z",
      currency: "USD",
      contract_total: 1000,
    },
    items: [
      {
        id: "i1",
        sequence_number: 1,
        label: "Deposit",
        payment_type: "custom",
        amount: 1000,
        due_rule: "custom",
        item_role: "future_obligation",
      },
    ],
    paymentReadiness: {
      status: "configured",
      contract_total: 1000,
      scheduled_total: 1000,
      remaining_difference: 0,
      item_count: 1,
      confirmed_at: "2026-01-03T00:00:00.000Z",
    },
    legalEffective: {
      confirmed_at: "2026-01-04T00:00:00.000Z",
      notices: { contract_notice: "Notice A" },
      enabled: { contract_notice: true },
    },
    legalProfile: {
      id: "lp1",
      legal_business_name: "Acme LLC",
      business_phone: "555",
      business_email: "o@example.com",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
    brandingRow: {
      business_name: "Acme",
      logo_url: "https://example.com/logo.png",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
    frozenAt: "2026-01-05T00:00:00.000Z",
  });
  assert.strictEqual(snapshotA.schema, "ch-011a-v1");
  assert.strictEqual(snapshotA.business_settings.source, "business_settings");
  assert.strictEqual(snapshotA.business_settings.legal_profile.legal_business_name, "Acme LLC");
  assert.ok(snapshotA.payment_schedule.items.length === 1);
  assert.ok(snapshotA.legal_notices.notices.contract_notice);
  assert.strictEqual(snapshotA.signature_method_preference, "email_link");
  assert.ok(!("invoice" in snapshotA));
  assert.ok(!JSON.stringify(snapshotA).includes("payment_intent"));
});

test("9-10. content_hash deterministic + idempotent policy A", () => {
  const base = {
    schema: "ch-011a-v1",
    a: 1,
    b: { z: 2, y: 1 },
  };
  const h1 = lib.contentHashForSnapshot(base);
  const h2 = lib.contentHashForSnapshot({ b: { y: 1, z: 2 }, a: 1, schema: "ch-011a-v1" });
  assert.strictEqual(h1, h2);
  assert.match(h1, /^[a-f0-9]{64}$/);
  assert.ok(libSrc.includes("idempotent"));
  assert.ok(libSrc.includes("loadLatestReadyPackage"));
  assert.ok(libSrc.includes("authoritativeContentForHash"));
  assert.ok(libSrc.includes("evaluateFreezeHashDecision"));
  const withFrozen = { ...base, frozen_at: "2026-01-01T00:00:00.000Z" };
  const withOtherFrozen = { ...base, frozen_at: "2099-01-01T00:00:00.000Z" };
  assert.strictEqual(
    lib.contentHashForSnapshot(withFrozen),
    lib.contentHashForSnapshot(withOtherFrozen)
  );
});

test("11-12. Business Settings snapshot frozen (no second profile schema)", () => {
  assert.ok(libSrc.includes('source: "business_settings"'));
  assert.ok(libSrc.includes("serializeLegalProfileForApi"));
  assert.ok(!/createTable.*business_profile|tenant_business_profiles/i.test(libSrc));
  assert.ok(libSrc.includes("business_settings"));
});

test("13. Payment Schedule included", () => {
  assert.ok(libSrc.includes("payment_schedule"));
  assert.ok(libSrc.includes("project_contract_payment_schedule"));
});

test("14. Legal Notices / Terms included", () => {
  assert.ok(libSrc.includes("legal_notices"));
  assert.ok(libSrc.includes("buildEffectiveForContracts"));
  assert.ok(libSrc.includes("quote_terms"));
});

test("15. No invoice/ledger/Stripe/Payment Intent writes", () => {
  for (const src of [libSrc, freezeSrc, listSrc]) {
    assert.ok(!/invoices\?/.test(src));
    assert.ok(!/tenant_project_payments/.test(src));
    assert.ok(!/require\(["'].*stripe/i.test(src));
    assert.ok(!/create-.*stripe/i.test(src));
    assert.ok(!/project-payment-intent/.test(src));
    assert.ok(!/tenant_project_payment_intents/.test(src));
  }
});

test("16. GET lists versions newest first", () => {
  assert.ok(listSrc.includes('event.httpMethod !== "GET"'));
  assert.ok(libSrc.includes("order=version.desc"));
  assert.ok(!/method:\s*"POST"/.test(listSrc));
  assert.ok(!/method:\s*"PATCH"/.test(listSrc));
});

test("17. Immutable — no package content edit API", () => {
  assert.ok(!freezeSrc.includes("snapshot_json"));
  assert.ok(sqlSrc.includes("tenant_contract_packages_protect_immutable"));
  assert.ok(sqlSrc.includes("contract_package_immutable"));
  assert.ok(!/exports\.handler[\s\S]*PATCH/.test(freezeSrc));
});

test("18. No duplicate version race helper", () => {
  assert.ok(sqlSrc.includes("tenant_contract_packages_next_version"));
  assert.ok(sqlSrc.includes("pg_advisory_xact_lock"));
  assert.ok(sqlSrc.includes("tenant_contract_packages_tenant_project_version_key"));
  assert.ok(libSrc.includes("23505") || libSrc.includes("unique"));
});

test("19. SQL constraints", () => {
  assert.ok(sqlSrc.includes("tenant_contract_packages"));
  assert.ok(sqlSrc.includes("check (status in ('ready', 'superseded', 'executed', 'void'))"));
  assert.ok(sqlSrc.includes("content_hash ~"));
  assert.ok(sqlSrc.includes("snapshot_json jsonb not null"));
  assert.ok(sqlSrc.includes("source_readiness jsonb not null"));
  assert.ok(sqlSrc.includes("supersedes_package_id"));
  assert.ok(sqlSrc.includes("created_by"));
});

test("20. RLS", () => {
  assert.ok(sqlSrc.includes("enable row level security"));
  assert.ok(sqlSrc.includes("service role full access tenant_contract_packages"));
  assert.ok(sqlSrc.includes("revoke all on table public.tenant_contract_packages from anon"));
  assert.ok(sqlSrc.includes("grant all on table public.tenant_contract_packages to service_role"));
});

test("21. Verification SQL present", () => {
  assert.ok(fs.existsSync(verifyPath));
  assert.ok(verifySrc.includes("CH-011A VERIFY"));
  assert.ok(verifySrc.includes("immutable"));
  assert.ok(verifySrc.includes("RLS"));
});

test("handlers export", () => {
  assert.strictEqual(typeof freezeMod.handler, "function");
  assert.strictEqual(typeof listMod.handler, "function");
  assert.strictEqual(lib.API_VERSION, "ch-011a-v1");
});

test("hotfix: project select uses project_name only (no nonexistent name)", () => {
  const select = String(lib.PROJECT_SELECT || "");
  assert.ok(select.includes("project_name"), "must select project_name");
  assert.ok(!/(^|,)name(,|$)/.test(select), "must not select nonexistent tenant_projects.name");
  assert.ok(
    !/tenant_projects\?[^`"'\n]*select=[^`"'\n]*\bname\b/.test(libSrc),
    "freeze must not request tenant_projects.name"
  );
  assert.ok(libSrc.includes("select=${PROJECT_SELECT}"));
});

test("no Contract Builder UI / CH-010 / Invoice Hub file touches in this module", () => {
  assert.ok(!freezeSrc.includes("contract-builder"));
  assert.ok(!listSrc.includes("estimates-invoices"));
});

console.log(`CH-011A QA: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
