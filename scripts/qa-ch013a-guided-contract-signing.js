/**
 * Guided Contract Workflow UX — owner-facing copy and action hierarchy.
 * Static QA only. No backend, no email, no live contracts.
 * Run: node scripts/qa-ch013a-guided-contract-signing.js
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

function slice(src, startNeedle, endNeedle) {
  const start = src.indexOf(startNeedle);
  const end = src.indexOf(endNeedle, start + 1);
  assert.ok(start >= 0, "missing start " + startNeedle);
  assert.ok(end > start, "missing end " + endNeedle);
  return src.slice(start, end);
}

function countPrimary(fragment) {
  return (fragment.match(/class="btn primary"/g) || []).length;
}

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

const visHtml = slice(html, 'id="swVisWorkspace"', 'id="swAdvancedDetails"');
const step1 = slice(html, 'id="swVisStep1"', 'id="swVisStep2"');
const step2 = slice(html, 'id="swVisStep2"', 'id="swVisStep3"');
const step3 = slice(html, 'id="swVisStep3"', 'id="swVisStep4"');
const step4 = slice(html, 'id="swVisStep4"', 'id="swVisStep5"');
const step5 = slice(html, 'id="swVisStep5"', 'id="swVisStep6"');
const step6 = slice(html, 'id="swVisStep6"', 'id="swAdvancedDetails"');

test("0 syntax signature-workspace.js", () => {
  const r = spawnSync(process.execPath, ["--check", jsPath], { encoding: "utf8" });
  assert.strictEqual(r.status, 0, r.stderr || r.stdout);
});

test("1 new user identifies the first CTA without guessing", () => {
  assert.ok(step1.includes("Start here. Review the contract, then sign as the contractor."));
  assert.ok(step1.includes("Review &amp; Sign Contract") || step1.includes("Review & Sign Contract"));
  assert.ok(step1.includes('id="swVisContinueBtn"'));
  assert.ok(step1.includes("Next: confirm the customer and send the signing link."));
  assert.ok(step1.includes('aria-describedby="swVis1Now swVis1Next"'));
  assert.ok(!step1.includes("View Contract"));
  assert.ok(js.includes('cta1.textContent = "Review & Sign Contract"'));
});

test("2 only one primary CTA per visual state", () => {
  assert.strictEqual(countPrimary(step1), 1, "step 1 extra primary");
  assert.ok(step2.includes('id="swVisSendContractBtn"'));
  assert.ok(step2.includes('id="swVisRetryPrimaryBtn" hidden'));
  assert.ok(js.includes("sendVis.hidden = emailAlreadySent || emailFailed || emailInFlight"));
  assert.ok(js.includes("retryPrimary.hidden = !emailFailed"));
  assert.ok(step4.includes('id="swVisIssueCertBtn" hidden'));
  assert.ok(step5.includes('id="swVisGeneratePdfBtn" hidden'));
  assert.ok(js.includes('sendVis.textContent = "Confirm Customer & Send"'));
  assert.ok(js.includes("forceHidden: !showCertFallback"));
  assert.ok(js.includes("forceHidden: !showPdfFallback"));
  assert.ok(step3.includes("Copy Signing Link"));
  assert.ok(!/class="btn primary"/.test(step3));
});

test("3 Step 1 leads Review → Contractor Signature", () => {
  assert.ok(js.includes('$("swViewFrozenBtn")?.click()'));
  assert.ok(js.includes("Continue to Contractor Signature"));
  assert.ok(js.includes("void continueAfterReview()"));
  assert.ok(js.includes("openSignContractorModal()"));
  assert.ok(js.includes("Step 1 of 2: Enter your name and confirm your signature."));
  assert.ok(js.includes("Sign as Contractor"));
  assert.ok(js.includes("swContractorTypedName"));
  assert.ok(js.includes("swContractorConsent"));
  assert.ok(js.includes("consent_esign: true"));
  assert.ok(!js.includes("Continue to Send"));
});

test("4 after contractor signature continues to Customer", () => {
  assert.ok(js.includes("Contractor signature completed."));
  assert.ok(js.includes('btn("Continue to Customer"'));
  assert.ok(js.includes("showContractorSignSuccess"));
  assert.ok(js.includes("openConfirmCustomerModal()"));
  assert.ok(js.includes("if (isDualSigning() && isContractorSigned()) return 2"));
});

test("5 confirmed customer leads to Send", () => {
  assert.ok(step2.includes("Confirm the customer’s name and email, then send the signing link.") ||
    step2.includes("Confirm the customer&rsquo;s name and email, then send the signing link.") ||
    html.includes("Confirm the customer’s name and email, then send the signing link."));
  assert.ok(step2.includes("Confirm Customer &amp; Send") || step2.includes("Confirm Customer & Send"));
  assert.ok(js.includes('btn("Confirm Customer & Send"'));
  assert.ok(js.includes("saveGuidedCustomerSigner"));
  assert.ok(js.includes("prepareSigningLinkIfNeeded"));
  assert.ok(js.includes('$("swEmailLinkBtn")?.click()'));
  assert.ok(!step2.includes("Create Envelope"));
  assert.ok(!step2.includes("Add Signer"));
  assert.ok(!step2.includes("Queue Email"));
  assert.ok(!visHtml.includes("Create Envelope"));
  assert.ok(!visHtml.includes("Add Signer"));
  assert.ok(!visHtml.includes("Queue Email"));
  assert.ok(!visHtml.toLowerCase().includes("token"));
  assert.ok(!/\bpackage\b/i.test(visHtml));
});

test("6 waiting copy never claims sent while delivery is in flight", () => {
  assert.ok(js.includes("function mgSwGuidedDeliveryCopy"));
  assert.ok(js.includes("Please wait while delivery is confirmed."));
  assert.ok(js.includes("Sending to Customer"));
  assert.ok(js.includes("if (emailFailed) return 2"));
  assert.ok(js.includes('primaryCta: "Retry Sending Email"'));
  assert.ok(step3.includes("Copy Signing Link"));
  assert.ok(!step3.includes("class=\"btn primary\""));
});

test("7 dual signing does not complete with one signature", () => {
  assert.ok(js.includes("isDualSigning() && !isContractorSigned()"));
  assert.ok(js.includes("Sign as the contractor before sending to the customer."));
  assert.ok(js.includes("SIGN_CONTRACTOR_API"));
  assert.ok(!/contract-sign-contractor[\s\S]{0,800}status:\s*['\"]completed['\"]/.test(js));
  assert.ok(js.includes('delivery_mode: "prepared"'));
  assert.ok(js.includes("continueAfterReview"));
});

test("8 customer-only path does not require contractor signature", () => {
  assert.ok(js.includes("if (!isDualSigning())"));
  assert.ok(js.includes('cta1.textContent = "Review Contract"'));
  assert.ok(js.includes("Start here. Review the contract, then confirm the customer and send the signing link."));
  assert.ok(js.includes('? "Continue to Contractor Signature"'));
  assert.ok(js.includes(': "Continue to Customer"'));
  const continueFn = slice(js, "async function continueAfterReview()", "function showContractorSignSuccess");
  assert.ok(continueFn.includes("if (!isDualSigning())"));
  assert.ok(continueFn.includes("openConfirmCustomerModal()"));
  assert.ok(continueFn.indexOf("if (!isDualSigning())") < continueFn.indexOf("openSignContractorModal()"));
});

test("9 Step 6 keeps Contract Signing Complete", () => {
  assert.ok(step6.includes("Contract Signing Complete"));
  assert.ok(!step6.includes("Project Completed"));
  assert.ok(!js.includes("Project Completed"));
  assert.ok(js.includes('setText("swVis6Title", "Contract Signing Complete")'));
});

test("10 no tenant technical language in visual workflow; backend files untouched", () => {
  assert.ok(!visHtml.includes("Create Envelope"));
  assert.ok(!visHtml.includes("Add Signer"));
  assert.ok(!visHtml.includes("Queue Email"));
  assert.ok(!js.includes("content_hash") || js.includes("shortHash(pkg?.content_hash)"));
  const reviewStart = js.indexOf('$("swViewFrozenBtn")?.addEventListener');
  const reviewEnd = js.indexOf('$("swIssueCertBtn")?.addEventListener');
  assert.ok(reviewStart >= 0 && reviewEnd > reviewStart, "review modal slice");
  const reviewModal = js.slice(reviewStart, reviewEnd);
  assert.ok(!reviewModal.includes("Technical Verification"));
  assert.ok(!reviewModal.includes("content_hash"));
  const diff = spawnSync(
    "git",
    ["diff", "--name-only", "--", "netlify/", "docs/"],
    { cwd: ROOT, encoding: "utf8" }
  );
  assert.strictEqual(diff.status, 0, diff.stderr);
  const files = diff.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  assert.deepStrictEqual(files, [], "backend/docs changed: " + files.join(", "));
});

test("11 accessibility + responsive markers", () => {
  assert.ok(html.includes('aria-describedby="swVis1Now swVis1Next"'));
  assert.ok(html.includes('aria-describedby="swVis2Now swVis2Why"'));
  assert.ok(html.includes('aria-live="polite"'));
  assert.ok(js.includes('label for="swFormName"'));
  assert.ok(js.includes("focusable?.focus()"));
  assert.ok(html.includes("@media (min-width: 980px)"));
  assert.ok(html.includes("@media (max-width: 390px)"));
  assert.ok(html.includes("grid-template-columns: minmax(0, 1fr)"));
  assert.ok(html.includes(".sw-vis-step .sw-vis-now"));
});

test("12 automatic documents copy does not promise closed-page work", () => {
  assert.ok(js.includes("function mgSwCreateAutoDocsSession"));
  assert.ok(js.includes("function maybeAutoPrepareDocuments"));
  const autoFn = js.slice(
    js.indexOf("async function runAutoPrepareDocuments"),
    js.indexOf("function computeSendReadiness")
  );
  assert.ok(autoFn.includes("session.maybePrepare(envelope)"));
  assert.ok(autoFn.includes("mgSwShouldApplyAutoDocsResult"));
  assert.ok(!autoFn.includes(".click()"));
  assert.ok(!autoFn.includes("swIssueCertBtn"));
  assert.ok(!autoFn.includes("swGeneratePdfBtn"));
  assert.ok(js.includes("CERT_CREATE_API"));
  assert.ok(js.includes("PDF_CREATE_API"));
  assert.ok(
    html.includes("Final documents are prepared automatically when Contract Workflow is open.")
  );
  assert.ok(!step4.includes("Your legal certificate is being prepared automatically."));
});

function loadGuidedHelpers() {
  const begin = js.indexOf("/* MG_SW_STATUS_BEGIN */");
  const end = js.indexOf("/* MG_SW_STATUS_END */");
  assert.ok(begin >= 0 && end > begin, "status helpers missing");
  const chunk = js.slice(begin, end + "/* MG_SW_STATUS_END */".length);
  const ctx = {};
  vm.runInNewContext(
    `${chunk}
this.mgSwIsEmailAlreadySent = mgSwIsEmailAlreadySent;
this.mgSwIsEmailDeliveryFailed = mgSwIsEmailDeliveryFailed;
this.mgSwIsEmailDeliveryInFlight = mgSwIsEmailDeliveryInFlight;
this.mgSwGuidedDeliveryCopy = mgSwGuidedDeliveryCopy;
`,
    ctx
  );
  return ctx;
}

