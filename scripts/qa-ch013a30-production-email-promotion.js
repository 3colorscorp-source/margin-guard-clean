/**
 * CH-013A.30 — Promote contract email from internal testing to production.
 * Run: node scripts/qa-ch013a30-production-email-promotion.js
 * Never calls Zapier. Never sends email.
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

function checkSyntax(rel) {
  const r = spawnSync(process.execPath, ["--check", path.join(ROOT, rel)], {
    encoding: "utf8",
  });
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || rel);
}

function withEnv(vars, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined || v === null) delete process.env[k];
    else process.env[k] = String(v);
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function reload(rel) {
  const abs = path.join(ROOT, rel);
  delete require.cache[require.resolve(abs)];
  return require(abs);
}

let passed = 0;
let failed = 0;
const pending = [];
function test(name, fn) {
  pending.push({ name, fn });
}

const swJs = read("public/js/signature-workspace.js");
const swHtml = read("public/signature-workspace.html");
const emailLib = read("netlify/functions/_lib/contract-invitation-email.js");
const zapierSrc = read("netlify/functions/_lib/providers/zapier-provider.js");
const channelSrc = read("netlify/functions/_lib/channels/email.js");
const docsSrc = read("docs/CH-013A21Z-ZAPIER-CONTRACT-EMAIL.md");

test("0 syntax", () => {
  [
    "netlify/functions/_lib/providers/zapier-provider.js",
    "netlify/functions/_lib/providers/resend-provider.js",
    "netlify/functions/_lib/contract-invitation-email.js",
    "netlify/functions/_lib/channels/email.js",
    "public/js/signature-workspace.js",
  ].forEach(checkSyntax);
});

test("1 UI has no Internal email testing only", () => {
  assert.ok(!/Internal email testing only/i.test(swHtml));
  assert.ok(!/Internal email testing only/i.test(swJs));
  assert.ok(!swHtml.includes("swEmailInternalNotice"));
});

test("2 UI email status labels are production-facing", () => {
  assert.ok(swJs.includes('return "Email sent"'));
  assert.ok(swJs.includes('return "Delivery failed"'));
  assert.ok(swJs.includes('return "Sending..."'));
  assert.ok(!swJs.includes('return "Email attempt stalled"'));
  assert.ok(!swJs.includes("Email accepted — finalizing status"));
  assert.ok(!swJs.includes('? "Email queued"'));
  assert.ok(!swJs.includes(': "Email queued"'));
});

test("3 capability is not internal_testing", () => {
  assert.ok(emailLib.includes("internal_testing: false"));
  assert.ok(!emailLib.includes("internal_testing: true"));
  assert.ok(!emailLib.includes("Internal email testing only"));
});

test("4 allowlist no longer blocks valid recipients", () => {
  withEnv(
    {
      CONTRACT_EMAIL_DELIVERY_ENABLED: "true",
      CONTRACT_EMAIL_ZAPIER_WEBHOOK_URL: "https://hooks.zapier.com/hooks/catch/example/test",
      CONTRACT_EMAIL_ZAPIER_HMAC_SECRET: "secret",
      CONTRACT_EMAIL_INTERNAL_ALLOWLIST: "",
    },
    () => {
      const z = reload("netlify/functions/_lib/providers/zapier-provider.js");
      assert.strictEqual(z.isRecipientAllowlisted("customer@example.com"), true);
      assert.strictEqual(z.isRecipientAllowlisted("bad"), false);
    }
  );
  assert.ok(!channelSrc.includes("internal_recipient_only"));
  assert.ok(!zapierSrc.includes('error_code: "internal_recipient_only"'));
});

test("5 HMAC / envelope / callback architecture unchanged", () => {
  assert.ok(zapierSrc.includes("buildSignedWireEnvelope"));
  assert.ok(zapierSrc.includes("signed_body"));
  assert.ok(zapierSrc.includes("signCanonicalBody(signedBody, timestamp, secret)"));
  assert.ok(emailLib.includes("`v1.callback.${String(rawBody || \"\")}`"));
  assert.ok(docsSrc.includes("body-signed envelope") || docsSrc.includes("signed_body"));
});

test("6 forbidden production test-mode strings absent from email system", () => {
  const blob = [swJs, swHtml, emailLib, zapierSrc, channelSrc].join("\n");
  for (const bad of [
    "internal_test",
    "email_testing",
    "debug_email",
    "sandbox_email",
    "force_test",
    "development_mode",
    "test_mode",
    "qa_only",
  ]) {
    assert.ok(!new RegExp("\\b" + bad + "\\b").test(blob), "found " + bad);
  }
});

test("7 Email Signing Link remains the production action", () => {
  assert.ok(swJs.includes("Email Signing Link"));
  assert.ok(swHtml.includes('id="swEmailLinkBtn"'));
  assert.ok(swJs.includes("cap.enabled === true"));
  assert.ok(swJs.includes("cap.recipient_allowed === true"));
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
  console.log("\nCH-013A.30 production email promotion:", passed, "passed,", failed, "failed");
  process.exit(failed === 0 ? 0 : 1);
})();
