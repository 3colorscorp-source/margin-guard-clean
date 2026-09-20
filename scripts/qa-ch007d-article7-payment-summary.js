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
const schedulePath = path.join(ROOT, "netlify/functions/project-contract-payment-schedule.js");
const art6QaPath = path.join(ROOT, "scripts/qa-ch007d-article6-contract-price.js");

const html = fs.readFileSync(htmlPath, "utf8");
const js = fs.readFileSync(jsPath, "utf8");
const helperSrc = fs.readFileSync(helperPath, "utf8");
const pdfSrc = fs.readFileSync(pdfPath, "utf8");
const freezeSrc = fs.readFileSync(freezePath, "utf8");
const depositSrc = fs.readFileSync(depositPath, "utf8");
const signSrc = fs.readFileSync(signPath, "utf8");
const scheduleSrc = fs.readFileSync(schedulePath, "utf8");
const PaymentConfirm = require("../public/js/contract-payment-confirm.js");
const PaymentDefaults = require("../public/js/contract-payment-defaults.js");
const Deposit = require("../netlify/functions/_lib/verified-contract-deposit.js");

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
const dueLabel = (rule, extras) => PaymentConfirm.article7DueRuleLabel(rule, extras);

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
  check(schedulePath);
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
  assert.ok(art7.includes("cbPayRemainingLabel"));
  assert.ok(art7.includes("cbPayDepositLabel"));
  assert.ok(art7.includes("cbPayStillDueRow"));
  assert.ok(art7.includes("Deposit Still Due"));
  assert.ok(art7.includes("Billing Terms"));
  assert.ok(!art7.includes("Payment Stages"));
  assert.ok(!art7.includes("Remaining Payment Schedule"));
  assert.ok(!js.includes("Remaining Payment Schedule"));
  assert.ok(!pdfSrc.includes("Remaining Payment Schedule"));
  assert.ok(!signSrc.includes("Remaining Payment Schedule"));
  assert.ok(helperSrc.includes("showPaymentStages"));
  assert.ok(js.includes("explanationCopy"));
  assert.ok(helperSrc.includes("summaryCopy"));
  assert.ok(!js.includes("depositMinus"));
  assert.doesNotMatch(art7, /Plan Check|Plan check/);
  assert.ok(js.includes("Confirm Payment Terms"));
  assert.ok(js.includes("Payment Terms Confirmed"));
  assert.ok(!js.includes('label: "Confirm & Continue"'));
  assert.doesNotMatch(helperSrc, /Review defaults/);
  assert.ok(art7.includes("cbPayProgressCopy"));
  assert.ok(art7.includes("Deposit Due Now"));
  assert.ok(!art7.includes("due upon completion"));
  assert.ok(!helperSrc.includes("due upon completion"));
  assert.ok(!js.includes("due upon completion"));
  assert.ok(!pdfSrc.includes("due upon completion"));
  assert.ok(!signSrc.includes("due upon completion"));
  assert.ok(helperSrc.includes("INVOICE_CADENCE_COPY"));
  assert.ok(freezeSrc.includes("invoice_cadence_copy"));
  assert.ok(freezeSrc.includes("deposit_status_copy"));
  assert.ok(pdfSrc.includes("paymentExplanationFromSnapshot"));
  assert.ok(signSrc.includes("paymentExplanationFromSnapshot"));
  assert.ok(!pdfSrc.includes("paySummary.progressCopy"));
  assert.ok(!signSrc.includes("summary.progressCopy"));
  assert.ok(html.includes(".cb-pay-ledger__row[hidden]"));
  assert.ok(html.includes(".cb-pay-workspace__badge[hidden]"));
  assert.ok(!js.includes('badgeMark.textContent = items.length ? "!"'));
  assert.doesNotMatch(art7, /Scheduled 100%/);
});

test("3 deposit paid uses ledger confirmation and exact cents", () => {
  const summary = PaymentConfirm.presentPaymentSummary({
    contractTotal: TOTAL,
    items: ITEMS,
    verifiedDeposit: {
      status: "paid",
      verified_paid: true,
      amount: 1,
      paid_at: "2026-09-01T12:00:00.000Z",
      source: "tenant_project_payments",
    },
    currency: "USD",
    dueRuleLabel: dueLabel,
  });
  assert.strictEqual(summary.contractTotal, 3265.49);
  assert.strictEqual(summary.depositStatus, "paid");
  assert.strictEqual(summary.depositLabel, "Deposit Paid");
  assert.strictEqual(summary.depositAmount, 1);
  assert.strictEqual(summary.depositMinus, false);
  assert.strictEqual(summary.remainingLabel, "Remaining Contract Balance");
  assert.strictEqual(summary.remainingBalance, 3264.49);
  assert.strictEqual(summary.showPaymentStages, false);
  assert.strictEqual(summary.remainingItems.length, 0);
  assert.strictEqual(
    summary.summaryCopy,
    "The deposit has been received and applied to the contract total."
  );
  assert.strictEqual(
    summary.explanationCopy,
    "The deposit has been received and applied to the contract total. Progress invoices are sent every two weeks based on completed work. If the project is completed sooner, the final invoice is sent when the work is complete."
  );
  assert.strictEqual(summary.appliedCopy, summary.explanationCopy);
  assert.ok(!/Initial Scheduling Payment/.test(JSON.stringify(summary)));
});

test("4 deposit due uses Balance After Deposit = total minus required deposit", () => {
  const summary = PaymentConfirm.presentPaymentSummary({
    contractTotal: TOTAL,
    items: ITEMS,
    verifiedDeposit: { status: "none", verified_paid: false, amount: null },
    currency: "USD",
    dueRuleLabel: dueLabel,
    hideFutureStages: true,
  });
  assert.strictEqual(summary.depositStatus, "due");
  assert.strictEqual(summary.depositLabel, "Deposit Due Now");
  assert.ok(!/Paid/.test(summary.depositLabel));
  assert.strictEqual(summary.depositAmount, 1);
  assert.strictEqual(summary.remainingLabel, "Balance After Deposit");
  assert.strictEqual(summary.remainingBalance, 3264.49);
  assert.strictEqual(
    PaymentConfirm.moneyToCents(summary.remainingBalance),
    PaymentConfirm.moneyToCents(TOTAL) - PaymentConfirm.moneyToCents(1)
  );
  assert.strictEqual(summary.showPaymentStages, false);
  assert.strictEqual(summary.remainingItems.length, 0);
  assert.strictEqual(summary.summaryCopy, PaymentConfirm.DEPOSIT_DUE_COPY);
  assert.strictEqual(
    summary.explanationCopy,
    PaymentConfirm.DEPOSIT_DUE_COPY + " " + PaymentConfirm.BILLING_TERMS_COPY
  );
});

test("4b two-stage schedule does not render Remaining Payment Schedule", () => {
  assert.strictEqual(PaymentConfirm.isSimpleTwoStageSchedule(ITEMS), true);
  assert.strictEqual(PaymentConfirm.shouldShowPaymentStages(ITEMS), false);
  const due = PaymentConfirm.presentPaymentSummary({
    contractTotal: TOTAL,
    items: ITEMS,
    verifiedDeposit: { verified_paid: false },
    currency: "USD",
    dueRuleLabel: dueLabel,
  });
  const paid = PaymentConfirm.presentPaymentSummary({
    contractTotal: TOTAL,
    items: ITEMS,
    verifiedDeposit: { status: "paid", verified_paid: true, amount: 1 },
    currency: "USD",
    dueRuleLabel: dueLabel,
  });
  assert.strictEqual(due.showPaymentStages, false);
  assert.strictEqual(paid.showPaymentStages, false);
  assert.strictEqual(due.remainingItems.length, 0);
  assert.strictEqual(paid.remainingItems.length, 0);
  assert.ok(!html.includes("Remaining Payment Schedule"));
  assert.ok(helperSrc.includes("hideFutureStages: true"));
  assert.ok(js.includes("presentAuthenticatedPaymentArticleFromBuilderSource"));
  assert.ok(pdfSrc.includes("showPaymentStages"));
  assert.ok(signSrc.includes("showPaymentStages"));
});

test("4c three-or-more-stage schedule renders compact Payment Stages", () => {
  const items = [
    ITEMS[0],
    {
      label: "Progress Payment",
      amount: 1000,
      due_rule: "on_start",
      payment_type: "progress",
      item_role: "future_obligation",
    },
    {
      label: "Final Payment",
      amount: 2264.49,
      due_rule: "on_completion",
      payment_type: "completion",
      item_role: "future_obligation",
    },
  ];
  const summary = PaymentConfirm.presentPaymentSummary({
    contractTotal: TOTAL,
    items,
    verifiedDeposit: { verified_paid: false },
    currency: "USD",
    dueRuleLabel: dueLabel,
    legacyRemaining: true,
  });
  assert.strictEqual(PaymentConfirm.isSimpleTwoStageSchedule(items), false);
  assert.strictEqual(PaymentConfirm.shouldShowPaymentStages(items), true);
  assert.strictEqual(summary.showPaymentStages, true);
  assert.strictEqual(summary.stageTitle, "Payment Stages");
  assert.strictEqual(summary.depositStatus, "due");
  assert.strictEqual(summary.remainingLabel, "Remaining Contract Balance");
  assert.strictEqual(summary.remainingBalance, TOTAL);
  assert.strictEqual(summary.remainingItems.length, 2);
  assert.strictEqual(summary.remainingItems[0].name, "Progress Payment");
  assert.strictEqual(summary.remainingItems[0].amount, 1000);
  assert.strictEqual(summary.remainingItems[1].name, "Final Payment");
  assert.strictEqual(summary.remainingItems[1].amount, 2264.49);
  assert.ok(!summary.remainingItems.some((row) => /deposit|initial scheduling/i.test(row.name)));
  assert.ok(!summary.remainingItems.some((row) => row.name === "Contract Total"));
  assert.ok(!summary.remainingItems.some((row) => row.name === "Deposit Paid"));
  assert.strictEqual(summary.summaryCopy, PaymentConfirm.DEPOSIT_DUE_COPY);
  assert.ok(summary.explanationCopy.includes("Progress invoices are sent every two weeks"));
  assert.ok(!summary.explanationCopy.includes("due in the stages below"));
  const paid = PaymentConfirm.presentPaymentSummary({
    contractTotal: TOTAL,
    items,
    verifiedDeposit: { status: "paid", verified_paid: true, amount: 1 },
    currency: "USD",
    dueRuleLabel: dueLabel,
  });
  assert.strictEqual(paid.showPaymentStages, true);
  assert.strictEqual(paid.remainingLabel, "Remaining Contract Balance");
  assert.strictEqual(paid.remainingItems.length, 2);
  assert.ok(!paid.remainingItems.some((row) => /deposit|initial scheduling/i.test(row.name)));
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
  assert.strictEqual(summary.remainingLabel, "Remaining Contract Balance");
  assert.strictEqual(summary.remainingBalance, 5000);
  assert.strictEqual(summary.showPaymentStages, false);
  assert.strictEqual(summary.remainingItems.length, 0);
  assert.strictEqual(summary.summaryCopy, "");
});

