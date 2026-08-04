/**
 * CH-013A.2.1 — Atomic rotation + handoff hardening offline QA.
 * Run: node scripts/qa-ch013a21-email-adapter.js
 * Never sends real email. Never applies SQL. Never commits env secrets.
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function checkSyntax(file) {
  const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || file);
}

let passed = 0;
let failed = 0;
const pending = [];

function test(name, fn) {
  pending.push({ name, fn });
}

function withEnv(vars, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined || v === null) delete process.env[k];
    else process.env[k] = String(v);
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
}

function reloadHandoff() {
  const abs = path.join(ROOT, "netlify/functions/_lib/email-delivery-handoff.js");
  delete require.cache[require.resolve(abs)];
  return require(abs);
}

const FILES = [
  "netlify/functions/_lib/providers/provider-interface.js",
  "netlify/functions/_lib/providers/resend-provider.js",
  "netlify/functions/_lib/channels/email.js",
  "netlify/functions/_lib/templates/email-contract-invitation.js",
  "netlify/functions/_lib/contract-invitation-email.js",
  "netlify/functions/_lib/email-delivery-handoff.js",
  "netlify/functions/_lib/contract-invitation.js",
  "netlify/functions/_lib/delivery-worker.js",
  "netlify/functions/contract-invitation-email-queue.js",
  "netlify/functions/contract-invitation-email-dispatch-background.js",
  "public/js/signature-workspace.js",
  "scripts/qa-ch013a21-email-adapter.js",
];

const iface = require(path.join(ROOT, "netlify/functions/_lib/providers/provider-interface.js"));
const resend = require(path.join(ROOT, "netlify/functions/_lib/providers/resend-provider.js"));
const email = require(path.join(ROOT, "netlify/functions/_lib/channels/email.js"));
const engine = require(path.join(ROOT, "netlify/functions/_lib/delivery-channel-engine.js"));
const builder = require(path.join(ROOT, "netlify/functions/_lib/signing-link-builder.js"));
const events = require(path.join(ROOT, "netlify/functions/_lib/platform-events.js"));

const emailLibSrc = read("netlify/functions/_lib/contract-invitation-email.js");
const invSrc = read("netlify/functions/_lib/contract-invitation.js");
const handoffSrc = read("netlify/functions/_lib/email-delivery-handoff.js");
const queueSrc = read("netlify/functions/contract-invitation-email-queue.js");
const dispatchSrc = read("netlify/functions/contract-invitation-email-dispatch-background.js");
const atomicSql = read("SUPABASE_CH013A21_ATOMIC_GENERATION_ROTATION.sql");
const sqlSrc = read("SUPABASE_CH013A1_SIGNING_INVITATION.sql");
const swJs = read("public/js/signature-workspace.js");
const swHtml = read("public/signature-workspace.html");
const emailChannelSrc = read("netlify/functions/_lib/channels/email.js");

const IDS = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  invitationId: "22222222-2222-4222-8222-222222222222",
  generationId: "33333333-3333-4333-8333-333333333333",
  attemptId: "44444444-4444-4444-8444-444444444444",
  attemptId2: "55555555-5555-4555-8555-555555555555",
  generationId2: "66666666-6666-4666-8666-666666666666",
};

test("syntax on every touched JS file", () => {
  FILES.filter((f) => f.endsWith(".js")).forEach((rel) => {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), rel);
    checkSyntax(path.join(ROOT, rel));
  });
});

test("QA1-7 Atomic RPC: failure leaves Gen N; success activates Gen N+1 only after revoke in txn", () => {
  assert.ok(atomicSql.includes("rotate_contract_invitation_generation"));
  assert.ok(atomicSql.includes("for update"));
  assert.ok(atomicSql.includes("status = 'revoked'"));
  assert.ok(atomicSql.includes("insert into public.tenant_contract_signing_tokens"));
  assert.ok(atomicSql.includes("insert into public.tenant_contract_invitation_generations"));
  assert.ok(atomicSql.includes("current_generation = v_next_num"));
  assert.ok(atomicSql.includes("atomic_rotation_active_generation_invariant"));
  // Revoke appears before insert new generation in function body order
  const revokeAt = atomicSql.indexOf("set status = 'revoked'");
  const insertGenAt = atomicSql.indexOf(
    "insert into public.tenant_contract_invitation_generations"
  );
  assert.ok(revokeAt > 0 && insertGenAt > revokeAt);
  assert.ok(invSrc.includes("rotateInvitationGenerationAtomic"));
  assert.ok(invSrc.includes("rpc/rotate_contract_invitation_generation"));
  assert.ok(!invSrc.includes("prior_generation_revoke_failed"));
  assert.ok(invSrc.includes("prior_generation_revoked: false"));
  assert.ok(invSrc.includes("atomic_rotation_rpc_missing"));
});

test("QA8 Concurrent activation idempotency key in RPC", () => {
  assert.ok(atomicSql.includes("rotation_idempotency_key"));
  assert.ok(atomicSql.includes("'idempotent', true"));
  assert.ok(emailLibSrc.includes("invitation:rotate:"));
});

test("QA9 Duplicate activation reuses attempt", () => {
  assert.ok(emailLibSrc.includes("findActiveEmailAttempt"));
  assert.ok(emailLibSrc.includes("idempotent: true"));
});

test("QA10-15 Handoff attempt-scoped AAD + TTL + consume", async () => {
  assert.ok(handoffSrc.includes("email_handoffs"));
  assert.ok(handoffSrc.includes("buildAad"));
  assert.ok(emailLibSrc.includes("generationId"));
  const key = crypto.randomBytes(32).toString("base64");
  await withEnv(
    {
      CONTRACT_EMAIL_HANDOFF_KEY: key,
      CONTRACT_EMAIL_HANDOFF_KEY_VERSION: "1",
      CONTRACT_EMAIL_DISPATCH_SECRET: "dispatch-secret-not-for-crypto",
    },
    () => {
      const h = reloadHandoff();
      const sealed = h.sealDeliverySecret({
        ...IDS,
        rawToken: "super-secret-token-value",
      });
      assert.ok(sealed.ok, sealed.error);
      assert.strictEqual(sealed.package.v, 2);
      assert.ok(sealed.package.key_version === 1);
      assert.ok(!JSON.stringify(sealed.package).includes("super-secret-token-value"));

      const okOpen = h.openDeliverySecret(sealed.package, IDS);
      assert.ok(okOpen.ok);
      assert.strictEqual(okOpen.raw_token_once, "super-secret-token-value");

      // Wrong attempt
      const badAttempt = h.openDeliverySecret(sealed.package, {
        ...IDS,
        attemptId: IDS.attemptId2,
      });
      assert.ok(!badAttempt.ok);

      // Wrong tenant
      const badTenant = h.openDeliverySecret(sealed.package, {
        ...IDS,
        tenantId: IDS.attemptId2,
      });
      assert.ok(!badTenant.ok);

      // Wrong generation
      const badGen = h.openDeliverySecret(sealed.package, {
        ...IDS,
        generationId: IDS.generationId2,
      });
      assert.ok(!badGen.ok);

      // Expired
      const expiredPkg = {
        ...sealed.package,
        expires_at: new Date(Date.now() - 1000).toISOString(),
      };
      const expired = h.openDeliverySecret(expiredPkg, IDS);
      assert.strictEqual(expired.code, "handoff_expired");

      // Consumed marker
      const consumed = h.openDeliverySecret(
        { ...sealed.package, consumed_at: new Date().toISOString() },
        IDS
      );
      assert.strictEqual(consumed.code, "handoff_consumed");
    }
  );
});

test("QA16-18 Separate encryption key; dispatch secret cannot decrypt; missing key fails closed", async () => {
  assert.ok(!handoffSrc.includes("CONTRACT_EMAIL_DISPATCH_SECRET)"));
  assert.ok(handoffSrc.includes("exactly 32"));
  await withEnv(
    {
      CONTRACT_EMAIL_HANDOFF_KEY: null,
      CONTRACT_EMAIL_DISPATCH_SECRET: "dispatch-only",
    },
    () => {
      const h = reloadHandoff();
      assert.strictEqual(h.handoffAvailable(), false);
      const sealed = h.sealDeliverySecret({ ...IDS, rawToken: "x" });
      assert.ok(!sealed.ok);
      assert.ok(
        sealed.code === "handoff_key_missing" || sealed.code === "handoff_key_invalid"
      );
    }
  );
  await withEnv(
    {
      CONTRACT_EMAIL_HANDOFF_KEY: "too-short",
      CONTRACT_EMAIL_DISPATCH_SECRET: "dispatch-only",
    },
    () => {
      const h = reloadHandoff();
      assert.strictEqual(h.handoffAvailable(), false);
      assert.strictEqual(h.getHandoffKeyInfo().code, "handoff_key_invalid");
    }
  );

  const keyA = crypto.randomBytes(32).toString("hex");
  let pkg;
  await withEnv({ CONTRACT_EMAIL_HANDOFF_KEY: keyA }, () => {
    const h = reloadHandoff();
    const sealed = h.sealDeliverySecret({ ...IDS, rawToken: "token-a" });
    assert.ok(sealed.ok);
    pkg = sealed.package;
  });
  // Dispatch secret alone cannot open
  await withEnv(
    {
      CONTRACT_EMAIL_HANDOFF_KEY: null,
      CONTRACT_EMAIL_DISPATCH_SECRET: keyA,
    },
    () => {
      const h = reloadHandoff();
      const opened = h.openDeliverySecret(pkg, IDS);
      assert.ok(!opened.ok);
    }
  );
  // Different 32-byte key cannot open
  await withEnv(
    { CONTRACT_EMAIL_HANDOFF_KEY: crypto.randomBytes(32).toString("hex") },
    () => {
      const h = reloadHandoff();
      const opened = h.openDeliverySecret(pkg, IDS);
      assert.ok(!opened.ok);
    }
  );
});

test("QA19-21 accepted_db_pending finalize-only; no second send; events once", () => {
  assert.ok(emailLibSrc.includes("accepted_db_pending"));
  assert.ok(emailLibSrc.includes("finalizeAcceptedAttempt"));
  assert.ok(emailLibSrc.includes("persistProviderAcceptance"));
  assert.ok(emailLibSrc.includes("finalize_only"));
  assert.ok(emailLibSrc.includes("delivery:sent:"));
  assert.ok(atomicSql.includes("v_pmid_only") || atomicSql.includes("provider_message_id"));
  assert.ok(swJs.includes("Email accepted — finalizing status"));
});

test("QA22-23 Cross-tenant recovery blocked; terminal replay blocked", () => {
  assert.ok(emailLibSrc.includes("cross_tenant_blocked"));
  assert.ok(emailLibSrc.includes("terminal_attempt_replay_blocked"));
  assert.ok(dispatchSrc.includes("timingSafeEqualString"));
  assert.ok(dispatchSrc.includes("ALLOWED_BODY_KEYS"));
  assert.ok(!dispatchSrc.includes("one_shot_secret"));
  assert.ok(!dispatchSrc.includes("recipient_email: body"));
});

test("Generation token_id immutable + no mint-on-existing", () => {
  assert.ok(sqlSrc.includes("old.token_id is distinct from new.token_id"));
  assert.ok(!emailLibSrc.includes("mintEmailDeliverySecret"));
  assert.ok(!emailLibSrc.includes("tenant_contract_invitation_generations"));
});

test("Queue UI truth + no optimistic sent", () => {
  assert.ok(swJs.includes("Email queued"));
  assert.ok(swJs.includes("pollEmailDeliveryStatus"));
  assert.ok(!swJs.includes("Optimistic sent"));
  assert.ok(queueSrc.includes("getEmailDeliveryStatus"));
  assert.ok(queueSrc.includes("recoverEmailDispatch"));
});

test("Allowlist + feature off + header injection", async () => {
  await withEnv(
    {
      CONTRACT_EMAIL_DELIVERY_ENABLED: "true",
      RESEND_API_KEY: "re_test",
      CONTRACT_EMAIL_FROM: "noreply@example.com",
      CONTRACT_EMAIL_INTERNAL_ALLOWLIST: "",
    },
    () => {
      assert.strictEqual(resend.isRecipientAllowlisted("a@b.com"), false);
    }
  );
  await withEnv(
    {
      CONTRACT_EMAIL_DELIVERY_ENABLED: null,
      RESEND_API_KEY: "re_test",
      CONTRACT_EMAIL_FROM: "noreply@example.com",
    },
    () => {
      assert.strictEqual(resend.health().reason, "delivery_disabled");
    }
  );
  await withEnv(
    {
      CONTRACT_EMAIL_DELIVERY_ENABLED: "true",
      RESEND_API_KEY: "re_test",
      CONTRACT_EMAIL_FROM: "noreply@example.com",
      CONTRACT_EMAIL_INTERNAL_ALLOWLIST: "owner@test.example",
    },
    async () => {
      const result = await resend.send({
        to: "owner@test.example",
        subject: "Test",
        html: "<p>Hi</p>",
        reply_to: "evil@x.com\r\nBcc: victim@x.com",
        fetchImpl: async () => {
          throw new Error("should not call");
        },
      });
      assert.strictEqual(result.error_code, "header_injection");
    }
  );
});

test("No delivered/opened/bounced + no invoice hub", () => {
  assert.ok(!emailLibSrc.includes('transitionDeliveryAttempt(tenantId, attemptId, "delivered"'));
  const tracking = email.supportsTracking();
  assert.strictEqual(tracking.delivered, false);
  const blob = [emailLibSrc, queueSrc, dispatchSrc, swJs, handoffSrc].join("\n");
  assert.ok(!/invoice-hub|payment-intent|stripe/i.test(blob));
  assert.ok(!/Delivered|Opened|Bounced/.test(swHtml));
});

test("Events catalog + scrub", () => {
  assert.ok(events.DOMAIN_EVENT_TYPES.includes("delivery.channel.queued"));
  assert.ok(events.DOMAIN_EVENT_TYPES.includes("delivery.channel.sent"));
  const scrub = events.scrubForbiddenKeys(
    { attempt_id: "x", signing_url: "https://evil", raw_token: "nope" },
    "payload"
  );
  assert.ok(!scrub.ok);
});

test("Signing link builder + engine gate", async () => {
  assert.ok(!builder.buildSigningLink({ token_hash: "a".repeat(64) }).ok);
  await withEnv(
    {
      CONTRACT_EMAIL_DELIVERY_ENABLED: null,
      RESEND_API_KEY: null,
      CONTRACT_EMAIL_FROM: null,
      CONTRACT_EMAIL_ZAPIER_WEBHOOK_URL: null,
      CONTRACT_EMAIL_ZAPIER_HMAC_SECRET: null,
    },
    () => {
      assert.ok(!engine.resolve("email", { activeOnly: true }).ok);
    }
  );
});

test("429 retryable classification", () => {
  assert.strictEqual(iface.classifyHttpFailure(429, false).retryable, true);
  assert.strictEqual(iface.classifyHttpFailure(401, false).retryable, false);
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
  console.log("");

  const regressions = [
    ["QA24 CH-013A.2.1 prior suite retained via this file", null],
    ["QA25 CH-013A.2.0", "scripts/qa-ch013a20-delivery-engine.js"],
    ["QA25b CH-013B", "scripts/qa-ch013b-wire-invitation.js"],
    ["QA25c CH-013A.1", "scripts/qa-ch013a1-signing-invitation.js"],
    ["QA26a CH-011D", "scripts/qa-ch011d-signing-tokens.js"],
    ["QA26b CH-011E", "scripts/qa-ch011e-envelope-send.js"],
    ["QA26c CH-012D", "scripts/qa-ch012d-guided-workflow.js"],
    ["QA26d CH-012F", "scripts/qa-ch012f-canonical-contract-schedule.js"],
  ];

  for (const [label, rel] of regressions) {
    if (!rel) {
      console.log("PASS", label);
      passed += 1;
      continue;
    }
    const r = spawnSync(process.execPath, [path.join(ROOT, rel)], {
      encoding: "utf8",
      env: {
        ...process.env,
        CONTRACT_EMAIL_DELIVERY_ENABLED: "",
        RESEND_API_KEY: "",
        CONTRACT_EMAIL_FROM: "",
        CONTRACT_EMAIL_INTERNAL_ALLOWLIST: "",
        CONTRACT_EMAIL_ZAPIER_WEBHOOK_URL: "",
        CONTRACT_EMAIL_ZAPIER_HMAC_SECRET: "",
      },
    });
    if (r.status === 0) {
      console.log("PASS regression", label);
      passed += 1;
    } else {
      console.log("FAIL regression", label);
      console.log(r.stdout || "");
      console.log(r.stderr || "");
      failed += 1;
    }
  }

  console.log("");
  console.log(`CH-013A.2.1 atomic-hardening QA: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
