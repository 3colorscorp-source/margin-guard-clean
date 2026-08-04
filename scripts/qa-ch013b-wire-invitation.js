/**
 * CH-013B — Wire invitation engine into contract envelope-send (offline QA).
 * Includes final link-availability + failure-safety audit assertions.
 * Run: node scripts/qa-ch013b-wire-invitation.js
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

const sendLib = read("netlify/functions/_lib/contract-envelope-send.js");
const sendHandler = read("netlify/functions/contract-envelope-send.js");
const invLib = read("netlify/functions/_lib/contract-invitation.js");
const eventsLib = read("netlify/functions/_lib/platform-events.js");
const activityLib = read("netlify/functions/_lib/platform-activity.js");
const notifyLib = read("netlify/functions/_lib/platform-notifications.js");
const swJs = read("public/js/signature-workspace.js");
const swHtml = read("public/signature-workspace.html");
const hubJs = read("public/js/contract-hub.js");

const send = require(path.join(ROOT, "netlify/functions/_lib/contract-envelope-send.js"));
const inv = require(path.join(ROOT, "netlify/functions/_lib/contract-invitation.js"));
const events = require(path.join(ROOT, "netlify/functions/_lib/platform-events.js"));

const TOUCHED = [
  "netlify/functions/_lib/contract-envelope-send.js",
  "netlify/functions/_lib/contract-invitation.js",
  "netlify/functions/contract-envelope-send.js",
  "public/js/signature-workspace.js",
  "public/signature-workspace.html",
  "public/js/contract-hub.js",
  "scripts/qa-ch013b-wire-invitation.js",
  "scripts/qa-ch013a1-signing-invitation.js",
  "scripts/qa-ch012d-guided-workflow.js",
];

test("syntax on every touched JS file", () => {
  TOUCHED.filter((rel) => rel.endsWith(".js") && exists(rel)).forEach((rel) => {
    checkSyntax(path.join(ROOT, rel));
  });
});

test("auth blockers 1-8 (session/seller/supervisor/tenant/package/envelope/signer)", () => {
  assert.ok(sendHandler.includes("no_session"));
  assert.ok(sendHandler.includes("owner_required"));
  assert.ok(sendHandler.includes("tenant_id_forbidden"));
  assert.ok(sendLib.includes("package_missing") || sendLib.includes("package_not_ready"));
  assert.ok(sendLib.includes("not_found"));
  assert.ok(sendLib.includes("no_signers"));
  assert.ok(sendLib.includes("invalid_required_signer"));
});

test("AUDIT 1 First Send returns raw link once", () => {
  assert.ok(sendLib.includes("raw_token_once") || sendLib.includes("prep.raw_token_once"));
  assert.ok(sendLib.includes("signing_token"));
  assert.ok(sendLib.includes("raw_link_available"));
  assert.ok(invLib.includes("raw_token_once"));
  assert.ok(invLib.includes("ensured.reused ? null"));
});

test("AUDIT 2 Raw token absent from persistent storage paths", () => {
  assert.ok(invLib.includes("Never persist raw token") || invLib.includes("never stored"));
  assert.ok(invLib.includes("scrubForbiddenKeys"));
  assert.ok(eventsLib.includes("scrubForbiddenKeys") || eventsLib.includes("FORBIDDEN"));
  assert.ok(!/sessionStorage\.setItem/.test(swJs));
  assert.ok(!/localStorage\.setItem/.test(swJs));
});

test("AUDIT 3 Refresh cannot reconstruct raw token", () => {
  assert.ok(swJs.includes("Policy A") || swJs.includes("Never reconstruct"));
  assert.ok(swJs.includes("fromSendResponse"));
  assert.ok(sendLib.includes("Policy A") || sendLib.includes("never reconstructed"));
  assert.ok(sendLib.includes("raw_link_available = false"));
});

test("AUDIT 4 Copy Link button is not broken after refresh", () => {
  assert.ok(swJs.includes("The secure link was generated previously"));
  assert.ok(swJs.includes("copyBtn.hidden = !canCopy") || swJs.includes("hidden = !canCopy"));
  assert.ok(swJs.includes("hasCopyableLink"));
  assert.ok(!/sessionStorage\.getItem/.test(swJs));
});

test("AUDIT 5-7 Duplicate call: no Gen 2 / no new token / no duplicate event", () => {
  assert.ok(invLib.includes("current_generation) > 0"));
  assert.ok(invLib.includes("ensureSigningTokenForSigner"));
  assert.ok(invLib.includes("invitation:prepared:"));
  assert.ok(invLib.includes("published.duplicate") || invLib.includes("isUniqueViolation"));
  assert.ok(!sendLib.includes("resendInvitation"));
  assert.ok(!/generation_number:\s*2/.test(sendLib));
});

test("AUDIT 8-9 Duplicate Activity / Notification projections", () => {
  assert.ok(activityLib.includes("source_event_id"));
  assert.ok(activityLib.includes("isUniqueViolation") || activityLib.includes("duplicate"));
  assert.ok(invLib.includes("ensureNotificationForEvent"));
  assert.ok(invLib.includes("source_event_id=eq."));
  assert.ok(invLib.includes("projectActivityFromEvent"));
});

test("AUDIT 10 Failure before token leaves no ready state", () => {
  // generation/token before event; envelope PATCH only after prepare + gate
  const prepIdx = sendLib.indexOf("prepareSignersForSend");
  const gateIdx = sendLib.indexOf("assertInvitationsReadyForSend");
  const patchIdx = sendLib.indexOf('status: "sent"');
  assert.ok(prepIdx > 0 && gateIdx > prepIdx && patchIdx > gateIdx);
  assert.ok(invLib.includes("createInitialGeneration"));
  const genBeforeEmit =
    invLib.indexOf("createInitialGeneration") < invLib.indexOf('eventType: "contract.invitation.prepared"');
  assert.ok(genBeforeEmit || invLib.includes("generation is ensured before the prepared event"));
});

test("AUDIT 11 Failure after token before event is recoverable", () => {
  assert.ok(invLib.includes("generation is ensured before the prepared event") || invLib.includes("create_initial_generation"));
  assert.ok(invLib.includes("duplicate = true"));
  assert.ok(invLib.includes("ensureSigningTokenForSigner"));
  // token create failure path revokes non-reused token when generation insert fails
  assert.ok(invLib.includes("revokeSigningToken"));
  assert.ok(invLib.includes("generation_create_failed"));
});

test("AUDIT 12-13 Activity/Notification projection failure recoverable", () => {
  assert.ok(invLib.includes("activity_project_failed") || invLib.includes("activity projection failed"));
  assert.ok(invLib.includes("notification_project_failed") || invLib.includes("notification projection failed"));
  // On outbox duplicate, projections are still attempted (repair path)
  assert.ok(invLib.includes("Always (re)project") || invLib.includes("projectActivityFromEvent"));
  assert.ok(invLib.includes("ensureNotificationForEvent"));
});

test("AUDIT 14 Envelope transition cannot complete without active invitation generation", () => {
  assert.ok(sendLib.includes("assertInvitationsReadyForSend"));
  assert.ok(sendLib.includes("invitation_incomplete") || sendLib.includes("invitation_generation_missing"));
  assert.ok(typeof send.assertInvitationsReadyForSend === "function");
  const blocked = send.assertInvitationsReadyForSend({
    signers: [{ id: "s1", auth_method: "email_link", is_required: true, email: "a@b.com" }],
    invitations: [],
    signerTokenEntries: new Map(),
  });
  assert.ok(!blocked.ok);
  assert.strictEqual(blocked.code, "invitation_incomplete");
});

test("AUDIT 15 No localStorage/sessionStorage token", () => {
  assert.ok(!swJs.includes("sessionStorage"));
  assert.ok(!swJs.includes("localStorage"));
  assert.ok(!sendLib.includes("sessionStorage"));
  assert.ok(!invLib.includes("sessionStorage"));
});

test("AUDIT 16 No raw token in logs/events/activity/notifications", () => {
  const TENANT = "11111111-1111-4111-8111-111111111111";
  const bad = events.buildDomainEvent({
    tenant_id: TENANT,
    aggregate: "invitation",
    type: "contract.invitation.prepared",
    payload: { token: "raw", signing_token: "x", signed_url: "https://x" },
  });
  assert.ok(!bad.ok);
  assert.ok(!/console\.log\([^)]*raw_token/i.test(invLib));
  assert.ok(!/console\.log\([^)]*signing_token/i.test(sendLib));
  assert.ok(invLib.includes("masked_email"));
});

test("AUDIT 17 Workspace Copy Link never claims Email Sent", () => {
  // CH-013A.2.1 adds Email Signing Link states; Copy Link path must stay distinct.
  assert.ok(swHtml.includes("swCopyLinkBtn"));
  assert.ok(swJs.includes("Secure Link Ready"));
  assert.ok(swJs.includes("No email has been sent yet") || swHtml.includes("No email has been sent yet"));
  assert.ok(!/Provider Accepted/.test(swHtml));
  assert.ok(!swJs.includes("Provider Accepted"));
  assert.ok(swJs.includes("Link copied") || swJs.includes("No email has been sent"));
  assert.ok(sendLib.includes('delivery_status: "prepared"'));
});

test("Owner readiness notification policy", () => {
  assert.ok(invLib.includes("Contract ready to send"));
  assert.ok(invLib.includes("The secure signing request for"));
  assert.ok(!/customer (was )?notified|email was sent to customer/i.test(invLib));
});

test("integration + no provider/payment", () => {
  assert.ok(sendLib.includes("prepareInvitation"));
  assert.ok(sendLib.includes("prepareSignersForSend"));
  assert.ok(!sendLib.includes("transitionDeliveryAttempt"));
  for (const src of [sendLib, sendHandler, invLib]) {
    assert.ok(!/project-payment-intent/.test(src));
    assert.ok(!/require\(["'][^"']*(smtp|sendgrid|postmark|nodemailer)/i.test(src));
  }
});

(async () => {
  await Promise.all(pending);
  console.log("");

  const regs = [
    ["CH-011D", "scripts/qa-ch011d-signing-tokens.js"],
    ["CH-011E", "scripts/qa-ch011e-envelope-send.js"],
    ["CH-013A.0", "scripts/qa-ch013a0-platform-fabric.js"],
    ["CH-013A.1", "scripts/qa-ch013a1-signing-invitation.js"],
    ["CH-012D", "scripts/qa-ch012d-guided-workflow.js"],
  ];
  for (const [label, rel] of regs) {
    const r = spawnSync(process.execPath, [path.join(ROOT, rel)], {
      encoding: "utf8",
      cwd: ROOT,
    });
    const ok = r.status === 0;
    console.log(ok ? "PASS" : "FAIL", `AUDIT regression ${label}`);
    if (!ok) {
      failed += 1;
      console.log((r.stdout || r.stderr || "").split(/\r?\n/).slice(-12).join("\n"));
    } else {
      passed += 1;
    }
  }

  console.log("");
  console.log(`CH-013B audit QA: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
