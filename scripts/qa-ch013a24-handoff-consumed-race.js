/**
 * CH-013A.2.4 — handoff consumed / duplicate dispatch race.
 * Proves a missing handoff is terminal only while the attempt is still queued.
 * Run: node scripts/qa-ch013a24-handoff-consumed-race.js
 * Never calls a real Zapier webhook. Never sends email.
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Module = require("module");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function checkSyntax(rel) {
  const r = spawnSync(process.execPath, ["--check", path.join(ROOT, rel)], {
    encoding: "utf8",
  });
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || rel);
}

let passed = 0;
let failed = 0;
const pending = [];

function test(name, fn) {
  pending.push({ name, fn });
}

const emailLibSrc = read("netlify/functions/_lib/contract-invitation-email.js");
const queueSrc = read("netlify/functions/contract-invitation-email-queue.js");
const handoffSrc = read("netlify/functions/_lib/email-delivery-handoff.js");
const callbackSrc = read("netlify/functions/contract-invitation-email-zapier-callback.js");
const zapierSrc = read("netlify/functions/_lib/providers/zapier-provider.js");
const docsSrc = read("docs/CH-013A21Z-ZAPIER-CONTRACT-EMAIL.md");

const EMAIL_LIB = path.join(ROOT, "netlify/functions/_lib/contract-invitation-email.js");
const SUPABASE_ADMIN = path.join(ROOT, "netlify/functions/_lib/supabase-admin.js");
const HANDOFF_LIB = path.join(ROOT, "netlify/functions/_lib/email-delivery-handoff.js");
const INVITATION_LIB = path.join(ROOT, "netlify/functions/_lib/contract-invitation.js");
const CHANNEL_LIB = path.join(ROOT, "netlify/functions/_lib/channels/email.js");
const BUS_LIB = path.join(ROOT, "netlify/functions/_lib/platform-bus.js");

const TENANT = "11111111-1111-4111-8111-111111111111";
const INVITATION = "22222222-2222-4222-8222-222222222222";
const GENERATION = "33333333-3333-4333-8333-333333333333";
const ATTEMPT = "44444444-4444-4444-8444-444444444444";
const SIGNER = "55555555-5555-4555-8555-555555555555";
const ENVELOPE = "66666666-6666-4666-8666-666666666666";

/**
 * Load contract-invitation-email.js with stubbed collaborators so no network,
 * database, provider webhook, or email send can occur.
 */
function loadEmailLibWithStubs(overrides) {
  const calls = {
    attemptTransitions: [],
    invitationFailed: [],
    events: [],
    handoffPeeks: [],
    providerSends: 0,
  };

  const state = {
    attempt: overrides.attempt,
    invitation: overrides.invitation || {
      id: INVITATION,
      tenant_id: TENANT,
      signer_id: SIGNER,
      envelope_id: ENVELOPE,
      project_id: null,
      quote_id: null,
      package_id: null,
      status: "sending",
      metadata: overrides.metadata || {},
    },
    handoffOpen: overrides.handoffOpen,
    handoffPresent: overrides.handoffPresent === true,
  };

  const stubs = new Map();

  stubs.set(SUPABASE_ADMIN, {
    supabaseRequest: async (pathStr) => {
      const p = String(pathStr);
      if (p.startsWith("tenant_contract_invitation_delivery_attempts")) {
        return [state.attempt];
      }
      if (p.startsWith("tenant_contract_invitations")) {
        return [state.invitation];
      }
      if (p.startsWith("tenant_contract_signers")) {
        return [{ id: SIGNER, tenant_id: TENANT, envelope_id: ENVELOPE, email: "owner@test.example", party_name: "Owner" }];
      }
      if (p.startsWith("tenant_contract_envelopes")) {
        return [{ id: ENVELOPE, tenant_id: TENANT, status: "sent", package_id: null, project_id: null, quote_id: null }];
      }
      if (p.startsWith("tenant_projects")) return [];
      return [];
    },
  });

  const realHandoff = require(HANDOFF_LIB);
  stubs.set(HANDOFF_LIB, {
    ...realHandoff,
    handoffAvailable: () => true,
    openHandoffWithoutConsume: async () => state.handoffOpen,
    peekHandoff: async () => {
      calls.handoffPeeks.push(true);
      return { ok: true, present: state.handoffPresent };
    },
    clearHandoff: async () => ({ ok: true }),
    markHandoffConsumed: async () => ({ ok: true }),
    persistProviderAcceptance: async () => ({ ok: true }),
    markAcceptanceFinalized: async () => ({ ok: true }),
  });

  const realInvitation = require(INVITATION_LIB);
  stubs.set(INVITATION_LIB, {
    ...realInvitation,
    getActiveGeneration: async () => ({
      id: GENERATION,
      generation_number: 1,
      expires_at: new Date(Date.now() + 3600000).toISOString(),
    }),
    transitionDeliveryAttempt: async (tenantId, attemptId, toStatus, options) => {
      calls.attemptTransitions.push({ attemptId, toStatus, options: options || {} });
      state.attempt = { ...state.attempt, status: toStatus };
      return { ok: true, attempt: state.attempt };
    },
    markInvitationSending: async () => ({ ok: true }),
    markInvitationSent: async () => ({ ok: true }),
    markInvitationFailed: async (tenantId, invitationId, options) => {
      calls.invitationFailed.push({ invitationId, options: options || {} });
      return { ok: true };
    },
    transitionInvitation: async () => ({ ok: true }),
  });

  stubs.set(BUS_LIB, {
    publishDomainEvent: async (event) => {
      calls.events.push(String(event?.type || ""));
      return { ok: true, event: { ...event, event_id: ATTEMPT } };
    },
    beginCorrelation: () => "MG-EVT-ABCD1234",
  });

  stubs.set(CHANNEL_LIB, {
    deliver: async () => {
      calls.providerSends += 1;
      return {
        ok: true,
        accepted: false,
        awaiting_callback: true,
        code: "awaiting_zapier_callback",
      };
    },
  });

  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
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
  return { lib, calls, state };
}

