/**
 * CH-013A.2.9 — Body-signed Zapier envelope offline QA.
 * Run: node scripts/qa-ch013a29-body-signed-envelope.js
 * Never calls a real webhook. Never sends Gmail. Never hits callback.
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const PROVIDER = path.join(ROOT, "netlify/functions/_lib/providers/zapier-provider.js");
const STEP2 = path.join(ROOT, "docs/CH-013A29-ZAPIER-STEP2-BODY-ENVELOPE.js");
const CALLBACK = path.join(
  ROOT,
  "netlify/functions/contract-invitation-email-zapier-callback.js"
);
const DOCS = path.join(ROOT, "docs/CH-013A21Z-ZAPIER-CONTRACT-EMAIL.md");

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function checkSyntax(rel) {
  const abs = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
  // Step 2 file uses ESM `export default` for Zapier paste — syntax-check via transform.
  if (abs === STEP2) {
    const src = fs
      .readFileSync(abs, "utf8")
      .replace(/export\s+default\s+async\s+function\s+main/, "async function main");
    const tmp = path.join(ROOT, "scripts", ".tmp-ch013a29-step2-check.cjs");
    fs.writeFileSync(tmp, src + "\nmodule.exports = main;\n");
    try {
      const r = spawnSync(process.execPath, ["--check", tmp], { encoding: "utf8" });
      assert.strictEqual(r.status, 0, r.stderr || r.stdout || "step2");
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch (_e) {
        /* ignore */
      }
    }
    return;
  }
  const r = spawnSync(process.execPath, ["--check", abs], { encoding: "utf8" });
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || abs);
}

