/**
 * CH-010B — Payment Intent foundation audit QA (static + pure unit).
 * Run: node scripts/qa-ch010b-payment-intents.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const fnPath = path.join(ROOT, "netlify/functions/project-payment-intents.js");
const sqlPath = path.join(ROOT, "SUPABASE_CH010B_PAYMENT_INTENTS.sql");
const verifyPath = path.join(ROOT, "SUPABASE_CH010B_PAYMENT_INTENTS_VERIFY.sql");

const fnSrc = fs.readFileSync(fnPath, "utf8");
const sqlSrc = fs.readFileSync(sqlPath, "utf8");
const verifySrc = fs.readFileSync(verifyPath, "utf8");

const mod = require("../netlify/functions/project-payment-intents");
const {
  API_VERSION,
  PAYMENT_TYPES,
  INTENT_STATUSES,
  toMoneyCents,
  centsToMoney,
  mapLegacyPaymentType,
  sortPaymentIntents,
  serializeIntent,
  summarizeIntents,
  validUuid,
  unknownKeys,
  ALLOWED_QUERY_KEYS,
  singleQueryValue,
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

test("syntax project-payment-intents.js", () => {
  const r = spawnSync(process.execPath, ["--check", fnPath], { encoding: "utf8" });
  assert.strictEqual(r.status, 0, r.stderr || r.stdout);
});

test("1. GET only", () => {
  assert.ok(fnSrc.includes('event.httpMethod !== "GET"'));
  assert.ok(fnSrc.includes("method_not_allowed"));
});

test("14. no writes", () => {
  assert.ok(!/method:\s*"POST"/.test(fnSrc));
  assert.ok(!/method:\s*"PATCH"/.test(fnSrc));
  assert.ok(!/method:\s*"DELETE"/.test(fnSrc));
});

test("15. no invoice calls", () => {
  assert.ok(!/invoices\?/.test(fnSrc));
  assert.ok(!/create-.*invoice/.test(fnSrc));
});

test("16. no ledger calls", () => {
  assert.ok(!/tenant_project_payments/.test(fnSrc));
  assert.ok(!/record-tenant-payment/.test(fnSrc));
});

test("17. no Stripe modules/calls", () => {
  assert.ok(!/create-.*stripe|stripe\.com|Stripe\(/i.test(fnSrc));
  assert.ok(!/stripe_checkout|stripe_payment_intent_id/.test(fnSrc));
  assert.ok(!/require\(.*stripe/i.test(fnSrc));
});

test("18. no secret leakage in client errors", () => {
  assert.ok(fnSrc.includes('error: "Server error"'));
  assert.ok(!/SUPABASE_SERVICE|service_role key/i.test(fnSrc));
});

test("4. no session Unauthorized", () => {
  assert.ok(fnSrc.includes("no_session") || fnSrc.includes("Unauthorized"));
});

test("5. Owner/Admin only; seller/supervisor blocked", () => {
  assert.ok(fnSrc.includes('"owner"') && fnSrc.includes('"admin"'));
  assert.ok(fnSrc.includes("owner_required"));
  assert.ok(!fnSrc.includes('"seller"') || !/OWNER_ADMIN_ROLES[\s\S]*seller/.test(fnSrc));
});

test("6/9. client tenant_id forbidden", () => {
  assert.ok(fnSrc.includes("tenant_id_forbidden"));
});

test("2. missing project_id", () => {
  assert.ok(fnSrc.includes("project_id_required"));
});

test("3. invalid UUID", () => {
  assert.ok(fnSrc.includes("invalid_project_id"));
  assert.ok(validUuid("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"));
  assert.ok(!validUuid("not-a-uuid"));
});

test("7/8/10. cross-tenant project → same 404", () => {
  assert.ok(/return json\(404[\s\S]*project_not_found/.test(fnSrc));
  assert.ok(fnSrc.includes("tenant_id=eq."));
});

test("3b. NULLS LAST sequence ordering", () => {
  const rows = [
    { id: "z", sequence_number: null, due_date: "2026-01-01", created_at: "2026-01-01T00:00:00Z" },
    { id: "a", sequence_number: 1, due_date: "2026-01-01", created_at: "2026-01-01T00:00:00Z" },
  ];
  assert.deepStrictEqual(sortPaymentIntents(rows).map((r) => r.id), ["a", "z"]);
});

test("4b. NULLS LAST due_date ordering", () => {
  const rows = [
    { id: "n", sequence_number: 1, due_date: null, created_at: "2026-01-01T00:00:00Z" },
    { id: "d", sequence_number: 1, due_date: "2026-01-01", created_at: "2026-01-01T00:00:00Z" },
  ];
  assert.deepStrictEqual(sortPaymentIntents(rows).map((r) => r.id), ["d", "n"]);
});

test("5b. same sequence/date → created_at then id", () => {
  const rows = [
    { id: "b", sequence_number: 1, due_date: "2026-01-01", created_at: "2026-01-02T00:00:00Z" },
    { id: "a", sequence_number: 1, due_date: "2026-01-01", created_at: "2026-01-01T00:00:00Z" },
    { id: "c", sequence_number: 1, due_date: "2026-01-01", created_at: "2026-01-01T00:00:00Z" },
  ];
  assert.deepStrictEqual(sortPaymentIntents(rows).map((r) => r.id), ["a", "c", "b"]);
});

test("10. deterministic compound order", () => {
  const rows = [
    { id: "b", sequence_number: 2, due_date: "2026-02-01", created_at: "2026-01-02T00:00:00Z" },
    { id: "a", sequence_number: 1, due_date: "2026-03-01", created_at: "2026-01-01T00:00:00Z" },
    { id: "c", sequence_number: null, due_date: "2026-01-01", created_at: "2026-01-03T00:00:00Z" },
    { id: "d", sequence_number: 1, due_date: "2026-01-01", created_at: "2026-01-01T00:00:00Z" },
  ];
  assert.deepStrictEqual(sortPaymentIntents(rows).map((r) => r.id), ["d", "a", "b", "c"]);
});

test("11. exact decimal without float authority", () => {
  assert.strictEqual(toMoneyCents("10.5"), 1050);
  assert.strictEqual(centsToMoney(1050), "10.50");
  assert.strictEqual(toMoneyCents("10.555"), null);
  const ser = serializeIntent({
    id: "1",
    project_id: "p",
    payment_type: "custom",
    title: "T",
    amount: "12.30",
    currency: "USD",
    status: "draft",
    metadata: {},
  });
  assert.strictEqual(ser.amount, "12.30");
  assert.strictEqual(ser.amount_cents, 1230);
  assert.strictEqual(typeof ser.amount, "string");
  assert.ok(!("amount_exact" in ser));
});

test("12. summary excludes cancelled/voided from intent_total", () => {
  const payments = [
    serializeIntent({
      id: "1",
      project_id: "p",
      payment_type: "start_payment",
      title: "A",
      amount: "100.00",
      currency: "USD",
      status: "draft",
      metadata: {},
    }),
    serializeIntent({
      id: "2",
      project_id: "p",
      payment_type: "progress_payment",
      title: "B",
      amount: "50.00",
      currency: "USD",
      status: "ready",
      metadata: {},
    }),
    serializeIntent({
      id: "3",
      project_id: "p",
      payment_type: "custom",
      title: "C",
      amount: "25.00",
      currency: "USD",
      status: "cancelled",
      metadata: {},
    }),
    serializeIntent({
      id: "4",
      project_id: "p",
      payment_type: "custom",
      title: "D",
      amount: "10.00",
      currency: "USD",
      status: "voided",
      metadata: {},
    }),
  ];
  const s = summarizeIntents(payments);
  assert.strictEqual(s.intent_total, "150.00");
  assert.strictEqual(s.intent_total_cents, 15000);
  assert.strictEqual(s.cancelled_total_cents, 2500);
  assert.strictEqual(s.voided_total_cents, 1000);
  assert.strictEqual(typeof s.intent_total, "string");
});

test("13. cancelled/voided statuses", () => {
  assert.ok(INTENT_STATUSES.has("cancelled") && INTENT_STATUSES.has("voided"));
});

test("9. empty list", () => {
  const s = summarizeIntents([]);
  assert.strictEqual(s.count, 0);
  assert.strictEqual(s.intent_total, "0.00");
  assert.strictEqual(s.intent_total_cents, 0);
});

test("19. JSON serializable", () => {
  const body = {
    ok: true,
    version: API_VERSION,
    project_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    summary: summarizeIntents([]),
    payments: [],
  };
  assert.strictEqual(JSON.parse(JSON.stringify(body)).version, "ch-010b-v1");
});

test("payment type map", () => {
  assert.strictEqual(mapLegacyPaymentType("deposit"), "initial_scheduling_payment");
  assert.strictEqual(mapLegacyPaymentType("material"), "material_cost");
  assert.ok(PAYMENT_TYPES.has("material_cost"));
  assert.ok(!PAYMENT_TYPES.has("material"));
});

test("6b. invalid status filter marker", () => {
  assert.ok(fnSrc.includes("invalid_status"));
});

test("7b. invalid payment_type filter marker", () => {
  assert.ok(fnSrc.includes("invalid_payment_type"));
});

test("8b. repeated query params rejected", () => {
  assert.ok(fnSrc.includes("repeated_query_param"));
  const r = singleQueryValue(
    { multiValueQueryStringParameters: { project_id: ["a", "b"] }, queryStringParameters: {} },
    "project_id"
  );
  assert.strictEqual(r.error, "repeated_query_param");
});

test("20. schema constraints", () => {
  assert.ok(sqlSrc.includes("amount > 0"));
  assert.ok(sqlSrc.includes("currency = 'USD'"));
  assert.ok(sqlSrc.includes("btrim(title)"));
  assert.ok(sqlSrc.includes("tenant_project_payment_intents_status_timestamps_chk"));
  assert.ok(sqlSrc.includes("tenant_project_payment_intents_assert_refs"));
  assert.ok(/^\s*paid_amount\b/m.test(sqlSrc) === false);
  assert.ok(/^\s*invoice_id\b/m.test(sqlSrc) === false);
});

test("15b. schema dependency markers", () => {
  assert.ok(sqlSrc.includes("MANUAL PRECHECK") || sqlSrc.includes("PRECHECK"));
  assert.ok(sqlSrc.includes("project_contract_payment_schedules"));
  assert.ok(sqlSrc.includes("tenant_projects"));
  assert.ok(sqlSrc.includes("to_regclass"));
});

test("16b. tenant integrity trigger source markers", () => {
  assert.ok(sqlSrc.includes("payment_intent_project_tenant_mismatch"));
  assert.ok(sqlSrc.includes("payment_intent_quote_tenant_mismatch"));
  assert.ok(sqlSrc.includes("payment_intent_schedule_scope_mismatch"));
  assert.ok(sqlSrc.includes("payment_intent_schedule_item_requires_schedule"));
  assert.ok(sqlSrc.includes("payment_intent_change_order_scope_mismatch"));
});

test("21. optional FKs conditional", () => {
  assert.ok(sqlSrc.includes("tenant_project_payment_intents_tenant_schedule_fk"));
});

test("22. existing systems untouched in function", () => {
  assert.ok(!fnSrc.includes("quote-accept-bridge"));
  assert.ok(!fnSrc.includes("create-remaining-balance"));
});

test("SQL additive / no destructive alters of peers", () => {
  assert.ok(sqlSrc.includes("create table if not exists"));
  assert.ok(!/alter table public\.invoices/i.test(sqlSrc));
  assert.ok(!/alter table public\.tenant_project_payments/i.test(sqlSrc));
  assert.ok(!/alter table public\.tenant_projects\b/i.test(sqlSrc));
  assert.ok(!/alter table public\.quotes\b/i.test(sqlSrc));
  assert.ok(sqlSrc.includes("service role full access"));
});

test("API order uses nullslast", () => {
  assert.ok(fnSrc.includes("sequence_number.asc.nullslast"));
  assert.ok(fnSrc.includes("due_date.asc.nullslast"));
});

test("duplicate sequence allowed (no unique)", () => {
  assert.ok(!/unique \(tenant_id, project_id, sequence_number\)/i.test(sqlSrc));
});

test("OPTIONS handled", () => {
  assert.ok(fnSrc.includes('httpMethod === "OPTIONS"'));
});

test("verify SQL coverage markers", () => {
  assert.ok(!verifySrc.includes("```"));
  assert.ok(verifySrc.includes("rls_enabled"));
  assert.ok(verifySrc.includes("row_count"));
  assert.ok(verifySrc.includes("invalid_amount_rows"));
  assert.ok(verifySrc.includes("assert_refs trigger"));
  assert.ok(verifySrc.includes("cross-tenant"));
  assert.ok(verifySrc.includes("blank title"));
  assert.ok(verifySrc.includes("deps projects="));
});

test("unknown query keys", () => {
  assert.deepStrictEqual(unknownKeys({ project_id: "x", foo: 1 }, ALLOWED_QUERY_KEYS), ["foo"]);
});

test("float drift: 0.1+0.2 path uses cents", () => {
  const a = serializeIntent({
    id: "1",
    project_id: "p",
    payment_type: "custom",
    title: "A",
    amount: "0.10",
    currency: "USD",
    status: "ready",
    metadata: {},
  });
  const b = serializeIntent({
    id: "2",
    project_id: "p",
    payment_type: "custom",
    title: "B",
    amount: "0.20",
    currency: "USD",
    status: "ready",
    metadata: {},
  });
  const s = summarizeIntents([a, b]);
  assert.strictEqual(s.intent_total, "0.30");
  assert.strictEqual(s.intent_total_cents, 30);
});

console.log(`\nCH-010B QA: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