function baseAttempt(status, extra) {
  return {
    attempt_id: ATTEMPT,
    tenant_id: TENANT,
    invitation_id: INVITATION,
    generation_id: GENERATION,
    provider: "zapier",
    status,
    started_at: new Date().toISOString(),
    provider_message_id: null,
    ...(extra || {}),
  };
}

const ALLOW_ENV = {
  CONTRACT_EMAIL_DELIVERY_ENABLED: "true",
  CONTRACT_EMAIL_ZAPIER_WEBHOOK_URL: "https://hooks.zapier.com/hooks/catch/example/test",
  CONTRACT_EMAIL_ZAPIER_HMAC_SECRET: "test-hmac-secret-value",
  CONTRACT_EMAIL_INTERNAL_ALLOWLIST: "owner@test.example",
  CONTRACT_EMAIL_HANDOFF_KEY: "a".repeat(64),
};

async function withEnv(fn) {
  const prev = {};
  for (const [k, v] of Object.entries(ALLOW_ENV)) {
    prev[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function dispatchWith(attemptStatus, handoffOpen, extraAttempt) {
  return withEnv(async () => {
    const { lib, calls } = loadEmailLibWithStubs({
      attempt: baseAttempt(attemptStatus, extraAttempt),
      handoffOpen,
    });
    const result = await lib.dispatchInvitationEmail({
      tenant_id: TENANT,
      attempt_id: ATTEMPT,
      invitation_id: INVITATION,
      correlation_id: null,
    });
    return { result, calls };
  });
}

const MISSING = { ok: false, code: "handoff_missing", error: "handoff package missing" };
const EXPIRED = { ok: false, code: "handoff_expired", error: "handoff expired" };
const DECRYPT_FAILED = { ok: false, code: "handoff_decrypt_failed", error: "handoff decrypt failed" };
const VALID = { ok: true, raw_token_once: "test-secret-value", key_version: 1 };

test("0 syntax on touched JavaScript files", () => {
  [
    "netlify/functions/_lib/contract-invitation-email.js",
    "netlify/functions/contract-invitation-email-queue.js",
    "netlify/functions/contract-invitation-email-zapier-callback.js",
    "scripts/qa-ch013a24-handoff-consumed-race.js",
  ].forEach(checkSyntax);
});

test("1 queued + valid handoff → dispatch proceeds to provider", async () => {
  const { result, calls } = await dispatchWith("queued", VALID);
  assert.strictEqual(calls.providerSends, 1, "provider must be invoked");
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.awaiting_callback, true);
  assert.strictEqual(result.code, "awaiting_zapier_callback");
  assert.ok(!calls.attemptTransitions.some((t) => t.toStatus === "failed"));
});

test("2 queued + missing handoff → failed with handoff_missing", async () => {
  const { result, calls } = await dispatchWith("queued", MISSING);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, "handoff_missing");
  const failure = calls.attemptTransitions.find((t) => t.toStatus === "failed");
  assert.ok(failure, "attempt must be marked failed");
  assert.strictEqual(failure.options.error_code, "handoff_missing");
  assert.strictEqual(calls.invitationFailed.length, 1);
  assert.ok(calls.events.includes("delivery.channel.failed"));
  assert.strictEqual(calls.providerSends, 0, "no provider send on true failure");
});

test("3 queued + expired handoff → failed with handoff_expired", async () => {
  const { result, calls } = await dispatchWith("queued", EXPIRED);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, "handoff_expired");
  const failure = calls.attemptTransitions.find((t) => t.toStatus === "failed");
  assert.ok(failure);
  assert.strictEqual(failure.options.error_code, "handoff_expired");
});

