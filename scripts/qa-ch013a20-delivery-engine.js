/**
 * CH-013A.2.0 — Final one-time link audit + Delivery Channel Engine QA (offline).
 * Run: node scripts/qa-ch013a20-delivery-engine.js
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

const engine = require(path.join(ROOT, "netlify/functions/_lib/delivery-channel-engine.js"));
const builder = require(path.join(ROOT, "netlify/functions/_lib/signing-link-builder.js"));
const branding = require(path.join(ROOT, "netlify/functions/_lib/tenant-branding.js"));
const templates = require(path.join(ROOT, "netlify/functions/_lib/template-renderer.js"));
const copyLink = require(path.join(ROOT, "netlify/functions/_lib/channels/copy-link.js"));
const email = require(path.join(ROOT, "netlify/functions/_lib/channels/email.js"));
const sms = require(path.join(ROOT, "netlify/functions/_lib/channels/sms.js"));
const whatsapp = require(path.join(ROOT, "netlify/functions/_lib/channels/whatsapp.js"));
const esignHost = require(path.join(ROOT, "netlify/functions/_lib/channels/esign-host.js"));
const worker = require(path.join(ROOT, "netlify/functions/_lib/delivery-worker.js"));
const sendLib = read("netlify/functions/_lib/contract-envelope-send.js");
const swJs = read("public/js/signature-workspace.js");

const FILES = [
  "netlify/functions/_lib/delivery-channel-engine.js",
  "netlify/functions/_lib/signing-link-builder.js",
  "netlify/functions/_lib/tenant-branding.js",
  "netlify/functions/_lib/template-renderer.js",
  "netlify/functions/_lib/delivery-worker.js",
  "netlify/functions/_lib/channels/copy-link.js",
  "netlify/functions/_lib/channels/email.js",
  "netlify/functions/_lib/channels/sms.js",
  "netlify/functions/_lib/channels/whatsapp.js",
  "netlify/functions/_lib/channels/esign-host.js",
  "netlify/functions/_lib/contract-envelope-send.js",
  "public/js/signature-workspace.js",
  "scripts/qa-ch013a20-delivery-engine.js",
];

const FAKE_HASH =
  "a".repeat(64); // sha256-shaped — must never be accepted as URL token via token_hash field

// ---------------------------------------------------------------------------
// Audit coverage 1–20
// ---------------------------------------------------------------------------

test("syntax on all A.2.0 modules", () => {
  FILES.filter((f) => f.endsWith(".js")).forEach((rel) => {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), rel);
    checkSyntax(path.join(ROOT, rel));
  });
});

test("1. Builder with fresh raw token returns correct URL", () => {
  const built = builder.buildSigningLink({
    raw_token: "raw-token-abc",
    public_origin: "https://example.test",
  });
  assert.ok(built.ok);
  assert.ok(built.signing_link.url.includes("contract-sign"));
  assert.ok(built.signing_link.url.includes(encodeURIComponent("raw-token-abc")));
});

test("2. Builder without raw token rejects link construction", () => {
  const built = builder.buildSigningLink({});
  assert.ok(!built.ok);
  assert.strictEqual(built.code, "link_unavailable");
});

test("3. token_hash cannot be used as URL token", () => {
  const viaHash = builder.buildSigningLink({ token_hash: FAKE_HASH });
  assert.ok(!viaHash.ok);
  assert.ok(
    viaHash.code === "forbidden_token_source" || viaHash.code === "link_unavailable"
  );
  const withBoth = builder.buildSigningLink({
    raw_token: "ok-raw",
    token_hash: FAKE_HASH,
  });
  assert.ok(!withBoth.ok);
  assert.strictEqual(withBoth.code, "forbidden_token_source");
});

test("4. generation_id alone cannot reconstruct URL", () => {
  const built = builder.buildSigningLink({
    generation_id: "60361a64-0000-4000-8000-000000000001",
  });
  assert.ok(!built.ok);
  assert.ok(
    built.code === "forbidden_token_source" || built.code === "link_unavailable"
  );
  const tokenIdOnly = builder.buildSigningLink({
    token_id: "tok_id_only",
  });
  assert.ok(!tokenIdOnly.ok);
});

test("5. first COPY_LINK reveal succeeds once", async () => {
  engine._resetMemoryAttemptsForTests();
  const out = await engine.deliverCopyLink(
    {
      tenant_id: "11111111-1111-4111-8111-111111111111",
      public_origin: "https://example.test",
    },
    "once-token-1"
  );
  assert.ok(out.ok);
  assert.strictEqual(out.channel, "copy_link");
  assert.strictEqual(out.provider, "none");
  assert.ok(out.signing_url.includes("once-token-1") || out.signing_url.includes(encodeURIComponent("once-token-1")));
  assert.strictEqual(out.attempt.status, "ready");
});

test("6. idempotent retry has no signing_url without secret", async () => {
  engine._resetMemoryAttemptsForTests();
  const retry = await engine.deliverCopyLink({
    tenant_id: "11111111-1111-4111-8111-111111111111",
    public_origin: "https://example.test",
  });
  assert.ok(!retry.ok);
  assert.ok(
    retry.code === "link_unavailable" || /link_unavailable|raw token/i.test(retry.error || "")
  );
  assert.ok(!retry.signing_url);
});

test("7. refresh has no signing_url (no client rebuild; Policy A)", () => {
  assert.ok(swJs.includes("captureDeliveryLink"));
  assert.ok(swJs.includes("fromSendResponse"));
  assert.ok(/state\.signingLink\s*=\s*null/.test(swJs));
  assert.ok(!swJs.includes("sessionStorage"));
  assert.ok(!swJs.includes("localStorage"));
  // Workspace does not build URLs from token_hash / generation_id
  assert.ok(!/token_hash.*contract-sign|contract-sign.*token_hash/.test(swJs));
});

test("8. no raw token in persistent context", async () => {
  const built = await engine.buildDeliveryContext({
    tenant_id: "11111111-1111-4111-8111-111111111111",
    channel: "copy_link",
    raw_token_once: "secret-raw",
    oneShotSecret: "secret-raw",
    recipient: { email: "person@example.com", party_name: "P" },
  });
  assert.ok(built.ok);
  assert.strictEqual(built.context.raw_token_once, undefined);
  assert.strictEqual(built.context.oneShotSecret, undefined);
  assert.strictEqual(built.context.raw_token, undefined);
  assert.ok(!("token_hash" in built.context));
  assert.ok(built.context.masked_recipient.includes("***"));
  assert.ok(!built.context.recipient.email);

  const queued = await engine.queueDelivery({
    channel: "copy_link",
    tenant_id: "11111111-1111-4111-8111-111111111111",
    oneShotSecret: "secret-raw",
  });
  assert.ok(queued.ok);
  assert.ok(!queued.context.raw_token_once);
  assert.ok(!queued.context.oneShotSecret);
  const dumped = JSON.stringify(queued);
  assert.ok(!dumped.includes("secret-raw"));
});

test("9. no raw token or URL in logs/events/activity/notifications/storage", () => {
  const eng = read("netlify/functions/_lib/delivery-channel-engine.js");
  assert.ok(eng.includes("stubTransportEvent"));
  assert.ok(/delete safe\.signing_url|delete safe\.raw_token/.test(eng));
  assert.ok(!swJs.includes("sessionStorage"));
  assert.ok(!swJs.includes("localStorage"));
  // Send path: oneShotSecret separate; raw not written to durable event payloads in A.2.0 wiring
  assert.ok(sendLib.includes("deliverCopyLink"));
  assert.ok(sendLib.includes("prep.raw_token_once"));
  // Activity / notification paths must not stringify raw tokens into storage keys
  assert.ok(!/localStorage\.setItem.*token|sessionStorage\.setItem.*token/.test(swJs));
});

test("10. COPY_LINK performs zero network calls", async () => {
  const src = read("netlify/functions/_lib/channels/copy-link.js");
  assert.ok(!/fetch\(|https\.request|http\.request|axios|nodemailer|resend|twilio|smtp/i.test(src));
  engine._resetMemoryAttemptsForTests();
  const out = await copyLink.deliver(
    { branding: branding.DEFAULT_BRANDING, masked_recipient: "ab***@x.com" },
    { oneShotSecret: "net-tok", public_origin: "https://example.test" }
  );
  assert.ok(out.ok);
  assert.strictEqual(out.provider, "none");
});

test("11. COPY_LINK never claims email sent", () => {
  assert.ok(swJs.includes("Secure Link Ready"));
  assert.ok(swJs.includes("Link copied") || swJs.includes("No email has been sent"));
  assert.ok(swJs.includes("swCopyLinkBtn"));
  // Copy Link action itself must not claim provider delivery.
  assert.ok(!/Provider accepted|Delivered to provider/i.test(swJs));
  const copySrc = read("netlify/functions/_lib/channels/copy-link.js");
  assert.ok(/provider:\s*["']none["']/.test(copySrc));
  assert.ok(!/toast\(["']Email sent|ui_copy:\s*["']Email sent|["']Delivered["']/.test(copySrc));
});

test("12. Stub adapters fail closed", async () => {
  // CH-013A.2.1: email is a real adapter — fail-closed when delivery disabled.
  assert.strictEqual(email.isAvailable(), false);
  assert.ok(!email.health().ok);
  const emailDeliver = await email.deliver({}, {});
  assert.ok(!emailDeliver.ok);
  assert.ok(
    emailDeliver.code === "channel_unavailable" ||
      emailDeliver.code === "link_unavailable" ||
      /unavailable|NOT_IMPLEMENTED/i.test(String(emailDeliver.error || ""))
  );

  for (const stub of [sms, whatsapp, esignHost]) {
    const d = await stub.deliver();
    assert.ok(!d.ok);
    assert.ok(/NOT_IMPLEMENTED/i.test(d.error) || d.code === "not_implemented");
    assert.strictEqual(stub.isAvailable(), false);
    assert.ok(!stub.health().ok);
  }
});

test("13. Stub adapters cannot be resolved as active delivery channels", () => {
  for (const ch of ["email", "sms", "whatsapp", "esign_host"]) {
    const r = engine.resolve(ch, { activeOnly: true });
    assert.ok(!r.ok);
    assert.strictEqual(r.code, "channel_unavailable");
  }
  const copy = engine.resolve("copy_link", { activeOnly: true });
  assert.ok(copy.ok);
  assert.strictEqual(copy.available, true);
  const listed = engine.list();
  assert.ok(listed.some((x) => x.channel === "email" && x.available === false));
  assert.ok(listed.some((x) => x.channel === "copy_link" && x.available === true));
});

test("14. Branding defaults are tenant-neutral", async () => {
  const res = await branding.resolveTenantBranding(null);
  assert.ok(res.ok);
  assert.strictEqual(res.source, "defaults");
  assert.strictEqual(res.branding.business_name, "");
  const blob = JSON.stringify(res.branding).toLowerCase();
  assert.ok(!blob.includes("three colors"));
  assert.ok(!blob.includes("threecolors"));
});

test("15. Branding snapshot cannot be mutated across calls", async () => {
  const a = await branding.resolveTenantBranding(null);
  const b = await branding.resolveTenantBranding(null);
  assert.ok(Object.isFrozen(a.branding));
  assert.ok(Object.isFrozen(b.branding));
  assert.notStrictEqual(a.branding, b.branding);
  try {
    a.branding.business_name = "HACKED";
  } catch (_e) {
    /* freeze may throw in strict */
  }
  assert.strictEqual(a.branding.business_name, "");
  const b2 = await branding.resolveTenantBranding(null);
  assert.strictEqual(b2.branding.business_name, "");
});

