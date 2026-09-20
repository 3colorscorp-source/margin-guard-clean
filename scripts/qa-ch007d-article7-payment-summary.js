/**
 * CH-007D — Article 7 Payment Summary: verified deposit, remaining balance, remaining schedule.
 * Does not POST live, create payments, or change Invoice Hub.
 * Run: node scripts/qa-ch007d-article7-payment-summary.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const htmlPath = path.join(ROOT, "public/contract-builder.html");
const jsPath = path.join(ROOT, "public/js/contract-builder.js");
const helperPath = path.join(ROOT, "public/js/contract-payment-confirm.js");
const pdfPath = path.join(ROOT, "netlify/functions/_lib/contract-signed-pdf.js");
const freezePath = path.join(ROOT, "netlify/functions/_lib/contract-package.js");
const depositPath = path.join(ROOT, "netlify/functions/_lib/verified-contract-deposit.js");
const signPath = path.join(ROOT, "public/js/contract-sign-portal.js");
const art6QaPath = path.join(ROOT, "scripts/qa-ch007d-article6-contract-price.js");

const html = fs.readFileSync(htmlPath, "utf8");
const js = fs.readFileSync(jsPath, "utf8");
const helperSrc = fs.readFileSync(helperPath, "utf8");
const pdfSrc = fs.readFileSync(pdfPath, "utf8");
const freezeSrc = fs.readFileSync(freezePath, "utf8");
const depositSrc = fs.readFileSync(depositPath, "utf8");
const signSrc = fs.readFileSync(signPath, "utf8");
const PaymentConfirm = require("../public/js/contract-payment-confirm.js");
const Deposit = require("../netlify/functions/_lib/verified-contract-deposit.js");
const PaymentDefaults = require("../public/js/contract-payment-defaults.js");

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
const dueLabel = (rule, extras) => PaymentDefaults.dueRuleCustomerLabel(rule, extras);

const ITEMS = [
  {
    label: "Initial Scheduling Payment",
    amount: 1,
    due_rule: "on_signature",
    payment_type: "deposit",
    item_role: "future_obligation",
  },
  {
    label: "Final Payment",
    amount: 3264.49,
    due_rule: "on_completion",
    payment_type: "completion",
    item_role: "future_obligation",
  },
];
const TOTAL = 3265.49;

test("0 syntax surfaces", () => {
  check(helperPath);
  check(jsPath);
  check(depositPath);
  check(pdfPath);
  check(freezePath);
  check(signPath);
});

test("1 Article 6 compact price card is unchanged", () => {
  assert.ok(art6.includes("This is the approved contract price."));
  assert.ok(art6.includes("Payment details are listed in Article 7."));
  assert.ok(!art6.includes("Deposit Paid"));
  assert.ok(!art6.includes("Remaining Contract Balance"));
  assert.ok(fs.existsSync(art6QaPath));
});

test("2 preview copy uses Payment Summary labels only", () => {
  assert.ok(art7.includes("Payment Summary"));
  assert.ok(art7.includes("Contract Total"));
  assert.ok(art7.includes("Remaining Contract Balance"));
  assert.ok(art7.includes("Remaining Payment Schedule"));
  assert.ok(art7.includes("cbPayDepositLabel"));
  assert.doesNotMatch(art7, /Plan Check|Plan check/);
  assert.ok(js.includes("Confirm Payment Schedule"));
  assert.ok(js.includes("Payment Schedule Confirmed"));
  assert.ok(!js.includes('label: "Confirm & Continue"'));
  assert.doesNotMatch(helperSrc, /Review defaults/);
  assert.doesNotMatch(art7, /Scheduled 100%/);
});

test("3 deposit paid uses ledger confirmation and exact cents", () => {
  const summary = PaymentConfirm.presentPaymentSummary({
    contractTotal: TOTAL,
    items: ITEMS,
    verifiedDeposit: {
      verified_paid: true,
      amount: 1,
      paid_at: "2026-09-01T12:00:00.000Z",
      source: "tenant_project_payments",
    },
    dueRuleLabel: dueLabel,
  });
  assert.strictEqual(summary.depositStatus, "paid");
  assert.strictEqual(summary.depositLabel, "Deposit Paid");
  assert.strictEqual(summary.depositAmount, 1);
  assert.strictEqual(summary.remainingBalance, 3264.49);
  assert.strictEqual(summary.remainingItems.length, 1);
  assert.strictEqual(summary.remainingItems[0].name, "Final Payment");
  assert.strictEqual(summary.remainingItems[0].amount, 3264.49);
  assert.ok(/completion/i.test(summary.remainingItems[0].due));
  assert.strictEqual(summary.remainingSumMatches, true);
  assert.ok(summary.appliedCopy.includes("deposit has been received"));
});

test("4 deposit due is not Paid", () => {
  const summary = PaymentConfirm.presentPaymentSummary({
    contractTotal: TOTAL,
    items: ITEMS,
    verifiedDeposit: { verified_paid: false, amount: null },
    dueRuleLabel: dueLabel,
  });
  assert.strictEqual(summary.depositStatus, "due");
  assert.strictEqual(summary.depositLabel, "Deposit Due");
  assert.ok(!/Paid/.test(summary.depositLabel));
  assert.strictEqual(summary.depositAmount, 1);
  assert.strictEqual(summary.remainingBalance, TOTAL);
  assert.strictEqual(summary.remainingItems.length, 2);
  assert.strictEqual(summary.appliedCopy, "");
});

test("5 contract without deposit omits the deposit line", () => {
  const items = [
    {
      label: "Final Payment",
      amount: 5000,
      due_rule: "on_completion",
      payment_type: "final",
    },
  ];
  const summary = PaymentConfirm.presentPaymentSummary({
    contractTotal: 5000,
    items,
    verifiedDeposit: { verified_paid: false },
    depositRequired: 0,
    dueRuleLabel: dueLabel,
  });
  assert.strictEqual(summary.depositStatus, "none");
  assert.strictEqual(summary.depositLabel, "");
  assert.strictEqual(summary.remainingBalance, 5000);
  assert.strictEqual(summary.remainingItems.length, 1);
});

test("6 frontend cannot falsify Paid via item_role or quote acceptance", () => {
  const summary = PaymentConfirm.presentPaymentSummary({
    contractTotal: TOTAL,
    items: ITEMS.map((row) => ({ ...row, item_role: "applied_payment" })),
    verifiedDeposit: { verified_paid: false, amount: 1 },
    acceptedAt: "2026-09-01T00:00:00.000Z",
    depositRequired: 1,
    dueRuleLabel: dueLabel,
  });
  assert.strictEqual(summary.depositStatus, "due");
  assert.strictEqual(summary.verifiedPaid, false);
  assert.ok(depositSrc.includes("payment_type"));
  assert.ok(depositSrc.includes("paid_at"));
  assert.ok(!depositSrc.includes("accepted_at"));
  assert.ok(!/item_role\s*===/.test(depositSrc));
  assert.ok(js.includes("verifiedDeposit: bundle.deposit"));
});

test("7 ledger helper requires a real deposit payment", () => {
  assert.deepStrictEqual(
    Deposit.fromLedgerRows([
      { payment_type: "deposit", amount: 1, paid_at: "2026-09-01T00:00:00.000Z" },
    ]),
    {
      verified_paid: true,
      amount: 1,
      paid_at: "2026-09-01T00:00:00.000Z",
      source: "tenant_project_payments",
    }
  );
  assert.strictEqual(
    Deposit.fromLedgerRows([{ payment_type: "deposit", amount: 1, paid_at: null }])
      .verified_paid,
    false
  );
  assert.strictEqual(
    Deposit.fromLedgerRows([{ payment_type: "progress", amount: 1, paid_at: "2026-09-01" }])
      .verified_paid,
    false
  );
  assert.strictEqual(
    Deposit.fromLedgerRows([{ payment_type: "deposit", amount: 0, paid_at: "2026-09-01" }])
      .verified_paid,
    false
  );
});

test("8 freeze, PDF, and sign portal consume the same summary", () => {
  assert.ok(freezeSrc.includes("resolveVerifiedContractDeposit"));
  assert.ok(freezeSrc.includes("deposit: depositVerified"));
  assert.ok(pdfSrc.includes("presentPaymentSummary"));
  assert.ok(pdfSrc.includes("Remaining Contract Balance"));
  assert.ok(pdfSrc.includes("Deposit Paid"));
  assert.ok(signSrc.includes("presentPaymentSummary"));
  assert.ok(signSrc.includes("Remaining Payment Schedule"));
  assert.ok(!pdfSrc.includes("quote.total ="));
});

test("9 no Invoice Hub writes or invented payments", () => {
  assert.doesNotMatch(depositSrc, /supabaseRequest\([\s\S]{0,80}method:\s*"POST"/);
  assert.ok(depositSrc.includes("Does not write"));
  assert.ok(!helperSrc.includes("record-tenant-payment"));
  assert.ok(!helperSrc.includes("upsert-tenant-invoice"));
  assert.doesNotMatch(js, /quote\.total\s*=/);
});

test("10 customer-only and dual signing still exist", () => {
  const signing = fs.readFileSync(
    path.join(ROOT, "scripts/qa-ch084-contractor-customer-signing.js"),
    "utf8"
  );
  assert.ok(/customer-only|customer_only|Customer only/i.test(signing));
  assert.ok(/contractor/i.test(signing));
});

test("11 no Three Colors hardcoded in Article 7", () => {
  assert.doesNotMatch(art7, /Three Colors Corp/i);
  assert.doesNotMatch(art7 + helperSrc, /3colorscorp@gmail\.com/i);
});

console.log("");
console.log("CH-007D Article 7 Payment Summary:", passed, "passed,", failed, "failed");
process.exit(failed === 0 ? 0 : 1);
