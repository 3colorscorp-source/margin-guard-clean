/**
 * CH-011H — Audit Certificate foundation QA (static + pure unit).
 * Run: node scripts/qa-ch011h-contract-certificates.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const sqlPath = path.join(ROOT, "SUPABASE_CH011H_CONTRACT_CERTIFICATES.sql");
const verifyPath = path.join(ROOT, "SUPABASE_CH011H_CONTRACT_CERTIFICATES_VERIFY.sql");
const libPath = path.join(ROOT, "netlify/functions/_lib/contract-certificate.js");
const createPath = path.join(ROOT, "netlify/functions/contract-certificate-create.js");
const listPath = path.join(ROOT, "netlify/functions/contract-certificates.js");

const sqlSrc = fs.readFileSync(sqlPath, "utf8");
const verifySrc = fs.readFileSync(verifyPath, "utf8");
const libSrc = fs.readFileSync(libPath, "utf8");
const createSrc = fs.readFileSync(createPath, "utf8");
const listSrc = fs.readFileSync(listPath, "utf8");

const lib = require("../netlify/functions/_lib/contract-certificate");
const createMod = require("../netlify/functions/contract-certificate-create");
const listMod = require("../netlify/functions/contract-certificates");

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

test("syntax lib + handlers", () => {
  check(libPath);
  check(createPath);
  check(listPath);
});

test("1. No session", () => {
  assert.ok(createSrc.includes("no_session"));
  assert.ok(listSrc.includes("no_session"));
});

test("2-3. Seller/supervisor blocked", () => {
  for (const src of [createSrc, listSrc]) {
    assert.ok(src.includes("owner_required"));
    assert.ok(src.includes("OWNER_ADMIN_ROLES"));
  }
});

test("4. Missing envelope", () => {
  assert.ok(libSrc.includes("not_found"));
  assert.ok(libSrc.includes("Envelope not found"));
});

test("5. Cross-tenant envelope", () => {
  assert.ok(libSrc.includes("tenant_id=eq."));
  assert.ok(createSrc.includes("tenant_id_forbidden"));
});

test("6. Non-completed envelope blocked", () => {
  assert.ok(libSrc.includes("envelope_not_completed"));
});

test("7. Executed package required", () => {
  assert.ok(libSrc.includes("package_not_executed"));
});

test("8. Missing audit event blocked", () => {
  assert.ok(libSrc.includes("missing_signature_events"));
});

test("9-11. Create / one only / idempotent", () => {
  assert.ok(libSrc.includes("createContractCertificate"));
  assert.ok(sqlSrc.includes("tenant_contract_certificates_tenant_envelope_key"));
  assert.ok(libSrc.includes("idempotent: true"));
  assert.ok(createSrc.includes("createContractCertificate"));
});

test("12. Deterministic certificate hash", () => {
  const evidence = {
    schema: "ch-011h-v1",
    package: { id: "p", version: 2, status: "executed", content_hash: "a".repeat(64) },
    envelope: { id: "e", status: "completed", completed_at: "2026-01-01T00:00:00.000Z" },
    project_id: "proj",
    quote_id: "quote",
    signers: [
      {
        signer_id: "s1",
        role: "customer",
        party_name: "A",
        email: "a@b.com",
        sign_order: 1,
        is_required: true,
        status: "signed",
        signed_at: "2026-01-01T00:00:00.000Z",
        signature_method: "typed",
        signature_event_id: "ev1",
        ip_address: "1.2.3.4",
        user_agent: "test",
      },
    ],
    signature_event_ids: ["ev1"],
    envelope_completed_at: "2026-01-01T00:00:00.000Z",
  };
  const h1 = lib.hashCertificateEvidence(evidence);
  const h2 = lib.hashCertificateEvidence({
    ...evidence,
    signers: [...evidence.signers],
  });
  assert.strictEqual(h1, h2);
  assert.strictEqual(h1.length, 64);
  assert.ok(/^[a-f0-9]{64}$/.test(h1));
  const num = lib.certificateNumberFromHash(h1);
  assert.ok(num.startsWith("MG-CERT-"));
});

test("13-14. Signer summaries + IP/UA", () => {
  assert.ok(libSrc.includes("party_name"));
  assert.ok(libSrc.includes("signature_method"));
  assert.ok(libSrc.includes("ip_address"));
  assert.ok(libSrc.includes("user_agent"));
  assert.ok(libSrc.includes("signature_event_id"));
});

test("15. No raw tokens", () => {
  assert.ok(!/raw_token|signing_token|token_hash/i.test(libSrc));
  assert.ok(sqlSrc.includes("No raw tokens") || sqlSrc.includes("No PDF. No raw tokens"));
});

test("16. Immutable row", () => {
  assert.ok(sqlSrc.includes("contract_certificate_immutable"));
  assert.ok(sqlSrc.includes("tenant_contract_certificates_protect_immutable"));
});

test("17. RLS", () => {
  assert.ok(sqlSrc.includes("enable row level security"));
  assert.ok(sqlSrc.includes("service role full access tenant_contract_certificates"));
  assert.ok(sqlSrc.includes("revoke all on table public.tenant_contract_certificates from anon"));
});

test("18. GET read", () => {
  assert.ok(listSrc.includes("listCertificatesForEnvelope"));
  assert.ok(listSrc.includes("envelope_id"));
  assert.strictEqual(typeof listMod.handler, "function");
});

test("19. No PDF generation", () => {
  for (const src of [libSrc, createSrc, listSrc]) {
    assert.ok(!/generatePdf|signed_pdf|pdfkit|puppeteer/i.test(src));
  }
});

test("20. No Invoice Hub / ledger / Stripe / PI", () => {
  for (const src of [libSrc, createSrc, listSrc]) {
    assert.ok(!/require\(["'].*stripe/i.test(src));
    assert.ok(!/project-payment-intent/.test(src));
    assert.ok(!/tenant_project_payments/.test(src));
    assert.ok(!/docusign|sendgrid/i.test(src));
    assert.ok(!/ledger/i.test(src));
  }
});

test("Handlers + verify + version", () => {
  assert.strictEqual(typeof createMod.handler, "function");
  assert.strictEqual(lib.API_VERSION, "ch-011h-v1");
  assert.ok(fs.existsSync(verifyPath));
  assert.ok(verifySrc.includes("CH-011H VERIFY"));
});

test("buildCertificateEvidence shape", () => {
  const ev = lib.buildCertificateEvidence({
    envelope: {
      id: "e1",
      status: "completed",
      completed_at: "t1",
      sent_at: "t0",
      project_id: "p1",
      quote_id: "q1",
    },
    pkg: {
      id: "pkg1",
      version: 2,
      status: "executed",
      content_hash: "b".repeat(64),
      executed_at: "t2",
    },
    signers: [
      {
        id: "s1",
        role: "customer",
        party_name: "Cust",
        email: "C@X.COM",
        sign_order: 1,
        is_required: true,
        status: "signed",
        signed_at: "t3",
      },
    ],
    events: [
      {
        id: "ev1",
        signer_id: "s1",
        signature_method: "typed",
        signed_at: "t3",
        ip_address: "9.9.9.9",
        user_agent: "UA",
      },
    ],
  });
  assert.strictEqual(ev.signers[0].email, "c@x.com");
  assert.strictEqual(ev.signers[0].signature_event_id, "ev1");
  assert.strictEqual(ev.signers[0].ip_address, "9.9.9.9");
  assert.deepStrictEqual(ev.signature_event_ids, ["ev1"]);
  assert.ok(!JSON.stringify(ev).includes("token"));
});

console.log(`CH-011H QA: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
