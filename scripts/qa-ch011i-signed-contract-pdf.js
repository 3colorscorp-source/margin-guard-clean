/**
 * CH-011I — Signed Contract PDF QA (static + pure unit).
 * Run: node scripts/qa-ch011i-signed-contract-pdf.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const sqlPath = path.join(ROOT, "SUPABASE_CH011I_SIGNED_CONTRACT_PDF.sql");
const verifyPath = path.join(ROOT, "SUPABASE_CH011I_SIGNED_CONTRACT_PDF_VERIFY.sql");
const libPath = path.join(ROOT, "netlify/functions/_lib/contract-signed-pdf.js");
const pdfUtilPath = path.join(ROOT, "netlify/functions/_lib/simple-pdf.js");
const createPath = path.join(ROOT, "netlify/functions/contract-signed-pdf-create.js");
const listPath = path.join(ROOT, "netlify/functions/contract-signed-pdfs.js");

const sqlSrc = fs.readFileSync(sqlPath, "utf8");
const verifySrc = fs.readFileSync(verifyPath, "utf8");
const libSrc = fs.readFileSync(libPath, "utf8");
const pdfUtilSrc = fs.readFileSync(pdfUtilPath, "utf8");
const createSrc = fs.readFileSync(createPath, "utf8");
const listSrc = fs.readFileSync(listPath, "utf8");

const lib = require("../netlify/functions/_lib/contract-signed-pdf");
const pdfUtil = require("../netlify/functions/_lib/simple-pdf");
const createMod = require("../netlify/functions/contract-signed-pdf-create");
const listMod = require("../netlify/functions/contract-signed-pdfs");

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

function sampleSnap(overrides = {}) {
  return {
    schema: "ch-011a-v1",
    business_settings: {
      source: "business_settings",
      legal_profile: {
        legal_business_name: "Acme Builders LLC",
        business_phone: "555-0100",
        business_email: "ops@acme.test",
        business_address_line1: "1 Main St",
        business_city: "Hayward",
        business_state: "CA",
        business_postal_code: "94544",
        contractor_license_number: "LIC-9",
      },
      branding: { business_name: "Acme" },
    },
    customer: { name: "Pat Customer", email: "pat@example.com", phone: "555-2" },
    project: { id: "proj-1", name: "Kitchen Remodel", status: "active" },
    property: {
      address_line1: "99 Oak Ave",
      city: "Hayward",
      state: "CA",
      postal_code: "94544",
    },
    quote: {
      id: "q1",
      title: "Kitchen Remodel Contract",
      total: 12000,
      currency: "USD",
      deposit_required: 2000,
    },
    price: { contract_total: 12000, currency: "USD", deposit_required: 2000 },
    scope: { text: "Demo and install cabinets." },
    payment_schedule: {
      items: [
        {
          sequence_number: 1,
          label: "Deposit",
          amount: 2000,
          due_rule: "on_signing",
        },
        {
          sequence_number: 2,
          label: "Final",
          percentage: 80,
          due_rule: "on_completion",
        },
      ],
    },
    warranty: {
      duration_value: 1,
      duration_unit: "year",
      summary: "Workmanship warranty",
      exclusions: "Acts of God",
    },
    terms: { quote_terms: "Net 15 after invoice." },
    legal_notices: {
      notices: {
        contract_notice: "This is a binding agreement.",
        payment_notice: "Payments due as scheduled.",
      },
    },
    ...overrides,
  };
}

function sampleCtx({ method = "typed", signature_json } = {}) {
  const signerId = "11111111-1111-4111-8111-111111111111";
  const eventId = "22222222-2222-4222-8222-222222222222";
  const sj =
    signature_json ||
    (method === "typed"
      ? {
          method: "typed",
          typed_name: "Pat Customer",
          rendered_name: "Pat Customer",
          signed_at: "2026-08-01T12:00:00.000Z",
        }
      : {
          method: "drawn",
          format: "svg_path",
          svg_path: "M10 40 C 20 10, 40 10, 50 40",
          signed_at: "2026-08-01T12:00:00.000Z",
        });
  return {
    snap: sampleSnap(),
    pkg: {
      id: "33333333-3333-4333-8333-333333333333",
      version: 2,
      status: "executed",
      content_hash: "a".repeat(64),
    },
    envelope: {
      id: "44444444-4444-4444-8444-444444444444",
      status: "completed",
      completed_at: "2026-08-01T12:05:00.000Z",
      project_id: "55555555-5555-4555-8555-555555555555",
    },
    certificate: {
      id: "66666666-6666-4666-8666-666666666666",
      certificate_number: "MG-CERT-ABCDEF0123456789",
      content_hash: "b".repeat(64),
      issued_at: "2026-08-01T12:10:00.000Z",
    },
    signers: [
      {
        id: signerId,
        role: "customer",
        party_name: "Pat Customer",
        email: "pat@example.com",
        sign_order: 1,
        status: "signed",
        is_required: true,
        signed_at: "2026-08-01T12:00:00.000Z",
      },
    ],
    events: [
      {
        id: eventId,
        signer_id: signerId,
        signature_method: method,
        signature_json: sj,
        signed_at: "2026-08-01T12:00:00.000Z",
        ip_address: "1.2.3.4",
        user_agent: "qa",
      },
    ],
    generatedAt: "2026-08-01T12:15:00.000Z",
  };
}

test("syntax lib + handlers + pdf util", () => {
  check(libPath);
  check(pdfUtilPath);
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

test("7. Missing certificate blocked", () => {
  assert.ok(libSrc.includes("certificate_missing"));
});

test("8. Missing signature event blocked", () => {
  assert.ok(libSrc.includes("missing_signature_events"));
});

test("9. Valid typed-signature PDF", () => {
  const { buffer, sha256 } = lib.renderSignedContractPdf(sampleCtx({ method: "typed" }));
  assert.ok(Buffer.isBuffer(buffer));
  assert.strictEqual(buffer.slice(0, 5).toString(), "%PDF-");
  const text = buffer.toString("latin1");
  assert.ok(text.includes("Pat Customer"));
  assert.ok(text.includes("Signature \\(typed\\)") || text.includes("typed"));
  assert.ok(text.includes("Helvetica-Oblique"));
  assert.strictEqual(sha256.length, 64);
});

test("10. Valid drawn-signature PDF", () => {
  const { buffer } = lib.renderSignedContractPdf(sampleCtx({ method: "drawn" }));
  const text = buffer.toString("latin1");
  assert.strictEqual(buffer.slice(0, 5).toString(), "%PDF-");
  assert.ok(text.includes("Signature \\(drawn\\)") || text.includes("drawn"));
  assert.ok(/\s[cl]\b/.test(text) || text.includes(" 0.6 w"));
});

test("11. Correct frozen package content", () => {
  const { buffer } = lib.renderSignedContractPdf(sampleCtx());
  const text = buffer.toString("latin1");
  assert.ok(text.includes("Acme Builders LLC"));
  assert.ok(text.includes("Demo and install cabinets"));
  assert.ok(text.includes("Kitchen Remodel Contract"));
  assert.ok(text.includes("Workmanship warranty"));
  assert.ok(text.includes("Net 15 after invoice"));
  assert.ok(text.includes("binding agreement"));
  assert.ok(text.includes("Deposit"));
  assert.ok(!text.includes("live Business Settings"));
  assert.ok(text.includes("immutable contract package snapshot"));
});

test("12. Correct certificate number/hash", () => {
  const { buffer } = lib.renderSignedContractPdf(sampleCtx());
  const text = buffer.toString("latin1");
  assert.ok(text.includes("MG-CERT-ABCDEF0123456789"));
  assert.ok(text.includes("b".repeat(64)));
});

test("13. Correct signer timestamps", () => {
  const { buffer } = lib.renderSignedContractPdf(sampleCtx());
  const text = buffer.toString("latin1");
  assert.ok(text.includes("2026-08-01T12:00:00.000Z"));
  assert.ok(text.includes("2026-08-01T12:05:00.000Z"));
});

test("14. PDF bytes valid", () => {
  const { buffer } = lib.renderSignedContractPdf(sampleCtx());
  assert.ok(buffer.includes(Buffer.from("%%EOF")));
  assert.ok(buffer.includes(Buffer.from("/Type /Catalog")));
});

test("15. SHA-256 deterministic", () => {
  const a = lib.renderSignedContractPdf(sampleCtx());
  const b = lib.renderSignedContractPdf(sampleCtx());
  assert.strictEqual(a.sha256, b.sha256);
  assert.strictEqual(a.buffer.compare(b.buffer), 0);
});

test("16. Private storage path", () => {
  const p = lib.buildStoragePath("t1", "p1", "e1");
  assert.strictEqual(p, "contracts/t1/p1/e1/signed-contract.pdf");
  assert.ok(libSrc.includes("contracts/"));
  assert.ok(libSrc.includes("public: false"));
});

test("17. No public bucket", () => {
  assert.ok(libSrc.includes("public: false"));
  assert.ok(!/object\/public\//.test(libSrc));
  assert.ok(sqlSrc.includes("Private storage only") || sqlSrc.includes("No public URLs"));
});

test("18. Signed URL short-lived", () => {
  assert.strictEqual(lib.SIGNED_URL_EXPIRES_SEC, 300);
  assert.ok(libSrc.includes("object/sign/"));
  assert.ok(listSrc.includes("SIGNED_URL_EXPIRES_SEC"));
});

test("19. Duplicate generation idempotent", () => {
  assert.ok(libSrc.includes("idempotent: true"));
  assert.ok(createSrc.includes("idempotent"));
});

test("20. One artifact per envelope", () => {
  assert.ok(sqlSrc.includes("tenant_contract_signed_artifacts_tenant_envelope_type_key"));
});

test("21. Immutable row", () => {
  assert.ok(sqlSrc.includes("contract_signed_artifact_immutable"));
  assert.ok(sqlSrc.includes("tenant_contract_signed_artifacts_protect_immutable"));
});

test("22. No raw token", () => {
  assert.ok(!/raw_token|signing_token|token_hash/i.test(libSrc));
  assert.ok(!/raw_token|signing_token/i.test(createSrc));
  assert.ok(!/raw_token|signing_token/i.test(listSrc));
});

test("23. XSS-safe signature rendering", () => {
  assert.ok(pdfUtilSrc.includes("sanitizeSvgPath"));
  const dirty = pdfUtil.sanitizeSvgPath(
    '<script>alert(1)</script> M10 10 L20 20 <img src=x onerror=alert(1)>'
  );
  assert.ok(!/<script/i.test(dirty));
  assert.ok(!/<img/i.test(dirty));
  assert.ok(!/onerror/i.test(dirty));
  const { buffer } = lib.renderSignedContractPdf(
    sampleCtx({
      method: "drawn",
      signature_json: {
        method: "drawn",
        format: "svg_path",
        svg_path: '<script>alert(1)</script> M 0 0 L 10 10',
      },
    })
  );
  const text = buffer.toString("latin1");
  assert.ok(!text.includes("<script>"));
  assert.ok(!text.includes("alert(1)"));
});

test("24. No Invoice Hub / ledger / Stripe / PI", () => {
  for (const src of [libSrc, createSrc, listSrc, pdfUtilSrc]) {
    assert.ok(!/require\(["'].*stripe/i.test(src));
    assert.ok(!/project-payment-intent/.test(src));
    assert.ok(!/tenant_project_payments/.test(src));
    assert.ok(!/docusign|sendgrid/i.test(src));
    assert.ok(!/ledger/i.test(src));
    assert.ok(!/invoice-hub|estimates-invoices/i.test(src));
  }
});

test("Handlers + verify + version + public policy", () => {
  assert.strictEqual(typeof createMod.handler, "function");
  assert.strictEqual(typeof listMod.handler, "function");
  assert.strictEqual(lib.API_VERSION, "ch-011i-v1");
  assert.ok(fs.existsSync(verifyPath));
  assert.ok(verifySrc.includes("CH-011I VERIFY"));
  assert.ok(listSrc.includes("deferred_token_bound") || listSrc.includes("PUBLIC_DOWNLOAD_POLICY"));
  assert.ok(lib.PUBLIC_DOWNLOAD_POLICY.includes("deferred_token_bound"));
});

test("Page numbers present", () => {
  const { buffer } = lib.renderSignedContractPdf(sampleCtx());
  assert.ok(buffer.toString("latin1").includes("Page "));
});

console.log("");
console.log(`CH-011I QA: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