function claimsSent(text) {
  return /\bsent\b/i.test(String(text || ""));
}

test("13 emailUiStatus queued/sending/accepted_db_pending never claim sent", () => {
  const h = loadGuidedHelpers();
  ["queued", "sending", "accepted_db_pending"].forEach((status) => {
    const copy = h.mgSwGuidedDeliveryCopy(status, { email: "ada@example.com" });
    assert.strictEqual(copy.panel, "sending", status);
    assert.strictEqual(copy.visualStep, 3, status);
    assert.strictEqual(copy.title, "Sending to Customer", status);
    assert.strictEqual(
      copy.now,
      "Sending the signing link to ada@example.com…"
    );
    assert.strictEqual(copy.lead, "Please wait while delivery is confirmed.");
    assert.strictEqual(copy.emailProgress, "current", status);
    assert.strictEqual(copy.claimSent, false, status);
    assert.ok(!claimsSent(copy.title), status + " title");
    assert.ok(!claimsSent(copy.now), status + " now");
    assert.ok(!claimsSent(copy.lead), status + " lead");
    assert.ok(h.mgSwIsEmailDeliveryInFlight(status));
    assert.ok(!h.mgSwIsEmailAlreadySent(status));
  });
});

test("14 emailUiStatus sent claims sent and waits for customer", () => {
  const h = loadGuidedHelpers();
  const copy = h.mgSwGuidedDeliveryCopy("sent", { email: "ada@example.com" });
  assert.strictEqual(copy.panel, "sent");
  assert.strictEqual(copy.visualStep, 3);
  assert.strictEqual(copy.title, "Wait for Customer");
  assert.strictEqual(copy.now, "Signing link sent to ada@example.com.");
  assert.strictEqual(
    copy.why,
    "The contract will complete automatically after the customer signs."
  );
  assert.strictEqual(copy.emailProgress, "complete");
  assert.strictEqual(copy.claimSent, true);
  assert.ok(h.mgSwIsEmailAlreadySent("sent"));
});

