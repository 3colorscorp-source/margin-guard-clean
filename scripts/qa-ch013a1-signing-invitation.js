/**
 * CH-013A.1 — Invitation generation + attempt hardening QA (offline).
 * Run: node scripts/qa-ch013a1-signing-invitation.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

function checkSyntax(file) {
  const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || file);
}

let passed = 0;
let failed = 0;
const pending = [];

function test(name, fn) {
  pending.push(
    (async () => {
      try {
        await fn();
        console.log("PASS", name);
        passed += 1;
      } catch (err) {
        console.log("FAIL", name, "-", err.message);
        failed += 1;
      }
    })()
  );
}

const inv = require(path.join(ROOT, "netlify/functions/_lib/contract-invitation.js"));
const events = require(path.join(ROOT, "netlify/functions/_lib/platform-events.js"));
const sql = read("SUPABASE_CH013A1_SIGNING_INVITATION.sql");
const sqlVerify = read("SUPABASE_CH013A1_SIGNING_INVITATION_VERIFY.sql");
const libSrc = read("netlify/functions/_lib/contract-invitation.js");

test("syntax", () => {
  checkSyntax(path.join(ROOT, "netlify/functions/_lib/contract-invitation.js"));
  checkSyntax(path.join(ROOT, "netlify/functions/_lib/platform-events.js"));
});

test("1 stable invitation unique (tenant, envelope, signer)", () => {
  assert.ok(sql.includes("unique (tenant_id, envelope_id, signer_id)"));
  assert.ok(sql.includes("current_generation"));
});

test("2 generations table + initial generation = 1", () => {
  assert.ok(sql.includes("tenant_contract_invitation_generations"));
  assert.ok(sql.includes("generation_number integer not null"));
  assert.ok(sql.includes("'initial_send'"));
  assert.ok(libSrc.includes("generation_number: 1"));
  assert.ok(typeof inv.createInitialGeneration === "function");
});

test("3 duplicate ordinary prepare is idempotent (unique + code path)", () => {
  assert.ok(libSrc.includes("duplicate = true"));
  assert.ok(libSrc.includes("isUniqueViolation"));
  assert.ok(libSrc.includes("skipIfDuplicate") || libSrc.includes("skipped: duplicate"));
});

test("4-6 resend creates generation N+1; revokes N; activates N+1 token", () => {
  assert.ok(libSrc.includes("resendInvitation"));
  assert.ok(libSrc.includes("prior_generation"));
  assert.ok(libSrc.includes("status: \"revoked\""));
  assert.ok(libSrc.includes("revokeSigningToken"));
  assert.ok(libSrc.includes("createSigningToken"));
  assert.ok(libSrc.includes("nextNum = priorGenNum + 1"));
  // Order: revoke prior before create new token
  const revokeIdx = libSrc.indexOf("prior.token_id");
  const createIdx = libSrc.indexOf("createSigningToken({", revokeIdx);
  assert.ok(revokeIdx > 0 && createIdx > revokeIdx, "revoke before create");
});

test("7-8 exactly one active generation + token pair", () => {
  assert.ok(sql.includes("tenant_contract_invitation_generations_one_active_idx"));
  assert.ok(sql.includes("where status = 'active'"));
  assert.ok(sql.includes("contract_invitation_generation_token_not_active"));
  assert.ok(sql.includes("token_id uuid not null"));
});

test("9-10 old token rejected / new validates (helper present)", () => {
  assert.ok(typeof inv.validateActiveGenerationToken === "function");
  assert.ok(libSrc.includes("token_generation_mismatch"));
  assert.ok(libSrc.includes("lookupSigningToken"));
});

test("11-14 attempt mutation policy", () => {
  assert.ok(sql.includes("contract_invitation_attempt_delete_forbidden"));
  assert.ok(sql.includes("contract_invitation_attempt_illegal_transition"));
  assert.ok(sql.includes("contract_invitation_attempt_terminal"));
  assert.ok(sql.includes("contract_invitation_attempt_immutable_fields"));
  assert.ok(sql.includes("protect_update"));
  assert.ok(!sql.includes("delivery_attempts is append-only"));
  assert.ok(!inv.canTransitionAttempt("sent", "failed"));
  assert.ok(!inv.canTransitionAttempt("failed", "sending"));
  assert.ok(inv.canTransitionAttempt("queued", "sending"));
  assert.ok(inv.canTransitionAttempt("sending", "sent"));
  assert.ok(inv.canTransitionAttempt("sending", "failed"));
  const bad = inv.assertAttemptTransition("sent", "failed");
  assert.ok(!bad.ok);
});

test("15 envelope deadline constrains generation/token expiration", () => {
  assert.ok(sql.includes("contract_invitation_generation_exceeds_envelope_deadline"));
  assert.ok(sql.includes("contract_invitation_generation_token_expires_mismatch"));
  const ceiling = "2099-06-01T00:00:00.000Z";
  const ok = inv.resolveGenerationExpiresAt({
    envelopeExpiresAt: ceiling,
    requestedExpiresAt: "2099-12-01T00:00:00.000Z",
    now: new Date("2026-01-01T00:00:00.000Z"),
  });
  assert.ok(ok.ok);
  assert.strictEqual(ok.expires_at, new Date(ceiling).toISOString());
  const past = inv.resolveGenerationExpiresAt({
    envelopeExpiresAt: "2020-01-01T00:00:00.000Z",
    requestedExpiresAt: null,
    now: new Date("2026-01-01T00:00:00.000Z"),
  });
  assert.ok(!past.ok);
  assert.strictEqual(past.code, "envelope_deadline_passed");
});

test("16 completed/signed invitation cannot resend", () => {
  assert.ok(!inv.canTransition("signed", "queued"));
  assert.ok(libSrc.includes("Cannot resend invitation in status"));
  assert.ok(libSrc.includes("signed_remains_signed") || libSrc.includes("TERMINAL_INVITATION"));
  assert.ok(sql.includes("contract_invitation_signed_immutable"));
});

test("17 resend event emitted once after safe create", () => {
  assert.ok(libSrc.includes('"contract.invitation.resent"'));
  assert.ok(libSrc.includes("generation_number"));
  assert.ok(libSrc.includes("prior_generation_number"));
  const resentEmit = libSrc.indexOf("contract.invitation.resent");
  const genCreate = libSrc.lastIndexOf("GENERATIONS_TABLE", resentEmit);
  assert.ok(genCreate > 0 && resentEmit > genCreate, "emit after generation create");
});

test("18 no secret/raw token in event/activity/notification payload", () => {
  const TENANT = "11111111-1111-4111-8111-111111111111";
  const bad = events.buildDomainEvent({
    tenant_id: TENANT,
    aggregate: "invitation",
    type: "contract.invitation.resent",
    payload: { token: "raw", signed_url: "https://x" },
  });
  assert.ok(!bad.ok);
  assert.ok(libSrc.includes("Never persist raw token") || libSrc.includes("never stored"));
  assert.ok(libSrc.includes("scrubForbiddenKeys"));
  assert.ok(!/raw_token_once[\s\S]{0,40}publishDomainEvent/.test(libSrc));
});

test("events describe Invitation aggregate with generation context", () => {
  assert.ok(libSrc.includes('aggregate: "invitation"'));
  assert.ok(libSrc.includes("generation_number"));
  [
    "contract.invitation.prepared",
    "contract.invitation.queued",
    "contract.invitation.sent",
    "contract.invitation.delivered",
    "contract.invitation.opened",
    "contract.invitation.failed",
    "contract.invitation.bounced",
    "contract.invitation.resent",
    "contract.invitation.revoked",
    "contract.invitation.expired",
  ].forEach((t) => assert.ok(events.DOMAIN_EVENT_TYPE_SET.has(t), t));
});

test("notifications priorities: failed/bounced critical; opened silent; prepared/queued none", () => {
  assert.ok(libSrc.includes('? "critical"'));
  assert.ok(libSrc.includes('"silent"'));
  assert.ok(libSrc.includes("skipNotify") || libSrc.includes('toStatus === "queued"'));
  assert.ok(libSrc.includes("notify: false") || libSrc.includes("notify: false,"));
});

test("activity copy includes resend / revoke / masked email / opened", () => {
  assert.ok(libSrc.includes("Owner resent signing request"));
  assert.ok(libSrc.includes("Previous secure link revoked"));
  assert.ok(libSrc.includes("Customer opened signing request"));
  assert.ok(libSrc.includes("maskEmail"));
  assert.ok(libSrc.includes("Delivery failed"));
});

test("VERIFY SQL covers generations + attempt terminal/delete/immutable", () => {
  assert.ok(sqlVerify.includes("two active generations"));
  assert.ok(sqlVerify.includes("terminal attempt"));
  assert.ok(sqlVerify.includes("attempt DELETE"));
  assert.ok(sqlVerify.includes("signed_immutable"));
  assert.ok(sqlVerify.includes("rollback"));
});

test("no wire-up into envelope-send / freeze / sign / cert / PDF", () => {
  [
    "netlify/functions/contract-envelope-send.js",
    "netlify/functions/_lib/contract-envelope-send.js",
    "netlify/functions/contract-package-freeze.js",
    "netlify/functions/contract-sign.js",
    "netlify/functions/contract-certificates.js",
  ].forEach((rel) => {
    if (!exists(rel)) return;
    const src = read(rel);
    assert.ok(!src.includes("contract-invitation") && !src.includes("prepareInvitation"));
  });
});

test("chosen attempt model documented: controlled UPDATE not full append-only", () => {
  assert.ok(sql.includes("Controlled status transitions only") || sql.includes("controlled status"));
  assert.ok(sql.includes("DELETE forbidden"));
  assert.ok(typeof inv.transitionDeliveryAttempt === "function");
});

(async () => {
  await Promise.all(pending);
  console.log("");
  // Run required regressions
  const regs = [
    ["CH-013A.0", "scripts/qa-ch013a0-platform-fabric.js"],
    ["CH-011D", "scripts/qa-ch011d-signing-tokens.js"],
    ["CH-011E", "scripts/qa-ch011e-envelope-send.js"],
  ];
  for (const [label, rel] of regs) {
    const r = spawnSync(process.execPath, [path.join(ROOT, rel)], {
      encoding: "utf8",
      cwd: ROOT,
    });
    const ok = r.status === 0;
    console.log(ok ? "PASS" : "FAIL", `regression ${label}`);
    if (!ok) {
      failed += 1;
      console.log((r.stdout || r.stderr || "").split(/\r?\n/).slice(-8).join("\n"));
    } else {
      passed += 1;
    }
  }

  console.log("");
  console.log(`CH-013A.1 hardening QA: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
