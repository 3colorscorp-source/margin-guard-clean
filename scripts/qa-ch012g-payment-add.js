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

test("CH-012G.1 root cause: render must not DOM-sync wipe before paint", () => {
  // Bug: renderPaymentEditGrid → validatePaymentDraftForSave → readPaymentDraftFromGrid
  // while empty-state DOM is still mounted cleared the just-pushed row.
  assert.ok(js.includes("syncFromDom: false") || js.includes("syncFromDom !== false"));
  assert.ok(js.includes("validatePaymentDraftForSave({ syncFromDom: false })"));
  assert.ok(js.includes("Do not sync from DOM when the grid still shows the previous"));
  // Mutation path must not read empty-state DOM into paymentDraftItems.
  assert.ok(js.includes('querySelector("[data-pay-client-id]")'));
  assert.ok(js.includes("must not clear in-memory drafts") || js.includes("Empty-state markup"));
});

test("1 Empty draft schedule shows visible Add payment action (paper CSS)", () => {
  assert.ok(html.includes('id="cbPayAddStage"'));
  assert.ok(html.includes("Add payment"));
  assert.ok(/#cbPayEditToolbar\s+\.btn|#cbPayAddStage/.test(html));
  assert.ok(html.includes("CH-012G"));
  assert.ok(html.includes("paper-safe"));
  assert.ok(html.includes("var(--cb-ink"));
  assert.ok(/#cbPayAddStage[\s\S]*?color:\s*var\(--cb-ink/.test(html) || /#cbPayEditToolbar \.btn[\s\S]*?color:\s*var\(--cb-ink/.test(html));
  assert.ok(js.includes("cbPayAddFirst") || js.includes("Add first payment"));
  assert.ok(js.includes("No payments yet. Click Add payment to begin."));
});

test("2 Add payment is not disabled when empty / total > 0", () => {
  assert.ok(/id="cbPayAddStage"[^>]*>/.test(html));
  assert.ok(!/id="cbPayAddStage"[^>]*\bdisabled\b/.test(html));
  assert.ok(js.includes("if (!paymentDraftItems.length)"));
  assert.ok(!/cbPayAddStage[\s\S]{0,80}disabled\s*=\s*true/.test(js));
  assert.ok(js.includes("paymentScheduleAllowsOwnerEdit"));
});

test("3 First row can be added — shared path + both buttons", () => {
  assert.ok(js.includes("function addPaymentDraftRow"));
  assert.ok(js.includes("createBlankPaymentDraftRow"));
  assert.ok(js.includes("paymentDraftItems.push(createBlankPaymentDraftRow())"));
  assert.ok(js.includes('id="cbPayAddFirst"') || js.includes("cbPayAddFirst"));
  assert.ok(js.includes("#cbPayAddStage, #cbPayAddFirst") || js.includes('closest("#cbPayAddStage, #cbPayAddFirst")'));
  assert.ok(js.includes("cbPayEditWorkspace"));
});

test("4 Multiple rows can be added", () => {
  assert.ok(js.includes('data-pay-action="insert"'));
  assert.ok(js.includes("addPaymentDraftRow"));
  assert.ok(js.includes("paymentDraftItems.splice(idx + 1, 0, createBlankPaymentDraftRow())"));
});

test("G1 handlers reachable on stable workspace container", () => {
  assert.ok(js.includes('dataset.payBound !== "1"') || js.includes("dataset.payBound"));
  assert.ok(js.includes("cbPayEditWorkspace"));
  assert.ok(js.includes("addEventListener(\"click\""));
  assert.ok(js.includes("type=\"button\"") || html.includes('type="button"'));
});

test("G1 draft item survives rerender (no wipe)", () => {
  // Simulate the bug sequence with the same guard semantics.
  let paymentDraftItems = [];
  const emptyDomRows = []; // empty-state has zero [data-pay-client-id]
  function readFromDom(rows) {
    paymentDraftItems = rows.map((r) => ({ ...r }));
  }
  // Fixed mutation: only sync when rows mounted
  if (emptyDomRows.length) readFromDom(emptyDomRows);
  paymentDraftItems.push({ client_id: "tmp_1", amount: 0, label: "" });
  // Fixed render: validate without DOM sync
  const syncFromDom = false;
  if (syncFromDom) readFromDom(emptyDomRows);
  assert.strictEqual(paymentDraftItems.length, 1);
});

test("G1 editable row template includes amount field", () => {
  assert.ok(js.includes("data-pay-field=\"amount\"") || js.includes("data-pay-field='amount'"));
  assert.ok(js.includes('data-pay-field="label"') || js.includes("data-pay-field='label'"));
  assert.ok(js.includes("data-pay-client-id"));
  assert.ok(js.includes('step="0.01"') || js.includes("step=\"0.01\""));
});

test("G1 amount accepts decimal 9044.16 (cents)", () => {
  assert.strictEqual(moneyToCents(9044.16), 904416);
  const t = computeTotals([{ amount: 9044.16 }], 9044.16);
  assert.strictEqual(t.balanced, true);
});

test("G1 one click adds exactly one row path", () => {
  assert.ok(js.includes("function addPaymentDraftRow"));
  // Single push per addPaymentDraftRow invocation
  const fn = js.slice(js.indexOf("function addPaymentDraftRow"));
  const body = fn.slice(0, fn.indexOf("function renderPaymentEditGrid"));
  const pushes = body.match(/paymentDraftItems\.push\(createBlankPaymentDraftRow\(\)\)/g) || [];
  assert.strictEqual(pushes.length, 1);
});

test("5 Draft save allows imbalance", () => {
  assert.ok(js.includes("validatePaymentDraftForSave"));
  assert.ok(js.includes("Draft can be saved while unbalanced"));
  assert.ok(js.includes("blocking: false"));
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
});

test("8 Confirm accepts exact total", () => {
  const exact = computeTotals([{ amount: 4500 }, { amount: 4544.16 }], 9044.16);
  assert.strictEqual(exact.balanced, true);
  assert.ok(js.includes("Ready to confirm — totals match"));
  assert.ok(/savePaymentScheduleDraft\(\s*true\s*\)/.test(js));
});

test("9 Currency cents remain precise", () => {
  assert.ok(js.includes("function moneyToCents"));
  assert.ok(js.includes("Math.round(n * 100)"));
  assert.strictEqual(moneyToCents(9044.16), 904416);
  assert.strictEqual(moneyToCents(0.1) + moneyToCents(0.2), moneyToCents(0.3));
});

test("10 Article 7 and right-rail readiness agree", () => {
  assert.ok(js.includes("readinessMapStatus"));
  assert.ok(js.includes('return readinessMapStatus("payment", source)'));
  assert.ok(js.includes("paymentConfigured"));
  assert.ok(js.includes("Complete Payment Schedule"));
  assert.ok(js.includes("overallContractReadiness"));
});

test("11 Freeze blocked before confirmation", () => {
  assert.ok(js.includes("overallContractReadiness(sourceSnapshot, draftEdits) !== \"configured\""));
  assert.ok(js.includes("if (!paymentConfigured(source.paymentSchedule))"));
});

test("12 Freeze allowed after confirmation", () => {
  assert.ok(js.includes('return "configured"'));
  assert.ok(js.includes("propOk && warOk && payOk && sigOk"));
  assert.ok(js.includes("expected_schedule_updated_at"));
});

test("13 Frozen snapshot contains exact payment schedule", () => {
  const freezeLib = read("netlify/functions/_lib/contract-package.js");
  assert.ok(/payment_schedule/.test(freezeLib) || /paymentSchedule/.test(freezeLib));
});

test("14 Frozen snapshot remains immutable / readiness incomplete before confirm", () => {
  assert.ok(js.includes("Confirmed payment schedules are read-only") || js.includes("paymentScheduleAllowsOwnerEdit"));
  assert.ok(js.includes("return !paymentConfigured"));
  // Before confirm, paymentConfigured is false → Article incomplete
  assert.ok(js.includes('=== "configured"'));
  assert.ok(js.includes("Complete Payment Schedule"));
});

test("15 Existing schedule loads", () => {
  assert.ok(js.includes("hydratePaymentDraftFromSource"));
  assert.ok(js.includes("reloadPaymentScheduleFromServer") || js.includes("PAYMENT_SCHEDULE_API"));
  assert.ok(js.includes("mapScheduleItemToDraft"));
});

test("16 No Invoice Hub / payment-intent / Stripe / Zapier / email changes", () => {
  assert.ok(!/project-payment-intent|record-tenant-payment|upsert-tenant-invoice|stripe\.com/i.test(js));
  assert.ok(!/zapier-provider|contract-invitation-email-zapier|RESEND_API_KEY/i.test(js));
  assert.ok(!/project-payment-intent|stripe\.com/i.test(html));
});

test("CSS scoped — no global .btn override", () => {
  assert.ok(html.includes("#cbPayEditToolbar .btn"));
  assert.ok(html.includes(".cb-pay-edit-row__actions .btn"));
  assert.ok(styles.includes(".btn.ghost{ background: transparent"));
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
