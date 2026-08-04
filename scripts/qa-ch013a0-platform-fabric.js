/**
 * CH-013A.0 — Platform Fabric foundation (offline / static QA).
 * Run: node scripts/qa-ch013a0-platform-fabric.js
 *
 * Does NOT require live Supabase. Does NOT emit into production flows.
 * Does NOT touch Invoice Hub, signing, PDF, payments, ledger, CRM.
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

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

function check(file) {
  const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || file);
}

let passed = 0;
let failed = 0;
const pending = [];

function test(name, fn) {
  const run = async () => {
    try {
      await fn();
      console.log("PASS", name);
      passed += 1;
    } catch (err) {
      console.log("FAIL", name, "-", err.message);
      failed += 1;
    }
  };
  pending.push(run());
}

const events = require(path.join(ROOT, "netlify/functions/_lib/platform-events.js"));
const bus = require(path.join(ROOT, "netlify/functions/_lib/platform-bus.js"));
const outbox = require(path.join(ROOT, "netlify/functions/_lib/platform-outbox.js"));
const activity = require(path.join(ROOT, "netlify/functions/_lib/platform-activity.js"));
const notifications = require(path.join(
  ROOT,
  "netlify/functions/_lib/platform-notifications.js"
));

const sql = read("SUPABASE_CH013A0_PLATFORM_FABRIC.sql");
const sqlVerify = read("SUPABASE_CH013A0_PLATFORM_FABRIC_VERIFY.sql");

const TENANT = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const QUOTE = "33333333-3333-4333-8333-333333333333";
const AGG = "44444444-4444-4444-8444-444444444444";

test("syntax platform fabric modules", () => {
  [
    "netlify/functions/_lib/platform-events.js",
    "netlify/functions/_lib/platform-outbox.js",
    "netlify/functions/_lib/platform-bus.js",
    "netlify/functions/_lib/platform-activity.js",
    "netlify/functions/_lib/platform-notifications.js",
  ].forEach((rel) => check(path.join(ROOT, rel)));
});

test("SQL objects present (outbox, activity, notifications)", () => {
  assert.ok(sql.includes("create table if not exists public.platform_domain_event_outbox"));
  assert.ok(sql.includes("create table if not exists public.platform_activity_events"));
  assert.ok(sql.includes("create table if not exists public.platform_notifications"));
  assert.ok(sql.includes("append-only"));
  assert.ok(sql.includes("platform_domain_event_outbox_tenant_idempotency_key"));
  assert.ok(sql.includes("MG-EVT-[0-9A-Z]{8}"));
  assert.ok(sql.includes("event_version"));
  assert.ok(sql.includes("'critical'"));
  assert.ok(sql.includes("'silent'"));
  assert.ok(sql.includes("read_at"));
  assert.ok(sql.includes("dismissed_at"));
  assert.ok(sql.includes("timezone('utc', now())"));
});

test("VERIFY covers append-only, idempotency, UTC, priority", () => {
  assert.ok(sqlVerify.includes("append-only"));
  assert.ok(sqlVerify.includes("unique_violation"));
  assert.ok(sqlVerify.includes("rollback"));
  assert.ok(sqlVerify.includes("event_version"));
  assert.ok(sqlVerify.includes("priority"));
});

test("explicit activity UPDATE rejection (SQL + VERIFY)", () => {
  assert.ok(sql.includes("platform_activity_events_reject_mutation"));
  assert.ok(sql.includes("platform_activity_events_no_update"));
  assert.ok(sql.includes("before update on public.platform_activity_events"));
  assert.ok(sql.includes("platform_activity_events is immutable"));
  assert.ok(!/create or replace function public\.platform_activity_events_reject_delete/i.test(sql));
  assert.ok(sqlVerify.includes("activity UPDATE should be blocked"));
  assert.ok(sqlVerify.includes("%immutable%"));
});

test("explicit activity DELETE rejection (SQL + VERIFY)", () => {
  assert.ok(sql.includes("platform_activity_events_no_delete"));
  assert.ok(sql.includes("before delete on public.platform_activity_events"));
  assert.ok(sqlVerify.includes("activity DELETE should be blocked"));
});

test("outbox UPDATE and DELETE blocked (SQL + VERIFY)", () => {
  assert.ok(sql.includes("platform_domain_event_outbox_no_update"));
  assert.ok(sql.includes("platform_domain_event_outbox_no_delete"));
  assert.ok(sqlVerify.includes("outbox UPDATE should be blocked"));
  assert.ok(sqlVerify.includes("outbox DELETE should be blocked"));
});

test("notifications remain mutable for read/dismiss (not immutable)", () => {
  assert.ok(sql.includes("read_at"));
  assert.ok(sql.includes("dismissed_at"));
  assert.ok(!/platform_notifications.*immutable/i.test(sql));
  assert.ok(!sql.includes("platform_notifications_no_update"));
  assert.ok(sqlVerify.includes("set read_at"));
  assert.ok(sqlVerify.includes("set dismissed_at"));
  assert.ok(typeof notifications.markNotificationRead === "function");
  assert.ok(typeof notifications.dismissNotification === "function");
});

test("catalog has exact canonical event names once", () => {
  const required = [
    "contract.package.frozen",
    "contract.envelope.prepared",
    "contract.invitation.prepared",
    "contract.invitation.queued",
    "contract.invitation.sent",
    "contract.invitation.delivered",
    "contract.invitation.failed",
    "contract.invitation.opened",
    "contract.invitation.bounced",
    "contract.invitation.resent",
    "contract.invitation.revoked",
    "contract.invitation.expired",
    "contract.signed",
    "contract.completed",
    "contract.certificate.created",
    "contract.signed_pdf.created",
    "contract.reminder.sent",
    "delivery.channel.queued",
    "delivery.channel.sending",
    "delivery.channel.sent",
    "delivery.channel.failed",
  ];
  assert.strictEqual(events.DOMAIN_EVENT_TYPES.length, required.length);
  required.forEach((t) => {
    assert.ok(events.DOMAIN_EVENT_TYPE_SET.has(t), `missing ${t}`);
  });
  const uniq = new Set(events.DOMAIN_EVENT_TYPES);
  assert.strictEqual(uniq.size, events.DOMAIN_EVENT_TYPES.length);
  // Catalog defined exactly once in platform-events.js (not duplicated in other libs)
  const busSrc = read("netlify/functions/_lib/platform-bus.js");
  const outboxSrc = read("netlify/functions/_lib/platform-outbox.js");
  assert.ok(!busSrc.includes("contract.package.frozen"));
  assert.ok(!outboxSrc.includes("DOMAIN_EVENT_TYPES"));
});

test("buildDomainEvent shape: version, correlation, UTC, no secrets", () => {
  const built = events.buildDomainEvent({
    tenant_id: TENANT,
    project_id: PROJECT,
    quote_id: QUOTE,
    aggregate: "package",
    aggregate_id: AGG,
    type: "contract.package.frozen",
    payload: { package_id: AGG, schema: "ch-013a0-v1" },
  });
  assert.ok(built.ok, built.error);
  const e = built.event;
  assert.strictEqual(e.event_version, 1);
  assert.strictEqual(events.EVENT_VERSION, 1);
  assert.ok(e.event_id);
  assert.ok(events.CORRELATION_RE.test(e.correlation_id));
  assert.ok(e.occurred_at.endsWith("Z"), "occurred_at must be UTC ISO (Z)");
  assert.strictEqual(e.tenant_id, TENANT);
  assert.strictEqual(e.project_id, PROJECT);
  assert.strictEqual(e.quote_id, QUOTE);
  assert.strictEqual(e.aggregate, "package");
  assert.strictEqual(e.type, "contract.package.frozen");
  assert.ok(Object.prototype.hasOwnProperty.call(e, "causation_id"));
  assert.ok(Object.prototype.hasOwnProperty.call(e, "payload"));
});

test("forbidden secrets rejected in payload", () => {
  const badKeys = [
    { token: "x" },
    { raw_token: "x" },
    { signed_url: "https://x" },
    { tokenized_url: "https://x?t=1" },
    { signature: {} },
    { signature_vector: [] },
    { secret: "x" },
    { nested: { api_key: "x" } },
  ];
  badKeys.forEach((payload) => {
    const built = events.buildDomainEvent({
      tenant_id: TENANT,
      aggregate: "invitation",
      type: "contract.invitation.queued",
      payload,
    });
    assert.ok(!built.ok, `should reject ${JSON.stringify(payload)}`);
    assert.strictEqual(built.code, "forbidden_payload");
  });
});

test("explicit recursive secret scrub (nested objects and arrays)", () => {
  const deep = {
    ok: true,
    items: [
      { meta: { note: "safe" } },
      { meta: { signed_url: "https://evil" } },
    ],
  };
  const scrub = events.scrubForbiddenKeys(deep, "payload");
  assert.ok(!scrub.ok);
  assert.ok(/signed_url/.test(scrub.error));

  const deepToken = {
    path: [{ children: [{ raw_token: "abc" }] }],
  };
  const scrub2 = events.scrubForbiddenKeys(deepToken, "payload");
  assert.ok(!scrub2.ok);
  assert.ok(/raw_token/.test(scrub2.error));

  const built = events.buildDomainEvent({
    tenant_id: TENANT,
    aggregate: "invitation",
    type: "contract.invitation.failed",
    payload: { attempts: [{ error: "timeout", nested: { api_key: "k" } }] },
  });
  assert.ok(!built.ok);
  assert.strictEqual(built.code, "forbidden_payload");

  const safe = events.scrubForbiddenKeys(
    { attempts: [{ error: "timeout", code: "x" }], ids: ["a", "b"] },
    "payload"
  );
  assert.ok(safe.ok);
});

test("correlation id format MG-EVT-XXXXXXXX", () => {
  const id = events.createCorrelationId();
  assert.ok(events.CORRELATION_RE.test(id), id);
  const bad = events.assertCorrelationId("evt-123");
  assert.ok(!bad.ok);
  const chain = bus.beginCorrelation();
  assert.ok(events.CORRELATION_RE.test(chain));
});

test("unknown event type rejected", () => {
  const built = events.buildDomainEvent({
    tenant_id: TENANT,
    aggregate: "package",
    type: "contract.email.sent",
    payload: {},
  });
  assert.ok(!built.ok);
  assert.strictEqual(built.code, "invalid_event_type");
});

test("bus requires idempotency_key (no silent publish)", async () => {
  const r = await bus.publishDomainEvent(
    {
      tenant_id: TENANT,
      aggregate: "package",
      type: "contract.package.frozen",
      payload: {},
    },
    {}
  );
  assert.ok(!r.ok);
  assert.strictEqual(r.code, "missing_idempotency_key");
});

test("idempotency key + duplicate replay path present in outbox", () => {
  const src = read("netlify/functions/_lib/platform-outbox.js");
  assert.ok(src.includes("idempotency_key"));
  assert.ok(src.includes("duplicate: true"));
  assert.ok(src.includes("isUniqueViolation"));
  assert.ok(sql.includes("unique (tenant_id, idempotency_key)"));
});

test("notification priority enum", () => {
  assert.deepStrictEqual(
    [...notifications.PRIORITIES],
    ["critical", "high", "normal", "low", "silent"]
  );
});

test("trust boundary: fabric has no public HTTP handlers; refs not client-trusted", () => {
  assert.ok(!exists("netlify/functions/platform-bus.js"));
  assert.ok(!exists("netlify/functions/platform-events.js"));
  assert.ok(!exists("netlify/functions/platform-outbox.js"));
  const busSrc = read("netlify/functions/_lib/platform-bus.js");
  const outboxSrc = read("netlify/functions/_lib/platform-outbox.js");
  assert.ok(busSrc.includes("TRUST BOUNDARY"));
  assert.ok(outboxSrc.includes("TRUST BOUNDARY"));
  assert.ok(busSrc.includes("server-resolved"));
});

test("no wire-up into signing / freeze / send / invoice / CRM", () => {
  const guarded = [
    "netlify/functions/_lib/contract-package.js",
    "netlify/functions/_lib/contract-signed-pdf.js",
    "netlify/functions/contract-envelope-send.js",
    "netlify/functions/_lib/contract-envelope.js",
    "netlify/functions/contract-certificates.js",
    "netlify/functions/contract-sign.js",
  ];
  guarded.forEach((rel) => {
    if (!exists(rel)) return;
    const src = read(rel);
    assert.ok(
      !src.includes("platform-bus") &&
        !src.includes("platform-outbox") &&
        !src.includes("publishDomainEvent") &&
        !src.includes("platform-events"),
      `${rel} must not emit platform events yet`
    );
  });
  // No UI / public JS fabric surface
  assert.ok(!exists("public/js/platform-events.js"));
  assert.ok(!exists("public/js/platform-bus.js"));
});

test("exports: outbox + activity + notifications tables named", () => {
  assert.strictEqual(outbox.OUTBOX_TABLE, "platform_domain_event_outbox");
  assert.strictEqual(activity.ACTIVITY_TABLE, "platform_activity_events");
  assert.strictEqual(notifications.NOTIFICATIONS_TABLE, "platform_notifications");
});

(async () => {
  await Promise.all(pending);
  console.log("");
  console.log(`CH-013A.0 QA: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
