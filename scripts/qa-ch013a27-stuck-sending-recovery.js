/**
 * CH-013A.2.7 — Unblock stuck sending attempt; allow one fresh Email click.
 * Run: node scripts/qa-ch013a27-stuck-sending-recovery.js
 * Never calls Zapier. Never sends email.
 */
"use strict";

const assert = require("assert");
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

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function checkSyntax(rel) {
  const r = spawnSync(process.execPath, ["--check", path.join(ROOT, rel)], { encoding: "utf8" });
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || rel);
}

let passed = 0;
let failed = 0;
const pending = [];
function test(name, fn) {
  pending.push({ name, fn });
}

const TENANT = "11111111-1111-4111-8111-111111111111";
const INVITATION = "22222222-2222-4222-8222-222222222222";
const GENERATION = "33333333-3333-4333-8333-333333333333";
const ATTEMPT = "44444444-4444-4444-8444-444444444444";
const ENVELOPE = "66666666-6666-4666-8666-666666666666";
const SIGNER = "55555555-5555-4555-8555-555555555555";

const emailLibSrc = read("netlify/functions/_lib/contract-invitation-email.js");
const queueSrc = read("netlify/functions/contract-invitation-email-queue.js");
const swJs = read("public/js/signature-workspace.js");
const swHtml = read("public/signature-workspace.html");
const zapierSrc = read("netlify/functions/_lib/providers/zapier-provider.js");

