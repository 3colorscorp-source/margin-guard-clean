/**
 * CH-012 / PR2 — Signature Workspace status + email copy.
 * Static + pure helpers. Does not queue, dispatch, or send email.
 * Run: node scripts/qa-ch012a-signature-workspace-copy.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const htmlPath = path.join(ROOT, "public/signature-workspace.html");
const jsPath = path.join(ROOT, "public/js/signature-workspace.js");
const html = fs.readFileSync(htmlPath, "utf8");
const js = fs.readFileSync(jsPath, "utf8");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log("PASS", name);
    passed += 1;
  } catch (err) {
    console.log("FAIL", name, "-", err.message);
    failed += 1;
  }
}

function loadHelpers() {
  const begin = js.indexOf("/* MG_SW_STATUS_BEGIN */");
  const end = js.indexOf("/* MG_SW_STATUS_END */");
  assert.ok(begin >= 0 && end > begin, "status helpers markers missing");
  const chunk = js.slice(begin, end + "/* MG_SW_STATUS_END */".length);
  const ctx = {};
  vm.runInNewContext(
    `${chunk}
this.mgSwIsEmailAlreadySent = mgSwIsEmailAlreadySent;
this.mgSwIsEmailDeliveryFailed = mgSwIsEmailDeliveryFailed;
this.mgSwIsEmailDeliveryInFlight = mgSwIsEmailDeliveryInFlight;
this.mgSwResolveSigningEmailMessage = mgSwResolveSigningEmailMessage;
`,
    ctx
  );
  return ctx;
}

const helpers = loadHelpers();

test("syntax signature-workspace.js", () => {
  const r = spawnSync(process.execPath, ["--check", jsPath], { encoding: "utf8" });
  assert.strictEqual(r.status, 0, r.stderr || r.stdout);
});

test("1. env=sent + email status sent shows sent; never 'No email has been sent yet'", () => {
  const msg = helpers.mgSwResolveSigningEmailMessage("sent", { canCopy: true });
  assert.strictEqual(msg, "The signing email was sent successfully.");
  assert.ok(!msg.includes("No email has been sent yet"));
  assert.ok(helpers.mgSwIsEmailAlreadySent("sent"));
  assert.ok(js.includes("mgSwResolveSigningEmailMessage(state.emailUiStatus"));
});

test("2. env=sent + prepared/not_sent keeps prepared + not-sent copy", () => {
  const msg = helpers.mgSwResolveSigningEmailMessage(null, { canCopy: true });
  assert.ok(msg.includes("The signing request is prepared"));
  assert.ok(msg.includes("No email has been sent yet"));
  const ready = helpers.mgSwResolveSigningEmailMessage("ready", { canCopy: false });
  assert.strictEqual(
    ready,
    "The signing request is prepared. No email has been sent yet."
  );
  assert.ok(!helpers.mgSwIsEmailAlreadySent("ready"));
  assert.ok(!helpers.mgSwIsEmailAlreadySent(""));
});

test("3. email status failed shows error/retry and not success", () => {
  const msg = helpers.mgSwResolveSigningEmailMessage("failed", { canCopy: true });
  assert.ok(msg.includes("could not be delivered") || msg.includes("Retry"));
  assert.ok(!msg.includes("was sent successfully"));
  assert.ok(!msg.includes("No email has been sent yet"));
  assert.ok(helpers.mgSwIsEmailDeliveryFailed("failed"));
  assert.ok(helpers.mgSwIsEmailDeliveryFailed("stalled"));
  assert.ok(!helpers.mgSwIsEmailAlreadySent("failed"));
});

test("4. refresh/hydration with delivery sent keeps sent message", () => {
  assert.ok(js.includes("async function hydrateEmailDeliveryStatus"));
  assert.ok(js.includes("await hydrateEmailDeliveryStatus()"));
  assert.ok(js.includes("applyEmailStatusPayload"));
  assert.ok(js.includes("state.emailUiStatus = ui"));
  const afterHydrate = helpers.mgSwResolveSigningEmailMessage("sent", {
    canCopy: true,
  });
  assert.strictEqual(afterHydrate, "The signing email was sent successfully.");
  assert.ok(!afterHydrate.includes("No email has been sent yet"));
  assert.ok(!js.includes("state.delivery?.invitations?.length"));
});

test("5. Step 6 is signing-complete, not project-complete, and does not write project status", () => {
  assert.ok(html.includes("Contract Signing Complete"));
  assert.ok(
    html.includes("The contract has been signed and the final documents are ready.")
  );
  assert.ok(!html.includes("Project Completed"));
  assert.ok(!js.includes("Project Completed"));
  assert.ok(!html.includes("Everything is finished."));
  assert.ok(!js.includes("Everything is finished."));
  assert.ok(!js.includes("tenant_projects"));
  assert.ok(!/status\s*:\s*["']completed["']/.test(js));
  assert.ok(!js.includes("upsert-tenant-project"));
});

test("tests do not send email", () => {
  assert.ok(js.includes('delivery_mode: "prepared"'));
  assert.ok(!js.includes("sendgrid"));
  assert.ok(!js.includes("nodemailer"));
  assert.ok(typeof helpers.mgSwResolveSigningEmailMessage === "function");
});

test("existing emailUiStatus remains the delivery truth", () => {
  assert.ok(js.includes("state.emailUiStatus"));
  assert.ok(js.includes("function hydrateEmailDeliveryStatus"));
  assert.ok(helpers.mgSwIsEmailDeliveryInFlight("queued"));
  assert.ok(helpers.mgSwIsEmailDeliveryInFlight("sending"));
  assert.ok(helpers.mgSwIsEmailDeliveryInFlight("accepted_db_pending"));
});

console.log("");
console.log(`CH-012A signature workspace copy QA: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