test("5b remaining cents never go negative and zero remaining is exact", () => {
  const zero = PaymentConfirm.presentPaymentSummary({
    contractTotal: 1,
    items: [
      {
        label: "Initial Scheduling Payment",
        amount: 1,
        due_rule: "on_signature",
        payment_type: "deposit",
      },
      {
        label: "Final Payment",
        amount: 0,
        due_rule: "on_completion",
        payment_type: "completion",
      },
    ],
    verifiedDeposit: { status: "paid", verified_paid: true, amount: 1 },
    currency: "USD",
    dueRuleLabel: dueLabel,
  });
  assert.strictEqual(zero.remainingBalance, 0);
  assert.ok(zero.remainingBalance >= 0);
  assert.strictEqual(zero.remainingLabel, "Remaining Contract Balance");
  const dueZero = PaymentConfirm.presentPaymentSummary({
    contractTotal: 1,
    items: [
      {
        label: "Initial Scheduling Payment",
        amount: 1,
        due_rule: "on_signature",
        payment_type: "deposit",
      },
      {
        label: "Final Payment",
        amount: 0,
        due_rule: "on_completion",
        payment_type: "completion",
      },
    ],
    verifiedDeposit: { verified_paid: false },
    currency: "USD",
    dueRuleLabel: dueLabel,
    hideFutureStages: true,
  });
  assert.strictEqual(dueZero.remainingBalance, 0);
  assert.ok(dueZero.remainingBalance >= 0);
  assert.strictEqual(dueZero.remainingLabel, "Balance After Deposit");
});

const TOTAL_5K = 5000;
const TWO_1K = [
  {
    label: "Initial Scheduling Payment",
    amount: 1000,
    due_rule: "on_signature",
    payment_type: "deposit",
    item_role: "future_obligation",
  },
  {
    label: "Final Payment",
    amount: 4000,
    due_rule: "on_completion",
    payment_type: "completion",
    item_role: "future_obligation",
  },
];
const THREE_1K = [
  TWO_1K[0],
  {
    label: "Progress Payment",
    amount: 1500,
    due_rule: "on_start",
    payment_type: "progress",
    item_role: "future_obligation",
  },
  {
    label: "Final Payment",
    amount: 2500,
    due_rule: "on_completion",
    payment_type: "completion",
    item_role: "future_obligation",
  },
];
const THREE_PROGRESS = [
  TWO_1K[0],
  {
    label: "Progress A",
    amount: 2000,
    due_rule: "on_start",
    payment_type: "progress",
    item_role: "future_obligation",
  },
  {
    label: "Progress B",
    amount: 2000,
    due_rule: "milestone",
    payment_type: "progress",
    item_role: "future_obligation",
  },
];
function paidDeposit(amount) {
  return {
    status: "paid",
    verified_paid: true,
    amount,
    paid_at: "2026-09-01T12:00:00.000Z",
    source: "tenant_project_payments",
  };
}

test("5c required 1000 / paid 0 keeps three rows and Deposit Due Now", () => {
  const summary = PaymentConfirm.presentPaymentSummary({
    contractTotal: TOTAL_5K,
    items: TWO_1K,
    verifiedDeposit: { verified_paid: false },
    currency: "USD",
    dueRuleLabel: dueLabel,
    hideFutureStages: true,
  });
  assert.strictEqual(summary.depositStatus, "due");
  assert.strictEqual(summary.depositLabel, "Deposit Due Now");
  assert.strictEqual(summary.depositAmount, 1000);
  assert.strictEqual(summary.depositStillDue, null);
  assert.strictEqual(summary.remainingLabel, "Balance After Deposit");
  assert.strictEqual(summary.remainingBalance, 4000);
  assert.strictEqual(summary.showPaymentStages, false);
  assert.strictEqual(summary.blockConfirm, false);
  assert.strictEqual(summary.summaryCopy, PaymentConfirm.DEPOSIT_DUE_COPY);
  assert.ok(!summary.explanationCopy.includes("due upon completion"));
  assert.ok(summary.explanationCopy.includes("Progress invoices are sent every two weeks"));
});

test("5d required 1000 / paid 1000 keeps three rows", () => {
  const summary = PaymentConfirm.presentPaymentSummary({
    contractTotal: TOTAL_5K,
    items: TWO_1K,
    verifiedDeposit: paidDeposit(1000),
    currency: "USD",
    dueRuleLabel: dueLabel,
  });
  assert.strictEqual(summary.depositStatus, "paid");
  assert.strictEqual(summary.depositAmount, 1000);
  assert.strictEqual(summary.depositStillDue, null);
  assert.strictEqual(summary.remainingLabel, "Remaining Contract Balance");
  assert.strictEqual(summary.remainingBalance, 4000);
  assert.strictEqual(summary.showPaymentStages, false);
  assert.strictEqual(summary.blockConfirm, false);
  assert.strictEqual(summary.summaryCopy, PaymentConfirm.DEPOSIT_PAID_COPY);
  assert.ok(summary.explanationCopy.startsWith(PaymentConfirm.DEPOSIT_PAID_COPY));
  assert.ok(!summary.explanationCopy.includes("due upon completion"));
});

test("5e required 1000 / paid 500 shows Deposit Still Due", () => {
  const summary = PaymentConfirm.presentPaymentSummary({
    contractTotal: TOTAL_5K,
    items: TWO_1K,
    verifiedDeposit: paidDeposit(500),
    currency: "USD",
    dueRuleLabel: dueLabel,
  });
  assert.strictEqual(summary.depositStatus, "paid");
  assert.strictEqual(summary.depositAmount, 500);
  assert.strictEqual(summary.depositStillDue, 500);
  assert.strictEqual(summary.depositStillDueLabel, "Deposit Still Due");
  assert.strictEqual(summary.remainingLabel, "Remaining Contract Balance");
  assert.strictEqual(summary.remainingBalance, 4500);
  assert.strictEqual(summary.showPaymentStages, false);
  assert.strictEqual(summary.blockConfirm, false);
  assert.strictEqual(
    summary.summaryCopy,
    "A partial deposit has been received. $500.00 remains due toward the deposit."
  );
  assert.strictEqual(
    summary.explanationCopy,
    "A partial deposit has been received. $500.00 remains due toward the deposit. " +
      PaymentConfirm.BILLING_TERMS_COPY
  );
  assert.strictEqual(summary.showDepositStillDue, true);
});

test("5e2 Deposit Still Due is absent when zero or null", () => {
  const paidFull = PaymentConfirm.presentPaymentSummary({
    contractTotal: TOTAL_5K,
    items: TWO_1K,
    verifiedDeposit: paidDeposit(1000),
    currency: "USD",
    dueRuleLabel: dueLabel,
  });
  assert.strictEqual(paidFull.depositStillDue, null);
  assert.strictEqual(paidFull.showDepositStillDue, false);
  assert.strictEqual(paidFull.depositStillDueLabel, "");
  const due = PaymentConfirm.presentPaymentSummary({
    contractTotal: TOTAL_5K,
    items: TWO_1K,
    verifiedDeposit: { verified_paid: false },
    currency: "USD",
    dueRuleLabel: dueLabel,
  });
  assert.strictEqual(due.depositStillDue, null);
  assert.strictEqual(due.showDepositStillDue, false);
  const none = PaymentConfirm.presentPaymentSummary({
    contractTotal: 5000,
    items: [
      {
        label: "Final Payment",
        amount: 5000,
        due_rule: "on_completion",
        payment_type: "final",
      },
    ],
    verifiedDeposit: { verified_paid: false },
    depositRequired: 0,
    currency: "USD",
    dueRuleLabel: dueLabel,
  });
  assert.strictEqual(none.depositStillDue, null);
  assert.strictEqual(none.showDepositStillDue, false);
  assert.ok(js.includes("showDepositStillDue"));
  assert.ok(js.includes("stillDueRow.hidden = true"));
});

test("5e3 draft uses one combined explanation; frozen surfaces do not leak code defaults", () => {
  const cadence = PaymentConfirm.INVOICE_CADENCE_COPY;
  assert.strictEqual(
    cadence,
    PaymentConfirm.BILLING_TERMS_COPY
  );
  const summary = PaymentConfirm.presentPaymentSummary({
    contractTotal: TOTAL,
    items: ITEMS,
    verifiedDeposit: { verified_paid: false },
    currency: "USD",
    dueRuleLabel: dueLabel,
  });
  assert.strictEqual(summary.progressCopy, undefined);
  assert.strictEqual(summary.summaryCopy, PaymentConfirm.DEPOSIT_DUE_COPY);
  assert.strictEqual(summary.explanationCopy, summary.summaryCopy + " " + cadence);
  assert.ok(!art7.includes("due upon completion"));
  assert.ok(js.includes("explanationCopy"));
  assert.ok(pdfSrc.includes("paymentExplanationFromSnapshot"));
  assert.ok(signSrc.includes("paymentExplanationFromSnapshot"));
});

test("5e4 empty warning icon is not rendered without a message", () => {
  assert.ok(!js.includes('badgeMark.textContent = items.length ? "!"'));
  assert.ok(js.includes('badgeMark.textContent = ""'));
  assert.ok(html.includes(".cb-pay-workspace__badge[hidden] { display: none !important; }"));
});