test("16. Worker skeleton cannot run automatically", () => {
  assert.strictEqual(typeof worker.claim, "function");
  assert.strictEqual(typeof worker.dispatch, "function");
  assert.strictEqual(typeof worker.complete, "function");
  const src = read("netlify/functions/_lib/delivery-worker.js");
  assert.ok(src.includes("cannot run automatically") || src.includes("CH-013A.2.1"));
  assert.ok(!/setInterval|while\s*\(true\)|cron|setTimeout\s*\(\s*dispatch/i.test(src));
  assert.ok(src.includes("require.main === module"));
  const run = spawnSync(process.execPath, [path.join(ROOT, "netlify/functions/_lib/delivery-worker.js")], {
    encoding: "utf8",
  });
  assert.notStrictEqual(run.status, 0);
});

test("Template renderer normalized model; rejects raw token; no HTML", () => {
  const r = templates.renderTemplate({
    channel: "copy_link",
    branding: { business_name: "Acme" },
    signing_link: { url: "https://x/contract-sign?token=a" },
    recipient: { masked_email: "a***@b.com", email: "secret@b.com" },
    project: { project_name: "Job" },
  });
  assert.ok(r.ok);
  assert.strictEqual(r.payload.channel, "copy_link");
  assert.strictEqual(r.payload.branding.business_name, "Acme");
  assert.strictEqual(r.payload.recipient.email, undefined);
  assert.ok(!JSON.stringify(r.payload).includes("<html"));
  const bad = templates.renderTemplate({
    channel: "email",
    raw_token: "nope",
  });
  assert.ok(!bad.ok);
  assert.strictEqual(bad.code, "raw_token_forbidden");
});

test("Copy Link adapter uses SigningLinkBuilder only", async () => {
  const src = read("netlify/functions/_lib/channels/copy-link.js");
  assert.ok(src.includes("buildSigningLink"));
  assert.ok(!/resend|sendgrid|postmark|smtp|nodemailer/i.test(src));
});

test("deliverCopyLink does not return raw token; attempt stores no URL", async () => {
  engine._resetMemoryAttemptsForTests();
  const out = await engine.deliverCopyLink(
    { tenant_id: "11111111-1111-4111-8111-111111111111", public_origin: "https://example.test" },
    "tok-xyz"
  );
  assert.ok(out.ok);
  assert.ok(out.signing_url);
  assert.ok(!Object.prototype.hasOwnProperty.call(out, "raw_token_once"));
  assert.ok(!Object.prototype.hasOwnProperty.call(out, "oneShotSecret"));
  assert.ok(!out.attempt.result.signing_url);
  assert.strictEqual(out.attempt.result.provider, "none");
  assert.strictEqual(out.attempt.status, "ready");
});

(async () => {
  await Promise.all(pending);
  console.log("");

  const regs = [
    ["17. CH-013B", "scripts/qa-ch013b-wire-invitation.js"],
    ["18. CH-013A.1", "scripts/qa-ch013a1-signing-invitation.js"],
    ["19. CH-013A.0", "scripts/qa-ch013a0-platform-fabric.js"],
    ["20a. CH-011D", "scripts/qa-ch011d-signing-tokens.js"],
    ["20b. CH-011E", "scripts/qa-ch011e-envelope-send.js"],
    ["20c. CH-012D", "scripts/qa-ch012d-guided-workflow.js"],
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
      console.log((r.stdout || r.stderr || "").split(/\r?\n/).slice(-10).join("\n"));
    } else {
      passed += 1;
    }
  }

  console.log("");
  console.log(`CH-013A.2.0 delivery-engine QA: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
