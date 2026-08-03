/**
 * CH-011C — Contract Signers foundation QA (static + pure unit).
 * Run: node scripts/qa-ch011c-contract-signers.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const sqlPath = path.join(ROOT, "SUPABASE_CH011C_CONTRACT_SIGNERS.sql");
const verifyPath = path.join(ROOT, "SUPABASE_CH011C_CONTRACT_SIGNERS_VERIFY.sql");
const libPath = path.join(ROOT, "netlify/functions/_lib/contract-signer.js");
const createPath = path.join(ROOT, "netlify/functions/contract-signer-create.js");
const updatePath = path.join(ROOT, "netlify/functions/contract-signer-update.js");
const deletePath = path.join(ROOT, "netlify/functions/contract-signer-delete.js");
const listPath = path.join(ROOT, "netlify/functions/contract-signers.js");

const sqlSrc = fs.readFileSync(sqlPath, "utf8");
const verifySrc = fs.readFileSync(verifyPath, "utf8");
const libSrc = fs.readFileSync(libPath, "utf8");
const createSrc = fs.readFileSync(createPath, "utf8");
const updateSrc = fs.readFileSync(updatePath, "utf8");
const deleteSrc = fs.readFileSync(deletePath, "utf8");
const listSrc = fs.readFileSync(listPath, "utf8");

const lib = require("../netlify/functions/_lib/contract-signer");
const createMod = require("../netlify/functions/contract-signer-create");
const updateMod = require("../netlify/functions/contract-signer-update");
const deleteMod = require("../netlify/functions/contract-signer-delete");
const listMod = require("../netlify/functions/contract-signers");

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
  check(updatePath);
  check(deletePath);
  check(listPath);
});

test("1. No session", () => {
  for (const src of [createSrc, updateSrc, deleteSrc, listSrc]) {
    assert.ok(src.includes("no_session"));
  }
});

test("2-3. Seller/supervisor blocked", () => {
  for (const src of [createSrc, updateSrc, deleteSrc, listSrc]) {
    assert.ok(src.includes("owner_required"));
    assert.ok(src.includes("OWNER_ADMIN_ROLES"));
  }
});

test("4. Missing envelope", () => {
  assert.ok(libSrc.includes("Envelope not found"));
  assert.ok(libSrc.includes("not_found"));
});

test("5. Cross-tenant envelope", () => {
  assert.ok(libSrc.includes("tenant_id=eq."));
  assert.ok(createSrc.includes("tenant_id_forbidden") || createSrc.includes("tenant_id is not accepted"));
});

test("6-8. Add customer / owner / additional roles", () => {
  assert.ok(lib.SIGNER_ROLES.has("customer"));
  assert.ok(lib.SIGNER_ROLES.has("owner"));
  assert.ok(lib.SIGNER_ROLES.has("additional"));
  assert.ok(sqlSrc.includes("'owner'"));
  assert.ok(sqlSrc.includes("'customer'"));
  assert.ok(sqlSrc.includes("'additional'"));
});

test("9. Duplicate email blocked", () => {
  assert.ok(libSrc.includes("duplicate_email"));
  assert.ok(sqlSrc.includes("tenant_contract_signers_envelope_email_uidx"));
  assert.ok(sqlSrc.includes("lower(email)"));
});

test("10. Invalid email", () => {
  const bad = lib.validateSignerFields({
    role: "customer",
    party_name: "A",
    email: "not-an-email",
    phone: "",
    sign_order: 1,
    auth_method: "email_link",
    is_required: true,
  });
  assert.strictEqual(bad.code, "invalid_email");
});

test("11. Blank name", () => {
  const bad = lib.validateSignerFields({
    role: "customer",
    party_name: "   ",
    email: "a@example.com",
    phone: "",
    sign_order: 1,
    auth_method: "email_link",
    is_required: true,
  });
  assert.strictEqual(bad.code, "blank_name");
});

test("12. Invalid role", () => {
  const bad = lib.validateSignerFields({
    role: "witness",
    party_name: "A",
    email: "a@example.com",
    phone: "",
    sign_order: 1,
    auth_method: "email_link",
    is_required: true,
  });
  assert.strictEqual(bad.code, "invalid_role");
});

test("13. Invalid auth method", () => {
  const bad = lib.validateSignerFields({
    role: "customer",
    party_name: "A",
    email: "a@example.com",
    phone: "",
    sign_order: 1,
    auth_method: "sms",
    is_required: true,
  });
  assert.strictEqual(bad.code, "invalid_auth_method");
});

test("14. Invalid sign_order", () => {
  const bad = lib.validateSignerFields({
    role: "customer",
    party_name: "A",
    email: "a@example.com",
    phone: "",
    sign_order: 0,
    auth_method: "email_link",
    is_required: true,
  });
  assert.strictEqual(bad.code, "invalid_sign_order");
});

test("15. Update signer path", () => {
  assert.ok(libSrc.includes("updateSigner"));
  assert.ok(updateSrc.includes("updateSigner"));
  assert.ok(updateSrc.includes("expected_updated_at"));
});

test("16. Stale updated_at = 409", () => {
  assert.ok(libSrc.includes("stale_updated_at"));
  assert.ok(libSrc.includes("409"));
});

test("17. Delete signer path", () => {
  assert.ok(libSrc.includes("deleteSigner"));
  assert.ok(deleteSrc.includes("deleteSigner"));
  assert.ok(deleteSrc.includes("expected_updated_at"));
});

test("18. Non-draft envelope blocks create/update/delete", () => {
  assert.ok(libSrc.includes("envelope_not_draft"));
  assert.ok(libSrc.includes('!== "draft"'));
});

test("19. List order deterministic", () => {
  assert.ok(libSrc.includes("order=sign_order.asc,created_at.asc,id.asc"));
  assert.ok(listSrc.includes("listSignersForEnvelope"));
});

test("20. RLS", () => {
  assert.ok(sqlSrc.includes("enable row level security"));
  assert.ok(sqlSrc.includes("service role full access tenant_contract_signers"));
  assert.ok(sqlSrc.includes("revoke all on table public.tenant_contract_signers from anon"));
});

test("21. No envelope status mutation", () => {
  for (const src of [libSrc, createSrc, updateSrc, deleteSrc, listSrc]) {
    assert.ok(!/tenant_contract_envelopes[\s\S]{0,80}method:\s*"PATCH"/i.test(src));
    assert.ok(!/status:\s*["']sent["']/.test(src));
  }
});

test("22. No email/token/signature/PDF side effects", () => {
  for (const src of [libSrc, createSrc, updateSrc, deleteSrc, listSrc]) {
    assert.ok(!/sendgrid|resend|twilio|docusign/i.test(src));
    assert.ok(!/signed.?pdf|certificate/i.test(src));
    assert.ok(!/require\(["'].*stripe/i.test(src));
    assert.ok(!/project-payment-intent/.test(src));
    assert.ok(!/tenant_project_payments/.test(src));
    assert.ok(!/invoices\?/.test(src));
  }
});

test("Valid field happy path", () => {
  const ok = lib.validateSignerFields({
    role: "customer",
    party_name: "Customer",
    email: "Cust@Example.com",
    phone: "555",
    sign_order: 1,
    auth_method: "email_link",
    is_required: true,
  });
  assert.ok(ok.fields);
  assert.strictEqual(ok.fields.email, "cust@example.com");
  assert.strictEqual(ok.fields.role, "customer");
});

test("Handlers export + verify SQL", () => {
  assert.strictEqual(typeof createMod.handler, "function");
  assert.strictEqual(typeof updateMod.handler, "function");
  assert.strictEqual(typeof deleteMod.handler, "function");
  assert.strictEqual(typeof listMod.handler, "function");
  assert.strictEqual(lib.API_VERSION, "ch-011c-v1");
  assert.ok(fs.existsSync(verifyPath));
  assert.ok(verifySrc.includes("CH-011C VERIFY"));
});

test("Status pending only", () => {
  assert.strictEqual(lib.SIGNER_STATUSES.size, 1);
  assert.ok(lib.SIGNER_STATUSES.has("pending"));
  assert.ok(sqlSrc.includes("check (status in ('pending'))"));
});

console.log(`CH-011C QA: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