test("5e5 freeze stores invoice_cadence_copy exactly; hash follows that field", () => {
  const Freeze = require("../netlify/functions/_lib/contract-package.js");
  const copy = PaymentConfirm.PROGRESS_INVOICE_COPY;
  const snap = Freeze.buildSnapshot({
    tenantId: "t1",
    project: { id: "p1", project_name: "Test", status: "active" },
    quote: {
      id: "q1",
      client_name: "Cust",
      status: "accepted",
      total: 5000,
      currency: "USD",
      deposit_required: 1000,
      scope_of_work: "Scope",
      terms: "Terms",
    },
    setup: {
      property_address_line1: "1 Main",
      property_city: "Hayward",
      property_state: "CA",
      property_postal_code: "94544",
      property_confirmed_at: "2026-01-02T00:00:00.000Z",
      warranty_duration_value: 1,
      warranty_duration_unit: "years",
      warranty_summary: "Workmanship",
      warranty_confirmed_at: "2026-01-02T00:00:00.000Z",
      signature_method: "email_link",
    },
    setupReadiness: {
      project_address: "confirmed",
      warranty: "configured",
      signature_method: "configured",
    },
    schedule: { id: "sch1", status: "confirmed", currency: "USD", contract_total: 5000 },
    items: [
      { id: "i1", sequence_number: 1, label: "Deposit", amount: 1000, due_rule: "on_signature" },
      { id: "i2", sequence_number: 2, label: "Final", amount: 4000, due_rule: "on_completion" },
    ],
    paymentReadiness: { status: "configured", contract_total: 5000, scheduled_total: 5000 },
    legalEffective: { confirmed_at: "2026-01-04T00:00:00.000Z", notices: {}, enabled: {} },
    frozenAt: "2026-09-20T00:00:00.000Z",
    contractSchedule: { start_date: "2026-10-01", due_date: "2026-10-15" },
    depositStatusCopy: "The $1,000.00 deposit is due now.",
  });
  assert.strictEqual(snap.payment_schedule.invoice_cadence_copy, copy);
  assert.strictEqual(snap.payment_schedule.billing_terms_copy, copy);
  assert.strictEqual(snap.payment_schedule.deposit_status_copy, "The $1,000.00 deposit is due now.");
  assert.strictEqual(snap.payment_terms.billing_terms_copy, copy);
  assert.strictEqual(snap.payment_terms.contract_total, 5000);
  assert.strictEqual(snap.payment_terms.deposit_required, 1000);
  assert.strictEqual(snap.payment_terms.remaining_contract_balance, 4000);
  assert.strictEqual(snap.payment_terms.remaining_label, "Balance After Deposit");
  assert.strictEqual(snap.payment_terms.confirmed, true);
  const h0 = Freeze.contentHashForSnapshot(snap);
  const mutated = {
    ...snap,
    payment_schedule: {
      ...snap.payment_schedule,
      invoice_cadence_copy: "Changed after freeze.",
    },
  };
  assert.notStrictEqual(h0, Freeze.contentHashForSnapshot(mutated));
  const mutatedTerms = {
    ...snap,
    payment_terms: {
      ...snap.payment_terms,
      remaining_contract_balance: 1,
    },
  };
  assert.notStrictEqual(h0, Freeze.contentHashForSnapshot(mutatedTerms));
  const mutatedStatus = {
    ...snap,
    payment_schedule: {
      ...snap.payment_schedule,
      deposit_status_copy: "Changed status copy after freeze.",
    },
  };
  assert.notStrictEqual(h0, Freeze.contentHashForSnapshot(mutatedStatus));
  const again = Freeze.contentHashForSnapshot({ ...snap });
  assert.strictEqual(h0, again);
  const decision = Freeze.evaluateFreezeHashDecision(
    { id: "ready-1", content_hash: h0, snapshot_json: snap, status: "ready" },
    h0
  );
  assert.strictEqual(decision.idempotent, true);
  assert.strictEqual(decision.createVersion, false);
  assert.ok(freezeSrc.includes("trimField(invoiceCadenceCopy) || PROGRESS_INVOICE_COPY"));
  assert.ok(freezeSrc.includes("paySummary.invoiceCadenceCopy"));
});

test("5e6 frozen surfaces read snapshot copy only; legacy omits it", () => {
  const stored = "Frozen cadence copy for this package only.";
  assert.strictEqual(
    PaymentConfirm.invoiceCadenceCopyFromSnapshot({
      payment_schedule: { invoice_cadence_copy: stored },
    }),
    stored
  );
  assert.strictEqual(
    PaymentConfirm.paymentExplanationFromSnapshot({
      payment_schedule: {
        deposit_status_copy: "The deposit has been received.",
        invoice_cadence_copy: PaymentConfirm.INVOICE_CADENCE_COPY,
      },
    }),
    "The deposit has been received. " + PaymentConfirm.INVOICE_CADENCE_COPY
  );
  assert.strictEqual(PaymentConfirm.paymentExplanationFromSnapshot({ payment_schedule: {} }), "");
  assert.strictEqual(PaymentConfirm.paymentExplanationFromSnapshot({}), "");
  assert.strictEqual(
    PaymentConfirm.paymentExplanationFromSnapshot({
      payment_schedule: { invoice_cadence_copy: stored },
    }),
    stored
  );
  assert.ok(pdfSrc.includes("paymentExplanationFromSnapshot(snap)"));
  assert.ok(signSrc.includes("paymentExplanationFromSnapshot(snap)"));
  assert.ok(!pdfSrc.includes("PROGRESS_INVOICE_COPY"));
  assert.ok(!signSrc.includes("PROGRESS_INVOICE_COPY"));
});

test("5f required 1000 / paid 1500 keeps three rows and real remaining", () => {
  const summary = PaymentConfirm.presentPaymentSummary({
    contractTotal: TOTAL_5K,
    items: TWO_1K,
    verifiedDeposit: paidDeposit(1500),
    currency: "USD",
    dueRuleLabel: dueLabel,
  });
  assert.strictEqual(summary.depositStatus, "paid");
  assert.strictEqual(summary.depositAmount, 1500);
  assert.strictEqual(summary.depositStillDue, null);
  assert.strictEqual(summary.remainingBalance, 3500);
  assert.strictEqual(summary.showPaymentStages, false);
  assert.strictEqual(summary.blockConfirm, false);
  assert.ok(summary.remainingBalance >= 0);
});

test("5g frozen Payment Stages keep stored amounts", () => {
  const summary = PaymentConfirm.presentPaymentSummary({
    contractTotal: TOTAL_5K,
    items: THREE_1K,
    verifiedDeposit: paidDeposit(500),
    currency: "USD",
    dueRuleLabel: dueLabel,
  });
  assert.strictEqual(summary.showPaymentStages, true);
  assert.strictEqual(summary.remainingBalance, 4500);
  assert.strictEqual(summary.depositStillDue, 500);
  assert.strictEqual(summary.remainingItems.length, 2);
  assert.strictEqual(summary.remainingItems[0].amount, 1500);
  assert.strictEqual(summary.remainingItems[1].amount, 2500);
  assert.strictEqual(summary.blockConfirm, false);
});

test("5g2 paid above required still shows stored historical stages", () => {
  const summary = PaymentConfirm.presentPaymentSummary({
    contractTotal: TOTAL_5K,
    items: THREE_1K,
    verifiedDeposit: paidDeposit(1500),
    currency: "USD",
    dueRuleLabel: dueLabel,
  });
  assert.strictEqual(summary.depositStillDue, null);
  assert.strictEqual(summary.remainingBalance, 3500);
  assert.strictEqual(summary.showPaymentStages, true);
  assert.strictEqual(summary.blockConfirm, false);
  assert.strictEqual(summary.remainingItems[0].amount, 1500);
  assert.strictEqual(summary.remainingItems[1].amount, 2500);
});

test("5h future stages do not block Confirm Payment Terms", () => {
  const summary = PaymentConfirm.presentPaymentSummary({
    contractTotal: TOTAL_5K,
    items: THREE_PROGRESS,
    verifiedDeposit: paidDeposit(3500),
    currency: "USD",
    dueRuleLabel: dueLabel,
    hideFutureStages: true,
  });
  assert.strictEqual(summary.showPaymentStages, false);
  assert.strictEqual(summary.remainingBalance, 1500);
  assert.strictEqual(summary.blockConfirm, false);
  const plan = PaymentConfirm.paymentFooterPlan({
    items: THREE_PROGRESS,
    contractTotal: TOTAL_5K,
    verifiedDeposit: paidDeposit(3500),
  });
  assert.strictEqual(plan.confirmEnabled, true);
  assert.strictEqual(plan.blockConfirm, false);
  assert.strictEqual(plan.primaryLabel, "Confirm Payment Terms");
});

test("5i Freeze does not require payment stages", () => {
  assert.ok(!freezeSrc.includes("if (paySummary.scheduleMismatch)"));
  assert.ok(!scheduleSrc.includes("payment_stages_mismatch"));
  assert.ok(js.includes("depositStillDue"));
  assert.ok(freezeSrc.includes("invoice_cadence_copy"));
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
  assert.ok(helperSrc.includes("verifiedDeposit: bundle.deposit"));
  assert.ok(js.includes("presentAuthenticatedPaymentArticleFromBuilderSource"));
});

