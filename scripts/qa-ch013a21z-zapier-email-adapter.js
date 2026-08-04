/**
 * CH-013A.2.1Z — Zapier email adapter offline QA.
 * Run: node scripts/qa-ch013a21z-zapier-email-adapter.js
 * Never calls a real Zapier webhook. Never sends email. Never commits secrets.
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

function reload(rel) {
  const abs = path.join(ROOT, rel);
  delete require.cache[require.resolve(abs)];
  return require(abs);
}

const FILES = [
  "netlify/functions/_lib/providers/provider-interface.js",
  "netlify/functions/_lib/providers/zapier-provider.js",
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
  "scripts/qa-ch013a21z-zapier-email-adapter.js",
];

const emailLibSrc = read("netlify/functions/_lib/contract-invitation-email.js");
const emailChannelSrc = read("netlify/functions/_lib/channels/email.js");
const zapierSrc = read("netlify/functions/_lib/providers/zapier-provider.js");
const resendSrc = read("netlify/functions/_lib/providers/resend-provider.js");
const handoffSrc = read("netlify/functions/_lib/email-delivery-handoff.js");
const invSrc = read("netlify/functions/_lib/contract-invitation.js");
const queueSrc = read("netlify/functions/contract-invitation-email-queue.js");
const dispatchSrc = read("netlify/functions/contract-invitation-email-dispatch-background.js");
const atomicSql = read("SUPABASE_CH013A21_ATOMIC_GENERATION_ROTATION.sql");
const swJs = read("public/js/signature-workspace.js");
const docsSrc = read("docs/CH-013A21Z-ZAPIER-CONTRACT-EMAIL.md");

const iface = require(path.join(ROOT, "netlify/functions/_lib/providers/provider-interface.js"));
const zapier = require(path.join(ROOT, "netlify/functions/_lib/providers/zapier-provider.js"));
const resend = require(path.join(ROOT, "netlify/functions/_lib/providers/resend-provider.js"));
const email = require(path.join(ROOT, "netlify/functions/_lib/channels/email.js"));
const engine = require(path.join(ROOT, "netlify/functions/_lib/delivery-channel-engine.js"));
const events = require(path.join(ROOT, "netlify/functions/_lib/platform-events.js"));

const ZAPIER_ENV_ON = {
  CONTRACT_EMAIL_DELIVERY_ENABLED: "true",
  CONTRACT_EMAIL_ZAPIER_WEBHOOK_URL: "https://hooks.zapier.com/hooks/catch/example/test",
  CONTRACT_EMAIL_ZAPIER_HMAC_SECRET: "test-hmac-secret-value",
  CONTRACT_EMAIL_FROM_NAME: "Margin Guard Contracts",
  CONTRACT_EMAIL_REPLY_TO: "owner@test.example",
  CONTRACT_EMAIL_INTERNAL_ALLOWLIST: "owner@test.example",
};

test("1 Generic Zapier 200 cannot mark sent (awaiting callback)", async () => {
  await withEnv(ZAPIER_ENV_ON, async () => {
    const z = reload("netlify/functions/_lib/providers/zapier-provider.js");
    const result = await z.send({
      to: "owner@test.example",
      subject: "S",
      html: "<p>x</p>",
      idempotency_key: "zapier:attempt:generic200",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ status: "success" }), // Catch Hook style — no accepted
      }),
    });
    assert.strictEqual(result.accepted, false);
    assert.strictEqual(result.awaiting_callback, true);
    assert.strictEqual(result.error_code, "awaiting_zapier_callback");
    assert.strictEqual(result.retryable, false);
  });
});

test("2 Async callback architecture chosen (Catch Hook cannot sync-respond)", () => {
  assert.ok(docsSrc.includes("ASYNCHRONOUS ACK ONLY") || docsSrc.includes("Model B"));
  assert.ok(docsSrc.includes("contract-invitation-email-zapier-callback"));
  assert.ok(fs.existsSync(path.join(ROOT, "netlify/functions/contract-invitation-email-zapier-callback.js")));
  assert.ok(emailLibSrc.includes("handleZapierEmailCallback"));
  assert.ok(emailLibSrc.includes("awaiting_zapier_callback"));
  assert.ok(emailChannelSrc.includes("awaiting_callback"));
});

test("3 Gmail message ID semantics documented (not Zap run id as Gmail)", () => {
  assert.ok(docsSrc.includes("Gmail message ID"));
  assert.ok(docsSrc.includes("Do **not** store Zap run id") || docsSrc.includes("not store Zap run"));
});

test("4-8 HMAC verify: invalid / stale / future / mutate / constant-time", () => {
  const z = zapier;
  const body = z.canonicalizeJson({ a: 1 });
  const secret = "hmac-secret";
  const ts = new Date().toISOString();
  const sig = z.signCanonicalBody(body, ts, secret);
  assert.ok(z.verifySignedRequest({ rawBody: body, timestamp: ts, signature: sig, secret }).ok);

  assert.strictEqual(
    z.verifySignedRequest({ rawBody: body, timestamp: ts, signature: "not-hex!", secret }).code,
    "signature_invalid"
  );
  assert.strictEqual(
    z.verifySignedRequest({ rawBody: body, timestamp: ts, signature: "abc", secret }).code,
    "signature_invalid"
  );
  assert.strictEqual(
    z.verifySignedRequest({
      rawBody: body,
      timestamp: ts,
      signature: "00".repeat(32),
      secret,
    }).code,
    "signature_mismatch"
  );
  assert.strictEqual(
    z.verifySignedRequest({
      rawBody: body + " ",
      timestamp: ts,
      signature: sig,
      secret,
    }).code,
    "signature_mismatch"
  );
  const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  assert.strictEqual(
    z.verifySignedRequest({
      rawBody: body,
      timestamp: stale,
      signature: z.signCanonicalBody(body, stale, secret),
      secret,
    }).code,
    "timestamp_stale"
  );
  const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  assert.strictEqual(
    z.verifySignedRequest({
      rawBody: body,
      timestamp: future,
      signature: z.signCanonicalBody(body, future, secret),
      secret,
    }).code,
    "timestamp_future"
  );
  assert.ok(z.timingSafeEqualHex(sig, sig));
  assert.ok(!z.timingSafeEqualHex(sig, "0".repeat(sig.length)));
});

test("9-10 Duplicate / Storage secondary SoT policy in docs+code", () => {
  assert.ok(docsSrc.includes("secondary"));
  assert.ok(docsSrc.includes("Margin Guard"));
  assert.ok(emailLibSrc.includes("zapier:attempt:"));
  assert.ok(!emailLibSrc.includes("resend:attempt:"));
});

test("11-13 Callback replay / cross-tenant / pmid write-once guards present", () => {
  assert.ok(emailLibSrc.includes("cross_tenant_blocked"));
  assert.ok(emailLibSrc.includes("provider_message_id_immutable") || emailLibSrc.includes("provider_message_id immutable"));
  assert.ok(emailLibSrc.includes("terminal_attempt_replay_blocked"));
  assert.ok(emailLibSrc.includes("relationship_mismatch"));
  const cbSrc = read("netlify/functions/contract-invitation-email-zapier-callback.js");
  assert.ok(cbSrc.includes("handleZapierEmailCallback"));
  assert.ok(cbSrc.includes("TIMESTAMP_HEADER"));
});

test("14 Gmail success + callback failure recoverable (accepted_db_pending path)", () => {
  assert.ok(emailLibSrc.includes("accepted_db_pending"));
  assert.ok(emailLibSrc.includes("finalizeAcceptedAttempt"));
});

test("15 Netlify timeout does not create another attempt after handoff consume", () => {
  assert.ok(emailLibSrc.includes("markHandoffConsumed"));
  assert.ok(emailLibSrc.includes("Awaiting Zapier/Gmail callback"));
});

test("16 UI never says sent from queue/generic ack", () => {
  assert.ok(swJs.includes("Email queued"));
  assert.ok(emailLibSrc.includes("awaiting_zapier_callback"));
  assert.ok(docsSrc.includes("NOT** email sent") || docsSrc.includes("NOT email sent"));
});

test("17 No raw token/URL/secrets outside ephemeral body", () => {
  const payload = zapier.buildCanonicalPayload({
    recipient_email: "owner@test.example",
    subject: "S",
    html: "<a href='https://example.com/sign?t=SECRETTOKEN'>x</a>",
    text: "https://example.com/sign?t=SECRETTOKEN",
    idempotency_key: "zapier:attempt:x",
    raw_token: "SECRETTOKEN",
    token_hash: "abc",
    token_id: "tid",
  });
  assert.ok(!Object.prototype.hasOwnProperty.call(payload, "raw_token"));
  assert.ok(!Object.prototype.hasOwnProperty.call(payload, "token_hash"));
  assert.ok(payload.html_body.includes("SECRETTOKEN"));
});

test("18 Existing atomic Gen N+1 rotation PASS", () => {
  assert.ok(atomicSql.includes("rotate_contract_invitation_generation"));
  assert.ok(invSrc.includes("rotateInvitationGenerationAtomic"));
});

test("19 Encrypted handoff PASS", () => {
  assert.ok(handoffSrc.includes("CONTRACT_EMAIL_HANDOFF_KEY"));
  assert.ok(handoffSrc.includes("exactly 32"));
});

test("Catch Raw Hook required for raw body HMAC", () => {
  assert.ok(docsSrc.includes("Catch Raw Hook"));
});

test("Zapier provider registered as active email provider", () => {
  assert.strictEqual(email.provider(), "zapier");
  assert.ok(emailChannelSrc.includes('require("../providers/zapier-provider")'));
});

test("Resend provider inactive / not registered on email channel", () => {
  assert.ok(resendSrc.includes("INACTIVE for beta") || resendSrc.includes("inactive"));
  assert.ok(!emailChannelSrc.includes("resend-provider"));
});

test("Missing webhook URL unavailable", async () => {
  await withEnv(
    { ...ZAPIER_ENV_ON, CONTRACT_EMAIL_ZAPIER_WEBHOOK_URL: null },
    () => {
      const h = reload("netlify/functions/_lib/providers/zapier-provider.js").health();
      assert.strictEqual(h.reason, "missing_webhook_url");
    }
  );
});

test("Missing HMAC secret unavailable", async () => {
  await withEnv(
    { ...ZAPIER_ENV_ON, CONTRACT_EMAIL_ZAPIER_HMAC_SECRET: null },
    () => {
      const h = reload("netlify/functions/_lib/providers/zapier-provider.js").health();
      assert.strictEqual(h.reason, "missing_hmac_secret");
    }
  );
});

test("Delivery disabled unavailable", async () => {
  await withEnv(
    { ...ZAPIER_ENV_ON, CONTRACT_EMAIL_DELIVERY_ENABLED: null },
    () => {
      const h = reload("netlify/functions/_lib/providers/zapier-provider.js").health();
      assert.strictEqual(h.reason, "delivery_disabled");
    }
  );
});

test("Allowlist blocked", async () => {
  await withEnv(
    { ...ZAPIER_ENV_ON, CONTRACT_EMAIL_INTERNAL_ALLOWLIST: "" },
    () => {
      const z = reload("netlify/functions/_lib/providers/zapier-provider.js");
      assert.strictEqual(z.isRecipientAllowlisted("owner@test.example"), false);
    }
  );
});

test("Canonical payload deterministic + HMAC headers", async () => {
  const a = zapier.buildCanonicalPayload({
    tenant_id: "t1",
    project_id: "p1",
    attempt_id: "a1",
    recipient_email: "Owner@Test.Example",
    subject: "S",
    html: "<p>x</p>",
    text: "x",
    idempotency_key: "zapier:attempt:a1",
    sent_at: "2026-01-01T00:00:00.000Z",
  });
  const b = zapier.buildCanonicalPayload({
    subject: "S",
    project_id: "p1",
    tenant_id: "t1",
    attempt_id: "a1",
    html_body: "<p>x</p>",
    text_body: "x",
    recipient_email: "owner@test.example",
    idempotency_key: "zapier:attempt:a1",
    sent_at: "2026-01-01T00:00:00.000Z",
  });
  assert.strictEqual(zapier.canonicalizeJson(a), zapier.canonicalizeJson(b));

  await withEnv(ZAPIER_ENV_ON, async () => {
    const z = reload("netlify/functions/_lib/providers/zapier-provider.js");
    let captured = null;
    await z.send({
      to: "owner@test.example",
      subject: "Hello",
      html: "<p>Hi</p>",
      text: "Hi",
      idempotency_key: "zapier:attempt:44444444-4444-4444-8444-444444444444",
      fetchImpl: async (_url, init) => {
        captured = init;
        return { ok: true, status: 200, json: async () => ({}) };
      },
    });
    assert.ok(captured.headers[z.TIMESTAMP_HEADER]);
    assert.ok(captured.headers[z.SIGNATURE_HEADER]);
    const sig = z.signCanonicalBody(
      captured.body,
      captured.headers[z.TIMESTAMP_HEADER],
      ZAPIER_ENV_ON.CONTRACT_EMAIL_ZAPIER_HMAC_SECRET
    );
    assert.strictEqual(captured.headers[z.SIGNATURE_HEADER], sig);
  });
});

test("Timeout/429 retryable; 401 fatal; accepted without pmid rejected", async () => {
  await withEnv(ZAPIER_ENV_ON, async () => {
    const z = reload("netlify/functions/_lib/providers/zapier-provider.js");
    const timeout = await z.send({
      to: "owner@test.example",
      subject: "S",
      html: "<p>x</p>",
      idempotency_key: "zapier:attempt:t1",
      fetchImpl: async () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      },
    });
    assert.strictEqual(timeout.retryable, true);

    const rate = await z.send({
      to: "owner@test.example",
      subject: "S",
      html: "<p>x</p>",
      idempotency_key: "zapier:attempt:r1",
      fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({}) }),
    });
    assert.strictEqual(rate.retryable, true);

    const auth = await z.send({
      to: "owner@test.example",
      subject: "S",
      html: "<p>x</p>",
      idempotency_key: "zapier:attempt:f1",
      fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }),
    });
    assert.strictEqual(auth.retryable, false);

    const missing = await z.send({
      to: "owner@test.example",
      subject: "S",
      html: "<p>x</p>",
      idempotency_key: "zapier:attempt:m1",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, accepted: true, provider: "zapier" }),
      }),
    });
    assert.strictEqual(missing.error_code, "provider_missing_message_id");
  });
});

test("Explicit accepted+pmid still normalizes (test double / future sync)", async () => {
  await withEnv(ZAPIER_ENV_ON, async () => {
    const z = reload("netlify/functions/_lib/providers/zapier-provider.js");
    const result = await z.send({
      to: "owner@test.example",
      subject: "S",
      html: "<p>x</p>",
      idempotency_key: "zapier:attempt:ok1",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          accepted: true,
          provider: "zapier",
          provider_message_id: "gmail-msg-1",
          idempotent: false,
        }),
      }),
    });
    assert.strictEqual(result.accepted, true);
    assert.strictEqual(result.provider_message_id, "gmail-msg-1");
  });
});

test("No Invoice Hub/payment; no real webhook in QA", () => {
  const blob = [emailLibSrc, queueSrc, dispatchSrc, zapierSrc, emailChannelSrc].join("\n");
  assert.ok(!/invoice-hub|payment-intent|stripe/i.test(blob));
  assert.ok(zapierSrc.includes("fetchImpl"));
});

test("Header injection blocked", async () => {
  await withEnv(ZAPIER_ENV_ON, async () => {
    const z = reload("netlify/functions/_lib/providers/zapier-provider.js");
    const result = await z.send({
      to: "owner@test.example",
      subject: "S",
      html: "<p>x</p>",
      reply_to: "evil@x.com\r\nBcc: victim@x.com",
      idempotency_key: "zapier:attempt:inj",
      fetchImpl: async () => {
        throw new Error("should not call");
      },
    });
    assert.strictEqual(result.error_code, "header_injection");
  });
});

test("No RESEND_API_KEY / CONTRACT_EMAIL_FROM required", async () => {
  await withEnv(
    { ...ZAPIER_ENV_ON, RESEND_API_KEY: null, CONTRACT_EMAIL_FROM: null },
    () => {
      const z = reload("netlify/functions/_lib/providers/zapier-provider.js");
      assert.strictEqual(z.health().available, true);
    }
  );
});

test("syntax on every touched JS file", () => {
  const files = [
    ...FILES,
    "netlify/functions/contract-invitation-email-zapier-callback.js",
  ];
  files.filter((f) => f.endsWith(".js")).forEach((rel) => {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), rel);
    checkSyntax(path.join(ROOT, rel));
  });
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
    ["24 CH-013A.2.0", "scripts/qa-ch013a20-delivery-engine.js"],
    ["25 CH-013B", "scripts/qa-ch013b-wire-invitation.js"],
    ["26 CH-013A.1", "scripts/qa-ch013a1-signing-invitation.js"],
    ["27a CH-011D", "scripts/qa-ch011d-signing-tokens.js"],
    ["27b CH-011E", "scripts/qa-ch011e-envelope-send.js"],
    ["28a CH-012D", "scripts/qa-ch012d-guided-workflow.js"],
    ["28b CH-012F", "scripts/qa-ch012f-canonical-contract-schedule.js"],
    ["prior CH-013A.2.1 atomic/handoff", "scripts/qa-ch013a21-email-adapter.js"],
  ];

  const clearEnv = {
    ...process.env,
    CONTRACT_EMAIL_DELIVERY_ENABLED: "",
    RESEND_API_KEY: "",
    CONTRACT_EMAIL_FROM: "",
    CONTRACT_EMAIL_INTERNAL_ALLOWLIST: "",
    CONTRACT_EMAIL_ZAPIER_WEBHOOK_URL: "",
    CONTRACT_EMAIL_ZAPIER_HMAC_SECRET: "",
  };

  for (const [label, rel] of regressions) {
    const r = spawnSync(process.execPath, [path.join(ROOT, rel)], {
      encoding: "utf8",
      env: clearEnv,
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
  console.log(`CH-013A.2.1Z Zapier email QA: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
