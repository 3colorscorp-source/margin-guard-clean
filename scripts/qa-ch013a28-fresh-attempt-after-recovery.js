/**
 * CH-013A.2.8 — a recovered attempt is never reused by the next Email click.
 * Run: node scripts/qa-ch013a28-fresh-attempt-after-recovery.js
 * Never calls Zapier. Never sends email.
 */
"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const Module = require("module");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const EMAIL_LIB = path.join(ROOT, "netlify/functions/_lib/contract-invitation-email.js");
const SUPABASE_ADMIN = path.join(ROOT, "netlify/functions/_lib/supabase-admin.js");
const HANDOFF_LIB = path.join(ROOT, "netlify/functions/_lib/email-delivery-handoff.js");
const INVITATION_LIB = path.join(ROOT, "netlify/functions/_lib/contract-invitation.js");
const BUS_LIB = path.join(ROOT, "netlify/functions/_lib/platform-bus.js");
const CHANNEL_LIB = path.join(ROOT, "netlify/functions/_lib/channels/email.js");
const PROVIDER_LIB = path.join(ROOT, "netlify/functions/_lib/providers/zapier-provider.js");

const TENANT = "11111111-1111-4111-8111-111111111111";
const INVITATION = "22222222-2222-4222-8222-222222222222";
const GEN_A = "33333333-3333-4333-8333-333333333333";
const GEN_B = "33333333-3333-4333-8333-333333333334";
const ATTEMPT_A = "44444444-4444-4444-8444-444444444444";
const SIGNER = "55555555-5555-4555-8555-555555555555";
const ENVELOPE = "66666666-6666-4666-8666-666666666666";
const RECIPIENT = "owner@test.example";

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function checkSyntax(rel) {
  const r = spawnSync(process.execPath, ["--check", path.join(ROOT, rel)], { encoding: "utf8" });
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || rel);
}

const emailLibSrc = read("netlify/functions/_lib/contract-invitation-email.js");
const queueSrc = read("netlify/functions/contract-invitation-email-queue.js");
const swJs = read("public/js/signature-workspace.js");
const zapierSrc = read("netlify/functions/_lib/providers/zapier-provider.js");

let passed = 0;
let failed = 0;
const pending = [];
function test(name, fn) {
  pending.push({ name, fn });
}

/**
 * In-memory stand-in for the invitation/attempt/generation tables so the real
 * queue + recovery code paths run unmodified against observable state.
 */
