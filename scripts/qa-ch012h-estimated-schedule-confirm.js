/**
 * CH-012H — server-persisted Estimated Schedule confirmation.
 * Real unit + static proof. Does not POST live. Does not apply SQL.
 * Run: node scripts/qa-ch012h-estimated-schedule-confirm.js
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

const schedule = require("../netlify/functions/_lib/contract-schedule");
const setupMod = require("../netlify/functions/project-contract-setup");
const quoteEdit = require("../netlify/functions/update-tenant-quote-edit");
const pkg = require("../netlify/functions/_lib/contract-package");
const ScheduleConfirm = require("../public/js/contract-schedule-confirm.js");

const sql = read("SUPABASE_CH012H_ESTIMATED_SCHEDULE_CONFIRM.sql");
const rollback = read("SUPABASE_CH012H_ESTIMATED_SCHEDULE_CONFIRM_ROLLBACK.sql");
const verify = read("SUPABASE_CH012H_ESTIMATED_SCHEDULE_CONFIRM_VERIFY.sql");
const setupSrc = read("netlify/functions/project-contract-setup.js");
const quoteEditSrc = read("netlify/functions/update-tenant-quote-edit.js");
const freezeLibSrc = read("netlify/functions/_lib/contract-package.js");
const freezeSrc = read("netlify/functions/contract-package-freeze.js");
const builderSrc = read("public/js/contract-builder.js");
const helperSrc = read("public/js/contract-schedule-confirm.js");
const portalSrc = read("public/js/contract-sign-portal.js");
const pdfSrc = read("netlify/functions/_lib/contract-signed-pdf.js");

const TOUCHED_JS = [
  "netlify/functions/project-contract-setup.js",
  "netlify/functions/_lib/contract-schedule.js",
  "netlify/functions/_lib/contract-package.js",
  "public/js/contract-schedule-confirm.js",
  "public/js/contract-builder.js",
  "scripts/qa-ch012h-estimated-schedule-confirm.js",
  "scripts/qa-ch007d-article8-estimated-schedule.js",
];

test("Invoice Hub quote-edit remains origin/main (no hub file touch)", () => {
  const r = spawnSync(
    "git",
    ["diff", "--exit-code", "origin/main", "--", "netlify/functions/update-tenant-quote-edit.js"],
    { cwd: ROOT, encoding: "utf8" }
  );
  assert.strictEqual(r.status, 0, r.stdout || r.stderr || "quote-edit diverged from origin/main");
});

test("syntax on CH-012H JS", () => {
  TOUCHED_JS.forEach((rel) => {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), rel);
    if (rel.endsWith(".js")) checkSyntax(path.join(ROOT, rel));
  });
});

test("SQL forward, rollback, and VERIFY are prepared and read-only VERIFY", () => {
  assert.ok(sql.includes("DO NOT APPLY"));
  assert.ok(sql.includes("schedule_confirmed_at timestamptz"));
  assert.ok(sql.includes("schedule_confirmed_start_date date"));
  assert.ok(sql.includes("schedule_confirmed_due_date date"));
  assert.ok(sql.includes("schedule_confirmed_by uuid"));
  assert.ok(sql.includes("references public.profiles"));
  assert.ok(sql.includes("confirm_project_estimated_schedule"));
  assert.ok(sql.includes("trg_quotes_invalidate_estimated_schedule"));
  assert.ok(sql.includes("invalidate_estimated_schedule_on_quote_date_change"));
  assert.ok(!/create or replace function public\.apply_quote_schedule_date_change/i.test(sql));
  assert.ok(!rollback.includes("apply_quote_schedule_date_change"));
  assert.ok(sql.includes("tenant_id + project_id + quote_id") || sql.includes("tenant_id, project_id, quote_id"));
  assert.ok(rollback.includes("drop column if exists schedule_confirmed_at"));
  assert.ok(rollback.includes("drop function if exists public.confirm_project_estimated_schedule"));
  assert.ok(rollback.includes("drop function if exists public.invalidate_estimated_schedule_on_quote_date_change"));
  assert.ok(verify.includes("READ ONLY") || verify.includes("SELECT only"));
  assert.ok(!/insert into|update public|delete from/i.test(verify));
  assert.ok(sql.includes("to service_role"));
  assert.ok(sql.includes("from anon"));
  assert.ok(sql.includes("from authenticated"));
  assert.ok(sql.includes("p.id = p_confirmed_by"));
  assert.ok(sql.includes("p.tenant_id = p_tenant_id"));
  assert.ok(sql.includes("p.status = 'active'"));
  assert.ok(sql.includes("p.role in ('owner', 'admin')"));
  assert.ok(verify.includes("confirm_execute_service_role_only"));
  assert.ok(verify.includes("trigger_fn_no_client_execute"));
  assert.ok(verify.includes("security_definer_search_path_ok"));
  assert.ok(verify.includes("confirm_validates_owner_admin"));
  assert.ok(verify.includes("quote_date_trigger_ok"));
  assert.ok(verify.includes("unused_rpc_absent"));
  assert.ok(verify.includes("proname = 'apply_quote_schedule_date_change'"));
});

test("1. confirmation persists across reload because GET reads schedule_confirmed_at", () => {
  const setup = {
    tenant_id: "t1",
    project_id: "p1",
    quote_id: "q1",
    schedule_confirmed_at: "2026-09-20T18:00:00.000Z",
    schedule_confirmed_start_date: "2026-09-01",
    schedule_confirmed_due_date: "2026-09-30",
    schedule_confirmed_by: "u1",
  };
  const first = schedule.evaluatePersistedScheduleConfirmation({
    setup,
    quote: { start_date: "2026-09-01", due_date: "2026-09-30" },
    tenantId: "t1",
    projectId: "p1",
    quoteId: "q1",
  });
  const refresh = schedule.evaluatePersistedScheduleConfirmation({
    setup: { ...setup },
    quote: { start_date: "2026-09-01", due_date: "2026-09-30" },
    tenantId: "t1",
    projectId: "p1",
    quoteId: "q1",
  });
  assert.strictEqual(first.confirmed, true);
  assert.strictEqual(refresh.confirmed, true);
  assert.strictEqual(refresh.readiness_caption, "COMPLETE — ESTIMATED SCHEDULE");
  assert.ok(setupSrc.includes("schedule_confirmed_at"));
  assert.ok(builderSrc.includes("schedule_confirmed_at"));
});

test("2. another session/browser COMPLETE comes from server setup, not localStorage", () => {
  const source = {
    projectId: "p1",
    quoteId: "q1",
    startDate: "2026-09-01",
    dueDate: "2026-09-30",
    scheduleConfirmedAt: "2026-09-20T18:00:00.000Z",
    scheduleConfirmedStart: "2026-09-01",
    scheduleConfirmedDue: "2026-09-30",
    contractSetup: {
      setup: {
        project_id: "p1",
        quote_id: "q1",
        schedule_confirmed_at: "2026-09-20T18:00:00.000Z",
        schedule_confirmed_start_date: "2026-09-01",
        schedule_confirmed_due_date: "2026-09-30",
        schedule_confirmed_by: "u1",
      },
    },
  };
  assert.strictEqual(ScheduleConfirm.scheduleConfirmed(source, {}), true);
  assert.ok(!helperSrc.includes("readStoredConfirmation(ids.projectId"));
  assert.ok(helperSrc.includes("serverConfirmationFromSource"));
});

test("3. localStorage manipulation cannot COMPLETE or Freeze", () => {
  const store = {
    getItem() {
      return JSON.stringify({ startDate: "2026-09-01", dueDate: "2026-09-30" });
    },
    setItem() {},
    removeItem() {},
  };
  const source = {
    projectId: "p1",
    quoteId: "q1",
    startDate: "2026-09-01",
    dueDate: "2026-09-30",
  };
  assert.strictEqual(ScheduleConfirm.scheduleConfirmed(source, {}, store), false);
  const persisted = schedule.evaluatePersistedScheduleConfirmation({
    setup: null,
    quote: { start_date: "2026-09-01", due_date: "2026-09-30" },
    tenantId: "t1",
    projectId: "p1",
    quoteId: "q1",
  });
  assert.strictEqual(persisted.confirmed, false);
  assert.strictEqual(persisted.freeze_ready, false);
  assert.ok(freezeLibSrc.includes("browser confirmed_start_date/confirmed_due_date are ignored"));
  assert.ok(builderSrc.includes("Do not send browser flags or dates as freeze authority"));
});

test("4+5. changing start or due invalidates confirmation", () => {
  const startChange = schedule.scheduleDatesChanged(
    { start_date: "2026-09-01", due_date: "2026-09-30" },
    { start_date: "2026-09-02" }
  );
  const dueChange = schedule.scheduleDatesChanged(
    { start_date: "2026-09-01", due_date: "2026-09-30" },
    { due_date: "2026-10-01" }
  );
  assert.strictEqual(startChange.changed, true);
  assert.strictEqual(dueChange.changed, true);
  assert.ok(sql.includes("trg_quotes_invalidate_estimated_schedule"));
  assert.ok(sql.includes("NEW.start_date is distinct from OLD.start_date"));
  assert.ok(sql.includes("NEW.due_date is distinct from OLD.due_date"));
  assert.ok(sql.includes("schedule_confirmed_at = null"));
  assert.ok(!quoteEditSrc.includes("applyQuoteScheduleDateChange"));
  assert.ok(quoteEditSrc.includes("start_date"));
  const staleStart = schedule.evaluatePersistedScheduleConfirmation({
    setup: {
      tenant_id: "t1",
      project_id: "p1",
      quote_id: "q1",
      schedule_confirmed_at: "2026-09-20T18:00:00.000Z",
      schedule_confirmed_start_date: "2026-09-01",
      schedule_confirmed_due_date: "2026-09-30",
      schedule_confirmed_by: "u1",
    },
    quote: { start_date: "2026-09-02", due_date: "2026-09-30" },
    tenantId: "t1",
    projectId: "p1",
    quoteId: "q1",
  });
  const staleDue = schedule.evaluatePersistedScheduleConfirmation({
    setup: {
      tenant_id: "t1",
      project_id: "p1",
      quote_id: "q1",
      schedule_confirmed_at: "2026-09-20T18:00:00.000Z",
      schedule_confirmed_start_date: "2026-09-01",
      schedule_confirmed_due_date: "2026-09-30",
      schedule_confirmed_by: "u1",
    },
    quote: { start_date: "2026-09-01", due_date: "2026-10-01" },
    tenantId: "t1",
    projectId: "p1",
    quoteId: "q1",
  });
  assert.strictEqual(staleStart.confirmed, false);
  assert.strictEqual(staleStart.stale, true);
  assert.strictEqual(staleDue.confirmed, false);
  assert.strictEqual(staleDue.stale, true);
  assert.strictEqual(staleStart.readiness_caption, "NEEDS CONFIRMATION — ESTIMATED SCHEDULE");
});

test("6. date change and invalidation are atomic or fail-closed", () => {
  assert.ok(sql.includes("CH-012H-TRIGGER-BEGIN"));
  assert.ok(sql.includes("after update of start_date, due_date on public.quotes"));
  assert.ok(sql.includes("s.tenant_id = NEW.tenant_id"));
  assert.ok(sql.includes("s.quote_id = NEW.id"));
  assert.ok(rollback.includes("drop trigger if exists trg_quotes_invalidate_estimated_schedule"));
});

test("7. other tenant cannot read, confirm, or invalidate", () => {
  const otherTenant = schedule.evaluatePersistedScheduleConfirmation({
    setup: {
      tenant_id: "t-other",
      project_id: "p1",
      quote_id: "q1",
      schedule_confirmed_at: "2026-09-20T18:00:00.000Z",
      schedule_confirmed_start_date: "2026-09-01",
      schedule_confirmed_due_date: "2026-09-30",
      schedule_confirmed_by: "u1",
    },
    quote: { start_date: "2026-09-01", due_date: "2026-09-30" },
    tenantId: "t1",
    projectId: "p1",
    quoteId: "q1",
  });
  assert.strictEqual(otherTenant.confirmed, false);
  assert.strictEqual(otherTenant.wrong_scope, true);
  assert.ok(setupSrc.includes("tenant_id must not be sent by client"));
  assert.ok(setupSrc.includes("p_tenant_id: tenantId"));
  assert.ok(!quoteEditSrc.includes("p_tenant_id: tenantId"));
  assert.ok(sql.includes("and q.tenant_id = p_tenant_id"));
  assert.ok(sql.includes("and tp.tenant_id = p_tenant_id"));
});

test("8. other quote/project cannot contaminate state", () => {
  const otherQuote = schedule.evaluatePersistedScheduleConfirmation({
    setup: {
      tenant_id: "t1",
      project_id: "p1",
      quote_id: "q-other",
      schedule_confirmed_at: "2026-09-20T18:00:00.000Z",
      schedule_confirmed_start_date: "2026-09-01",
      schedule_confirmed_due_date: "2026-09-30",
      schedule_confirmed_by: "u1",
    },
    quote: { start_date: "2026-09-01", due_date: "2026-09-30" },
    tenantId: "t1",
    projectId: "p1",
    quoteId: "q1",
  });
  const otherProject = schedule.evaluatePersistedScheduleConfirmation({
    setup: {
      tenant_id: "t1",
      project_id: "p-other",
      quote_id: "q1",
      schedule_confirmed_at: "2026-09-20T18:00:00.000Z",
      schedule_confirmed_start_date: "2026-09-01",
      schedule_confirmed_due_date: "2026-09-30",
      schedule_confirmed_by: "u1",
    },
    quote: { start_date: "2026-09-01", due_date: "2026-09-30" },
    tenantId: "t1",
    projectId: "p1",
    quoteId: "q1",
  });
  assert.strictEqual(otherQuote.confirmed, false);
  assert.strictEqual(otherProject.confirmed, false);
  assert.ok(sql.includes("and s.project_id = p_project_id"));
  assert.ok(sql.includes("and s.quote_id = p_quote_id"));
  assert.ok(sql.includes("s.project_id in ("));
  assert.ok(sql.includes("tp.tenant_id = NEW.tenant_id"));
  assert.ok(sql.includes("tp.quote_id = NEW.id"));
  assert.ok(setupSrc.includes("project_quote_mismatch"));
});

test("9. double-click confirm is idempotent", async () => {
  const payload = ScheduleConfirm.buildScheduleConfirmPayload("p1", "q1");
  assert.deepStrictEqual(payload, {
    project_id: "p1",
    quote_id: "q1",
    confirm_estimated_schedule: true,
  });
  assert.ok(sql.includes("idempotent"));
  assert.ok(sql.includes("v_setup.schedule_confirmed_start_date is not distinct from v_start"));
  let posts = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const runner = ScheduleConfirm.createScheduleConfirmRunner({
    getBusy: () => false,
    isConfirmed: () => false,
    getDates: () => ({ startDate: "2026-09-01", dueDate: "2026-09-30" }),
    getIds: () => ({ projectId: "p1", quoteId: "q1" }),
    postJson: async () => {
      posts += 1;
      await gate;
      return {
        ok: true,
        data: {
          ok: true,
          setup: {
            project_id: "p1",
            quote_id: "q1",
            schedule_confirmed_at: "2026-09-20T12:00:00.000Z",
            schedule_confirmed_start_date: "2026-09-01",
            schedule_confirmed_due_date: "2026-09-30",
            schedule_confirmed_by: "u1",
          },
        },
      };
    },
  });
  const first = runner.confirm();
  const second = await runner.confirm();
  assert.strictEqual(second.reason, "busy");
  release();
  const firstResult = await first;
  assert.strictEqual(firstResult.ok, true);
  assert.strictEqual(posts, 1);
});

test("10. invalid dates are rejected and not confirmed", async () => {
  const confirmable = schedule.validateConfirmableQuoteDates(null, "2026-09-30");
  assert.strictEqual(confirmable.ok, false);
  assert.strictEqual(confirmable.errors[0].code, "schedule_start_missing");
  const missingDue = schedule.validateConfirmableQuoteDates("2026-09-01", null);
  assert.strictEqual(missingDue.ok, false);
  assert.ok(missingDue.errors.some((err) => err.code === "schedule_completion_missing"));
  const order = schedule.validateConfirmableQuoteDates("2026-09-30", "2026-09-01");
  assert.strictEqual(order.ok, false);
  const runner = ScheduleConfirm.createScheduleConfirmRunner({
    getBusy: () => false,
    getDates: () => ({ startDate: "2026-09-30", dueDate: "2026-09-01" }),
    getIds: () => ({ projectId: "p1", quoteId: "q1" }),
    postJson: async () => {
      throw new Error("should not post");
    },
  });
  const result = await runner.confirm();
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.posted, false);
  assert.ok(sql.includes("MG_ERR:schedule_start_missing"));
  assert.ok(sql.includes("MG_ERR:schedule_completion_missing"));
  assert.ok(sql.includes("MG_ERR:schedule_completion_before_start"));
});

test("11. frozen packages stay immutable and UI hides Edit", () => {
  const frozen = ScheduleConfirm.scheduleFooterPlan({
    startDate: "2026-09-01",
    dueDate: "2026-09-30",
    confirmed: true,
    frozen: true,
  });
  assert.ok(!frozen.buttons.some((btn) => btn.id === "edit"));
  assert.ok(freezeLibSrc.includes("identical content_hash"));
  assert.ok(builderSrc.includes("never rewrite accepted quote"));
});

test("12. Portal, Print, and PDF use frozen snapshot dates", () => {
  assert.ok(portalSrc.includes("contract_schedule"));
  assert.ok(portalSrc.includes("Estimated Start Date"));
  assert.ok(portalSrc.includes("Target Completion"));
  assert.ok(pdfSrc.includes("Estimated Start Date"));
  assert.ok(pdfSrc.includes("Target Completion"));
  assert.ok(pdfSrc.includes("contract_schedule"));
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
  assert.strictEqual(snap.quote.start_date, "2026-08-10");
  assert.strictEqual(snap.contract_schedule.estimated_completion_date, "2026-08-14");
});

test("confirm copies quote dates and rejects browser date authority", () => {
  const payload = ScheduleConfirm.buildScheduleConfirmPayload("p1", "q1");
  assert.ok(!Object.prototype.hasOwnProperty.call(payload, "start_date"));
  assert.ok(!Object.prototype.hasOwnProperty.call(payload, "due_date"));
  assert.ok(setupSrc.includes("Unknown fields rejected"));
  assert.ok(sql.includes("v_start := v_quote.start_date"));
  assert.ok(sql.includes("v_due := v_quote.due_date"));
  assert.ok(setupMod._test.evaluateReadiness);
  const ready = setupMod._test.evaluateReadiness(
    {
      project_id: "p1",
      quote_id: "q1",
      tenant_id: "t1",
      schedule_confirmed_at: "2026-09-20T18:00:00.000Z",
      schedule_confirmed_start_date: "2026-09-01",
      schedule_confirmed_due_date: "2026-09-30",
      schedule_confirmed_by: "u1",
    },
    { start_date: "2026-09-01", due_date: "2026-09-30" },
    { tenantId: "t1", projectId: "p1", quoteId: "q1" }
  );
  assert.strictEqual(ready.estimated_schedule, "confirmed");
  assert.strictEqual(
    ready.estimated_schedule_caption,
    "COMPLETE — ESTIMATED SCHEDULE"
  );
});

test("direct POST with start and due null does not confirm", () => {
  const missingBoth = schedule.validateConfirmableQuoteDates(null, null);
  assert.strictEqual(missingBoth.ok, false);
  assert.ok(missingBoth.errors.some((err) => err.code === "schedule_start_missing"));
  assert.ok(missingBoth.errors.some((err) => err.code === "schedule_completion_missing"));
  const mappedDue = setupMod._test.mapScheduleConfirmFailure({
    message: "MG_ERR:schedule_completion_missing:Estimated completion date is required.",
  });
  assert.strictEqual(mappedDue.statusCode, 400);
  assert.strictEqual(mappedDue.body.ok, false);
  assert.strictEqual(mappedDue.body.code, "schedule_completion_missing");
  assert.strictEqual(mappedDue.body.error, "Estimated completion date is required.");
  assert.ok(sql.includes("if v_due is null"));
  assert.ok(sql.includes("MG_ERR:schedule_completion_missing:Estimated completion date is required."));
  assert.ok(setupSrc.includes("schedule_completion_missing"));
});

test("COMPLETE never appears with due null", () => {
  const persisted = schedule.evaluatePersistedScheduleConfirmation({
    setup: {
      tenant_id: "t1",
      project_id: "p1",
      quote_id: "q1",
      schedule_confirmed_at: "2026-09-20T18:00:00.000Z",
      schedule_confirmed_start_date: "2026-09-01",
      schedule_confirmed_due_date: null,
        schedule_confirmed_by: "u1",
    },
    quote: { start_date: "2026-09-01", due_date: null },
    tenantId: "t1",
    projectId: "p1",
    quoteId: "q1",
  });
  assert.strictEqual(persisted.confirmed, false);
  assert.strictEqual(persisted.freeze_ready, false);
  assert.strictEqual(persisted.readiness_caption, "NEEDS CONFIRMATION — ESTIMATED SCHEDULE");
  const ready = setupMod._test.evaluateReadiness(
    {
      project_id: "p1",
      quote_id: "q1",
      tenant_id: "t1",
      schedule_confirmed_at: "2026-09-20T18:00:00.000Z",
      schedule_confirmed_start_date: "2026-09-01",
      schedule_confirmed_due_date: null,
        schedule_confirmed_by: "u1",
    },
    { start_date: "2026-09-01", due_date: null },
    { tenantId: "t1", projectId: "p1", quoteId: "q1" }
  );
  assert.strictEqual(ready.estimated_schedule, "needs_confirmation");
  assert.notStrictEqual(ready.estimated_schedule_caption, "COMPLETE — ESTIMATED SCHEDULE");
});

test("VERIFY requires FK RESTRICT and all-or-none consistency CHECK", () => {
  assert.ok(sql.includes("on delete restrict"));
  assert.ok(!sql.includes("on delete set null"));
  assert.ok(sql.includes("schedule_confirmed_due_date is not null"));
  assert.ok(verify.includes("fk_restrict_ok"));
  assert.ok(verify.includes("ON DELETE RESTRICT"));
  assert.ok(verify.includes("consistency_all_or_none_ok"));
  assert.ok(verify.includes("schedule_confirmed_due_date is not null"));
});

test("Article 8 state B remains Set Project Dates", () => {
  const p = ScheduleConfirm.scheduleFooterPlan({
    startDate: "2026-09-01",
    dueDate: "",
  });
  assert.strictEqual(p.kind, "missing_completion");
  assert.strictEqual(p.primaryLabel, "Set Project Dates");
  assert.strictEqual(p.continueVisible, false);
  assert.ok(!p.buttons.some((btn) => btn.label === "Confirm Schedule"));
});

(async () => {
  await Promise.all(pending);

  const regs = [
    ["13. Article 7 Payment Terms", "scripts/qa-ch007d-article7-payment-summary.js"],
    ["Article 8 UI A-E", "scripts/qa-ch007d-article8-estimated-schedule.js"],
    ["14. Owner Shield V2", "scripts/test-owner-shield-v2.js"],
    ["14. Core Security Shield V2", "scripts/test-core-security-shield-v2.js"],
    ["14. Seller Shield V2", "scripts/test-seller-shield-v2.js"],
    ["14. Invoice Hub Shield V2", "scripts/test-invoice-hub-shield-v2.js"],
    ["14. Invoice Hub scope guard", "scripts/guard-invoice-hub-scope.js"],
  ];
  for (const [label, rel] of regs) {
    const full = path.join(ROOT, rel);
    const r = spawnSync(process.execPath, [full], { encoding: "utf8", cwd: ROOT });
    const ok = r.status === 0;
    console.log(ok ? "PASS" : "FAIL", label);
    if (!ok) {
      failed += 1;
      console.log((r.stdout || r.stderr || "").split(/\r?\n/).slice(-20).join("\n"));
    } else {
      passed += 1;
      const summary = String(r.stdout || "")
        .split(/\r?\n/)
        .filter((line) => /passed/.test(line))
        .pop();
      if (summary) console.log("     ", summary);
    }
  }

  console.log("");
  console.log(`CH-012H Estimated Schedule confirm QA: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
