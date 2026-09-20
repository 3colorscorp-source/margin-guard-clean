/**
 * CH-007D — Article 7 Payment Schedule simplified presentation + confirm behavior.
 * Executes real confirm logic via contract-payment-confirm.js. Does not POST live.
 * Run: node scripts/qa-ch007d-article7-payment-simple.js
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
const html = fs.readFileSync(htmlPath, "utf8");
const js = fs.readFileSync(jsPath, "utf8");
const helperSrc = fs.readFileSync(helperPath, "utf8");
const PaymentConfirm = require("../public/js/contract-payment-confirm.js");
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

function slice(src, startToken, endToken) {
  const start = src.indexOf(startToken);
  const end = src.indexOf(endToken, start + startToken.length);
  assert.ok(start >= 0 && end > start, `missing slice ${startToken}`);
  return src.slice(start, end);
}

const art7 = slice(html, 'id="art-payment"', 'id="art-schedule"');

test("0 syntax helper + builder", () => {
  const helperCheck = spawnSync(process.execPath, ["--check", helperPath], { encoding: "utf8" });
  assert.strictEqual(helperCheck.status, 0, helperCheck.stderr || helperCheck.stdout);
  const builderCheck = spawnSync(process.execPath, ["--check", jsPath], { encoding: "utf8" });
  assert.strictEqual(builderCheck.status, 0, builderCheck.stderr || builderCheck.stdout);
});

test("presentation drops diagnostics from Article 7 preview", () => {
  assert.ok(art7.includes("Contract Total"));
  assert.ok(art7.includes('id="cbPayTimeline"'));
  assert.ok(html.includes("cb-pay-row"));
  assert.ok(html.includes("is-diag"));
  assert.ok(!/Review defaults/i.test(js));
  assert.ok(!/Matches contract total/.test(js));
  assert.ok(!/Scheduled 100%/.test(html + js + helperSrc));
  assert.ok(!js.includes('badgeText.textContent = "Review defaults"'));
  assert.ok(js.includes("Payment Schedule Confirmed"));
  assert.ok(js.includes("Confirm Payment Schedule"));
  assert.ok(!js.includes('label: "Confirm Schedule"'));
  assert.ok(!js.includes('label: "Confirm & Continue"'));
  assert.ok(!/Stage \$\{item\.sequence_number\}/.test(js));
  assert.ok(js.includes("overflow-wrap") || html.includes("overflow-wrap: anywhere"));
});

test("helper loads before builder and confirm stays explicit", () => {
  const helperIdx = html.indexOf("contract-payment-confirm.js");
  const builderIdx = html.indexOf("contract-builder.js");
  assert.ok(helperIdx > 0 && builderIdx > helperIdx);
  assert.ok(helperSrc.includes("confirm_schedule: true"));
  assert.ok(js.includes("createPaymentConfirmRunner"));
  assert.ok(js.includes("PAYMENT_SCHEDULE_API") || helperSrc.includes("project-contract-payment-schedule"));
  assert.ok(!/record-tenant-payment|project-payment-intent|upsert-tenant-invoice/.test(helperSrc));
});

const TWO = [
  {
    label: "Initial Scheduling Payment",
    amount: 1,
    due_rule: "on_signature",
    payment_type: "deposit",
    item_role: "future_obligation",
  },
  {
    label: "Remaining Balance",
    amount: 3264.49,
    due_rule: "on_completion",
    payment_type: "completion",
    item_role: "future_obligation",
  },
];
const THREE = TWO.concat([
  {
    label: "Progress Payment",
    amount: 500,
    due_rule: "on_start",
    payment_type: "progress",
    item_role: "future_obligation",
  },
]);
const TOTAL_TWO = 3265.49;
const TOTAL_THREE = 3765.49;

function dueLabel(rule, extras) {
  return PaymentDefaults.dueRuleCustomerLabel(rule, extras);
}

function session(opts) {
  const options = opts || {};
  const posts = [];
  let busy = false;
  let confirmed = options.confirmed === true;
  let items = PaymentConfirm.cloneItems(options.items || []);
  let advanced = false;
  const postJson =
    options.postJson ||
    (async function (url, body) {
      posts.push({ url, body });
      if (options.httpFail) {
        return { ok: false, status: 500, data: { ok: false, error: "boom" } };
      }
      return {
        ok: true,
        status: 200,
        data: {
          ok: true,
          schedule: { status: "confirmed" },
          items: body.items,
          readiness: { status: "configured", contract_total: options.contractTotal },
        },
      };
    });
  const runner = PaymentConfirm.createPaymentConfirmRunner({
    getBusy: () => busy,
    setBusy: (value) => {
      busy = Boolean(value);
    },
    isConfirmed: () => confirmed,
    getItems: () => items,
    getContractTotal: () => options.contractTotal,
    getIds: () => ({ projectId: "proj-1", quoteId: "quote-1" }),
    getVerifiedDeposit: () => options.verifiedDeposit || null,
    postJson,
    applySuccess: (data) => {
      confirmed = PaymentConfirm.paymentConfigured({ readiness: data.readiness });
      items = PaymentConfirm.cloneItems(data.items);
    },
  });
  return {
    posts,
    get busy() {
      return busy;
    },
    get confirmed() {
      return confirmed;
    },
    get items() {
      return items;
    },
    get advanced() {
      return advanced;
    },
    plan() {
      return PaymentConfirm.paymentFooterPlan({
        confirmed,
        items,
        contractTotal: options.contractTotal,
        verifiedDeposit: options.verifiedDeposit || null,
        busy,
      });
    },
    rows() {
      return PaymentConfirm.presentPaymentRows(items, { dueRuleLabel: dueLabel });
    },
    confirm: () => runner.confirm(),
  };
}

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
  await testAsync("1 schedule of 2 payments", async () => {
    const s = session({ items: TWO, contractTotal: TOTAL_TWO });
    const rows = s.rows();
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].name, "Initial Scheduling Payment");
    assert.strictEqual(rows[1].name, "Remaining Balance");
    assert.strictEqual(Number(rows[0].amount), 1);
    assert.strictEqual(Number(rows[1].amount), 3264.49);
    assert.ok(rows[0].due);
    assert.ok(rows[1].due);
    assert.ok(!JSON.stringify(rows).includes("%"));
    assert.ok(!JSON.stringify(rows).includes("Stage 1"));
  });

  await testAsync("2 schedule of 3 or more payments", async () => {
    const s = session({ items: THREE, contractTotal: TOTAL_THREE });
    const rows = s.rows();
    assert.strictEqual(rows.length, 3);
    assert.strictEqual(rows[2].index, 3);
    assert.strictEqual(rows[2].name, "Progress Payment");
    assert.ok(!PaymentConfirm.presentPaymentRows(THREE).every((row) => row.name === "Initial Scheduling Payment"));
  });

  await testAsync("3 totals correct: Confirm Payment Schedule is the only primary", async () => {
    const s = session({ items: TWO, contractTotal: TOTAL_TWO });
    const totals = PaymentConfirm.computePaymentTotals(TWO, TOTAL_TWO);
    assert.strictEqual(totals.balanced, true);
    const plan = s.plan();
    assert.strictEqual(plan.kind, "unconfirmed");
    assert.strictEqual(plan.primaryLabel, "Confirm Payment Schedule");
    assert.strictEqual(plan.primaryEnabledCount, 1);
    assert.strictEqual(plan.continueVisible, false);
    assert.ok(plan.buttons.some((b) => b.id === "edit" && b.style === "ghost"));
  });

  await testAsync("4 totals incorrect: 0 POST", async () => {
    const s = session({ items: TWO, contractTotal: 100 });
    const plan = s.plan();
    assert.strictEqual(plan.kind, "unbalanced");
    assert.strictEqual(plan.errorMessage, PaymentConfirm.SUM_ERROR);
    assert.strictEqual(plan.primaryLabel, "Edit Payment Schedule");
    assert.strictEqual(plan.confirmVisible, false);
    assert.strictEqual(plan.continueVisible, false);
    const result = await s.confirm();
    assert.strictEqual(result.posted, false);
    assert.strictEqual(result.advance, false);
    assert.strictEqual(result.reason, "unbalanced");
    assert.strictEqual(s.posts.length, 0);
    assert.strictEqual(s.confirmed, false);
  });

  await testAsync("5 Confirm Payment Schedule: exactly 1 POST and advances", async () => {
    const s = session({ items: TWO, contractTotal: TOTAL_TWO });
    const result = await s.confirm();
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.posted, true);
    assert.strictEqual(result.advance, true);
    assert.strictEqual(s.posts.length, 1);
    assert.strictEqual(s.posts[0].body.confirm_schedule, true);
    assert.strictEqual(s.confirmed, true);
    const after = s.plan();
    assert.strictEqual(after.kind, "confirmed");
    assert.strictEqual(after.continueVisible, true);
    assert.strictEqual(after.primaryLabel, "Continue");
  });

  await testAsync("6 double click: at most 1 POST", async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const httpPosts = [];
    const s = session({
      items: TWO,
      contractTotal: TOTAL_TWO,
      postJson: async (url, body) => {
        httpPosts.push({ url, body });
        await gate;
        return {
          ok: true,
          status: 200,
          data: {
            ok: true,
            schedule: { status: "confirmed" },
            items: body.items,
            readiness: { status: "configured" },
          },
        };
      },
    });
    const first = s.confirm();
    const second = s.confirm();
    const secondResult = await second;
    assert.strictEqual(secondResult.reason, "busy");
    assert.strictEqual(secondResult.posted, false);
    release();
    const firstResult = await first;
    assert.strictEqual(firstResult.ok, true);
    assert.strictEqual(httpPosts.length, 1);
    assert.strictEqual(s.busy, false);
  });

  await testAsync("7 HTTP failure: not confirmed, no advance, retry works", async () => {
    let fail = true;
    const httpPosts = [];
    const s = session({
      items: TWO,
      contractTotal: TOTAL_TWO,
      postJson: async (url, body) => {
        httpPosts.push({ url, body });
        if (fail) return { ok: false, status: 500, data: { ok: false, error: "boom" } };
        return {
          ok: true,
          status: 200,
          data: {
            ok: true,
            schedule: { status: "confirmed" },
            items: body.items,
            readiness: { status: "configured" },
          },
        };
      },
    });
    const first = await s.confirm();
    assert.strictEqual(first.reason, "http");
    assert.strictEqual(first.advance, false);
    assert.strictEqual(s.confirmed, false);
    assert.strictEqual(s.busy, false);
    assert.strictEqual(Number(s.items[0].amount), 1);
    assert.strictEqual(s.items[1].due_rule, "on_completion");
    fail = false;
    const retry = await s.confirm();
    assert.strictEqual(retry.ok, true);
    assert.strictEqual(retry.advance, true);
    assert.strictEqual(httpPosts.length, 2);
    assert.strictEqual(s.confirmed, true);
  });

  await testAsync("8 already confirmed: 0 POST and Continue enabled", async () => {
    const s = session({ items: TWO, contractTotal: TOTAL_TWO, confirmed: true });
    const plan = s.plan();
    assert.strictEqual(plan.kind, "confirmed");
    assert.strictEqual(plan.confirmedLabel, "Payment Schedule Confirmed");
    assert.strictEqual(plan.continueVisible, true);
    assert.strictEqual(plan.continueEnabled, true);
    assert.strictEqual(plan.primaryEnabledCount, 1);
    const result = await s.confirm();
    assert.strictEqual(result.posted, false);
    assert.strictEqual(result.advance, false);
    assert.strictEqual(s.posts.length, 0);
  });

  await testAsync("9 amounts and due terms remain exactly equal", async () => {
    const s = session({ items: TWO, contractTotal: TOTAL_TWO });
    const result = await s.confirm();
    const body = result.payload;
    assert.strictEqual(body.items[0].amount, "1.00");
    assert.strictEqual(body.items[1].amount, "3264.49");
    assert.strictEqual(body.items[0].due_rule, "on_signature");
    assert.strictEqual(body.items[1].due_rule, "on_completion");
    assert.strictEqual(body.items[0].label, "Initial Scheduling Payment");
    assert.strictEqual(body.items[1].label, "Remaining Balance");
    assert.ok(PaymentConfirm.itemsMatchSource(body.items, TWO));
    assert.notStrictEqual(body.items[0].due_rule, "on_acceptance");
  });

  test("10 mobile, preview, and print avoid overflow diagnostics", () => {
    assert.ok(html.includes("overflow-wrap: anywhere"));
    assert.ok(html.includes(".cb-pay-ledger__copy"));
    assert.ok(html.includes("#cbMain.is-printing .cb-pay-workspace__badge"));
    assert.ok(html.includes("#cbMain.is-printing .cb-pay-summary__item.is-diag"));
    assert.ok(html.includes("@media (max-width: 720px)") || html.includes("@media (max-width: 640px)"));
    assert.ok(html.includes("is-preview"));
    assert.ok(html.includes("is-printing"));
    assert.ok(!/cb-pay-row__amount[\s\S]{0,80}%/.test(js));
  });

  await testAsync("11 verification_unavailable blocks Confirm with 0 POST", async () => {
    const s = session({
      items: TWO,
      contractTotal: TOTAL_TWO,
      verifiedDeposit: {
        status: "verification_unavailable",
        verified_paid: false,
        amount: null,
      },
    });
    const plan = s.plan();
    assert.strictEqual(plan.confirmVisible, true);
    assert.strictEqual(plan.confirmEnabled, false);
    assert.strictEqual(plan.blockConfirm, true);
    assert.ok(!/Deposit Due/.test(plan.errorMessage || ""));
    assert.ok(
      plan.errorMessage.includes("Deposit status could not be verified. Refresh before confirming.")
    );
    const result = await s.confirm();
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.posted, false);
    assert.strictEqual(result.reason, "verification_unavailable");
    assert.strictEqual(s.posts.length, 0);
  });

  console.log("");
  console.log(`CH-007D Article 7 payment simple: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