function makeWorld(options = {}) {
  const world = {
    attempts: [
      {
        attempt_id: ATTEMPT_A,
        tenant_id: TENANT,
        invitation_id: INVITATION,
        generation_id: GEN_A,
        provider: "zapier",
        status: options.attemptAStatus || "sending",
        provider_message_id: null,
        error_code: options.attemptAErrorCode || null,
        started_at: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
      },
    ],
    invitation: {
      id: INVITATION,
      tenant_id: TENANT,
      envelope_id: ENVELOPE,
      signer_id: SIGNER,
      status: options.invitationStatus || "sending",
      current_generation: 2,
      metadata: {},
    },
    generations: [{ id: GEN_A, generation_number: 2, status: "active", expires_at: null }],
    rotations: [],
    rotationByKey: new Map(),
    handoffs: new Map(),
    dispatches: [],
    createdAttempts: [],
    transitions: [],
    allowAbandon: options.allowAbandon !== false,
  };

  function activeGeneration() {
    return world.generations[world.generations.length - 1];
  }

  const stubs = new Map();

  stubs.set(SUPABASE_ADMIN, {
    supabaseRequest: async (pathStr, init) => {
      const p = String(pathStr);
      const method = String(init?.method || "GET").toUpperCase();
      if (p.startsWith("tenant_contract_invitation_delivery_attempts")) {
        if (method === "GET") {
          const attemptMatch = /attempt_id=eq\.([^&]+)/.exec(p);
          if (attemptMatch) {
            const id = decodeURIComponent(attemptMatch[1]);
            return world.attempts.filter((a) => a.attempt_id === id);
          }
          const genMatch = /generation_id=eq\.([^&]+)/.exec(p);
          const statusMatch = /status=in\.\(([^)]+)\)/.exec(p);
          let rows = world.attempts.filter((a) => a.invitation_id === INVITATION);
          if (genMatch) {
            const gid = decodeURIComponent(genMatch[1]);
            rows = rows.filter((a) => a.generation_id === gid);
          }
          if (statusMatch) {
            const allowed = new Set(statusMatch[1].split(","));
            rows = rows.filter((a) => allowed.has(a.status));
          }
          return rows
            .slice()
            .sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
        }
      }
      if (p.startsWith("tenant_contract_invitations")) return [world.invitation];
      if (p.startsWith("tenant_contract_signers")) {
        return [{ id: SIGNER, tenant_id: TENANT, envelope_id: ENVELOPE, email: RECIPIENT }];
      }
      if (p.startsWith("tenant_contract_envelopes")) {
        return [{ id: ENVELOPE, tenant_id: TENANT, status: "sent", expires_at: null }];
      }
      return [];
    },
  });

  const realHandoff = require(HANDOFF_LIB);
  stubs.set(HANDOFF_LIB, {
    ...realHandoff,
    handoffAvailable: () => true,
    sealDeliverySecret: ({ attemptId }) => ({ ok: true, package: { attempt_id: attemptId } }),
    persistHandoff: async (tenantId, invitationId, pkg) => {
      world.handoffs.set(pkg.attempt_id, true);
      return { ok: true, invitation: world.invitation };
    },
    peekHandoff: async (tenantId, invitationId, attemptId) => ({
      ok: true,
      present: world.handoffs.has(attemptId),
    }),
    clearHandoff: async () => ({ ok: true }),
    markHandoffConsumed: async () => ({ ok: true }),
    readAcceptance: () => null,
  });

  const realInvitation = require(INVITATION_LIB);
  stubs.set(INVITATION_LIB, {
    ...realInvitation,
    getActiveGeneration: async () => activeGeneration(),
    createDeliveryAttempt: async (invitation, fields) => {
      const attempt = {
        attempt_id: crypto.randomUUID(),
        tenant_id: TENANT,
        invitation_id: INVITATION,
        generation_id: fields.generation_id,
        provider: fields.provider || "none",
        status: "queued",
        provider_message_id: null,
        error_code: null,
        started_at: new Date().toISOString(),
      };
      world.attempts.push(attempt);
      world.createdAttempts.push(attempt.attempt_id);
      return { ok: true, attempt };
    },
    transitionDeliveryAttempt: async (tenantId, attemptId, toStatus, opts) => {
      world.transitions.push({ attemptId, toStatus });
      const row = world.attempts.find((a) => a.attempt_id === attemptId);
      if (!row) return { ok: false, error: "Attempt not found", code: "not_found" };
      if (!world.allowAbandon && toStatus === "failed") {
        return { ok: false, error: "Illegal attempt transition", code: "illegal_attempt_transition" };
      }
      row.status = toStatus;
      if (opts?.error_code) row.error_code = opts.error_code;
      return { ok: true, attempt: row };
    },
    markInvitationFailed: async () => {
      world.invitation = { ...world.invitation, status: "failed" };
      return { ok: true };
    },
    transitionInvitation: async (tenantId, invitationId, toStatus) => {
      world.invitation = { ...world.invitation, status: toStatus };
      return { ok: true, invitation: world.invitation };
    },
    resendInvitation: async (tenantId, invitationId, opts) => {
      const key = String(opts?.idempotency_key || "");
      world.rotations.push(key);
      const replay = world.rotationByKey.get(key);
      if (replay) {
        // Idempotent rotation replay: no fresh secret is minted.
        return {
          ok: true,
          invitation: world.invitation,
          generation: replay,
          attempt: null,
          rotation_idempotent: true,
          raw_token_once: null,
        };
      }
      const generation = {
        id: world.generations.length === 1 ? GEN_B : crypto.randomUUID(),
        generation_number: activeGeneration().generation_number + 1,
        status: "active",
        expires_at: null,
      };
      world.generations.push(generation);
      world.rotationByKey.set(key, generation);
      world.invitation = {
        ...world.invitation,
        status: "queued",
        current_generation: generation.generation_number,
      };
      let attempt;
      if (options.rotationReturnsOldAttempt) {
        // Production symptom under test: rotation reports the already-recovered row.
        attempt = world.attempts.find((a) => a.attempt_id === ATTEMPT_A);
      } else {
        attempt = {
          attempt_id: crypto.randomUUID(),
          tenant_id: TENANT,
          invitation_id: INVITATION,
          generation_id: generation.id,
          provider: "zapier",
          status: "queued",
          provider_message_id: null,
          error_code: null,
          started_at: new Date().toISOString(),
        };
        world.attempts.push(attempt);
        world.createdAttempts.push(attempt.attempt_id);
      }
      return {
        ok: true,
        invitation: world.invitation,
        generation,
        attempt,
        rotation_idempotent: false,
        raw_token_once: "raw-token-once",
      };
    },
  });

  stubs.set(BUS_LIB, {
    publishDomainEvent: async (event) => ({ ok: true, event }),
    beginCorrelation: () => "MG-EVT-ABCD1234",
  });
  stubs.set(CHANNEL_LIB, { deliver: async () => ({ ok: false }) });

  const realProvider = require(PROVIDER_LIB);
  stubs.set(PROVIDER_LIB, {
    ...realProvider,
    health: () => ({ available: true, reason: "" }),
    isValidEmail: () => true,
    isRecipientAllowlisted: () => true,
  });

  const originalLoad = Module._load;
  Module._load = function patched(request, parent, isMain) {
    if (parent && parent.filename === EMAIL_LIB) {
      const resolved = Module._resolveFilename(request, parent, isMain);
      if (stubs.has(resolved)) return stubs.get(resolved);
    }
    return originalLoad.apply(this, arguments);
  };
  delete require.cache[EMAIL_LIB];
  let lib;
  try {
    lib = require(EMAIL_LIB);
  } finally {
    Module._load = originalLoad;
    delete require.cache[EMAIL_LIB];
  }
  return { lib, world };
}

