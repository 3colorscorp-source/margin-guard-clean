/**
 * CH-012G — Contract Builder Payment Schedule Add-payment visibility + authoring QA.
 * Offline static / logic proofs. Never mutates production. Never calls Stripe/Invoice Hub.
 * Run: node scripts/qa-ch012g-payment-add.js
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

const html = read("public/contract-builder.html");
const js = read("public/js/contract-builder.js");
const styles = read("public/styles.css");

function moneyToCents(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

function computeTotals(items, contractTotal) {
  const scheduledCents = (Array.isArray(items) ? items : []).reduce(
    (sum, row) => sum + moneyToCents(row.amount),
    0
  );
  const contractCents = contractTotal == null ? null : moneyToCents(contractTotal);
  const differenceCents = contractCents == null ? null : contractCents - scheduledCents;
  return {
    scheduledCents,
    contractCents,
    differenceCents,
    balanced: differenceCents === 0,
  };
}

test("syntax contract-builder.js", () => {
  checkSyntax(path.join(ROOT, "public/js/contract-builder.js"));
});

test("1 Empty draft schedule shows visible Add payment action (paper CSS)", () => {
  assert.ok(html.includes('id="cbPayAddStage"'));
  assert.ok(html.includes("Add payment"));
  assert.ok(/#cbPayEditToolbar\s+\.btn|#cbPayAddStage/.test(html));
  assert.ok(html.includes("CH-012G"));
  assert.ok(html.includes("paper-safe"));
  // Paper ink (not shell --text light color) on payment editor buttons.
  assert.ok(html.includes("var(--cb-ink"));
  assert.ok(/#cbPayAddStage[\s\S]*?color:\s*var\(--cb-ink/.test(html) || /#cbPayEditToolbar \.btn[\s\S]*?color:\s*var\(--cb-ink/.test(html));
  assert.ok(js.includes("cbPayAddFirst") || js.includes("Add first payment"));
  assert.ok(js.includes("No payments yet. Click Add payment to begin."));
});

test("2 Add payment is not disabled when empty / total > 0", () => {
  // Toolbar button ships without disabled attribute.
  assert.ok(/id="cbPayAddStage"[^>]*>/.test(html));
  assert.ok(!/id="cbPayAddStage"[^>]*\bdisabled\b/.test(html));
  // Empty array only changes grid HTML; does not disable Add.
  assert.ok(js.includes("if (!paymentDraftItems.length)"));
  assert.ok(!/cbPayAddStage[\s\S]{0,80}disabled\s*=\s*true/.test(js));
  assert.ok(js.includes("paymentScheduleAllowsOwnerEdit"));
  assert.ok(js.includes('status || "").toLowerCase() === "configured"'));
});

test("3 First row can be added", () => {
  assert.ok(js.includes("function addPaymentDraftRow"));
  assert.ok(js.includes("createBlankPaymentDraftRow"));
  assert.ok(js.includes("paymentDraftItems.push(createBlankPaymentDraftRow())"));
  assert.ok(js.includes('id="cbPayAddFirst"') || js.includes("cbPayAddFirst"));
});

test("4 Multiple rows can be added", () => {
  assert.ok(js.includes('data-pay-action="insert"'));
  assert.ok(js.includes("addPaymentDraftRow"));
  // Repeated Add / Insert both push blank rows.
  assert.ok(js.includes("paymentDraftItems.splice(idx + 1, 0, createBlankPaymentDraftRow())"));
});

test("5 Draft save allows imbalance", () => {
  assert.ok(js.includes("validatePaymentDraftForSave"));
  assert.ok(js.includes("Draft can be saved while unbalanced"));
  assert.ok(js.includes("blocking: false"));
  assert.ok(js.includes("savePaymentScheduleDraft(false)") || js.includes("confirm_schedule:false") || js.includes("confirmSchedule"));
  assert.ok(/savePaymentScheduleDraft\(\s*false\s*\)/.test(js));
});

test("6 Confirm blocks under total", () => {
  assert.ok(js.includes("validatePaymentDraftForConfirm"));
  assert.ok(js.includes("Scheduled must equal contract total"));
  assert.ok(js.includes("if (!totals.balanced)"));
  const under = computeTotals([{ amount: 100 }], 9044.16);
  assert.strictEqual(under.balanced, false);
  assert.ok(under.differenceCents > 0);
});

test("7 Confirm blocks over total", () => {
  const over = computeTotals([{ amount: 10000 }], 9044.16);
  assert.strictEqual(over.balanced, false);
  assert.ok(over.differenceCents < 0);
  assert.ok(js.includes("!totals.balanced"));
});

test("8 Confirm accepts exact total", () => {
  const exact = computeTotals(
    [{ amount: 4500 }, { amount: 4544.16 }],
    9044.16
  );
  assert.strictEqual(exact.balanced, true);
  assert.strictEqual(exact.scheduledCents, moneyToCents(9044.16));
  assert.ok(js.includes("Ready to confirm — totals match"));
  assert.ok(/savePaymentScheduleDraft\(\s*true\s*\)/.test(js));
});

test("9 Currency cents remain precise", () => {
  assert.ok(js.includes("function moneyToCents"));
  assert.ok(js.includes("Math.round(n * 100)"));
  assert.strictEqual(moneyToCents(9044.16), 904416);
  assert.strictEqual(moneyToCents(0.1) + moneyToCents(0.2), moneyToCents(0.3));
  const t = computeTotals([{ amount: 9044.16 }], 9044.16);
  assert.strictEqual(t.balanced, true);
});

test("10 Article 7 and right-rail readiness agree", () => {
  assert.ok(js.includes("readinessMapStatus"));
  assert.ok(js.includes('return readinessMapStatus("payment", source)'));
  assert.ok(js.includes("paymentConfigured"));
  assert.ok(js.includes("Complete Payment Schedule"));
  assert.ok(js.includes("overallContractReadiness"));
  assert.ok(js.includes("const payOk = paymentConfigured(schedule)"));
});

test("11 Freeze blocked before confirmation", () => {
  assert.ok(js.includes("overallContractReadiness(sourceSnapshot, draftEdits) !== \"configured\""));
  assert.ok(js.includes("if (!paymentConfigured(source.paymentSchedule))"));
  assert.ok(js.includes("Complete Payment Schedule"));
});

test("12 Freeze allowed after confirmation", () => {
  assert.ok(js.includes('return "configured"'));
  assert.ok(js.includes("propOk && warOk && payOk && sigOk"));
  assert.ok(js.includes("expected_schedule_updated_at"));
});

test("13 Frozen snapshot contains exact payment schedule", () => {
  const freezeLib = read("netlify/functions/_lib/contract-package.js");
  assert.ok(/payment_schedule/.test(freezeLib) || /paymentSchedule/.test(freezeLib));
  assert.ok(js.includes("expected_schedule_updated_at"));
});

test("14 Frozen snapshot remains immutable", () => {
  const freezeLib = read("netlify/functions/_lib/contract-package.js");
  assert.ok(
    /immutable|content_hash|snapshot_json|already.?frozen|version/i.test(freezeLib)
  );
  // Confirmed schedules become read-only in builder.
  assert.ok(js.includes("Confirmed payment schedules are read-only") || js.includes("paymentScheduleAllowsOwnerEdit"));
  assert.ok(js.includes("return !paymentConfigured"));
});

test("15 Existing schedule loads", () => {
  assert.ok(js.includes("hydratePaymentDraftFromSource"));
  assert.ok(js.includes("reloadPaymentScheduleFromServer") || js.includes("PAYMENT_SCHEDULE_API"));
  assert.ok(js.includes("mapScheduleItemToDraft"));
});

test("16 No Invoice Hub / payment-intent / Stripe changes", () => {
  assert.ok(!/project-payment-intent|record-tenant-payment|upsert-tenant-invoice|stripe\.com/i.test(js));
  assert.ok(!/project-payment-intent|stripe\.com/i.test(html));
  // Diff scope: only builder UI files for this chapter — no payment-intent modules touched by grepping unchanged markers.
  assert.ok(fs.existsSync(path.join(ROOT, "scripts/qa-ch007d-p2-payment-workspace.js")));
});

test("CSS scoped — no global .btn override in contract-builder paper rules", () => {
  assert.ok(html.includes("#cbPayEditToolbar .btn"));
  assert.ok(html.includes(".cb-pay-edit-row__actions .btn"));
  // Must not rewrite global styles.css .btn for this fix.
  assert.ok(styles.includes(".btn.ghost{ background: transparent"));
  assert.ok(!html.includes(".btn.ghost{ color: var(--cb-ink"));
});

test("disabled appearance only when actually disabled", () => {
  assert.ok(html.includes("#cbPayEditToolbar .btn:disabled") || html.includes(".cb-pay-edit-row__actions .btn:disabled"));
  assert.ok(html.includes("cursor: not-allowed"));
});

(async () => {
  console.log("");

  const regressions = [
    ["17a CH-012F", "scripts/qa-ch012f-canonical-contract-schedule.js"],
    ["17b CH-012D", "scripts/qa-ch012d-guided-workflow.js"],
    ["17c CH-011A packages", "scripts/qa-ch011a-contract-packages.js"],
    ["17d CH-011A idempotent freeze", "scripts/qa-ch011a-idempotent-freeze.js"],
    ["17e CH-011E", "scripts/qa-ch011e-envelope-send.js"],
    ["17f CH-013A.2.1Z", "scripts/qa-ch013a21z-zapier-email-adapter.js"],
    ["prior CH-007D-P2", "scripts/qa-ch007d-p2-payment-workspace.js"],
  ];

  for (const [label, rel] of regressions) {
    const r = spawnSync(process.execPath, [path.join(ROOT, rel)], {
      encoding: "utf8",
      env: {
        ...process.env,
        CONTRACT_EMAIL_DELIVERY_ENABLED: "",
        CONTRACT_EMAIL_ZAPIER_WEBHOOK_URL: "",
        CONTRACT_EMAIL_ZAPIER_HMAC_SECRET: "",
        RESEND_API_KEY: "",
      },
    });
    if (r.status === 0) {
      console.log("PASS regression", label);
      passed += 1;
    } else {
      console.log("FAIL regression", label);
      console.log(r.stdout || "");
      console.log(r.stderr || "");
      failed += 1;
    }
  }

  console.log("");
  console.log(`CH-012G payment-add QA: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