function loadLib(overrides) {
  const calls = {
    attemptTransitions: [],
    invitationFailed: [],
    events: [],
    peeks: [],
  };
  const state = {
    attempt: overrides.attempt,
    invitation: overrides.invitation || {
      id: INVITATION,
      tenant_id: TENANT,
      signer_id: SIGNER,
      envelope_id: ENVELOPE,
      status: "sending",
      metadata: {},
    },
    handoffPresent: overrides.handoffPresent === true,
  };

  const stubs = new Map();
  stubs.set(SUPABASE_ADMIN, {
    supabaseRequest: async (pathStr) => {
      const p = String(pathStr);
      if (p.startsWith("tenant_contract_invitation_delivery_attempts")) return [state.attempt];
      if (p.startsWith("tenant_contract_invitations")) return [state.invitation];
      if (p.startsWith("tenant_contract_signers")) {
        return [{ id: SIGNER, tenant_id: TENANT, envelope_id: ENVELOPE, email: "owner@test.example" }];
      }
      if (p.startsWith("tenant_contract_envelopes")) {
        return [{ id: ENVELOPE, tenant_id: TENANT, status: "sent" }];
      }
      return [];
    },
  });

  const realHandoff = require(HANDOFF_LIB);
  stubs.set(HANDOFF_LIB, {
    ...realHandoff,
    handoffAvailable: () => true,
    peekHandoff: async () => {
      calls.peeks.push(true);
      return { ok: true, present: state.handoffPresent };
    },
    clearHandoff: async () => ({ ok: true }),
    markHandoffConsumed: async () => ({ ok: true }),
    readAcceptance: () => null,
  });

  const realInvitation = require(INVITATION_LIB);
  stubs.set(INVITATION_LIB, {
    ...realInvitation,
    getActiveGeneration: async () => ({ id: GENERATION, generation_number: 2 }),
    transitionDeliveryAttempt: async (tenantId, attemptId, toStatus, options) => {
      calls.attemptTransitions.push({ attemptId, toStatus, options: options || {} });
      state.attempt = {
        ...state.attempt,
        status: toStatus,
        error_code: options?.error_code || state.attempt.error_code || null,
      };
      return { ok: true, attempt: state.attempt };
    },
    markInvitationFailed: async (tenantId, invitationId, options) => {
      calls.invitationFailed.push({ invitationId, options: options || {} });
      state.invitation = { ...state.invitation, status: "failed" };
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
  stubs.set(CHANNEL_LIB, { deliver: async () => ({ ok: false }) });

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
  return { lib, calls, state };
}

function sendingAttempt(ageMs) {
  return {
    attempt_id: ATTEMPT,
    tenant_id: TENANT,
    invitation_id: INVITATION,
    generation_id: GENERATION,
    provider: "zapier",
    status: "sending",
    started_at: new Date(Date.now() - ageMs).toISOString(),
    provider_message_id: null,
    error_code: null,
  };
}

test("0 syntax on touched files", () => {
  [
    "netlify/functions/_lib/contract-invitation-email.js",
    "netlify/functions/contract-invitation-email-queue.js",
    "public/js/signature-workspace.js",
    "scripts/qa-ch013a27-stuck-sending-recovery.js",
  ].forEach(checkSyntax);
});

test("1 sending + no pmid + not stuck → cannot abandon", async () => {
  const { lib, calls } = loadLib({
    attempt: sendingAttempt(60 * 1000), // 1 minute
    handoffPresent: false,
  });
  const result = await lib.recoverEmailDispatch({
    tenantId: TENANT,
    attemptId: ATTEMPT,
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.recovered, false);
  assert.strictEqual(result.awaiting_callback, true);
  assert.strictEqual(result.code, "awaiting_zapier_callback");
  assert.strictEqual(result.recoverable, false);
  assert.ok(!calls.attemptTransitions.some((t) => t.toStatus === "failed"));
});

test("2 sending + no pmid + stuck → owner recovery allowed", async () => {
  const { lib, calls } = loadLib({
    attempt: sendingAttempt(11 * 60 * 1000),
    handoffPresent: false,
  });
  const result = await lib.recoverEmailDispatch({
    tenantId: TENANT,
    attemptId: ATTEMPT,
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.recovered, true);
  assert.strictEqual(result.abandoned, true);
  assert.strictEqual(result.ui_status, "failed");
  assert.strictEqual(result.recoverable, true);
  assert.strictEqual(result.error_code, "upstream_validation_failed");
  const failure = calls.attemptTransitions.find((t) => t.toStatus === "failed");
  assert.ok(failure);
  assert.strictEqual(failure.options.error_code, "upstream_validation_failed");
});

test("3 recovery marks attempt failed/recoverable; invitation left re-queueable", async () => {
  const { lib, calls, state } = loadLib({
    attempt: sendingAttempt(11 * 60 * 1000),
    handoffPresent: false,
  });
  await lib.recoverEmailDispatch({ tenantId: TENANT, attemptId: ATTEMPT });
  assert.strictEqual(state.attempt.status, "failed");
  assert.strictEqual(state.attempt.error_code, "upstream_validation_failed");
  assert.strictEqual(calls.invitationFailed.length, 1);
  assert.strictEqual(state.invitation.status, "failed");
  assert.strictEqual(state.invitation.envelope_id, ENVELOPE);
  assert.strictEqual(state.invitation.signer_id, SIGNER);
});

test("4+5+6 envelope / secure-link / signer unchanged by design", () => {
  assert.ok(emailLibSrc.includes('error_code: "upstream_validation_failed"'));
  assert.ok(emailLibSrc.includes("abandoned: true"));
  assert.ok(!emailLibSrc.includes("contract-envelope-create"));
  assert.ok(!/envelope\.status\s*=\s*[\"']cancelled[\"']/.test(emailLibSrc));
  // Recovery must not rebuild signing URLs.
  assert.ok(!/signing_url/.test(
    emailLibSrc.slice(
      emailLibSrc.indexOf("async function recoverEmailDispatch"),
      emailLibSrc.indexOf("async function finalizeAcceptedAttempt")
    )
  ));
});

test("7 next Email click creates new generation/attempt after failed active gap", () => {
  assert.ok(emailLibSrc.includes("const ACTIVE_ATTEMPT_STATUSES = new Set([\"queued\", \"sending\", \"sent\"]);"));
  assert.ok(emailLibSrc.includes("const rotated = await resendInvitation(tenantId, invitation.id, {"));
  assert.ok(emailLibSrc.includes("reason: GENERATION_REASON_DB"));
  assert.ok(emailLibSrc.includes('} else if (["failed", "bounced"].includes(trimField(invitation.status))) {'));
});

test("8+9 fresh handoff + background dispatch on non-idempotent queue", () => {
  assert.ok(emailLibSrc.includes("const sealed = await sealAndPersistHandoff({"));
  assert.ok(emailLibSrc.includes("_dispatch: dispatchRef({"));
  assert.ok(queueSrc.includes("if (queued._dispatch && !queued.idempotent)"));
  assert.ok(queueSrc.includes("await invokeBackgroundDispatch(queued._dispatch, { site_origin: origin })"));
});

test("10 old abandoned attempt cannot dispatch again", async () => {
  const { lib, calls } = loadLib({
    attempt: {
      ...sendingAttempt(11 * 60 * 1000),
      status: "failed",
      error_code: "upstream_validation_failed",
    },
    handoffPresent: false,
  });
  const result = await lib.recoverEmailDispatch({
    tenantId: TENANT,
    attemptId: ATTEMPT,
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.idempotent, true);
  assert.strictEqual(result.recoverable, true);
  assert.ok(!result._dispatch);
  assert.strictEqual(calls.attemptTransitions.length, 0);
});

test("11 polling stops after stuck timeout / server stuck", () => {
  assert.ok(swJs.includes("EMAIL_POLL_FAST_TICKS"));
  assert.ok(swJs.includes("EMAIL_POLL_SLOW_TICKS"));
  assert.ok(swJs.includes("if (res.data.stuck === true)"));
  assert.ok(swJs.includes("state.emailStuck = true"));
  assert.ok(swJs.includes("stopEmailStatusPoll()"));
  assert.ok(swJs.includes("Delivery failed") || swJs.includes("Sending..."));
  assert.ok(swHtml.includes('id="swEmailRetryBtn"'));
});

test("12 no duplicate attempt on repeated clicks while active", () => {
  assert.ok(emailLibSrc.includes("const existing = await findActiveEmailAttempt(tenantId, invitation.id, generation.id);"));
  assert.ok(emailLibSrc.includes("idempotent: true"));
  assert.ok(emailLibSrc.includes("async function idempotentDispatchRef("));
});

test("13+14 no Zap replay / no real email in QA", () => {
  const self = read("scripts/qa-ch013a27-stuck-sending-recovery.js");
  assert.ok(!/hooks\.zapier\.com\/hooks\/catch\/(?!example)/.test(self));
  assert.ok(!/globalThis\.fetch\s*\(/.test(self));
  assert.ok(emailLibSrc.includes("Awaiting Zapier/Gmail callback — do not re-dispatch"));
});

test("15 no HMAC/callback schema changes", () => {
  assert.ok(zapierSrc.includes("const message = `${String(timestampIso)}.${String(canonicalBody)}`;"));
  assert.ok(zapierSrc.includes('const TIMESTAMP_HEADER = "X-Margin-Guard-Timestamp";'));
  assert.ok(emailLibSrc.includes("`v1.callback.${String(rawBody || \"\")}`"));
  assert.ok(queueSrc.includes("recoverable: recovered.recoverable === true"));
  assert.ok(swJs.includes('recover: true'));
  assert.ok(swJs.includes("Retry Email Delivery"));
});

test("16 only approved files modified", () => {
  const diff = spawnSync("git", ["diff", "--name-only"], { cwd: ROOT, encoding: "utf8" });
  assert.strictEqual(diff.status, 0, diff.stderr);
  const allowed = new Set([
    "netlify/functions/_lib/contract-invitation-email.js",
    "netlify/functions/contract-invitation-email-queue.js",
    "public/js/signature-workspace.js",
    "public/signature-workspace.html",
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
  console.log("\nCH-013A.2.7 stuck sending recovery:", passed, "passed,", failed, "failed");
  process.exit(failed === 0 ? 0 : 1);
})();
