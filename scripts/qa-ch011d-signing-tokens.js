/**
 * CH-011D — Signing Tokens foundation QA (static + pure unit).
 * Run: node scripts/qa-ch011d-signing-tokens.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const sqlPath = path.join(ROOT, "SUPABASE_CH011D_SIGNING_TOKENS.sql");
const verifyPath = path.join(ROOT, "SUPABASE_CH011D_SIGNING_TOKENS_VERIFY.sql");
const libPath = path.join(ROOT, "netlify/functions/_lib/contract-signing-token.js");
const createPath = path.join(ROOT, "netlify/functions/contract-signing-token-create.js");
const lookupPath = path.join(ROOT, "netlify/functions/contract-signing-token.js");
const revokePath = path.join(ROOT, "netlify/functions/contract-signing-token-revoke.js");

const sqlSrc = fs.readFileSync(sqlPath, "utf8");
const verifySrc = fs.readFileSync(verifyPath, "utf8");
const libSrc = fs.readFileSync(libPath, "utf8");
const createSrc = fs.readFileSync(createPath, "utf8");
const lookupSrc = fs.readFileSync(lookupPath, "utf8");
const revokeSrc = fs.readFileSync(revokePath, "utf8");

const lib = require("../netlify/functions/_lib/contract-signing-token");
const createMod = require("../netlify/functions/contract-signing-token-create");
const lookupMod = require("../netlify/functions/contract-signing-token");
const revokeMod = require("../netlify/functions/contract-signing-token-revoke");

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
  check(lookupPath);
  check(revokePath);
});

test("1. Create/revoke require session", () => {
  for (const src of [createSrc, revokeSrc]) {
    assert.ok(src.includes("no_session"));
    assert.ok(src.includes("owner_required"));
    assert.ok(src.includes("OWNER_ADMIN_ROLES"));
  }
});

test("2. Table + required columns", () => {
  assert.ok(sqlSrc.includes("create table if not exists public.tenant_contract_signing_tokens"));
  for (const col of [
    "id",
    "tenant_id",
    "envelope_id",
    "signer_id",
    "token_hash",
    "status",
    "expires_at",
    "consumed_at",
    "revoked_at",
    "created_at",
    "updated_at",
  ]) {
    assert.ok(sqlSrc.includes(col), `missing column ${col}`);
  }
});

test("3. Hash-only storage (SHA-256)", () => {
  assert.ok(sqlSrc.includes("token_hash text not null"));
  assert.ok(sqlSrc.includes("^[a-f0-9]{64}$"));
  assert.ok(libSrc.includes("createHash(\"sha256\")") || libSrc.includes("createHash('sha256')"));
  assert.ok(libSrc.includes("hashRawToken"));
  assert.ok(!sqlSrc.includes("raw_token"));
  assert.ok(!/token_plain|plaintext_token/i.test(sqlSrc));
});

test("4. One active token per signer + regeneration", () => {
  assert.ok(sqlSrc.includes("tenant_contract_signing_tokens_one_active_per_signer_uidx"));
  assert.ok(sqlSrc.includes("where status = 'active'"));
  assert.ok(verifySrc.includes("regeneration after revoke"));
  assert.ok(libSrc.includes("active_token_exists"));
});

test("5. RLS service_role only", () => {
  assert.ok(sqlSrc.includes("enable row level security"));
  assert.ok(sqlSrc.includes("service role full access tenant_contract_signing_tokens"));
  assert.ok(sqlSrc.includes("revoke all on table public.tenant_contract_signing_tokens from anon"));
  assert.ok(sqlSrc.includes("revoke all on table public.tenant_contract_signing_tokens from authenticated"));
  assert.ok(sqlSrc.includes("grant all on table public.tenant_contract_signing_tokens to service_role"));
});

test("6. Immutable hash / refs / created_at", () => {
  assert.ok(sqlSrc.includes("signing_token_hash_immutable"));
  assert.ok(sqlSrc.includes("signing_token_refs_immutable"));
  assert.ok(sqlSrc.includes("signing_token_created_at_immutable"));
  assert.ok(sqlSrc.includes("tenant_contract_signing_tokens_protect_immutable"));
});

test("7. Multitenant FKs", () => {
  assert.ok(sqlSrc.includes("tenant_contract_signing_tokens_envelope_fk"));
  assert.ok(sqlSrc.includes("tenant_contract_signing_tokens_signer_fk"));
  assert.ok(sqlSrc.includes("unique (tenant_id, id)"));
});

test("8. Statuses include active/revoked/consumed/expired", () => {
  assert.ok(lib.TOKEN_STATUSES.has("active"));
  assert.ok(lib.TOKEN_STATUSES.has("revoked"));
  assert.ok(lib.TOKEN_STATUSES.has("consumed"));
  assert.ok(lib.TOKEN_STATUSES.has("expired"));
  assert.ok(sqlSrc.includes("'active', 'revoked', 'consumed', 'expired'"));
});

test("9. Create returns raw once; client cannot supply hash", () => {
  assert.ok(createSrc.includes("includeRaw") || libSrc.includes("includeRaw: true"));
  assert.ok(createSrc.includes("token_hash_forbidden"));
  assert.ok(createSrc.includes("token_forbidden"));
  assert.ok(libSrc.includes("serializeToken(inserted, { includeRaw: true, rawToken })"));
});

test("10. Lookup validates expired/revoked/consumed", () => {
  assert.ok(libSrc.includes("evaluateTokenValidity"));
  assert.ok(lookupSrc.includes("lookupSigningToken"));
  const revoked = lib.evaluateTokenValidity({
    id: "x",
    status: "revoked",
    expires_at: new Date(Date.now() + 86400000).toISOString(),
  });
  assert.strictEqual(revoked.code, "revoked");
  const consumed = lib.evaluateTokenValidity({
    id: "x",
    status: "consumed",
    expires_at: new Date(Date.now() + 86400000).toISOString(),
  });
  assert.strictEqual(consumed.code, "consumed");
  const expiredStatus = lib.evaluateTokenValidity({
    id: "x",
    status: "expired",
    expires_at: new Date(Date.now() + 86400000).toISOString(),
  });
  assert.strictEqual(expiredStatus.code, "expired");
  const expiredByTime = lib.evaluateTokenValidity({
    id: "x",
    status: "active",
    expires_at: new Date(Date.now() - 1000).toISOString(),
  });
  assert.strictEqual(expiredByTime.code, "expired");
  const valid = lib.evaluateTokenValidity({
    id: "x",
    status: "active",
    expires_at: new Date(Date.now() + 86400000).toISOString(),
  });
  assert.ok(valid.ok);
});

test("11. Revoke marks revoked; no delete", () => {
  assert.ok(libSrc.includes('status: "revoked"'));
  assert.ok(libSrc.includes("revoked_at"));
  assert.ok(revokeSrc.includes("revokeSigningToken"));
  assert.ok(!/method:\s*"DELETE"/i.test(libSrc));
  assert.ok(!/method:\s*"DELETE"/i.test(revokeSrc));
});

test("12. Crypto generate + hash roundtrip shape", () => {
  const raw = lib.generateRawToken();
  assert.ok(raw.length >= 32);
  const hash = lib.hashRawToken(raw);
  assert.strictEqual(hash.length, 64);
  assert.ok(/^[a-f0-9]{64}$/.test(hash));
  assert.strictEqual(lib.hashRawToken(raw), hash);
  assert.notStrictEqual(lib.hashRawToken(raw + "x"), hash);
});

test("13. Serialize never exposes token_hash", () => {
  const row = {
    id: "11111111-1111-4111-8111-111111111111",
    tenant_id: "22222222-2222-4222-8222-222222222222",
    envelope_id: "33333333-3333-4333-8333-333333333333",
    signer_id: "44444444-4444-4444-8444-444444444444",
    token_hash: "a".repeat(64),
    status: "active",
    expires_at: "2099-01-01T00:00:00.000Z",
    consumed_at: null,
    revoked_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
  const ser = lib.serializeToken(row);
  assert.ok(ser);
  assert.strictEqual(ser.token_hash, undefined);
  assert.strictEqual(ser.token, undefined);
  const once = lib.serializeToken(row, { includeRaw: true, rawToken: "SECRET" });
  assert.strictEqual(once.token, "SECRET");
  assert.strictEqual(once.token_hash, undefined);
});

test("14. No UI / email / PDF / DocuSign / send pipeline", () => {
  for (const src of [libSrc, createSrc, lookupSrc, revokeSrc]) {
    assert.ok(!/sendgrid|resend|twilio|docusign/i.test(src));
    assert.ok(!/signed.?pdf|certificate/i.test(src));
    assert.ok(!/require\(["'].*stripe/i.test(src));
    assert.ok(!/project-payment-intent/.test(src));
    assert.ok(!/public.?contract/i.test(src));
    assert.ok(!/captureSignature|signature_pad|draw.?signature/i.test(src));
  }
});

test("15. Provider-agnostic (no DocuSign coupling)", () => {
  assert.ok(!/docusign/i.test(sqlSrc));
  assert.ok(!/hellosign|adobe.?sign/i.test(sqlSrc));
  assert.ok(!/docusign/i.test(libSrc));
});

test("Handlers export + verify SQL + API version", () => {
  assert.strictEqual(typeof createMod.handler, "function");
  assert.strictEqual(typeof lookupMod.handler, "function");
  assert.strictEqual(typeof revokeMod.handler, "function");
  assert.strictEqual(lib.API_VERSION, "ch-011d-v1");
  assert.ok(fs.existsSync(verifyPath));
  assert.ok(verifySrc.includes("CH-011D VERIFY"));
  assert.ok(verifySrc.includes("one active token per signer"));
  assert.ok(verifySrc.includes("token_hash immutable"));
});

console.log(`CH-011D QA: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
