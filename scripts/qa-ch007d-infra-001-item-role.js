/**
 * CH-007D-INFRA-001 — item_role compatibility tests (no network).
 */
const assert = require("assert");
const mod = require("../netlify/functions/project-contract-payment-schedule");
const {
  normalizeItem,
  normalizeItems,
  serializeItem,
  evaluateReadiness,
  totalItemsCents,
  DEFAULT_ITEM_ROLE,
  ITEM_ROLES,
  ALLOWED_ITEM_KEYS,
} = mod._test;

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

function baseItem(over = {}) {
  return {
    sequence_number: 1,
    label: "Start Payment",
    payment_type: "start",
    amount: 1000,
    due_rule: "on_start",
    milestone_description: "",
    fixed_due_date: null,
    ...over,
  };
}

test("ALLOWED_ITEM_KEYS includes item_role", () => {
  assert.ok(ALLOWED_ITEM_KEYS.has("item_role"));
});

test("ITEM_ROLES enum", () => {
  assert.ok(ITEM_ROLES.has("future_obligation"));
  assert.ok(ITEM_ROLES.has("applied_payment"));
  assert.strictEqual(DEFAULT_ITEM_ROLE, "future_obligation");
});

test("old payload without item_role defaults to future_obligation", () => {
  const raw = baseItem();
  delete raw.item_role;
  const out = normalizeItem(raw, 0);
  assert.ok(!out.error, out.error);
  assert.strictEqual(out.item.item_role, "future_obligation");
});

test("blank item_role defaults to future_obligation", () => {
  const out = normalizeItem(baseItem({ item_role: "   " }), 0);
  assert.ok(!out.error, out.error);
  assert.strictEqual(out.item.item_role, "future_obligation");
});

test("future_obligation accepted", () => {
  const out = normalizeItem(baseItem({ item_role: "future_obligation" }), 0);
  assert.ok(!out.error, out.error);
  assert.strictEqual(out.item.item_role, "future_obligation");
});

test("applied_payment accepted", () => {
  const out = normalizeItem(baseItem({ item_role: "applied_payment" }), 0);
  assert.ok(!out.error, out.error);
  assert.strictEqual(out.item.item_role, "applied_payment");
});

test("invalid item_role rejected", () => {
  const out = normalizeItem(baseItem({ item_role: "historical" }), 0);
  assert.strictEqual(out.code, "invalid_enum");
  assert.ok(/item_role/i.test(out.error));
});

test("serializeItem defaults missing role", () => {
  const s = serializeItem(
    {
      id: "i1",
      sequence_number: 1,
      label: "X",
      payment_type: "start",
      amount: 500,
      due_rule: "on_start",
      milestone_description: "",
      fixed_due_date: null,
    },
    50000
  );
  assert.strictEqual(s.item_role, "future_obligation");
});

test("serializeItem preserves applied_payment", () => {
  const s = serializeItem(
    {
      id: "i1",
      sequence_number: 1,
      label: "Received",
      payment_type: "deposit",
      amount: 2000,
      due_rule: "on_signature",
      milestone_description: "",
      fixed_due_date: null,
      item_role: "applied_payment",
    },
    2118023
  );
  assert.strictEqual(s.item_role, "applied_payment");
});

test("existing records readable with select=* shape", () => {
  // Simulates PostgREST row after migration default backfill
  const s = serializeItem(
    {
      id: "old",
      sequence_number: 2,
      label: "Progress",
      payment_type: "progress",
      amount: 5000,
      percentage: 25,
      due_rule: "milestone",
      milestone_description: "Mid",
      fixed_due_date: null,
      item_role: "future_obligation",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    },
    2000000
  );
  assert.strictEqual(s.sequence_number, 2);
  assert.strictEqual(s.item_role, "future_obligation");
  assert.strictEqual(s.amount, 5000);
});

test("confirm readiness still requires sum == contract_total", () => {
  const contractCents = 2118023; // $21,180.23
  const items = normalizeItems([
    baseItem({
      sequence_number: 1,
      label: "Applied",
      payment_type: "deposit",
      amount: 2000,
      due_rule: "on_signature",
      item_role: "applied_payment",
    }),
    baseItem({
      sequence_number: 2,
      label: "Future",
      payment_type: "final",
      amount: 19180.23,
      due_rule: "on_completion",
      item_role: "future_obligation",
    }),
  ]);
  assert.ok(!items.error, items.error);
  assert.strictEqual(totalItemsCents(items.items), contractCents);

  const readiness = evaluateReadiness(
    { status: "confirmed", confirmed_at: "2026-07-30T00:00:00Z" },
    items.items,
    contractCents
  );
  assert.strictEqual(readiness.status, "configured");
});

test("confirm fails when sum != contract_total (unchanged rule)", () => {
  const items = normalizeItems([
    baseItem({ sequence_number: 1, amount: 100, item_role: "applied_payment" }),
  ]);
  assert.ok(!items.error);
  const readiness = evaluateReadiness(
    { status: "confirmed", confirmed_at: "2026-07-30T00:00:00Z" },
    items.items,
    2118023
  );
  assert.strictEqual(readiness.status, "draft");
});

test("mixed roles normalize in batch", () => {
  const out = normalizeItems([
    baseItem({ sequence_number: 1, amount: 2000, item_role: "applied_payment" }),
    baseItem({ sequence_number: 2, amount: 8000 }), // missing role
  ]);
  assert.ok(!out.error, out.error);
  assert.strictEqual(out.items[0].item_role, "applied_payment");
  assert.strictEqual(out.items[1].item_role, "future_obligation");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
