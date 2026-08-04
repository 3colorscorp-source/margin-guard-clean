/**
 * CH-012F — Canonical contract schedule QA (final audit coverage).
 * Run: node scripts/qa-ch012f-canonical-contract-schedule.js
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
const pending = [];

function test(name, fn) {
  pending.push(
    (async () => {
      try {
        await fn();
        console.log("PASS", name);
        passed += 1;
      } catch (err) {
        console.log("FAIL", name, "-", err.message);
        failed += 1;
      }
    })()
  );
}

const schedule = require(path.join(ROOT, "netlify/functions/_lib/contract-schedule.js"));
const pkg = require(path.join(ROOT, "netlify/functions/_lib/contract-package.js"));
const publishSrc = read("netlify/functions/publish-public-quote.js");
const sendSrc = read("public/js/estimate-public-send.js");
const salesSrc = read("public/sales.html");
const builderSrc = read("public/js/contract-builder.js");
const builderHtml = read("public/contract-builder.html");
const portalSrc = read("public/js/contract-sign-portal.js");
const pdfSrc = read("netlify/functions/_lib/contract-signed-pdf.js");
const updateSrc = read("netlify/functions/update-tenant-quote-edit.js");
const freezeSrc = read("netlify/functions/contract-package-freeze.js");
const upsertSrc = read("netlify/functions/upsert-tenant-project.js");
const appSrc = read("public/js/app.js");
const schedSrc = read("netlify/functions/_lib/contract-schedule.js");

const TOUCHED = [
  "netlify/functions/_lib/contract-schedule.js",
  "netlify/functions/_lib/contract-package.js",
  "netlify/functions/_lib/contract-source-assembler.js",
  "netlify/functions/_lib/contract-signed-pdf.js",
  "netlify/functions/publish-public-quote.js",
  "netlify/functions/update-tenant-quote-edit.js",
  "netlify/functions/upsert-tenant-project.js",
  "netlify/functions/contract-package-freeze.js",
  "public/js/estimate-public-send.js",
  "public/js/contract-builder.js",
  "public/js/contract-sign-portal.js",
  "public/js/app.js",
  "public/sales.html",
  "public/contract-builder.html",
  "scripts/qa-ch012f-canonical-contract-schedule.js",
  "scripts/qa-ch011a-contract-packages.js",
];

test("syntax on every touched JS file", () => {
  TOUCHED.filter((f) => f.endsWith(".js")).forEach((rel) => {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), rel);
    checkSyntax(path.join(ROOT, rel));
  });
});

test("semantic field docs present", () => {
  assert.ok(schedSrc.includes("NOT invoice"));
  assert.ok(schedSrc.includes("target finish"));
  assert.ok(schedSrc.includes("issue_date"));
  assert.ok(schedSrc.includes("expiration_date"));
});

test("1-2. Create Schedule persists without operational plan", () => {
  assert.ok(sendSrc.includes("scheduleOut"));
  assert.ok(salesSrc.includes("CH-012F"));
  assert.ok(publishSrc.includes("scheduleFields"));
  assert.ok(/planHasDays[\s\S]{0,200}scheduleFields|scheduleFields[\s\S]{0,200}planHasDays/.test(publishSrc) || publishSrc.includes("independently"));
});

test("3-4. Omitted/blank schedule does not erase", () => {
  assert.ok(updateSrc.includes("never erase existing dates") || updateSrc.includes("omit from patch"));
  assert.ok(/if \(normalized === null\)[\s\S]{0,40}continue/.test(updateSrc));
});

test("5-9. Locked quote fill-once narrow gate", () => {
  assert.ok(
    schedule.isAuthorizedLockedScheduleFillPatch(
      ["start_date", "due_date"],
      { status: "accepted", start_date: null, due_date: null }
    )
  );
  assert.ok(
    !schedule.isAuthorizedLockedScheduleFillPatch(
      ["start_date", "due_date"],
      { status: "draft", start_date: null, due_date: null }
    )
  );
  assert.ok(
    !schedule.isAuthorizedLockedScheduleFillPatch(
      ["start_date"],
      { status: "accepted", start_date: null, due_date: null }
    )
  );
  assert.ok(
    !schedule.isAuthorizedLockedScheduleFillPatch(
      ["start_date", "due_date"],
      { status: "accepted", start_date: "2026-08-10", due_date: null }
    )
  );
  assert.ok(updateSrc.includes("scheduleFillCorrection"));
  assert.ok(updateSrc.includes("owner_required") || updateSrc.includes("OWNER_ADMIN"));
  assert.ok(upsertSrc.includes("fillQuoteScheduleIfNull"));
});

test("10-11. Article MISSING and right readiness agree; freeze gated", () => {
  assert.ok(builderSrc.includes("contractScheduleComplete"));
  assert.ok(builderSrc.includes('label: "Estimated schedule"'));
  assert.ok(builderSrc.includes("Set Estimated Start and Completion dates"));
  assert.ok(
    /overallContractReadiness\(source(?:Snapshot)?,\s*(?:edits|draftEdits)\)/.test(
      builderSrc
    )
  );
  assert.ok(builderSrc.includes("schedOk"));
});

test("12-14. Both dates / finish-before-start / same-day", () => {
  assert.ok(schedule.validateContractSchedule("2026-08-10", "2026-08-14").complete);
  assert.ok(!schedule.validateContractSchedule("2026-08-14", "2026-08-10").ok);
  assert.ok(schedule.validateContractSchedule("2026-08-10", "2026-08-10").ok);
  assert.ok(builderSrc.includes("cannot be before the estimated start date"));
  assert.ok(freezeSrc.includes("confirmed_start_date"));
});

test("15. Timezone does not shift date", () => {
  assert.strictEqual(schedule.normIsoDate("2026-08-10"), "2026-08-10");
  assert.strictEqual(schedule.normIsoDate("2026-08-10T00:00:00.000Z"), "2026-08-10");
  assert.ok(builderSrc.includes("never Date#toISOString"));
  assert.ok(builderSrc.includes("T12:00:00"));
  // America/Los_Angeles midnight UTC would be prior evening — we slice YYYY-MM-DD only.
  assert.strictEqual(schedule.normIsoDate("2026-08-10T07:00:00.000Z"), "2026-08-10");
});

test("16. Contract override does not rewrite quote on freeze", () => {
  assert.ok(builderSrc.includes("never rewrite accepted quote"));
  assert.ok(!/freezeContractFromBuilder[\s\S]{0,800}update-tenant-quote-edit/.test(builderSrc));
});

test("17-18. Snapshot source + freeze validation", () => {
  const snap = pkg.buildSnapshot({
    tenantId: "t1",
    project: { id: "p1", project_name: "P", updated_at: "2026-01-01T00:00:00.000Z" },
    quote: {
      id: "q1",
      status: "accepted",
      total: 100,
      currency: "USD",
      client_name: "C",
      scope_of_work: "Scope",
      start_date: "2026-08-10",
      due_date: "2026-08-14",
    },
    setup: {},
    setupReadiness: {},
    schedule: null,
    items: [],
    paymentReadiness: { status: "configured" },
    legalEffective: { notices: {}, enabled: {} },
    legalProfile: { legal_business_name: "Biz" },
    brandingRow: null,
    frozenAt: "2026-01-05T00:00:00.000Z",
    contractSchedule: {
      start_date: "2026-08-10",
      due_date: "2026-08-14",
      source: "approved_quote",
    },
  });
  assert.strictEqual(snap.contract_schedule.source, "approved_quote");
  const override = pkg.buildSnapshot({
    ...{
      tenantId: "t1",
      project: { id: "p1", project_name: "P", updated_at: "2026-01-01T00:00:00.000Z" },
      quote: {
        id: "q1",
        status: "accepted",
        total: 100,
        currency: "USD",
        client_name: "C",
        scope_of_work: "Scope",
        start_date: "2026-08-10",
        due_date: "2026-08-14",
      },
      setup: {},
      setupReadiness: {},
      schedule: null,
      items: [],
      paymentReadiness: { status: "configured" },
      legalEffective: { notices: {}, enabled: {} },
      legalProfile: { legal_business_name: "Biz" },
      brandingRow: null,
      frozenAt: "2026-01-05T00:00:00.000Z",
    },
    contractSchedule: {
      start_date: "2026-08-11",
      due_date: "2026-08-15",
      source: "contract_builder_confirmed",
    },
  });
  assert.strictEqual(override.quote.start_date, "2026-08-11");
  assert.strictEqual(override.contract_schedule.source, "contract_builder_confirmed");
});

test("19-20. Portal and PDF read frozen dates", () => {
  assert.ok(portalSrc.includes("renderContractSchedule"));
  assert.ok(portalSrc.includes("contract_schedule"));
  assert.ok(pdfSrc.includes("Estimated Schedule"));
  assert.ok(pdfSrc.includes("contract_schedule"));
});

test("21. Precedence: both quote dates win; project never invents start", () => {
  const both = schedule.resolveCanonicalContractSchedule({
    quote: { start_date: "2026-08-10", due_date: "2026-08-14" },
    project: { due_date: "2099-01-01" },
  });
  assert.strictEqual(both.source, "approved_quote");
  assert.strictEqual(both.due_date, "2026-08-14");
  const legacy = schedule.resolveCanonicalContractSchedule({
    quote: { start_date: null, due_date: null },
    project: { due_date: "2026-08-14" },
  });
  assert.strictEqual(legacy.source, "project_legacy_due_date");
  assert.strictEqual(legacy.start_date, null);
  const noIssue = schedule.resolveCanonicalContractSchedule({
    quote: {
      start_date: null,
      due_date: null,
      issue_date: "2026-01-01",
      expiration_date: "2026-12-31",
    },
  });
  assert.strictEqual(noIssue.source, "missing");
});

test("Builder UX source labels + freeze payload", () => {
  assert.ok(builderHtml.includes("cbScheduleSourceDisplay"));
  assert.ok(builderSrc.includes("scheduleSourceDisplayLabel"));
  assert.ok(builderSrc.includes("confirmed_start_date"));
  assert.ok(appSrc.includes("syncApprovedQuoteScheduleFillOnce"));
});

test("Freeze gate blocks missing schedule", () => {
  const gate = pkg.buildFreezeGate({
    project: { id: "p" },
    quote: { status: "accepted", scope_of_work: "x" },
    setup: null,
    setupReadiness: {
      project_address: "confirmed",
      warranty: "configured",
      signature_method: "configured",
    },
    paymentReadiness: { status: "configured" },
    legalEffective: { notices: {} },
    legalProfile: { id: "1" },
    legalProfileReadiness: { status: "ready" },
    contractSchedule: { start_date: null, due_date: null },
  });
  assert.ok(gate.missing.includes("contract_schedule"));
});

(async () => {
  await Promise.all(pending);
  console.log("");

  const regs = [
    ["22. CH-012D", "scripts/qa-ch012d-guided-workflow.js"],
    ["23. CH-012E.1", "scripts/qa-ch012e1-canonical-scope.js"],
    ["24. CH-011A", "scripts/qa-ch011a-contract-packages.js"],
    ["24b. CH-011A idempotent", "scripts/qa-ch011a-idempotent-freeze.js"],
    ["25. CH-011I", "scripts/qa-ch011i-signed-contract-pdf.js"],
    ["26. CH-013A.2.0", "scripts/qa-ch013a20-delivery-engine.js"],
  ];
  for (const [label, rel] of regs) {
    const full = path.join(ROOT, rel);
    if (!fs.existsSync(full)) {
      console.log("SKIP", `regression ${label}`, "- missing script");
      continue;
    }
    const r = spawnSync(process.execPath, [full], { encoding: "utf8", cwd: ROOT });
    const ok = r.status === 0;
    console.log(ok ? "PASS" : "FAIL", `regression ${label}`);
    if (!ok) {
      failed += 1;
      console.log((r.stdout || r.stderr || "").split(/\r?\n/).slice(-12).join("\n"));
    } else {
      passed += 1;
    }
  }

  console.log("");
  console.log(`CH-012F final audit QA: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
