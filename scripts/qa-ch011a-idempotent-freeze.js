/**
 * CH-011A — deterministic / idempotent freeze hash QA.
 * Run: node scripts/qa-ch011a-idempotent-freeze.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const libPath = path.join(ROOT, "netlify/functions/_lib/contract-package.js");
const libSrc = fs.readFileSync(libPath, "utf8");
const lib = require("../netlify/functions/_lib/contract-package");

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

function baseSnapshotArgs(overrides = {}) {
  return {
    tenantId: "t1",
    project: {
      id: "p1",
      project_name: "Test",
      status: "active",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
    quote: {
      id: "q1",
      client_name: "Cust",
      client_email: "c@example.com",
      client_phone: "555",
      project_address: "1 Main",
      job_site: "",
      status: "accepted",
      total: 1000,
      currency: "USD",
      deposit_required: 100,
      quote_number_display: "2026-1",
      title: "T",
      notes: "Hi — estimate email only",
      scope_of_work: "Scope text",
      terms: "Terms text",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
    setup: {
      id: "s1",
      property_address_line1: "1 Main",
      property_address_line2: "",
      property_city: "Hayward",
      property_state: "CA",
      property_postal_code: "94544",
      property_confirmed_at: "2026-01-02T00:00:00.000Z",
      warranty_duration_value: 1,
      warranty_duration_unit: "years",
      warranty_summary: "Workmanship",
      warranty_exclusions: "Abuse",
      warranty_confirmed_at: "2026-01-02T00:00:00.000Z",
      signature_method: "email_link",
      updated_at: "2026-01-02T00:00:00.000Z",
    },
    setupReadiness: {
      project_address: "confirmed",
      warranty: "configured",
      signature_method: "configured",
    },
    schedule: {
      id: "sch1",
      status: "confirmed",
      confirmed_at: "2026-01-03T00:00:00.000Z",
      updated_at: "2026-01-03T00:00:00.000Z",
      currency: "USD",
      contract_total: 1000,
    },
    items: [
      {
        id: "i2",
        sequence_number: 2,
        label: "Final",
        payment_type: "custom",
        amount: 500,
        due_rule: "custom",
        item_role: "future_obligation",
      },
      {
        id: "i1",
        sequence_number: 1,
        label: "Deposit",
        payment_type: "custom",
        amount: 500,
        due_rule: "custom",
        item_role: "future_obligation",
      },
    ],
    paymentReadiness: {
      status: "configured",
      contract_total: 1000,
      scheduled_total: 1000,
      remaining_difference: 0,
      item_count: 2,
      confirmed_at: "2026-01-03T00:00:00.000Z",
    },
    legalEffective: {
      confirmed_at: "2026-01-04T00:00:00.000Z",
      notices: { contract_notice: "Notice A", payment_notice: "Pay" },
      enabled: { contract_notice: true, payment_notice: true },
    },
    legalProfile: {
      id: "lp1",
      legal_business_name: "Acme LLC",
      business_phone: "555",
      business_email: "o@example.com",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
    brandingRow: {
      business_name: "Acme",
      logo_url: "https://example.com/logo.png",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
    frozenAt: "2026-01-05T00:00:00.000Z",
    ...overrides,
  };
}

test("syntax contract-package.js", () => {
  const r = spawnSync(process.execPath, ["--check", libPath], { encoding: "utf8" });
  assert.strictEqual(r.status, 0, r.stderr || r.stdout);
});

test("1. same authoritative snapshot twice → same hash", () => {
  const a = lib.buildSnapshot(baseSnapshotArgs());
  const b = lib.buildSnapshot(baseSnapshotArgs());
  assert.strictEqual(lib.contentHashForSnapshot(a), lib.contentHashForSnapshot(b));
});

test("2. different object key order → same hash", () => {
  const snap = lib.buildSnapshot(baseSnapshotArgs());
  const shuffled = {
    readiness: snap.readiness,
    scope: snap.scope,
    schema: snap.schema,
    frozen_at: snap.frozen_at,
    payment_schedule: snap.payment_schedule,
    contract_schedule: snap.contract_schedule,
    business_settings: snap.business_settings,
    quote: snap.quote,
    property: snap.property,
    warranty: snap.warranty,
    terms: snap.terms,
    legal_notices: snap.legal_notices,
    signature_method_preference: snap.signature_method_preference,
    customer: snap.customer,
    project: snap.project,
    tenant: snap.tenant,
    source_ids: snap.source_ids,
    source_timestamps: snap.source_timestamps,
    price: snap.price,
  };
  assert.strictEqual(
    lib.contentHashForSnapshot(snap),
    lib.contentHashForSnapshot(shuffled)
  );
});

test("3. different array input order → deterministic hash", () => {
  const ordered = lib.buildSnapshot(
    baseSnapshotArgs({
      items: [
        {
          id: "i1",
          sequence_number: 1,
          label: "Deposit",
          payment_type: "custom",
          amount: 500,
          due_rule: "custom",
          item_role: "future_obligation",
        },
        {
          id: "i2",
          sequence_number: 2,
          label: "Final",
          payment_type: "custom",
          amount: 500,
          due_rule: "custom",
          item_role: "future_obligation",
        },
      ],
    })
  );
  const reversed = lib.buildSnapshot(baseSnapshotArgs());
  assert.strictEqual(
    lib.contentHashForSnapshot(ordered),
    lib.contentHashForSnapshot(reversed)
  );
  assert.strictEqual(ordered.payment_schedule.items[0].sequence_number, 1);
  assert.strictEqual(reversed.payment_schedule.items[0].sequence_number, 1);
});

test("4. freeze timestamp difference → same hash", () => {
  const a = lib.buildSnapshot(baseSnapshotArgs({ frozenAt: "2026-01-05T00:00:00.000Z" }));
  const b = lib.buildSnapshot(baseSnapshotArgs({ frozenAt: "2026-08-03T20:00:00.000Z" }));
  assert.notStrictEqual(a.frozen_at, b.frozen_at);
  assert.strictEqual(lib.contentHashForSnapshot(a), lib.contentHashForSnapshot(b));
  assert.ok(!("frozen_at" in lib.authoritativeContentForHash(a)));
});

test("5. package metadata difference → same hash", () => {
  const snap = lib.buildSnapshot(baseSnapshotArgs());
  const withMeta = {
    ...snap,
    package_id: "pkg-a",
    package_version: 1,
    package_status: "ready",
    created_at: "2026-01-05T00:00:00.000Z",
    updated_at: "2026-01-06T00:00:00.000Z",
    created_by: "member-1",
    supersedes_package_id: "pkg-old",
  };
  assert.strictEqual(
    lib.contentHashForSnapshot(snap),
    lib.contentHashForSnapshot(withMeta)
  );
});

test("6. real scope/payment/legal change → different hash", () => {
  const base = lib.buildSnapshot(baseSnapshotArgs());
  const scopeChanged = lib.buildSnapshot(
    baseSnapshotArgs({
      quote: {
        ...baseSnapshotArgs().quote,
        scope_of_work: "Scope text CHANGED",
      },
    })
  );
  const payChanged = lib.buildSnapshot(
    baseSnapshotArgs({
      items: [
        {
          id: "i1",
          sequence_number: 1,
          label: "Deposit",
          payment_type: "custom",
          amount: 400,
          due_rule: "custom",
          item_role: "future_obligation",
        },
        {
          id: "i2",
          sequence_number: 2,
          label: "Final",
          payment_type: "custom",
          amount: 600,
          due_rule: "custom",
          item_role: "future_obligation",
        },
      ],
    })
  );
  const legalChanged = lib.buildSnapshot(
    baseSnapshotArgs({
      legalEffective: {
        confirmed_at: "2026-01-04T00:00:00.000Z",
        notices: { contract_notice: "Notice B", payment_notice: "Pay" },
        enabled: { contract_notice: true, payment_notice: true },
      },
    })
  );
  const h0 = lib.contentHashForSnapshot(base);
  assert.notStrictEqual(h0, lib.contentHashForSnapshot(scopeChanged));
  assert.notStrictEqual(h0, lib.contentHashForSnapshot(payChanged));
  assert.notStrictEqual(h0, lib.contentHashForSnapshot(legalChanged));
});

test("7. identical freeze → no INSERT", () => {
  const snap = lib.buildSnapshot(baseSnapshotArgs());
  const hash = lib.contentHashForSnapshot(snap);
  const latest = {
    id: "c6f1e3a1-16c7-467a-a7ed-d31c146b9dad",
    content_hash: "legacy-hash-with-frozen-at",
    snapshot_json: snap,
    status: "ready",
    version: 2,
  };
  const d = lib.evaluateFreezeHashDecision(latest, hash);
  assert.strictEqual(d.idempotent, true);
  assert.strictEqual(d.createVersion, false);
  assert.strictEqual(d.supersedeId, null);
});

test("8. identical freeze → no supersede", () => {
  const snap = lib.buildSnapshot(baseSnapshotArgs());
  const hash = lib.contentHashForSnapshot(snap);
  const d = lib.evaluateFreezeHashDecision(
    { id: "ready-1", content_hash: hash, snapshot_json: snap },
    hash
  );
  assert.strictEqual(d.supersedeId, null);
  assert.ok(libSrc.includes("evaluateFreezeHashDecision"));
  assert.ok(libSrc.includes("decision.idempotent"));
});

test("9. changed freeze → version increments once", () => {
  const a = lib.buildSnapshot(baseSnapshotArgs());
  const b = lib.buildSnapshot(
    baseSnapshotArgs({
      quote: { ...baseSnapshotArgs().quote, scope_of_work: "New scope" },
    })
  );
  const latest = {
    id: "ready-1",
    version: 2,
    content_hash: lib.contentHashForSnapshot(a),
    snapshot_json: a,
  };
  const d = lib.evaluateFreezeHashDecision(latest, lib.contentHashForSnapshot(b));
  assert.strictEqual(d.idempotent, false);
  assert.strictEqual(d.createVersion, true);
  assert.strictEqual(d.supersedeId, "ready-1");
});

test("10. changed freeze → prior ready becomes superseded", () => {
  assert.ok(libSrc.includes("markPackageSuperseded"));
  assert.ok(libSrc.includes("decision.supersedeId"));
  const a = lib.buildSnapshot(baseSnapshotArgs());
  const b = lib.buildSnapshot(
    baseSnapshotArgs({
      setup: {
        ...baseSnapshotArgs().setup,
        warranty_summary: "Changed warranty",
      },
    })
  );
  const d = lib.evaluateFreezeHashDecision(
    {
      id: "prior-ready",
      content_hash: lib.contentHashForSnapshot(a),
      snapshot_json: a,
    },
    lib.contentHashForSnapshot(b)
  );
  assert.strictEqual(d.supersedeId, "prior-ready");
  assert.strictEqual(d.createVersion, true);
});

test("frozen_at excluded from hash input helper", () => {
  assert.ok(libSrc.includes("authoritativeContentForHash"));
  assert.ok(libSrc.includes("frozen_at"));
  assert.match(libSrc, /frozen_at:\s*_frozenAt/);
});

console.log(`CH-011A idempotent freeze QA: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