test("4+5 sending + missing handoff → not failed, stays in flight", async () => {
  const { result, calls } = await dispatchWith("sending", MISSING);
  assert.strictEqual(result.ok, true, "must not report failure");
  assert.strictEqual(result.awaiting_callback, true);
  assert.strictEqual(result.code, "handoff_already_consumed");
  assert.strictEqual(result.handoff_code, "handoff_missing");
  assert.strictEqual(result.provider_message_id, null, "must not claim sent");
  assert.ok(
    !calls.attemptTransitions.some((t) => t.toStatus === "failed"),
    "attempt must remain sending"
  );
});

test("6 sending + missing handoff → no markInvitationFailed", async () => {
  const { calls } = await dispatchWith("sending", MISSING);
  assert.strictEqual(calls.invitationFailed.length, 0);
});

test("7 sending + missing handoff → no delivery.channel.failed event", async () => {
  const { calls } = await dispatchWith("sending", MISSING);
  assert.ok(!calls.events.includes("delivery.channel.failed"));
});

test("7b sending + expired handoff → preserved in flight", async () => {
  const { result, calls } = await dispatchWith("sending", EXPIRED);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.code, "handoff_already_consumed");
  assert.strictEqual(result.handoff_code, "handoff_expired");
  assert.ok(!calls.attemptTransitions.some((t) => t.toStatus === "failed"));
  assert.strictEqual(calls.invitationFailed.length, 0);
});

test("8 duplicate late dispatch after consume is harmless (no second send)", async () => {
  const { result, calls } = await dispatchWith("sending", MISSING);
  assert.strictEqual(calls.providerSends, 0, "must not re-send to Zapier");
  assert.strictEqual(result.idempotent, true);
  assert.strictEqual(calls.attemptTransitions.length, 0);
});

test("8b sending + consumed handoff after acceptance → idempotent sent, no re-send", async () => {
  const { result, calls } = await withEnv(async () => {
    const { lib, calls: c } = loadEmailLibWithStubs({
      attempt: baseAttempt("sent", { provider_message_id: "gmail-msg-id" }),
      handoffOpen: MISSING,
    });
    const r = await lib.dispatchInvitationEmail({
      tenant_id: TENANT,
      attempt_id: ATTEMPT,
      invitation_id: INVITATION,
    });
    return { result: r, calls: c };
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.idempotent, true);
  assert.strictEqual(result.provider_message_id, "gmail-msg-id");
  assert.strictEqual(calls.providerSends, 0);
});

test("9 first dispatch Zapier 2xx → handoff consumed, attempt awaits callback", async () => {
  const { result } = await dispatchWith("queued", VALID);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.awaiting_callback, true);
  assert.ok(!result.provider_message_id, "Catch Hook ack is never sent");
  assert.ok(emailLibSrc.includes("await markHandoffConsumed(tenantId, invitationId, attemptId);"));
});

test("10+11 callback remains the only authority for sent|failed", () => {
  assert.ok(emailLibSrc.includes("async function handleZapierEmailCallback("));
  assert.ok(emailLibSrc.includes('error: "provider_message_id required for sent"'));
  assert.ok(emailLibSrc.includes('trimField(body.error_code) || "zapier_gmail_failed"'));
  assert.ok(emailLibSrc.includes('ui_status: "sent"'));
  assert.ok(callbackSrc.includes("handleZapierEmailCallback"));
});