test("7 ledger helper requires a real deposit payment", () => {
  const paid = Deposit.fromLedgerRows([
    { payment_type: "deposit", amount: 1, paid_at: "2026-09-01T00:00:00.000Z" },
  ]);
  assert.strictEqual(paid.verified_paid, true);
  assert.strictEqual(paid.status, "paid");
  assert.strictEqual(paid.amount, 1);
  assert.strictEqual(paid.paid_at, "2026-09-01T00:00:00.000Z");
  assert.strictEqual(paid.source, "tenant_project_payments");
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
  assert.ok(freezeSrc.includes("serializeDepositForSnapshot"));
  assert.ok(freezeSrc.includes("assertDepositReadyForFreeze"));
  assert.ok(freezeSrc.includes("deposit_verification_unavailable"));
  assert.ok(!freezeSrc.includes("depositVerified || unpaidDeposit()"));
  assert.ok(freezeSrc.includes("presentPaymentSummary"));
  assert.ok(!freezeSrc.includes("if (paySummary.scheduleMismatch)"));
  assert.ok(pdfSrc.includes("presentPaymentSummary"));
  assert.ok(pdfSrc.includes("remainingLabel"));
  assert.ok(pdfSrc.includes("paymentExplanationFromSnapshot"));
  assert.ok(pdfSrc.includes("showPaymentStages"));
  assert.ok(pdfSrc.includes("Payment Stages"));
  assert.ok(pdfSrc.includes("Deposit Paid"));
  assert.ok(pdfSrc.includes("Deposit Still Due"));
  assert.ok(pdfSrc.includes("Deposit Due Now"));
  assert.ok(signSrc.includes("presentPaymentSummary"));
  assert.ok(signSrc.includes("paymentExplanationFromSnapshot"));
  assert.ok(signSrc.includes("Payment Stages"));
  assert.ok(signSrc.includes("remainingLabel"));
  assert.ok(signSrc.includes("Deposit Still Due"));
  assert.ok(signSrc.includes("Deposit Due Now"));
  assert.ok(freezeSrc.includes("invoice_cadence_copy"));
  assert.ok(freezeSrc.includes("deposit_status_copy"));
  assert.ok(!pdfSrc.includes("quote.total ="));
  assert.ok(scheduleSrc.includes("depositBlocksConfirm"));
  assert.ok(scheduleSrc.includes("deposit_verification_unavailable"));
  assert.ok(!scheduleSrc.includes("payment_stages_mismatch"));
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

const MIXED_QUOTES = [
  {
    id: "pay-a",
    tenant_id: "t1",
    project_id: "p1",
    quote_id: "quote-a",
    payment_type: "deposit",
    amount: 500,
    paid_at: "2026-09-01T12:00:00.000Z",
  },
  {
    id: "pay-b",
    tenant_id: "t1",
    project_id: "p1",
    quote_id: "quote-b",
    payment_type: "deposit",
    amount: 800,
    paid_at: "2026-09-02T12:00:00.000Z",
  },
];

test("12 two quotes in the same project stay isolated", () => {
  const a = Deposit.fromLedgerRows(MIXED_QUOTES, {
    tenantId: "t1",
    projectId: "p1",
    quoteId: "quote-a",
  });
  const b = Deposit.fromLedgerRows(MIXED_QUOTES, {
    tenantId: "t1",
    projectId: "p1",
    quoteId: "quote-b",
  });
  assert.strictEqual(a.status, "paid");
  assert.strictEqual(a.amount, 500);
  assert.strictEqual(a.quote_id, "quote-a");
  assert.strictEqual(b.status, "paid");
  assert.strictEqual(b.amount, 800);
  assert.strictEqual(b.quote_id, "quote-b");
  assert.notStrictEqual(a.amount, b.amount);
});

test("13 deposit of quote A never appears on quote B", () => {
  const onlyA = [
    {
      id: "pay-a",
      tenant_id: "t1",
      project_id: "p1",
      quote_id: "quote-a",
      payment_type: "deposit",
      amount: 500,
      paid_at: "2026-09-01T12:00:00.000Z",
    },
  ];
  const b = Deposit.fromLedgerRows(onlyA, {
    tenantId: "t1",
    projectId: "p1",
    quoteId: "quote-b",
  });
  assert.strictEqual(b.verified_paid, false);
  assert.strictEqual(b.status, "none");
  assert.strictEqual(b.amount, null);
  assert.ok(
    Deposit.isLegacyProjectDepositUnique({
      targetQuoteId: "quote-a",
      projectQuoteId: "quote-a",
      paymentQuoteIds: ["quote-a", "quote-b"],
    }) === false
  );
});

test("14 query is tenant + project + quote", () => {
  const path = Deposit.scopedDepositRequestPath({
    tenantId: "t1",
    projectId: "p1",
    quoteId: "q1",
  });
  assert.ok(path.includes("tenant_id=eq.t1"));
  assert.ok(path.includes("project_id=eq.p1"));
  assert.ok(path.includes("quote_id=eq.q1"));
  assert.match(
    depositSrc,
    /tenant_id=eq\.\$\{tid\}[\s\S]{0,80}project_id=eq\.\$\{pid\}[\s\S]{0,80}quote_id=eq\.\$\{qid\}/
  );
  assert.ok(!depositSrc.includes("tenant_id=eq.${tid}&quote_id=eq.${qid}"));
  assert.ok(js.includes("Deposit status could not be verified. Refresh before confirming."));
});

test("15 verification_unavailable is not Deposit Due and blocks confirm/freeze", () => {
  const unavailable = {
    status: "verification_unavailable",
    verified_paid: false,
    amount: null,
    error: PaymentConfirm.DEPOSIT_UNAVAILABLE_MESSAGE,
  };
  const summary = PaymentConfirm.presentPaymentSummary({
    contractTotal: TOTAL,
    items: ITEMS,
    verifiedDeposit: unavailable,
    dueRuleLabel: dueLabel,
  });
  assert.strictEqual(summary.depositStatus, "verification_unavailable");
  assert.strictEqual(summary.depositLabel, "Deposit Status Unavailable");
  assert.ok(!/Paid|Due Now/.test(summary.depositLabel));
  assert.strictEqual(summary.blockConfirm, true);
  assert.strictEqual(
    summary.verificationMessage,
    "Deposit status could not be verified. Refresh before confirming."
  );
  assert.strictEqual(summary.remainingBalance, null);
  const plan = PaymentConfirm.paymentFooterPlan({
    items: ITEMS,
    contractTotal: TOTAL,
    verifiedDeposit: unavailable,
  });
  assert.strictEqual(plan.confirmEnabled, false);
  assert.strictEqual(plan.blockConfirm, true);
  assert.strictEqual(plan.refreshVisible, true);
  assert.ok(plan.buttons.some((btn) => btn.id === "refresh" && btn.enabled === true));
  assert.ok(js.includes("workspaceRefreshPaymentDeposit"));
  assert.ok(Deposit.depositBlocksConfirm(unavailable));
  assert.ok(Deposit.depositBlocksFreeze(unavailable));
  assert.strictEqual(Deposit.assertDepositReadyForFreeze(unavailable).ok, false);
  assert.strictEqual(
    Deposit.assertDepositReadyForFreeze(unavailable).code,
    "deposit_verification_unavailable"
  );
  const snap = Deposit.serializeDepositForSnapshot(unavailable, "q1");
  assert.strictEqual(snap.status, "verification_unavailable");
  assert.notStrictEqual(snap.status, "none");
  assert.strictEqual(snap.verified_paid, false);
});

test("16 deposit greater than contract total blocks", () => {
  const over = Deposit.fromLedgerRows(
    [
      {
        id: "over",
        tenant_id: "t1",
        project_id: "p1",
        quote_id: "q1",
        payment_type: "deposit",
        amount: 5000,
        paid_at: "2026-09-01T00:00:00.000Z",
      },
    ],
    { tenantId: "t1", projectId: "p1", quoteId: "q1", contractTotal: TOTAL }
  );
  assert.strictEqual(over.status, "inconsistent");
  assert.strictEqual(over.verified_paid, false);
  assert.ok(Deposit.depositBlocksConfirm(over));
  const summary = PaymentConfirm.presentPaymentSummary({
    contractTotal: TOTAL,
    items: ITEMS,
    verifiedDeposit: over,
    dueRuleLabel: dueLabel,
  });
  assert.strictEqual(summary.depositStatus, "inconsistent");
  assert.strictEqual(summary.depositLabel, "");
  assert.ok(summary.remainingBalance == null || summary.remainingBalance >= 0);
  assert.strictEqual(summary.blockConfirm, true);
  assert.strictEqual(Deposit.assertDepositReadyForFreeze(over).ok, false);
});

test("17 multiple valid partials on the same quote sum", () => {
  const summed = Deposit.fromLedgerRows(
    [
      {
        id: "p1",
        tenant_id: "t1",
        project_id: "p1",
        quote_id: "q1",
        payment_type: "deposit",
        amount: 0.4,
        paid_at: "2026-09-01T00:00:00.000Z",
      },
      {
        id: "p2",
        tenant_id: "t1",
        project_id: "p1",
        quote_id: "q1",
        payment_type: "deposit",
        amount: 0.6,
        paid_at: "2026-09-02T00:00:00.000Z",
      },
    ],
    { tenantId: "t1", projectId: "p1", quoteId: "q1", contractTotal: TOTAL }
  );
  assert.strictEqual(summed.status, "paid");
  assert.strictEqual(summed.amount, 1);
  assert.strictEqual(summed.verified_paid, true);
});

test("18 refund/void/reversal uses invoice_id, not notes", () => {
  const deposit = {
    id: "dep-1",
    tenant_id: "t1",
    quote_id: "q1",
    invoice_id: "inv-deposit",
    project_id: "p1",
    payment_type: "deposit",
    payment_method: "check",
    amount: 1,
    paid_at: "2026-09-01T00:00:00.000Z",
    notes: "",
    created_at: "2026-09-01T00:00:00.000Z",
  };
  const reversal = {
    ...deposit,
    id: "adj-1",
    payment_type: "adjustment",
    amount: -1,
    paid_at: "2026-09-02T00:00:00.000Z",
    notes: "",
  };
  const result = Deposit.fromLedgerRows([deposit, reversal], {
    tenantId: "t1",
    projectId: "p1",
    quoteId: "q1",
  });
  assert.strictEqual(result.verified_paid, false);
  assert.strictEqual(result.status, "none");
  const stillPaidIfNotesSayRefund = Deposit.fromLedgerRows(
    [{ ...deposit, notes: "refunded later" }],
    { tenantId: "t1", projectId: "p1", quoteId: "q1" }
  );
  assert.strictEqual(stillPaidIfNotesSayRefund.status, "paid");
  assert.strictEqual(stillPaidIfNotesSayRefund.amount, 1);
});

test("19 duplicate ledger rows do not double-count", () => {
  const dup = Deposit.fromLedgerRows(
    [
      {
        id: "same",
        tenant_id: "t1",
        project_id: "p1",
        quote_id: "q1",
        payment_type: "deposit",
        amount: 1,
        paid_at: "2026-09-01T00:00:00.000Z",
      },
      {
        id: "same",
        tenant_id: "t1",
        project_id: "p1",
        quote_id: "q1",
        payment_type: "deposit",
        amount: 1,
        paid_at: "2026-09-01T00:00:00.000Z",
      },
    ],
    { tenantId: "t1", projectId: "p1", quoteId: "q1" }
  );
  assert.strictEqual(dup.amount, 1);
  assert.strictEqual(dup.status, "paid");
});

test("20 contract without deposit stays none and $1.00 stays exact", () => {
  const none = Deposit.fromLedgerRows([], {
    tenantId: "t1",
    projectId: "p1",
    quoteId: "q1",
  });
  assert.strictEqual(none.status, "none");
  assert.strictEqual(none.verified_paid, false);
  const dollar = Deposit.fromLedgerRows(
    [
      {
        id: "one",
        tenant_id: "t1",
        project_id: "p1",
        quote_id: "q1",
        payment_type: "deposit",
        amount: 1,
        paid_at: "2026-09-01T00:00:00.000Z",
      },
    ],
    { tenantId: "t1", projectId: "p1", quoteId: "q1", contractTotal: TOTAL }
  );
  assert.strictEqual(dollar.amount, 1);
  const summary = PaymentConfirm.presentPaymentSummary({
    contractTotal: TOTAL,
    items: ITEMS,
    verifiedDeposit: dollar,
    dueRuleLabel: dueLabel,
  });
  assert.strictEqual(summary.depositAmount, 1);
  assert.strictEqual(summary.remainingBalance, 3264.49);
  assert.strictEqual(summary.remainingLabel, "Remaining Contract Balance");
  assert.strictEqual(summary.showPaymentStages, false);
  const snap = Deposit.serializeDepositForSnapshot(dollar, "q1");
  assert.strictEqual(snap.verified_paid, true);
  assert.strictEqual(snap.amount, 1);
  assert.strictEqual(snap.quote_id, "q1");
  assert.strictEqual(snap.source, "tenant_project_payments");
  assert.ok(snap.paid_at);
});

test("20b SELECT uses only real tenant_project_payments columns", () => {
  const schemaSrc = fs.readFileSync(
    path.join(ROOT, "SUPABASE_TENANT_PROJECT_PAYMENTS.sql"),
    "utf8"
  );
  assert.strictEqual(Deposit.LEDGER_SELECT, Deposit.LEDGER_COLUMNS.join(","));
  Deposit.LEDGER_COLUMNS.forEach((col) => {
    assert.ok(schemaSrc.includes(col), `missing schema column ${col}`);
    assert.ok(Deposit.LEDGER_SELECT.split(",").includes(col));
  });
  Deposit.INVENTED_LEDGER_COLUMNS.forEach((col) => {
    assert.ok(!Deposit.LEDGER_COLUMNS.includes(col), col);
    assert.ok(!Deposit.LEDGER_SELECT.split(",").includes(col), col);
  });
  const selectPath = Deposit.scopedDepositRequestPath({
    tenantId: "t1",
    projectId: "p1",
    quoteId: "q1",
  });
  assert.ok(selectPath.includes(`select=${Deposit.LEDGER_SELECT}`));
  Deposit.INVENTED_LEDGER_COLUMNS.forEach((col) => {
    assert.ok(!selectPath.includes(col), col);
  });
  assert.doesNotMatch(depositSrc, /row\?\.voided_at|row\?\.refunded_at|row\?\.status/);
  const scheduleApi = require("../netlify/functions/project-contract-payment-schedule.js");
  assert.strictEqual(typeof scheduleApi._test.depositBlocksConfirm, "function");
});

function ledgerRow(overrides) {
  return {
    id: "row-1",
    tenant_id: "t1",
    quote_id: "q1",
    invoice_id: "inv-deposit",
    project_id: "p1",
    payment_type: "deposit",
    payment_method: "check",
    amount: 1,
    paid_at: "2026-09-01T00:00:00.000Z",
    notes: "",
    created_at: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function depositOf(rows, extra) {
  return Deposit.fromLedgerRows(rows, {
    tenantId: "t1",
    projectId: "p1",
    quoteId: "q1",
    contractTotal: TOTAL,
    ...(extra || {}),
  });
}

test("26 adjustment alone never creates Deposit Paid", () => {
  const positive = depositOf([
    ledgerRow({ id: "adj+", payment_type: "adjustment", amount: 500 }),
  ]);
  assert.strictEqual(positive.status, "none");
  assert.strictEqual(positive.verified_paid, false);
  const negative = depositOf([
    ledgerRow({ id: "adj-", payment_type: "adjustment", amount: -500 }),
  ]);
  assert.strictEqual(negative.status, "none");
  assert.strictEqual(negative.verified_paid, false);
});

test("27 valid deposit with paid_at is paid", () => {
  const paid = depositOf([ledgerRow({ id: "dep" })]);
  assert.strictEqual(paid.status, "paid");
  assert.strictEqual(paid.amount, 1);
  assert.strictEqual(paid.verified_paid, true);
});

test("28 linked negative adjustment nets the deposit", () => {
  const netted = depositOf([
    ledgerRow({ id: "dep", amount: 1, invoice_id: "inv-deposit" }),
    ledgerRow({
      id: "adj",
      payment_type: "adjustment",
      amount: -0.4,
      invoice_id: "inv-deposit",
      paid_at: "2026-09-02T00:00:00.000Z",
    }),
  ]);
  assert.strictEqual(netted.status, "paid");
  assert.strictEqual(netted.amount, 0.6);
});

test("29 linked positive adjustment nets the deposit", () => {
  const netted = depositOf([
    ledgerRow({ id: "dep", amount: 1, invoice_id: "inv-deposit" }),
    ledgerRow({
      id: "adj",
      payment_type: "adjustment",
      amount: 0.25,
      invoice_id: "inv-deposit",
      paid_at: "2026-09-02T00:00:00.000Z",
    }),
  ]);
  assert.strictEqual(netted.status, "paid");
  assert.strictEqual(netted.amount, 1.25);
});

test("30 adjustment on another invoice_id does not change the deposit", () => {
  const kept = depositOf([
    ledgerRow({ id: "dep", amount: 1, invoice_id: "inv-deposit" }),
    ledgerRow({
      id: "adj",
      payment_type: "adjustment",
      amount: -1,
      invoice_id: "inv-progress",
    }),
  ]);
  assert.strictEqual(kept.status, "paid");
  assert.strictEqual(kept.amount, 1);
});

test("31 adjustment without invoice_id does not change an invoiced deposit", () => {
  const kept = depositOf([
    ledgerRow({ id: "dep", amount: 1, invoice_id: "inv-deposit" }),
    ledgerRow({
      id: "adj",
      payment_type: "adjustment",
      amount: -1,
      invoice_id: null,
    }),
  ]);
  assert.strictEqual(kept.status, "paid");
  assert.strictEqual(kept.amount, 1);
});

test("32 legacy deposit without invoice_id stays valid and does not absorb adjustments", () => {
  const legacy = depositOf([
    ledgerRow({ id: "legacy", amount: 1, invoice_id: null }),
    ledgerRow({
      id: "adj-null",
      payment_type: "adjustment",
      amount: -1,
      invoice_id: null,
    }),
    ledgerRow({
      id: "adj-other",
      payment_type: "adjustment",
      amount: -1,
      invoice_id: "inv-other",
    }),
  ]);
  assert.strictEqual(legacy.status, "paid");
  assert.strictEqual(legacy.amount, 1);
  assert.ok(depositSrc.includes("invoice_id is the authoritative link"));
  assert.ok(depositSrc.includes("does not absorb adjustments"));
});

test("33 multiple partial deposits net with their own invoice_id adjustments", () => {
  const netted = depositOf([
    ledgerRow({ id: "d1", amount: 0.4, invoice_id: "inv-a" }),
    ledgerRow({ id: "d2", amount: 0.6, invoice_id: "inv-b", paid_at: "2026-09-02T00:00:00.000Z" }),
    ledgerRow({
      id: "adj-a",
      payment_type: "adjustment",
      amount: -0.1,
      invoice_id: "inv-a",
    }),
    ledgerRow({
      id: "adj-b",
      payment_type: "adjustment",
      amount: 0.1,
      invoice_id: "inv-b",
    }),
  ]);
  assert.strictEqual(netted.status, "paid");
  assert.strictEqual(netted.amount, 1);
});

test("34 progress/final adjustments do not change Deposit Paid", () => {
  const kept = depositOf([
    ledgerRow({ id: "dep", amount: 1, invoice_id: "inv-deposit" }),
    ledgerRow({
      id: "progress",
      payment_type: "progress",
      amount: 500,
      invoice_id: "inv-progress",
    }),
    ledgerRow({
      id: "adj-progress",
      payment_type: "adjustment",
      amount: -500,
      invoice_id: "inv-progress",
    }),
    ledgerRow({
      id: "final",
      payment_type: "final",
      amount: 200,
      invoice_id: "inv-final",
    }),
    ledgerRow({
      id: "adj-final",
      payment_type: "adjustment",
      amount: -50,
      invoice_id: "inv-final",
    }),
  ]);
  assert.strictEqual(kept.status, "paid");
  assert.strictEqual(kept.amount, 1);
});

test("35 quote A never inherits quote B payments or adjustments", () => {
  const rows = [
    ledgerRow({
      id: "dep-a",
      quote_id: "quote-a",
      invoice_id: "inv-a",
      amount: 500,
    }),
    ledgerRow({
      id: "adj-a",
      quote_id: "quote-a",
      invoice_id: "inv-a",
      payment_type: "adjustment",
      amount: -50,
    }),
    ledgerRow({
      id: "dep-b",
      quote_id: "quote-b",
      invoice_id: "inv-b",
      amount: 800,
    }),
    ledgerRow({
      id: "adj-b",
      quote_id: "quote-b",
      invoice_id: "inv-b",
      payment_type: "adjustment",
      amount: 25,
    }),
  ];
  const a = Deposit.fromLedgerRows(rows, {
    tenantId: "t1",
    projectId: "p1",
    quoteId: "quote-a",
  });
  const b = Deposit.fromLedgerRows(rows, {
    tenantId: "t1",
    projectId: "p1",
    quoteId: "quote-b",
  });
  assert.strictEqual(a.amount, 450);
  assert.strictEqual(b.amount, 825);
  assert.notStrictEqual(a.amount, b.amount);
});

async function testAsync(name, fn) {
  try {
    await fn();
    console.log("PASS", name);
    passed += 1;
  } catch (err) {
    console.log("FAIL", name, "-", err.message);
    failed += 1;
  }
}

(async () => {
  await testAsync("21 exact scoped query failure is verification_unavailable", async () => {
    const scopedPath = Deposit.scopedDepositRequestPath({
      tenantId: "t1",
      projectId: "p1",
      quoteId: "q1",
    });
    const result = await Deposit.resolveVerifiedContractDeposit(
      { tenantId: "t1", projectId: "p1", quoteId: "q1", contractTotal: TOTAL },
      {
        request: async (path) => {
          if (String(path) === scopedPath) {
            throw new Error("Supabase HTTP 500: boom");
          }
          throw new Error("unexpected path " + path);
        },
      }
    );
    assert.strictEqual(result.status, "verification_unavailable");
    assert.strictEqual(result.verified_paid, false);
    assert.notStrictEqual(result.status, "due");
    const summary = PaymentConfirm.presentPaymentSummary({
      contractTotal: TOTAL,
      items: ITEMS,
      verifiedDeposit: result,
      dueRuleLabel: dueLabel,
    });
    assert.strictEqual(summary.depositStatus, "verification_unavailable");
    assert.strictEqual(summary.depositLabel, "Deposit Status Unavailable");
    assert.strictEqual(summary.blockConfirm, true);
    assert.ok(
      summary.verificationMessage.includes("Deposit status could not be verified")
    );
  });

  await testAsync("22 proveLegacyUnique failure is verification_unavailable, never Due", async () => {
    const scopedPath = Deposit.scopedDepositRequestPath({
      tenantId: "t1",
      projectId: "p1",
      quoteId: "q1",
    });
    const result = await Deposit.resolveVerifiedContractDeposit(
      { tenantId: "t1", projectId: "p1", quoteId: "q1", contractTotal: TOTAL },
      {
        request: async (path) => {
          if (String(path) === scopedPath) return [];
          throw new Error("Supabase HTTP 500: proveLegacyUnique failed");
        },
      }
    );
    assert.strictEqual(result.status, "verification_unavailable");
    assert.notStrictEqual(result.status, "none");
    const summary = PaymentConfirm.presentPaymentSummary({
      contractTotal: TOTAL,
      items: ITEMS,
      verifiedDeposit: result,
      dueRuleLabel: dueLabel,
    });
    assert.strictEqual(summary.depositStatus, "verification_unavailable");
    assert.notStrictEqual(summary.depositStatus, "due");
    assert.strictEqual(summary.depositLabel, "Deposit Status Unavailable");
    assert.ok(!/Due Now|Paid/.test(summary.depositLabel));
    assert.strictEqual(summary.blockConfirm, true);
    assert.ok(Deposit.depositBlocksConfirm(result));
    assert.strictEqual(Deposit.assertDepositReadyForFreeze(result).ok, false);
    const plan = PaymentConfirm.paymentFooterPlan({
      items: ITEMS,
      contractTotal: TOTAL,
      verifiedDeposit: result,
    });
    assert.strictEqual(plan.confirmEnabled, false);
    assert.ok(
      plan.errorMessage.includes("Deposit status could not be verified")
    );
  });

  await testAsync("23 quote-scoped request is the only paid query when quote exists", async () => {
    const seen = [];
    const result = await Deposit.resolveVerifiedContractDeposit(
      { tenantId: "t1", projectId: "p1", quoteId: "quote-b", contractTotal: TOTAL },
      {
        request: async (path) => {
          seen.push(String(path));
          if (String(path).includes("quote_id=eq.quote-b")) {
            return [MIXED_QUOTES[1]];
          }
          if (String(path).includes("tenant_projects?")) {
            return [{ id: "p1", quote_id: "quote-b" }];
          }
          return [];
        },
      }
    );
    assert.strictEqual(result.status, "paid");
    assert.strictEqual(result.amount, 800);
    assert.ok(seen[0].includes("tenant_id=eq.t1"));
    assert.ok(seen[0].includes("project_id=eq.p1"));
    assert.ok(seen[0].includes("quote_id=eq.quote-b"));
    assert.ok(!seen.some((path) => path.includes("quote_id=eq.quote-a")));
  });

  await testAsync("24 Confirm API and Freeze block unavailable and inconsistent", async () => {
    const unavailable = await Deposit.resolveVerifiedContractDeposit(
      { tenantId: "t1", projectId: "p1", quoteId: "q1", contractTotal: TOTAL },
      {
        request: async (path) => {
          if (String(path).includes("quote_id=eq.q1")) return [];
          throw new Error("Supabase HTTP 500: proveLegacyUnique failed");
        },
      }
    );
    const posts = [];
    const runner = PaymentConfirm.createPaymentConfirmRunner({
      getItems: () => ITEMS,
      getContractTotal: () => TOTAL,
      getVerifiedDeposit: () => unavailable,
      getDepositRequired: () => 1,
      getIds: () => ({ projectId: "p1", quoteId: "q1" }),
      postJson: async (url, body) => {
        posts.push({ url, body });
        return { ok: true, status: 200, data: { ok: true } };
      },
    });
    const confirmResult = await runner.confirm();
    assert.strictEqual(confirmResult.ok, false);
    assert.strictEqual(confirmResult.posted, false);
    assert.strictEqual(confirmResult.reason, "verification_unavailable");
    assert.strictEqual(posts.length, 0);
    assert.ok(Deposit.depositBlocksConfirm(unavailable));
    assert.strictEqual(Deposit.assertDepositReadyForFreeze(unavailable).ok, false);
    assert.strictEqual(
      Deposit.assertDepositReadyForFreeze(unavailable).code,
      "deposit_verification_unavailable"
    );

    const inconsistent = Deposit.fromLedgerRows(
      [
        {
          id: "over",
          tenant_id: "t1",
          project_id: "p1",
          quote_id: "q1",
          payment_type: "deposit",
          payment_method: "check",
          amount: 5000,
          paid_at: "2026-09-01T00:00:00.000Z",
          notes: "",
        },
      ],
      { tenantId: "t1", projectId: "p1", quoteId: "q1", contractTotal: TOTAL }
    );
    assert.strictEqual(inconsistent.status, "inconsistent");
    assert.ok(Deposit.depositBlocksConfirm(inconsistent));
    assert.strictEqual(Deposit.assertDepositReadyForFreeze(inconsistent).ok, false);
    const scheduleApi = require("../netlify/functions/project-contract-payment-schedule.js");
    assert.strictEqual(scheduleApi._test.depositBlocksConfirm(unavailable), true);
    assert.strictEqual(scheduleApi._test.depositBlocksConfirm(inconsistent), true);
    assert.ok(scheduleSrc.includes("if (confirmSchedule && depositBlocksConfirm(deposit))"));
    assert.ok(freezeSrc.includes("deposit_verification_unavailable"));
    assert.ok(freezeSrc.includes("deposit_inconsistent"));
  });

  await testAsync("24b Confirm Payment Terms posts deposit only and ignores future stages", async () => {
    const posts = [];
    const runner = PaymentConfirm.createPaymentConfirmRunner({
      getItems: () => THREE_PROGRESS,
      getContractTotal: () => TOTAL_5K,
      getVerifiedDeposit: () => paidDeposit(3500),
      getDepositRequired: () => 1000,
      getIds: () => ({ projectId: "p1", quoteId: "q1" }),
      postJson: async (url, body) => {
        posts.push({ url, body });
        return { ok: true, status: 200, data: { ok: true } };
      },
    });
    const confirmResult = await runner.confirm();
    assert.strictEqual(confirmResult.ok, true);
    assert.strictEqual(confirmResult.posted, true);
    assert.strictEqual(posts.length, 1);
    assert.strictEqual(posts[0].body.confirm_schedule, true);
    assert.ok(posts[0].body.items.every((row) => /deposit|initial scheduling/i.test(row.label + " " + row.payment_type)));
    assert.ok(!posts[0].body.items.some((row) => /progress/i.test(row.label)));
    assert.ok(!freezeSrc.includes("if (paySummary.scheduleMismatch)"));
  });

  await testAsync("25 quote A never inherits quote B deposit from the live resolver", async () => {
    const resultA = await Deposit.resolveVerifiedContractDeposit(
      { tenantId: "t1", projectId: "p1", quoteId: "quote-a", contractTotal: TOTAL },
      {
        request: async (path) => {
          if (String(path).includes("quote_id=eq.quote-a")) return [MIXED_QUOTES[0]];
          if (String(path).includes("quote_id=eq.quote-b")) return [MIXED_QUOTES[1]];
          return MIXED_QUOTES;
        },
      }
    );
    const resultB = await Deposit.resolveVerifiedContractDeposit(
      { tenantId: "t1", projectId: "p1", quoteId: "quote-b", contractTotal: TOTAL },
      {
        request: async (path) => {
          if (String(path).includes("quote_id=eq.quote-a")) return [MIXED_QUOTES[0]];
          if (String(path).includes("quote_id=eq.quote-b")) return [MIXED_QUOTES[1]];
          return MIXED_QUOTES;
        },
      }
    );
    assert.strictEqual(resultA.amount, 500);
    assert.strictEqual(resultB.amount, 800);
    assert.notStrictEqual(resultA.amount, resultB.amount);
  });

  test("26 customize UX: unpaid/paid/partial, locked deposit, one primary, no technical terms", () => {
    const unpaid = PaymentConfirm.presentPaymentSummary({
      contractTotal: TOTAL,
      items: ITEMS,
      verifiedDeposit: { verified_paid: false },
      currency: "USD",
      dueRuleLabel: dueLabel,
      hideFutureStages: true,
    });
    const paid = PaymentConfirm.presentPaymentSummary({
      contractTotal: TOTAL,
      items: ITEMS,
      verifiedDeposit: { status: "paid", verified_paid: true, amount: 1 },
      currency: "USD",
      dueRuleLabel: dueLabel,
      hideFutureStages: true,
    });
    const partial = PaymentConfirm.presentPaymentSummary({
      contractTotal: TOTAL,
      items: ITEMS,
      verifiedDeposit: { status: "paid", verified_paid: true, amount: 0.5 },
      depositRequired: 1,
      currency: "USD",
      dueRuleLabel: dueLabel,
      hideFutureStages: true,
    });
    assert.strictEqual(unpaid.depositLabel, "Deposit Due Now");
    assert.strictEqual(unpaid.remainingLabel, "Balance After Deposit");
    assert.strictEqual(unpaid.remainingBalance, 3264.49);
    assert.strictEqual(paid.depositLabel, "Deposit Paid");
    assert.strictEqual(paid.remainingLabel, "Remaining Contract Balance");
    assert.strictEqual(partial.depositLabel, "Deposit Paid");
    assert.strictEqual(partial.showDepositStillDue, true);
    assert.strictEqual(partial.depositStillDue, 0.5);
    assert.ok(!js.includes("data-pay-field=\"item_role\""));
    assert.ok(!PaymentConfirm.BILLING_TERMS_COPY.toLowerCase().includes("due upon completion"));
    assert.ok(!unpaid.explanationCopy.toLowerCase().includes("due upon completion"));
    assert.ok(PaymentConfirm.BILLING_TERMS_COPY.includes("Progress invoices are sent every two weeks based on completed work"));
    const unconfirmed = PaymentConfirm.paymentFooterPlan({
      items: ITEMS,
      contractTotal: TOTAL,
      confirmed: false,
    });
    assert.strictEqual(unconfirmed.primaryLabel, "Confirm Payment Terms");
    assert.strictEqual(unconfirmed.buttons.filter((b) => b.style === "primary").length, 1);
    assert.ok(!unconfirmed.buttons.some((b) => b.id === "customize"));
    const confirmed = PaymentConfirm.paymentFooterPlan({
      items: ITEMS,
      contractTotal: TOTAL,
      confirmed: true,
    });
    assert.strictEqual(confirmed.primaryLabel, "Continue");
    assert.strictEqual(confirmed.buttons.filter((b) => b.style === "primary").length, 1);
    assert.ok(!html.includes("+ Add Payment Stage"));
    assert.ok(!html.includes("Customize Payment Plan"));
    assert.ok(!html.includes(">Scheduled<"));
    assert.ok(!html.includes(">Difference<"));
    assert.ok(!js.includes("Edit Payment Schedule"));
    assert.ok(!html.includes("Advanced editing"));
    assert.ok(html.includes('class="btn ghost" id="cbNextActionBtn"'));
    assert.ok(html.includes("overflow-x: hidden"));
    assert.ok(!scheduleSrc.includes("upsert-tenant-invoice"));
    assert.ok(!js.includes("record-tenant-payment"));
    assert.ok(art6.includes("This is the approved contract price."));
  });

  test("27 Payment Terms seed deposit only and keep exact billing copy", () => {
    const PaymentDefaults = require("../public/js/contract-payment-defaults.js");
    const seeded = PaymentDefaults.buildDefaultPaymentSchedule({
      contractTotal: TOTAL,
      depositRequired: 1,
      items: [],
      readinessStatus: "missing",
    });
    assert.strictEqual(seeded.items.length, 1);
    assert.strictEqual(seeded.items[0].label, "Initial Scheduling Payment");
    assert.strictEqual(seeded.items[0].amount, 1);
    assert.ok(!seeded.items.some((row) => row.label === "Progress & Final Billing"));
    const none = PaymentDefaults.buildDefaultPaymentSchedule({
      contractTotal: TOTAL,
      depositRequired: 0,
      items: [],
    });
    assert.strictEqual(none.items.length, 0);
    assert.strictEqual(
      PaymentConfirm.BILLING_TERMS_COPY,
      "Progress invoices are sent every two weeks based on completed work. If the project is completed sooner, the final invoice is sent when the work is complete."
    );
    assert.ok(html.includes("Billing Terms"));
    assert.ok(helperSrc.includes("hideFutureStages: true"));
    assert.ok(js.includes("presentAuthenticatedPaymentArticleFromBuilderSource"));
    assert.ok(!scheduleSrc.includes("upsert-tenant-invoice"));
    assert.ok(!js.includes("record-tenant-payment"));
  });

  test("28 reorder helper remains unused by the Payment Terms UI", () => {
    const one = PaymentConfirm.paymentStageReorderActions(0, 1);
    assert.strictEqual(one.up, false);
    assert.strictEqual(one.down, false);
    const firstOfTwo = PaymentConfirm.paymentStageReorderActions(0, 2);
    assert.strictEqual(firstOfTwo.up, false);
    assert.strictEqual(firstOfTwo.down, true);
    const lastOfTwo = PaymentConfirm.paymentStageReorderActions(1, 2);
    assert.strictEqual(lastOfTwo.up, true);
    assert.strictEqual(lastOfTwo.down, false);
    const firstOfThree = PaymentConfirm.paymentStageReorderActions(0, 3);
    assert.strictEqual(firstOfThree.up, false);
    assert.strictEqual(firstOfThree.down, true);
    const middle = PaymentConfirm.paymentStageReorderActions(1, 3);
    assert.strictEqual(middle.up, true);
    assert.strictEqual(middle.down, true);
    const lastOfThree = PaymentConfirm.paymentStageReorderActions(2, 3);
    assert.strictEqual(lastOfThree.up, true);
    assert.strictEqual(lastOfThree.down, false);
    assert.ok(js.includes("paymentStageActionButtonsHtml"));
    assert.ok(js.includes("paymentStageReorderActions"));
    assert.doesNotMatch(js, /data-pay-action="up"[\s\S]{0,80}disabled/);
    assert.doesNotMatch(js, /data-pay-action="down"[\s\S]{0,80}disabled/);
    assert.ok(js.includes("if (!buttons.length) return \"\""));
    assert.ok(html.includes(".cb-pay-stage-card__actions:empty"));
  });

  test("29 Payment Terms replace the payment schedule UI", () => {
    assert.ok(art7.includes("Payment Terms"));
    assert.ok(!art7.includes("Payment Schedule"));
    assert.ok(!html.includes("+ Add Payment Stage"));
    assert.ok(!html.includes("Customize Payment Plan"));
    assert.ok(!html.includes("Move up"));
    assert.ok(!html.includes("Move down"));
    assert.ok(!html.includes(">Difference<"));
    assert.ok(!html.includes(">Scheduled<"));
    assert.ok(!js.includes("Complete Payment Schedule"));
    assert.ok(js.includes("Open Payment Terms"));
    assert.ok(js.includes("Confirm the payment terms"));
    assert.ok(js.includes("Confirm Payment Terms"));
    const plan = PaymentConfirm.paymentFooterPlan({
      items: [],
      contractTotal: TOTAL,
      depositRequired: 1,
      confirmed: false,
    });
    assert.strictEqual(plan.primaryLabel, "Confirm Payment Terms");
    assert.strictEqual(plan.buttons.filter((b) => b.style === "primary").length, 1);
    assert.ok(!plan.buttons.some((b) => b.id === "customize"));
    const due = PaymentConfirm.presentPaymentSummary({
      contractTotal: TOTAL,
      items: [],
      depositRequired: 1,
      verifiedDeposit: { verified_paid: false },
      hideFutureStages: true,
    });
    assert.strictEqual(due.depositStatus, "due");
    assert.strictEqual(due.remainingBalance, 3264.49);
    assert.strictEqual(due.remainingLabel, "Balance After Deposit");
    assert.strictEqual(due.showPaymentStages, false);
    assert.ok(due.explanationCopy.startsWith(PaymentConfirm.DEPOSIT_DUE_COPY));
    assert.ok(due.explanationCopy.includes(PaymentConfirm.BILLING_TERMS_COPY));
    const paid = PaymentConfirm.presentPaymentSummary({
      contractTotal: TOTAL,
      items: [],
      depositRequired: 1,
      verifiedDeposit: { status: "paid", verified_paid: true, amount: 1 },
      hideFutureStages: true,
    });
    assert.strictEqual(paid.depositStatus, "paid");
    assert.strictEqual(paid.remainingBalance, 3264.49);
    assert.ok(paid.explanationCopy.startsWith(PaymentConfirm.DEPOSIT_PAID_COPY));
    assert.ok(freezeSrc.includes("invoice_cadence_copy"));
    assert.ok(freezeSrc.includes("contentHashForSnapshot") || freezeSrc.includes("content_hash"));
    assert.ok(!freezeSrc.includes("if (paySummary.scheduleMismatch)"));
    assert.ok(pdfSrc.includes("Payment Terms"));
    assert.ok(pdfSrc.includes("paymentExplanationFromSnapshot"));
    assert.ok(signSrc.includes("Payment Terms"));
    assert.ok(signSrc.includes("paymentExplanationFromSnapshot"));
    assert.ok(helperSrc.includes("legacy omits") || pdfSrc.includes("paymentExplanationFromSnapshot"));
    assert.ok(!scheduleSrc.includes("upsert-tenant-invoice"));
    assert.ok(!js.includes("record-tenant-payment"));
    assert.ok(art6.includes("This is the approved contract price."));
    assert.ok(art6.includes("Payment details are listed in Article 7."));
    assert.ok(helperSrc.includes("approved change orders") || helperSrc.includes("Invoice Hub"));
  });

  test("30 new Payment Terms UI omits schedule-sum blockers", () => {
    assert.ok(!art7.includes("Payment amounts must equal the contract total"));
    assert.ok(!js.includes("Payment amounts must equal the contract total"));
    assert.ok(!helperSrc.includes("Payment amounts must equal the contract total"));
    assert.ok(!art7.includes("Payment schedule"));
    assert.ok(!js.includes("Payment schedule"));
    assert.ok(!helperSrc.includes("Payment schedule"));
    assert.ok(!js.includes("payment_stages_mismatch"));
    assert.ok(!helperSrc.includes("payment_stages_mismatch"));
    assert.ok(!js.includes("items_required"));
    assert.ok(!helperSrc.includes("items_required"));
    assert.ok(!js.includes("if (paySummary.scheduleMismatch)"));
    assert.ok(js.includes("NEEDS CONFIRMATION — PAYMENT TERMS"));
    assert.ok(js.includes("COMPLETE — PAYMENT TERMS"));
    assert.ok(js.includes("presentAuthenticatedPaymentArticle"));
    assert.ok(js.includes("payView.remainingLabel"));
    assert.ok(helperSrc.includes("Balance After Deposit"));
    const due = PaymentConfirm.presentPaymentSummary({
      contractTotal: 5000,
      depositRequired: 1000,
      verifiedDeposit: { verified_paid: false },
      hideFutureStages: true,
    });
    assert.strictEqual(due.remainingLabel, "Balance After Deposit");
    assert.strictEqual(due.remainingBalance, 4000);
    assert.strictEqual(due.blockConfirm, false);
    const paid = PaymentConfirm.presentPaymentSummary({
      contractTotal: 5000,
      depositRequired: 1000,
      verifiedDeposit: { status: "paid", verified_paid: true, amount: 1000 },
      hideFutureStages: true,
    });
    assert.strictEqual(paid.remainingLabel, "Remaining Contract Balance");
    assert.strictEqual(paid.remainingBalance, 4000);
    const partial = PaymentConfirm.presentPaymentSummary({
      contractTotal: 5000,
      depositRequired: 1000,
      verifiedDeposit: { status: "paid", verified_paid: true, amount: 400 },
      hideFutureStages: true,
    });
    assert.strictEqual(partial.showDepositStillDue, true);
    assert.strictEqual(partial.depositStillDue, 600);
    assert.strictEqual(partial.remainingLabel, "Remaining Contract Balance");
    assert.strictEqual(partial.remainingBalance, 4600);
    const blocked = PaymentConfirm.paymentFooterPlan({
      contractTotal: 5000,
      depositRequired: 1000,
      verifiedDeposit: { status: "verification_unavailable" },
      confirmed: false,
    });
    assert.strictEqual(blocked.confirmEnabled, false);
    assert.strictEqual(blocked.blockConfirm, true);
    const ready = PaymentConfirm.paymentFooterPlan({
      contractTotal: 5000,
      depositRequired: 1000,
      verifiedDeposit: { verified_paid: false },
      confirmed: false,
    });
    assert.strictEqual(ready.confirmEnabled, true);
    assert.ok(!ready.buttons.some((b) => b.id === "customize"));
  });

  test("31 authenticated Contract Builder render path for unpaid deposit", () => {
    assert.ok(js.includes("presentAuthenticatedPaymentArticle"));
    assert.ok(js.includes("hydratePaymentDraftFromSource"));
    assert.ok(js.includes("renderPaymentScheduleSection(source)"));
    const hydrate = js.slice(
      js.indexOf("function hydratePaymentDraftFromSource"),
      js.indexOf("function paymentDraftContractTotal")
    );
    assert.ok(!hydrate.includes("ensureResidualBillingRow()"));
    const view = PaymentConfirm.presentAuthenticatedPaymentArticle({
      contractTotal: 3265.49,
      depositRequired: 1,
      items: [
        {
          label: "Initial Scheduling Payment",
          amount: 1,
          due_rule: "on_signature",
          payment_type: "deposit",
        },
      ],
      verifiedDeposit: { status: "none", verified_paid: false, amount: null },
      readinessStatus: "missing",
      currency: "USD",
    });
    assert.strictEqual(view.contractTotal, 3265.49);
    assert.strictEqual(view.depositLabel, "Deposit Due Now");
    assert.strictEqual(view.depositAmount, 1);
    assert.strictEqual(view.remainingLabel, "Balance After Deposit");
    assert.strictEqual(view.remainingBalance, 3264.49);
    assert.strictEqual(
      PaymentConfirm.moneyToCents(view.remainingBalance),
      PaymentConfirm.moneyToCents(3265.49) - PaymentConfirm.moneyToCents(1)
    );
    assert.strictEqual(view.readinessCaption, "NEEDS CONFIRMATION — PAYMENT TERMS");
    assert.strictEqual(view.readinessStatus, "needs_confirmation");
    assert.strictEqual(view.showPaymentStages, false);
    assert.strictEqual(view.blockConfirm, false);
    assert.strictEqual(view.errorMessage, "");
    assert.strictEqual(view.sumError, "");
    const plan = PaymentConfirm.paymentFooterPlan({
      contractTotal: 3265.49,
      depositRequired: 1,
      items: [{ label: "Initial Scheduling Payment", amount: 1, payment_type: "deposit" }],
      verifiedDeposit: { verified_paid: false },
      confirmed: false,
    });
    assert.strictEqual(plan.primaryLabel, "Confirm Payment Terms");
    assert.strictEqual(plan.confirmEnabled, true);
    assert.strictEqual(plan.errorMessage, "");
    assert.ok(!js.includes("Payment amounts must equal the contract total"));
    assert.ok(!js.includes("MISSING — Payment schedule"));
    assert.ok(!js.includes('{ label: "Payment schedule"'));
  });

  test("32 authenticated Contract Builder source render path for unpaid deposit", () => {
    const renderFn = slice(js, "function renderPaymentScheduleSection", "function renderWarrantySection");
    assert.ok(renderFn.includes("presentAuthenticatedPaymentArticleFromBuilderSource"));
    assert.ok(renderFn.includes("authenticatedPaymentSource(source)"));
    assert.ok(!renderFn.includes("presentPaymentSummary("));
    assert.ok(!renderFn.includes('paySummary.remainingLabel || "Remaining Contract Balance"'));
    const summaryFn = slice(js, "function currentPaymentSummary", "function paymentFutureDraftItems");
    assert.ok(summaryFn.includes("presentAuthenticatedPaymentArticleFromBuilderSource"));
    const footerFn = slice(js, "function currentPaymentFooterPlan", "function paymentScheduleAllowsOwnerEdit");
    assert.ok(footerFn.includes("authenticatedPaymentSource(sourceSnapshot)"));
    const hydrate = slice(js, "function hydratePaymentDraftFromSource", "function paymentDraftContractTotal");
    assert.ok(!hydrate.includes("ensureResidualBillingRow()"));
    const readinessFn = slice(js, "function renderReadiness", "function renderLogo");
    assert.ok(readinessFn.includes("presentAuthenticatedPaymentChrome"));
    assert.ok(readinessFn.includes('i.label !== "Payment terms"'));
    assert.ok(html.includes("contract-builder.js?v=pt-src-3"));
    assert.ok(html.includes("contract-payment-confirm.js?v=pt-src-3"));

    const source = {
      contractTotal: 3265.49,
      depositRequired: 1,
      depositRequiredAmount: 1,
      currency: "USD",
      paymentSchedule: {
        available: true,
        items: [],
        readiness: { status: "missing", contract_total: 3265.49 },
        deposit: { status: "none", verified_paid: false, amount: null },
      },
    };
    const seeded = PaymentDefaults.buildDefaultPaymentSchedule({
      contractTotal: source.contractTotal,
      depositRequired: source.depositRequiredAmount,
      items: source.paymentSchedule.items,
      readinessStatus: source.paymentSchedule.readiness.status,
    });
    assert.strictEqual(seeded.seeded, true);
    source.paymentSchedule.items = seeded.items;

    const view = PaymentConfirm.presentAuthenticatedPaymentArticleFromBuilderSource(source);
    assert.strictEqual(view.contractTotal, 3265.49);
    assert.strictEqual(view.depositLabel, "Deposit Due Now");
    assert.strictEqual(view.depositAmount, 1);
    assert.strictEqual(view.remainingLabel, "Balance After Deposit");
    assert.strictEqual(view.remainingBalance, 3264.49);
    assert.strictEqual(view.readinessCaption, "NEEDS CONFIRMATION — PAYMENT TERMS");
    assert.strictEqual(view.readinessStatus, "needs_confirmation");
    assert.strictEqual(view.errorMessage, "");
    assert.strictEqual(view.sumError, "");
    assert.strictEqual(view.showPaymentStages, false);
    assert.ok(!String(view.errorMessage || "").includes("Payment amounts must equal"));

    source.paymentSchedule.items = source.paymentSchedule.items.concat([
      {
        label: "Progress & Final Billing",
        amount: 3265.49,
        payment_type: "final",
        due_rule: "custom",
        item_role: "future_obligation",
      },
    ]);
    const leftover = PaymentConfirm.presentAuthenticatedPaymentArticleFromBuilderSource(source);
    assert.strictEqual(leftover.remainingLabel, "Balance After Deposit");
    assert.strictEqual(leftover.remainingBalance, 3264.49);
    assert.strictEqual(leftover.errorMessage, "");
    assert.strictEqual(leftover.sumError, "");
    assert.strictEqual(leftover.readinessCaption, "NEEDS CONFIRMATION — PAYMENT TERMS");

    const paymentReady = PaymentConfirm.paymentTermsReadiness(source.paymentSchedule.readiness.status);
    const readinessItems = [
      { label: "Payment terms", status: paymentReady.status, caption: paymentReady.caption },
    ];
    const missing = readinessItems.filter(
      (i) => i.status === "missing" && i.label !== "Payment terms"
    );
    const warns = readinessItems.filter(
      (i) => i.status === "needs_confirmation" && i.label !== "Payment terms"
    );
    assert.deepStrictEqual(missing, []);
    assert.deepStrictEqual(warns, []);
    assert.strictEqual(paymentReady.caption, "NEEDS CONFIRMATION — PAYMENT TERMS");

    const plan = PaymentConfirm.paymentFooterPlan({
      confirmed: false,
      source,
    });
    assert.strictEqual(plan.primaryLabel, "Confirm Payment Terms");
    assert.strictEqual(plan.confirmEnabled, true);
    assert.strictEqual(plan.errorMessage, "");
  });

  function unpaidBuilderSource() {
    const source = {
      contractTotal: 3265.49,
      depositRequired: 1,
      depositRequiredAmount: 1,
      currency: "USD",
      paymentSchedule: {
        available: true,
        items: [],
        readiness: { status: "missing", contract_total: 3265.49 },
        deposit: { status: "none", verified_paid: false, amount: null },
      },
    };
    const seeded = PaymentDefaults.buildDefaultPaymentSchedule({
      contractTotal: source.contractTotal,
      depositRequired: source.depositRequiredAmount,
      items: source.paymentSchedule.items,
      readinessStatus: source.paymentSchedule.readiness.status,
    });
    source.paymentSchedule.items = seeded.items;
    return source;
  }

  test("33A Article 7 open pending: one PAYMENT TERMS readiness row, footer confirm only", () => {
    const readinessFn = slice(js, "function renderReadiness", "function renderLogo");
    assert.ok(readinessFn.includes("presentAuthenticatedPaymentChrome"));
    assert.ok(readinessFn.includes('i.label !== "Payment terms"'));
    assert.ok(!readinessFn.includes('span>Payment terms</span>'));
    assert.ok(js.includes('label: "PAYMENT TERMS"'));
    assert.ok(!js.includes('label: "COMMERCIAL"'));
    const nextClick = slice(
      js,
      '$("cbNextActionBtn")?.addEventListener("click"',
      '$("cbFreezeBtn")?.addEventListener("click"'
    );
    assert.ok(nextClick.includes('setActiveArticle("art-payment"'));
    assert.ok(!nextClick.includes("workspaceConfirmPayment"));
    assert.ok(!nextClick.includes("workspaceSave"));

    const source = unpaidBuilderSource();
    const chrome = PaymentConfirm.presentAuthenticatedPaymentChrome({
      source,
      confirmed: false,
      activeArticleId: "art-payment",
    });
    const plan = PaymentConfirm.paymentFooterPlan({
      confirmed: false,
      source,
    });
    assert.strictEqual(chrome.readinessCaption, "NEEDS CONFIRMATION — PAYMENT TERMS");
    assert.strictEqual(chrome.readinessLabel, "PAYMENT TERMS");
    assert.strictEqual(chrome.showInWarnings, false);
    assert.strictEqual(chrome.openPaymentTermsVisible, false);
    assert.strictEqual(chrome.nextCtaVisible, false);
    assert.ok(!String(chrome.nextCta || "").includes("Open Payment Terms"));
    assert.strictEqual(chrome.footerPrimaryVisible, true);
    assert.strictEqual(chrome.footerPrimaryLabel, "Confirm Payment Terms");
    assert.strictEqual(plan.primaryLabel, "Confirm Payment Terms");
    assert.strictEqual(plan.buttons.filter((b) => b.style === "primary").length, 1);
    assert.ok(!plan.buttons.some((b) => b.label === "Open Payment Terms"));
    assert.strictEqual(chrome.nextCtaConfirms, false);
    assert.strictEqual(chrome.nextCtaPersists, false);
  });

  test("33B other article open pending: Next Action is only Open Payment Terms", () => {
    const source = unpaidBuilderSource();
    const chrome = PaymentConfirm.presentAuthenticatedPaymentChrome({
      source,
      confirmed: false,
      activeArticleId: "art-price",
    });
    assert.strictEqual(chrome.readinessCaption, "NEEDS CONFIRMATION — PAYMENT TERMS");
    assert.strictEqual(chrome.readinessLabel, "PAYMENT TERMS");
    assert.strictEqual(chrome.showInWarnings, false);
    assert.strictEqual(chrome.nextCtaVisible, true);
    assert.strictEqual(chrome.nextCta, "Open Payment Terms");
    assert.strictEqual(chrome.nextArticle, "art-payment");
    assert.strictEqual(chrome.nextCtaConfirms, false);
    assert.strictEqual(chrome.nextCtaPersists, false);
    assert.strictEqual(chrome.footerPrimaryVisible, false);
    assert.strictEqual(chrome.openPaymentTermsVisible, true);
  });

  test("33C Payment Terms confirmed: COMPLETE row, no warning, no confirm CTA", () => {
    const source = unpaidBuilderSource();
    source.paymentSchedule.readiness.status = "configured";
    const chrome = PaymentConfirm.presentAuthenticatedPaymentChrome({
      source,
      confirmed: true,
      activeArticleId: "art-payment",
    });
    const plan = PaymentConfirm.paymentFooterPlan({
      confirmed: true,
      source,
    });
    assert.strictEqual(chrome.readinessCaption, "COMPLETE — PAYMENT TERMS");
    assert.strictEqual(chrome.readinessStatus, "available");
    assert.strictEqual(chrome.showInWarnings, false);
    assert.strictEqual(chrome.nextCtaVisible, false);
    assert.strictEqual(chrome.openPaymentTermsVisible, false);
    assert.strictEqual(chrome.footerPrimaryVisible, false);
    assert.ok(!plan.buttons.some((b) => b.id === "confirm"));
    assert.ok(!plan.confirmVisible);
    assert.ok(!js.includes("Payment amounts must equal the contract total"));
    assert.ok(!js.includes("Payment schedule"));
    assert.ok(!js.includes("items_required"));
    assert.ok(!helperSrc.includes("payment_stages_mismatch"));
  });

  console.log("");
  console.log("CH-007D Article 7 Payment Summary:", passed, "passed,", failed, "failed");
  process.exit(failed === 0 ? 0 : 1);
})();