test("15 emailUiStatus failed returns to retry without creating another customer", () => {
  const h = loadGuidedHelpers();
  const copy = h.mgSwGuidedDeliveryCopy("failed", { email: "ada@example.com" });
  assert.strictEqual(copy.panel, "failed");
  assert.strictEqual(copy.visualStep, 2);
  assert.strictEqual(copy.now, "Email delivery needs attention.");
  assert.strictEqual(copy.primaryCta, "Retry Sending Email");
  assert.strictEqual(copy.secondaryCta, "Copy Signing Link");
  assert.strictEqual(copy.claimSent, false);
  assert.ok(!claimsSent(copy.now));
  assert.ok(js.includes("swVisRetryPrimaryBtn"));
  assert.ok(js.includes("openConfirmCustomerModal()"));
  const retryHandler = js.slice(
    js.indexOf('$("swVisRetryPrimaryBtn")'),
    js.indexOf('$("swVisContinueBtn")')
  );
  assert.ok(!retryHandler.includes("openConfirmCustomerModal"));
  assert.ok(!retryHandler.includes("ensureDraftEnvelope"));
  assert.ok(!retryHandler.includes("saveGuidedCustomerSigner"));
});

console.log("");
console.log("CH-013A guided contract signing:", passed, "passed,", failed, "failed");
process.exit(failed === 0 ? 0 : 1);