function queueOnce(lib) {
  return lib.queueInvitationEmail({
    tenantId: TENANT,
    envelopeId: ENVELOPE,
    signerId: SIGNER,
    publicOrigin: "https://example.invalid",
    membershipId: null,
  });
}

test("0 syntax on touched files", () => {
  [
    "netlify/functions/_lib/contract-invitation-email.js",
    "netlify/functions/contract-invitation-email-queue.js",
    "public/js/signature-workspace.js",
    "scripts/qa-ch013a28-fresh-attempt-after-recovery.js",
  ].forEach(checkSyntax);
});

test("1+2 recover stuck attempt A; A stays failed/recoverable", async () => {
  const { lib, world } = makeWorld();
  const recovered = await lib.recoverEmailDispatch({ tenantId: TENANT, attemptId: ATTEMPT_A });
  assert.strictEqual(recovered.ok, true);
  assert.strictEqual(recovered.abandoned, true);
  const rowA = world.attempts.find((a) => a.attempt_id === ATTEMPT_A);
  assert.strictEqual(rowA.status, "failed");
  assert.strictEqual(rowA.error_code, "upstream_validation_failed");
  assert.strictEqual(recovered.recoverable, true);
});

test("3+4 next queue creates attempt B and B !== A", async () => {
  const { lib, world } = makeWorld();
  await lib.recoverEmailDispatch({ tenantId: TENANT, attemptId: ATTEMPT_A });
  const queued = await queueOnce(lib);
  assert.strictEqual(queued.ok, true, queued.error);
  assert.strictEqual(queued.idempotent, false);
  assert.ok(queued.attempt_id);
  assert.notStrictEqual(queued.attempt_id, ATTEMPT_A);
  assert.ok(world.attempts.some((a) => a.attempt_id === queued.attempt_id));
  assert.strictEqual(world.attempts.find((a) => a.attempt_id === ATTEMPT_A).status, "failed");
});

