/**
 * CH-011B — Contract Envelope foundation QA (static + pure unit).
 * Run: node scripts/qa-ch011b-contract-envelopes.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const sqlPath = path.join(ROOT, "SUPABASE_CH011B_CONTRACT_ENVELOPES.sql");
const verifyPath = path.join(ROOT, "SUPABASE_CH011B_CONTRACT_ENVELOPES_VERIFY.sql");
const libPath = path.join(ROOT, "netlify/functions/_lib/contract-envelope.js");
const createPath = path.join(ROOT, "netlify/functions/contract-envelope-create.js");
const listPath = path.join(ROOT, "netlify/functions/contract-envelopes.js");

const sqlSrc = fs.readFileSync(sqlPath, "utf8");
const verifySrc = fs.readFileSync(verifyPath, "utf8");
const libSrc = fs.readFileSync(libPath, "utf8");
const createSrc = fs.readFileSync(createPath, "utf8");
const listSrc = fs.readFileSync(listPath, "utf8");

const lib = require("../netlify/functions/_lib/contract-envelope");
const createMod = require("../netlify/functions/contract-envelope-create");
const listMod = require("../netlify/functions/contract-envelopes");

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

test("syntax contract-envelope.js", () => {
  const r = spawnSync(process.execPath, ["--check", libPath], { encoding: "utf8" });
  assert.strictEqual(r.status, 0, r.stderr || r.stdout);
});

test("syntax contract-envelope-create.js", () => {
  const r = spawnSync(process.execPath, ["--check", createPath], { encoding: "utf8" });
  assert.strictEqual(r.status, 0, r.stderr || r.stdout);
});

test("syntax contract-envelopes.js", () => {
  const r = spawnSync(process.execPath, ["--check", listPath], { encoding: "utf8" });
  assert.strictEqual(r.status, 0, r.stderr || r.stdout);
});

test("No session guard present", () => {
  assert.ok(createSrc.includes("no_session"));
  assert.ok(listSrc.includes("no_session"));
});

test("Seller/supervisor blocked (owner_required)", () => {
  assert.ok(createSrc.includes("owner_required"));
  assert.ok(listSrc.includes("owner_required"));
  assert.ok(createSrc.includes("OWNER_ADMIN_ROLES"));
  assert.ok(listSrc.includes("OWNER_ADMIN_ROLES"));
});

test("Missing package handled", () => {
  assert.ok(libSrc.includes("not_found"));
  assert.ok(libSrc.includes("Contract package not found"));
  assert.ok(listSrc.includes("not_found"));
});

test("Wrong tenant / cross-tenant = 404 path", () => {
  assert.ok(libSrc.includes("tenant_id=eq."));
  assert.ok(libSrc.includes("loadPackageForTenant"));
  assert.ok(createSrc.includes("tenant_id_forbidden") || createSrc.includes("tenant_id is not accepted"));
});

test("Create envelope draft path", () => {
  assert.ok(libSrc.includes("createDraftEnvelope"));
  assert.ok(libSrc.includes('status: "draft"'));
  assert.ok(createSrc.includes("createDraftEnvelope"));
  assert.ok(createSrc.includes("package_id"));
});

test("Duplicate active envelope blocked", () => {
  assert.ok(libSrc.includes("active_envelope_exists"));
  assert.ok(libSrc.includes("listActiveEnvelopes"));
  assert.ok(sqlSrc.includes("tenant_contract_envelopes_one_active_per_package_uidx"));
  assert.ok(sqlSrc.includes("where status in ('draft', 'sent', 'opened')"));
});

test("Completed envelope blocks new active", () => {
  assert.ok(libSrc.includes("package_envelope_completed"));
  assert.ok(libSrc.includes("listCompletedEnvelopes"));
});

test("Package must be ready", () => {
  assert.ok(libSrc.includes("package_not_ready"));
  assert.ok(libSrc.includes('pkgStatus !== "ready"'));
});

test("Read list newest first", () => {
  assert.ok(listSrc.includes('event.httpMethod !== "GET"'));
  assert.ok(libSrc.includes("order=created_at.desc"));
  assert.ok(!/method:\s*"POST"/.test(listSrc));
  assert.ok(!/method:\s*"PATCH"/.test(listSrc));
});

test("Status validation", () => {
  for (const st of [
    "draft",
    "sent",
    "opened",
    "completed",
    "declined",
    "expired",
    "cancelled",
  ]) {
    assert.ok(lib.ENVELOPE_STATUSES.has(st));
    assert.ok(sqlSrc.includes(`'${st}'`));
  }
  assert.strictEqual(lib.ENVELOPE_STATUSES.size, 7);
  assert.ok(lib.isActiveEnvelopeStatus("draft"));
  assert.ok(lib.isActiveEnvelopeStatus("sent"));
  assert.ok(lib.isActiveEnvelopeStatus("opened"));
  assert.ok(!lib.isActiveEnvelopeStatus("completed"));
  assert.ok(!lib.isActiveEnvelopeStatus("declined"));
  assert.ok(!lib.isActiveEnvelopeStatus("expired"));
  assert.ok(!lib.isActiveEnvelopeStatus("cancelled"));
});

test("Serialize envelope metadata", () => {
  const row = lib.serializeEnvelope({
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    tenant_id: "t",
    package_id: "p",
    project_id: "pr",
    quote_id: "q",
    status: "draft",
    created_by: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    expires_at: "2026-02-01T00:00:00.000Z",
    completed_at: null,
    cancelled_at: null,
    declined_at: null,
    metadata: { note: "x" },
  });
  assert.strictEqual(row.status, "draft");
  assert.strictEqual(row.metadata.note, "x");
  assert.strictEqual(lib.serializeEnvelope(null), null);
});

test("RLS service_role only", () => {
  assert.ok(sqlSrc.includes("enable row level security"));
  assert.ok(sqlSrc.includes("service role full access tenant_contract_envelopes"));
  assert.ok(sqlSrc.includes("revoke all on table public.tenant_contract_envelopes from anon"));
  assert.ok(sqlSrc.includes("grant all on table public.tenant_contract_envelopes to service_role"));
});

test("Verification SQL present", () => {
  assert.ok(fs.existsSync(verifyPath));
  assert.ok(verifySrc.includes("CH-011B VERIFY"));
  assert.ok(verifySrc.includes("one active envelope"));
  assert.ok(verifySrc.includes("RLS"));
});

test("Handlers export", () => {
  assert.strictEqual(typeof createMod.handler, "function");
  assert.strictEqual(typeof listMod.handler, "function");
  assert.strictEqual(lib.API_VERSION, "ch-011b-v1");
});

test("No signing platform / Invoice / Stripe / Payment Intent / CB touches", () => {
  for (const src of [libSrc, createSrc, listSrc]) {
    assert.ok(!/invoices\?/.test(src));
    assert.ok(!/tenant_project_payments/.test(src));
    assert.ok(!/require\(["'].*stripe/i.test(src));
    assert.ok(!/project-payment-intent/.test(src));
    assert.ok(!/signed.?pdf/i.test(src));
    assert.ok(!/docusign/i.test(src));
    assert.ok(!/sendgrid|resend|twilio/i.test(src));
    assert.ok(!/contract-builder/i.test(src));
  }
  assert.ok(!createSrc.includes("freezeContractPackage"));
  assert.ok(!listSrc.includes("freezeContractPackage"));
});

test("SQL refs package + tenant constraints", () => {
  assert.ok(sqlSrc.includes("tenant_contract_envelopes_package_fk"));
  assert.ok(sqlSrc.includes("tenant_contract_envelopes_assert_refs"));
  assert.ok(sqlSrc.includes("tenant_contract_packages"));
});

console.log(`CH-011B QA: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
