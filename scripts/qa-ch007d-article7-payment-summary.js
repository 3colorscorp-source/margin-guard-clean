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
  assert.ok(pdfSrc.includes("presentPaymentSummary"));
  assert.ok(pdfSrc.includes("Remaining Contract Balance"));
  assert.ok(pdfSrc.includes("Deposit Paid"));
  assert.ok(signSrc.includes("presentPaymentSummary"));
  assert.ok(signSrc.includes("Remaining Payment Schedule"));
  assert.ok(!pdfSrc.includes("quote.total ="));
  const scheduleSrc = fs.readFileSync(
    path.join(ROOT, "netlify/functions/project-contract-payment-schedule.js"),
    "utf8"
  );
  assert.ok(scheduleSrc.includes("depositBlocksConfirm"));
  assert.ok(scheduleSrc.includes("deposit_verification_unavailable"));
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
  assert.strictEqual(summary.depositLabel, "");
  assert.ok(!/Paid|Due/.test(summary.depositLabel));
  assert.strictEqual(summary.blockConfirm, true);
  assert.strictEqual(
    summary.verificationMessage,
    "Deposit status could not be verified. Refresh before confirming."
  );
  assert.strictEqual(summary.remainingBalance, TOTAL);
  const plan = PaymentConfirm.paymentFooterPlan({
    items: ITEMS,
    contractTotal: TOTAL,
    verifiedDeposit: unavailable,
  });
  assert.strictEqual(plan.confirmEnabled, false);
  assert.strictEqual(plan.blockConfirm, true);
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

test("18 refunded, voided, or reversed payments do not count", () => {
  const rows = [
    {
      id: "voided",
      tenant_id: "t1",
      project_id: "p1",
      quote_id: "q1",
      payment_type: "deposit",
      amount: 1,
      paid_at: "2026-09-01T00:00:00.000Z",
      status: "voided",
    },
    {
      id: "refunded",
      tenant_id: "t1",
      project_id: "p1",
      quote_id: "q1",
      payment_type: "deposit",
      amount: 1,
      paid_at: "2026-09-01T00:00:00.000Z",
      notes: "refunded",
    },
    {
      id: "reversed",
      tenant_id: "t1",
      project_id: "p1",
      quote_id: "q1",
      payment_type: "deposit",
      amount: -1,
      paid_at: "2026-09-01T00:00:00.000Z",
    },
    {
      id: "netted",
      tenant_id: "t1",
      project_id: "p1",
      quote_id: "q1",
      payment_type: "deposit",
      amount: 1,
      paid_at: "2026-09-01T00:00:00.000Z",
    },
    {
      id: "adj",
      tenant_id: "t1",
      project_id: "p1",
      quote_id: "q1",
      payment_type: "adjustment",
      amount: -1,
      paid_at: "2026-09-02T00:00:00.000Z",
      notes: "deposit refund",
    },
  ];
  const result = Deposit.fromLedgerRows(rows, {
    tenantId: "t1",
    projectId: "p1",
    quoteId: "q1",
  });
  assert.strictEqual(result.verified_paid, false);
  assert.strictEqual(result.status, "none");
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
  const snap = Deposit.serializeDepositForSnapshot(dollar, "q1");
  assert.strictEqual(snap.verified_paid, true);
  assert.strictEqual(snap.amount, 1);
  assert.strictEqual(snap.quote_id, "q1");
  assert.strictEqual(snap.source, "tenant_project_payments");
  assert.ok(snap.paid_at);
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
  await testAsync("21 supabase error produces verification_unavailable not Due", async () => {
    const result = await Deposit.resolveVerifiedContractDeposit(
      { tenantId: "t1", projectId: "p1", quoteId: "q1", contractTotal: TOTAL },
      {
        request: async () => {
          throw new Error("Supabase HTTP 500: boom");
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
    assert.strictEqual(summary.depositLabel, "");
    assert.strictEqual(summary.blockConfirm, true);
  });

  await testAsync("22 quote-scoped request is the only paid query when quote exists", async () => {
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

  console.log("");
  console.log("CH-007D Article 7 Payment Summary:", passed, "passed,", failed, "failed");
  process.exit(failed === 0 ? 0 : 1);
})();