test("5+6 generation increments exactly once and generation id differs", async () => {
  const { lib, world } = makeWorld();
  await lib.recoverEmailDispatch({ tenantId: TENANT, attemptId: ATTEMPT_A });
  const queued = await queueOnce(lib);
  assert.strictEqual(queued.generation_number, 3);
  assert.strictEqual(queued.generation_rotated, true);
  assert.strictEqual(world.generations.length, 2);
  assert.notStrictEqual(queued.generation_id, GEN_A);
});

test("7 rotation idempotency key is scoped past the recovered attempt", async () => {
  const { lib, world } = makeWorld();
  await lib.recoverEmailDispatch({ tenantId: TENANT, attemptId: ATTEMPT_A });
  await queueOnce(lib);
  assert.strictEqual(world.rotations.length, 1);
  assert.ok(world.rotations[0].includes(`:after:${ATTEMPT_A}`));
  assert.ok(emailLibSrc.includes("const rotationScope = lastTerminalAttemptId"));
});

test("8+9 handoff is sealed under B only; A has no handoff", async () => {
  const { lib, world } = makeWorld();
  await lib.recoverEmailDispatch({ tenantId: TENANT, attemptId: ATTEMPT_A });
  const queued = await queueOnce(lib);
  assert.strictEqual(world.handoffs.size, 1);
  assert.ok(world.handoffs.has(queued.attempt_id));
  assert.ok(!world.handoffs.has(ATTEMPT_A));
});

test("10+11 dispatch ref and response carry only the new attempt", async () => {
  const { lib } = makeWorld();
  await lib.recoverEmailDispatch({ tenantId: TENANT, attemptId: ATTEMPT_A });
  const queued = await queueOnce(lib);
  assert.ok(queued._dispatch);
  assert.strictEqual(queued._dispatch.attempt_id, queued.attempt_id);
  assert.notStrictEqual(queued._dispatch.attempt_id, ATTEMPT_A);
  assert.strictEqual(queued.ui_status, "queued");
});

test("12 reproduced bug: rotation handing back attempt A is rejected, not dispatched", async () => {
  const { lib, world } = makeWorld({ rotationReturnsOldAttempt: true });
  await lib.recoverEmailDispatch({ tenantId: TENANT, attemptId: ATTEMPT_A });
  const queued = await queueOnce(lib);
  assert.strictEqual(queued.ok, false);
  assert.strictEqual(queued.status, 500);
  assert.strictEqual(queued.code, "stale_attempt_reuse");
  assert.ok(!queued._dispatch);
  assert.ok(!queued.attempt_id);
  const rowA = world.attempts.find((a) => a.attempt_id === ATTEMPT_A);
  assert.strictEqual(rowA.status, "failed");
  assert.strictEqual(world.handoffs.has(ATTEMPT_A), false);
  assert.ok(emailLibSrc.includes("async function assertFreshQueuedAttempt("));
  assert.ok(emailLibSrc.includes("if (!freshness.ok) return freshness;"));
});

test("12b invariant rejects a reused attempt id and does not dispatch", async () => {
  const { lib, world } = makeWorld();
  await lib.recoverEmailDispatch({ tenantId: TENANT, attemptId: ATTEMPT_A });
  const priorIds = new Set(world.attempts.map((a) => a.attempt_id));
  const verdict = await lib.assertFreshQueuedAttempt({
    tenantId: TENANT,
    attempt: { attempt_id: ATTEMPT_A },
    generation: { id: GEN_A },
    priorAttemptIds: priorIds,
  });
  assert.strictEqual(verdict.ok, false);
  assert.strictEqual(verdict.code, "stale_attempt_reuse");
  assert.strictEqual(verdict.status, 500);
});