function loadStep2() {
  const src = fs
    .readFileSync(STEP2, "utf8")
    .replace(/export\s+default\s+async\s+function\s+main/, "async function main");
  const tmp = path.join(ROOT, "scripts", ".tmp-ch013a29-step2-run.cjs");
  fs.writeFileSync(tmp, src + "\nmodule.exports = main;\n");
  try {
    delete require.cache[require.resolve(tmp)];
    return require(tmp);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch (_e) {
      /* ignore */
    }
  }
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

function reloadProvider() {
  delete require.cache[require.resolve(PROVIDER)];
  return require(PROVIDER);
}

const SECRET = "test-hmac-secret-value-ch013a29";
const ZAPIER_ENV = {
  CONTRACT_EMAIL_DELIVERY_ENABLED: "true",
  CONTRACT_EMAIL_ZAPIER_WEBHOOK_URL: "https://hooks.zapier.com/hooks/catch/example/test",
  CONTRACT_EMAIL_ZAPIER_HMAC_SECRET: SECRET,
  CONTRACT_EMAIL_FROM_NAME: "Margin Guard Contracts",
  CONTRACT_EMAIL_REPLY_TO: "owner@test.example",
  CONTRACT_EMAIL_INTERNAL_ALLOWLIST: "owner@test.example",
};

const REQUIRED_OUT = [
  "valid",
  "validation_error",
  "schema_version",
  "event_type",
  "tenant_id",
  "project_id",
  "envelope_id",
  "invitation_id",
  "generation_id",
  "generation_number",
  "attempt_id",
  "recipient_email",
  "recipient_name",
  "subject",
  "html_body",
  "text_body",
  "reply_to",
  "from_name",
  "expires_at",
  "correlation_id",
  "idempotency_key",
];

let passed = 0;
let failed = 0;
const pending = [];
function test(name, fn) {
  pending.push({ name, fn });
}

function invitationInput() {
  return {
    to: "owner@test.example",
    recipient_name: "Owner",
    subject: "Your contract is ready to sign",
    html: "<p>Sign here: https://example.invalid/sign?x=1</p>",
    text: "Sign here: https://example.invalid/sign?x=1",
    idempotency_key: "zapier:attempt:99999999-9999-4999-8999-999999999999",
    tenant_id: "11111111-1111-4111-8111-111111111111",
    project_id: "bf3eed35-50d1-47e0-82ca-62bccb114fbe",
    envelope_id: "07afe998-d9c8-4552-970e-5d8c29d02e81",
    invitation_id: "22222222-2222-4222-8222-222222222222",
    generation_id: "33333333-3333-4333-8333-333333333333",
    generation_number: 4,
    attempt_id: "99999999-9999-4999-8999-999999999999",
    correlation_id: "MG-EVT-ABCD1234",
    expires_at: "2026-09-01T00:00:00.000Z",
  };
}

async function captureSend(z, overrides = {}) {
  let captured = null;
  const result = await z.send({
    ...invitationInput(),
    ...overrides,
    fetchImpl: async (_url, init) => {
      captured = init;
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
  return { result, captured };
}

function assertCompleteOut(label, out) {
  assert.ok(out && typeof out === "object", label + ": missing object");
  assert.notStrictEqual(out, null);
  assert.ok(Object.keys(out).length > 0, label + ": empty object");
  for (const key of REQUIRED_OUT) {
    assert.ok(Object.prototype.hasOwnProperty.call(out, key), label + ": missing " + key);
    assert.strictEqual(typeof out[key], "string", label + ": " + key + " not string");
  }
  assert.ok(out.valid === "true" || out.valid === "false", label + ": valid not string bool");
}

test("0 syntax on touched files", () => {
  [
    "netlify/functions/_lib/providers/zapier-provider.js",
    "docs/CH-013A29-ZAPIER-STEP2-BODY-ENVELOPE.js",
    "scripts/qa-ch013a29-body-signed-envelope.js",
  ].forEach(checkSyntax);
});

test("1+2+3+4 outer body + signed_body byte-identical + headers match", async () => {
  await withEnv(ZAPIER_ENV, async () => {
    const z = reloadProvider();
    const { captured } = await captureSend(z);
    assert.ok(captured && captured.body);
    const outer = JSON.parse(captured.body);
    assert.strictEqual(outer.envelope_schema_version, "1");
    assert.ok(typeof outer.timestamp === "string" && outer.timestamp);
    assert.ok(typeof outer.signature === "string" && outer.signature);
    assert.ok(typeof outer.signed_body === "string" && outer.signed_body);

    const payload = z.buildCanonicalPayload(invitationInput());
    // buildCanonicalPayload uses recipient_email from input; send() normalizes to `to`.
    const expectedPayload = z.buildCanonicalPayload({
      ...invitationInput(),
      recipient_email: "owner@test.example",
      html_body: invitationInput().html,
      text_body: invitationInput().text,
      from_name: "Margin Guard Contracts",
      reply_to: "owner@test.example",
      sent_at: JSON.parse(outer.signed_body).sent_at,
    });
    const expectedSigned = z.canonicalizeJson(expectedPayload);
    assert.strictEqual(outer.signed_body, expectedSigned);

    assert.strictEqual(captured.headers[z.TIMESTAMP_HEADER], outer.timestamp);
    assert.strictEqual(captured.headers[z.SIGNATURE_HEADER], outer.signature);

    const expectedSig = z
      .signCanonicalBody(outer.signed_body, outer.timestamp, SECRET)
      .toLowerCase();
    assert.strictEqual(outer.signature, expectedSig);
    assert.strictEqual(payload.attempt_id, "99999999-9999-4999-8999-999999999999");
  });
});

test("5 valid envelope verifies", async () => {
  await withEnv(ZAPIER_ENV, async () => {
    const z = reloadProvider();
    const { captured } = await captureSend(z);
    const verified = z.verifySignedEnvelope({ rawBody: captured.body, secret: SECRET });
    assert.strictEqual(verified.ok, true);
    assert.ok(verified.signed_body);
  });
});

test("6 modified signed_body fails", async () => {
  await withEnv(ZAPIER_ENV, async () => {
    const z = reloadProvider();
    const { captured } = await captureSend(z);
    const outer = JSON.parse(captured.body);
    outer.signed_body = outer.signed_body.replace("owner@", "evil@");
    const wire = z.canonicalizeJson(outer);
    const verified = z.verifySignedEnvelope({ rawBody: wire, secret: SECRET });
    assert.strictEqual(verified.ok, false);
    assert.strictEqual(verified.code, "signature_mismatch");
  });
});

test("7 modified timestamp fails", async () => {
  await withEnv(ZAPIER_ENV, async () => {
    const z = reloadProvider();
    const { captured } = await captureSend(z);
    const outer = JSON.parse(captured.body);
    outer.timestamp = new Date(Date.now() - 60 * 1000).toISOString();
    const verified = z.verifySignedEnvelope({
      rawBody: z.canonicalizeJson(outer),
      secret: SECRET,
    });
    assert.strictEqual(verified.ok, false);
    assert.strictEqual(verified.code, "signature_mismatch");
  });
});

test("8 modified signature fails", async () => {
  await withEnv(ZAPIER_ENV, async () => {
    const z = reloadProvider();
    const { captured } = await captureSend(z);
    const outer = JSON.parse(captured.body);
    outer.signature = "ab".repeat(32);
    const verified = z.verifySignedEnvelope({
      rawBody: z.canonicalizeJson(outer),
      secret: SECRET,
    });
    assert.strictEqual(verified.ok, false);
    assert.strictEqual(verified.code, "signature_mismatch");
  });
});

test("9 stale timestamp fails", async () => {
  await withEnv(ZAPIER_ENV, async () => {
    const z = reloadProvider();
    const signedBody = z.canonicalizeJson(
      z.buildCanonicalPayload({
        ...invitationInput(),
        recipient_email: "owner@test.example",
        html_body: "<p>x</p>",
        text_body: "x",
      })
    );
    const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const sealed = z.buildSignedWireEnvelope({
      signedBody,
      timestamp: stale,
      secret: SECRET,
    });
    const verified = z.verifySignedEnvelope({
      rawBody: sealed.wire_body,
      secret: SECRET,
    });
    assert.strictEqual(verified.ok, false);
    assert.strictEqual(verified.code, "timestamp_stale");
  });
});

test("10 future timestamp fails", async () => {
  await withEnv(ZAPIER_ENV, async () => {
    const z = reloadProvider();
    const signedBody = z.canonicalizeJson(
      z.buildCanonicalPayload({
        ...invitationInput(),
        recipient_email: "owner@test.example",
        html_body: "<p>x</p>",
        text_body: "x",
      })
    );
    const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const sealed = z.buildSignedWireEnvelope({
      signedBody,
      timestamp: future,
      secret: SECRET,
    });
    const verified = z.verifySignedEnvelope({
      rawBody: sealed.wire_body,
      secret: SECRET,
    });
    assert.strictEqual(verified.ok, false);
    assert.strictEqual(verified.code, "timestamp_future");
  });
});

test("11 missing signed_body fails", () => {
  const z = reloadProvider();
  const verified = z.verifySignedEnvelope({
    envelope: {
      envelope_schema_version: "1",
      timestamp: new Date().toISOString(),
      signature: "ab".repeat(32),
    },
    secret: SECRET,
  });
  assert.strictEqual(verified.ok, false);
  assert.strictEqual(verified.code, "signed_body_missing");
});

test("12 missing signature fails", () => {
  const z = reloadProvider();
  const verified = z.verifySignedEnvelope({
    envelope: {
      envelope_schema_version: "1",
      timestamp: new Date().toISOString(),
      signature: "",
      signed_body: "{\"a\":1}",
    },
    secret: SECRET,
  });
  assert.strictEqual(verified.ok, false);
  assert.strictEqual(verified.code, "signature_missing");
});

test("13 invalid outer JSON fails", () => {
  const z = reloadProvider();
  const verified = z.verifySignedEnvelope({
    rawBody: "not-json{",
    secret: SECRET,
  });
  assert.strictEqual(verified.ok, false);
  assert.strictEqual(verified.code, "envelope_not_json");
});

test("14 invalid inner JSON fails only after valid HMAC", async () => {
  await withEnv(ZAPIER_ENV, async () => {
    const z = reloadProvider();
    const badInner = "{not-json";
    const sealed = z.buildSignedWireEnvelope({
      signedBody: badInner,
      secret: SECRET,
    });
    // HMAC over the bad string still verifies — parse is the next gate.
    const verified = z.verifySignedEnvelope({
      rawBody: sealed.wire_body,
      secret: SECRET,
    });
    assert.strictEqual(verified.ok, true, "HMAC must pass before inner parse");

    const step2 = loadStep2();
    const out = await step2({
      raw_body: sealed.wire_body,
      hmac_secret: SECRET,
    });
    assertCompleteOut("14", out);
    assert.strictEqual(out.valid, "false");
    assert.strictEqual(out.validation_error, "body_not_json");
  });
});

test("15+16 Step 2 needs only raw_body + hmac_secret (no header mappings)", async () => {
  await withEnv(ZAPIER_ENV, async () => {
    const z = reloadProvider();
    const { captured } = await captureSend(z);
    const step2 = loadStep2();
    const step2Src = fs.readFileSync(STEP2, "utf8");
    assert.ok(!/inputData\.signature_header/.test(step2Src));
    assert.ok(!/inputData\.timestamp_header/.test(step2Src));
    assert.ok(!/inputData\.headers_json/.test(step2Src));
    assert.ok(step2Src.includes("inputData.raw_body"));
    assert.ok(step2Src.includes("inputData.hmac_secret"));

    // Call with ONLY the two mapped fields — no headers.
    const out = await step2({
      raw_body: captured.body,
      hmac_secret: SECRET,
    });
    assertCompleteOut("15", out);
    assert.strictEqual(out.valid, "true");
    assert.strictEqual(out.validation_error, "");
    assert.strictEqual(out.attempt_id, "99999999-9999-4999-8999-999999999999");
    assert.strictEqual(out.invitation_id, "22222222-2222-4222-8222-222222222222");
    assert.strictEqual(out.generation_number, "4");
    assert.strictEqual(out.recipient_email, "owner@test.example");
    assert.strictEqual(out.subject, "Your contract is ready to sign");
    assert.ok(out.html_body.includes("Sign here"));
    assert.ok(out.text_body.includes("Sign here"));
  });
});

test("17 Gmail output fields remain unchanged", async () => {
  await withEnv(ZAPIER_ENV, async () => {
    const z = reloadProvider();
    const { captured } = await captureSend(z);
    const step2 = loadStep2();
    const out = await step2({ raw_body: captured.body, hmac_secret: SECRET });
    // Same field names Gmail step already maps.
    for (const key of [
      "recipient_email",
      "subject",
      "html_body",
      "text_body",
      "reply_to",
      "from_name",
    ]) {
      assert.ok(out[key], "gmail field " + key);
    }
  });
});

test("18 callback contract unchanged", () => {
  const cb = read("netlify/functions/contract-invitation-email-zapier-callback.js");
  const emailLib = read("netlify/functions/_lib/contract-invitation-email.js");
  assert.ok(cb.includes("handleZapierEmailCallback"));
  assert.ok(emailLib.includes("`v1.callback.${String(rawBody || \"\")}`"));
  assert.ok(!cb.includes("signed_body"));
  assert.ok(!cb.includes("envelope_schema_version"));
  assert.ok(!emailLib.includes("buildSignedWireEnvelope"));
});

test("19 no real webhook / Gmail / callback in QA", () => {
  const self = read("scripts/qa-ch013a29-body-signed-envelope.js");
  assert.ok(!/hooks\.zapier\.com\/hooks\/catch\/(?!example)/.test(self));
  assert.ok(!/globalThis\.fetch\s*\(/.test(self));
  assert.ok(self.includes("fetchImpl"));
  assert.ok(fs.existsSync(CALLBACK));
  assert.ok(fs.existsSync(DOCS));
});

test("20 Step 2 failure paths still return complete Data Out", async () => {
  const step2 = loadStep2();
  const empty = await step2({});
  assertCompleteOut("empty", empty);
  assert.strictEqual(empty.valid, "false");

  const badOuter = await step2({ raw_body: "{", hmac_secret: SECRET });
  assertCompleteOut("badOuter", badOuter);
  assert.strictEqual(badOuter.validation_error, "envelope_not_json");
});

test("21 docs describe body-signed envelope", () => {
  const docs = fs.readFileSync(DOCS, "utf8");
  assert.ok(docs.includes("body-signed envelope"));
  assert.ok(docs.includes("signed_body"));
  assert.ok(docs.includes("envelope_schema_version"));
  assert.ok(docs.includes("raw_body"));
  assert.ok(docs.includes("hmac_secret"));
});

(async () => {
  for (const { name, fn } of pending) {
    try {
      await fn();
      console.log("PASS", name);
      passed += 1;
    } catch (err) {
      console.log("FAIL", name, "-", err && err.stack ? err.stack : err);
      failed += 1;
    }
  }
  console.log("\nCH-013A.2.9 body-signed envelope:", passed, "passed,", failed, "failed");
  process.exit(failed === 0 ? 0 : 1);
})();
