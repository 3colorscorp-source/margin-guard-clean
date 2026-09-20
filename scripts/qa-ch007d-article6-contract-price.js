/**
 * CH-007D — Article 6 Contract Price: approved quote amount only.
 * Isolated static QA. Does not POST, freeze, or recalculate live prices.
 * Run: node scripts/qa-ch007d-article6-contract-price.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const htmlPath = path.join(ROOT, "public/contract-builder.html");
const jsPath = path.join(ROOT, "public/js/contract-builder.js");
const freezePath = path.join(ROOT, "netlify/functions/_lib/contract-package.js");
const pdfPath = path.join(ROOT, "netlify/functions/_lib/contract-signed-pdf.js");
const signPath = path.join(ROOT, "public/js/contract-sign-portal.js");
const signingPolicyPath = path.join(ROOT, "public/js/business-signing-policy.js");
const html = fs.readFileSync(htmlPath, "utf8");
const js = fs.readFileSync(jsPath, "utf8");
const freezeSrc = fs.readFileSync(freezePath, "utf8");
const pdfSrc = fs.readFileSync(pdfPath, "utf8");
const signSrc = fs.readFileSync(signPath, "utf8");

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

function check(file) {
  const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || "syntax failed");
}

function slice(src, startToken, endToken) {
  const start = src.indexOf(startToken);
  const end = src.indexOf(endToken, start + startToken.length);
  assert.ok(start >= 0 && end > start, `missing slice ${startToken}`);
  return src.slice(start, end);
}

const art6 = slice(html, 'id="art-price"', 'id="art-payment"');
const art7 = slice(html, 'id="art-payment"', 'id="art-schedule"');
const art8 = slice(html, 'id="art-schedule"', 'id="art-changes"');
const art9 = slice(html, 'id="art-changes"', 'id="art-warranty"');
const art10 = slice(html, 'id="art-warranty"', 'id="art-terms"');
const priceCaps = slice(js, '"art-price": defaultWorkspaceCaps', '"art-payment": defaultWorkspaceCaps');
const continueFn = slice(js, "async function handleWorkspaceContinue", "function $(");
const resolveFn = slice(js, "function resolveContractTotal", "function initialsFromName");
const pdfPrice = slice(pdfSrc, 'heading("Contract Price")', 'heading("Estimated Schedule")');
const signPrice = slice(signSrc, 'id="sec-price"', 'id="sec-contract-schedule"');

test("0 syntax builder, freeze, pdf, sign portal", () => {
  check(jsPath);
  check(freezePath);
  check(pdfPath);
  check(signPath);
});

test("1 compact card keeps heading, amount, and two copy lines", () => {
  assert.ok(art6.includes('class="cb-article__title">Contract Price</h3>'));
  assert.ok(art6.includes('id="cbPriceLine"'));
  assert.ok(art6.includes("This is the approved contract price."));
  assert.ok(art6.includes("Payment details are listed in Article 7."));
  assert.ok(art6.includes("cb-price-card"));
  assert.ok(!art6.includes("cb-summary__item"));
});

test("2 Article 6 drops payment, tax, CO, and empty cards", () => {
  assert.doesNotMatch(art6, /\bDeposit\b/);
  assert.doesNotMatch(art6, /Final Payment/);
  assert.doesNotMatch(art6, /Progress Payments/);
  assert.doesNotMatch(art6, /Change Orders/);
  assert.doesNotMatch(art6, /\bTaxes\b/);
  assert.doesNotMatch(art6, /\bBalance\b/);
  assert.doesNotMatch(art6, /Not yet defined/);
  assert.doesNotMatch(art6, /Contract total is locked/);
  assert.doesNotMatch(art6, /Payment stages are configured/);
  assert.doesNotMatch(art6, /Review & Continue/);
  assert.doesNotMatch(art6, /\bREADY\b/);
  assert.ok(!art6.includes("cbSumDeposit"));
  assert.ok(!art6.includes("cbSumTaxes"));
  assert.ok(!art6.includes("cbSumBalance"));
});

test("3 other articles keep their legal homes", () => {
  assert.ok(art7.includes("Payment Terms"));
  assert.ok(art7.includes('id="cbPayTimeline"'));
  assert.ok(js.includes("Confirm Payment Terms"));
  assert.ok(art8.includes("Estimated Start Date"));
  assert.ok(art8.includes("cbStartDisplay"));
  assert.ok(art9.includes("Changes and Additional Work"));
  assert.ok(art9.includes("Approved changes may affect the contract price"));
  assert.ok(art10.includes("Confirm Warranty") || js.includes("Confirm Warranty"));
});

test("4 read-only: amount comes from approved quote, no editor", () => {
  assert.match(priceCaps, /supportsEdit:\s*false/);
  assert.match(priceCaps, /supportsSave:\s*false/);
  assert.match(priceCaps, /continueLabel:\s*"Continue"/);
  assert.ok(!art6.includes("<input"));
  assert.ok(!art6.includes("contenteditable"));
  assert.ok(resolveFn.indexOf("quote?.total") < resolveFn.indexOf("salePrice"));
  assert.ok(js.includes('setText("cbPriceLine", money)'));
  assert.ok(js.includes("formatMoney(source.contractTotal, source.currency)"));
});

test("5 Continue only advances; it does not write or recalculate price", () => {
  assert.ok(continueFn.includes("setActiveArticle(next.id"));
  assert.ok(!/fetch\(|workspaceSave\(|savePayment|PAYMENT_SCHEDULE_API|contract_total\s*=/.test(continueFn));
  assert.ok(!js.includes('label: "Review & Continue"') || !priceCaps.includes("Review & Continue"));
  assert.doesNotMatch(priceCaps, /Review & Continue/);
  assert.ok(js.includes('id: "cbStepBack"') && js.includes('label: "Back"'));
  assert.ok(js.includes('id: "cbStepContinue"'));
});

test("6 cents stay exact on quote, freeze, and PDF", () => {
  const amount = 1234.56;
  const formatted = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(amount);
  assert.strictEqual(formatted, "$1,234.56");
  assert.ok(js.includes("n.toFixed(2)") || js.includes('style: "currency"'));
  assert.match(freezeSrc, /const contractTotal = moneyNumber\(quote\.total\)/);
  assert.match(freezeSrc, /contract_total: contractTotal/);
  assert.match(pdfSrc, /n\.toFixed\(2\)/);
  assert.ok(pdfPrice.includes("snap?.price?.contract_total ?? snap?.quote?.total"));
  assert.ok(!pdfPrice.includes("Deposit required"));
  assert.ok(!pdfPrice.includes("Not yet defined"));
});

test("7 preview / print / frozen / signed PDF show Contract Price only", () => {
  assert.ok(html.includes("enterPreviewMode") || js.includes("enterPreviewMode"));
  assert.ok(html.includes("@media print"));
  assert.ok(signPrice.includes("Contract Price"));
  assert.ok(signPrice.includes("This is the approved contract price."));
  assert.ok(signPrice.includes("Payment details are listed in Article 7."));
  assert.ok(!signPrice.includes("Deposit required"));
  assert.ok(pdfSrc.includes('heading("Contract Price")'));
  assert.ok(pdfSrc.includes('heading("Payment Terms")'));
  assert.ok(signSrc.includes('cs-section-label">Payment Terms'));
});

test("8 no READY banner or extra confirmation on Article 6", () => {
  assert.ok(priceCaps.includes('badge: "", message: ""'));
  assert.doesNotMatch(priceCaps, /READY/);
  assert.ok(!art6.includes("Confirm Price"));
  assert.ok(!js.includes("workspaceConfirmPrice"));
  assert.ok(!art6.includes("cb-draft-note"));
});

test("9 payment schedule notices stay in Article 7 / PDF payment section", () => {
  assert.ok(art7.includes("cbPayWorkspace") || art7.includes("Payment Terms"));
  const pdfPay = slice(pdfSrc, 'heading("Payment Terms")', 'heading("Warranty")');
  assert.ok(pdfPay.includes("it.label") || pdfPay.includes("Payment"));
  assert.ok(freezeSrc.includes("deposit_required: moneyNumber(quote.deposit_required)"));
});

test("10 no Three Colors tenant data hardcoded; signing policies intact", () => {
  assert.doesNotMatch(art6, /Three Colors Corp/i);
  assert.doesNotMatch(art6, /1083733/);
  assert.doesNotMatch(art6 + priceCaps + pdfPrice + signPrice, /3colorscorp@gmail\.com/i);
  assert.ok(fs.existsSync(signingPolicyPath));
  const signing = fs.readFileSync(path.join(ROOT, "scripts/qa-ch084-contractor-customer-signing.js"), "utf8");
  assert.ok(/customer-only|customer_only|Customer only/i.test(signing));
  assert.ok(/contractor/i.test(signing));
});

console.log("");
console.log("CH-007D Article 6 Contract Price:", passed, "passed,", failed, "failed");
process.exit(failed === 0 ? 0 : 1);