test("13+14 repeated click while B is queued returns B idempotently (no attempt C)", async () => {
  const { lib, world } = makeWorld();
  await lib.recoverEmailDispatch({ tenantId: TENANT, attemptId: ATTEMPT_A });
  const first = await queueOnce(lib);
  const second = await queueOnce(lib);
  assert.strictEqual(second.ok, true);
  assert.strictEqual(second.idempotent, true);
  assert.strictEqual(second.attempt_id, first.attempt_id);
  assert.strictEqual(world.createdAttempts.length, 1);
  assert.strictEqual(world.attempts.length, 2); // A + B only
});

test("15 same envelope and signer preserved across recovery + fresh queue", async () => {
  const { lib, world } = makeWorld();
  await lib.recoverEmailDispatch({ tenantId: TENANT, attemptId: ATTEMPT_A });
  await queueOnce(lib);
  assert.strictEqual(world.invitation.envelope_id, ENVELOPE);
  assert.strictEqual(world.invitation.signer_id, SIGNER);
  assert.ok(world.attempts.every((a) => a.invitation_id === INVITATION));
});

test("16 recovery that cannot persist the failure is reported as an error", async () => {
  const { lib, world } = makeWorld({ allowAbandon: false });
  const recovered = await lib.recoverEmailDispatch({ tenantId: TENANT, attemptId: ATTEMPT_A });
  assert.strictEqual(recovered.ok, false);
  assert.strictEqual(recovered.status, 500);
  assert.ok(
    recovered.code === "recovery_transition_failed" ||
      recovered.code === "illegal_attempt_transition"
  );
  assert.strictEqual(world.attempts.find((a) => a.attempt_id === ATTEMPT_A).status, "sending");
});

test("17 UI drops the recovered attempt id and rejects a stale queue response", () => {
  assert.ok(swJs.includes("emailRecoveredAttemptId"));
  assert.ok(swJs.includes("Email queue returned a stale delivery attempt"));
  assert.ok(swJs.includes("state.emailAttemptId = null;"));
  assert.ok(!swJs.includes("state.emailAttemptId = res.data.attempt_id || state.emailAttemptId"));
});

test("18 no Zap replay / no real webhook or email in QA", () => {
  const self = read("scripts/qa-ch013a28-fresh-attempt-after-recovery.js");
  assert.ok(!/hooks\.zapier\.com\/hooks\/catch\/(?!example)/.test(self));
  assert.ok(!/globalThis\.fetch\s*\(/.test(self));
  assert.ok(zapierSrc.includes("const message = `${String(timestampIso)}.${String(canonicalBody)}`;"));
  assert.ok(queueSrc.includes("if (queued._dispatch && !queued.idempotent)"));
});

test("19 only approved files modified", () => {
  const diff = spawnSync("git", ["diff", "--name-only"], { cwd: ROOT, encoding: "utf8" });
  assert.strictEqual(diff.status, 0, diff.stderr);
  const allowed = new Set([
    "netlify/functions/_lib/contract-invitation-email.js",
    "netlify/functions/contract-invitation-email-queue.js",
    "public/js/signature-workspace.js",
  ]);
  diff.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach((file) => assert.ok(allowed.has(file), "unexpected modified file: " + file));
});

(async () => {
  for (const { name, fn } of pending) {
    try {
      await fn();
      console.log("PASS", name);
      passed += 1;
    } catch (err) {
      console.log("FAIL", name, "-", err.message);
      failed += 1;
    }
  }
  console.log("\nCH-013A.2.8 fresh attempt after recovery:", passed, "passed,", failed, "failed");
  process.exit(failed === 0 ? 0 : 1);
})();