test("12 handoff_decrypt_failed security behavior preserved", async () => {
  const { result, calls } = await dispatchWith("sending", DECRYPT_FAILED);
  assert.strictEqual(result.ok, false, "decrypt failure is never treated as in flight");
  assert.strictEqual(result.code, "handoff_decrypt_failed");
  assert.strictEqual(result.retryable, false);
  assert.ok(!calls.attemptTransitions.some((t) => t.toStatus === "failed"));
  assert.strictEqual(calls.providerSends, 0);
  assert.ok(handoffSrc.includes('return { ok: false, code: "handoff_decrypt_failed", error: "handoff decrypt failed" };'));
});

test("13 queue re-click while sending without handoff does not re-kick dispatch", () => {
  assert.ok(emailLibSrc.includes("async function idempotentDispatchRef("));
  assert.ok(
    emailLibSrc.includes("_dispatch: await idempotentDispatchRef(tenantId, invitation.id, existing, {"),
    "ordinary idempotent branch must use the guard"
  );
  assert.ok(
    emailLibSrc.includes("_dispatch: await idempotentDispatchRef(tenantId, invitation.id, existingAfter, {"),
    "rotation replay branch must use the guard"
  );
  assert.ok(queueSrc.includes("if (queued._dispatch && !queued.idempotent)"));
  assert.ok(queueSrc.includes('} else if (queued._dispatch && queued.idempotent && queued.ui_status !== "sent") {'));
});

test("14 queue re-click while sending reuses the in-flight attempt", () => {
  assert.ok(emailLibSrc.includes("const existing = await findActiveEmailAttempt(tenantId, invitation.id, generation.id);"));
  assert.ok(emailLibSrc.includes("&status=in.(queued,sending,sent)"));
  assert.ok(emailLibSrc.includes("idempotent: true"));
});

test("15 terminal failed attempt cannot be replayed; new click rotates", () => {
  assert.ok(emailLibSrc.includes('code: "terminal_attempt_replay_blocked"'));
  assert.ok(emailLibSrc.includes('if (["failed", "cancelled", "bounced"].includes(attempt.status)) {'));
  assert.ok(emailLibSrc.includes("const rotated = await resendInvitation(tenantId, invitation.id, {"));
  assert.ok(emailLibSrc.includes("reason: GENERATION_REASON_DB"));
});

test("16 no real webhook or Gmail in QA", () => {
  const self = read("scripts/qa-ch013a24-handoff-consumed-race.js");
  assert.ok(!/globalThis\.fetch\s*\(/.test(self));
  assert.ok(!/require\(['"]https?['"]\)/.test(self));
  assert.ok(!/hooks\.zapier\.com\/hooks\/catch\/(?!example)/.test(self));
});

test("17 payload / HMAC / callback schema unchanged", () => {
  assert.ok(zapierSrc.includes("const message = `${String(timestampIso)}.${String(canonicalBody)}`;"));
  assert.ok(zapierSrc.includes('const TIMESTAMP_HEADER = "X-Margin-Guard-Timestamp";'));
  assert.ok(zapierSrc.includes('const SIGNATURE_HEADER = "X-Margin-Guard-Signature";'));
  assert.ok(zapierSrc.includes("const TIMESTAMP_MAX_SKEW_MS = 5 * 60 * 1000;"));
  assert.ok(emailLibSrc.includes("`v1.callback.${String(rawBody || \"\")}`"));
  assert.ok(docsSrc.includes("handoff_already_consumed"));
});

test("18 only approved files modified", () => {
  const diff = spawnSync("git", ["diff", "--name-only"], { cwd: ROOT, encoding: "utf8" });
  assert.strictEqual(diff.status, 0, diff.stderr);
  const allowed = new Set([
    "netlify/functions/_lib/contract-invitation-email.js",
    "docs/CH-013A21Z-ZAPIER-CONTRACT-EMAIL.md",
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
  console.log("\nCH-013A.2.4 handoff race:", passed, "passed,", failed, "failed");
  process.exit(failed === 0 ? 0 : 1);
})();
