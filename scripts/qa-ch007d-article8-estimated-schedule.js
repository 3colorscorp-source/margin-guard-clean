/**
 * CH-007D — Article 8 Estimated Schedule presentation + confirm behavior.
 * Executes real confirm logic via contract-schedule-confirm.js. Does not POST live.
 * Run: node scripts/qa-ch007d-article8-estimated-schedule.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const htmlPath = path.join(ROOT, "public/contract-builder.html");
const jsPath = path.join(ROOT, "public/js/contract-builder.js");
const helperPath = path.join(ROOT, "public/js/contract-schedule-confirm.js");
const paymentHelperPath = path.join(ROOT, "public/js/contract-payment-confirm.js");
const portalPath = path.join(ROOT, "public/js/contract-sign-portal.js");
const pdfPath = path.join(ROOT, "netlify/functions/_lib/contract-signed-pdf.js");
const freezePath = path.join(ROOT, "netlify/functions/contract-package-freeze.js");

const html = fs.readFileSync(htmlPath, "utf8");
const js = fs.readFileSync(jsPath, "utf8");
const helperSrc = fs.readFileSync(helperPath, "utf8");
const paymentHelperSrc = fs.readFileSync(paymentHelperPath, "utf8");
const portalSrc = fs.readFileSync(portalPath, "utf8");
const pdfSrc = fs.readFileSync(pdfPath, "utf8");
const freezeSrc = fs.readFileSync(freezePath, "utf8");
const ScheduleConfirm = require("../public/js/contract-schedule-confirm.js");

let passed = 0;
let failed = 0;
const pending = [];
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

function testAsync(name, fn) {
  pending.push({ name, fn });
}

function slice(src, startToken, endToken) {
  const start = src.indexOf(startToken);
  const end = src.indexOf(endToken, start + startToken.length);
  assert.ok(start >= 0 && end > start, `missing slice ${startToken}`);
  return src.slice(start, end);
}

const art8 = slice(html, 'id="art-schedule"', 'id="art-changes"');
const art7 = slice(html, 'id="art-payment"', 'id="art-schedule"');

function memoryStore(seed) {
  const map = new Map(Object.entries(seed || {}));
  return {
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
    removeItem(key) {
      map.delete(key);
    },
    map,
  };
}

function view(input) {
  return ScheduleConfirm.presentScheduleArticle(input);
}

function plan(input) {
  return ScheduleConfirm.scheduleFooterPlan(input);
}

test("0 syntax helper + builder", () => {
  [helperPath, jsPath].forEach((file) => {
    const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    assert.strictEqual(r.status, 0, r.stderr || r.stdout || file);
  });
});

test("1 both dates empty: Not scheduled, hide completion, Set Project Dates only", () => {
  const v = view({ startDate: "", dueDate: "" });
  const p = plan({ startDate: "", dueDate: "" });
  assert.strictEqual(v.kind, "missing_start");
  assert.strictEqual(v.startValue, "Not scheduled");
  assert.strictEqual(v.showCompletion, false);
  assert.strictEqual(v.message, "Add the project start date to continue.");
  assert.strictEqual(p.primaryLabel, "Set Project Dates");
  assert.strictEqual(p.primaryEnabledCount, 1);
  assert.strictEqual(p.continueVisible, false);
  assert.ok(!p.buttons.some((b) => b.label === "Confirm Schedule"));
  assert.ok(!p.buttons.some((b) => b.id === "continue"));
});

test("2 start absent, completion present: show completion, Set Project Dates", () => {
  const v = view({ startDate: "", dueDate: "2026-09-30" });
  const p = plan({ startDate: "", dueDate: "2026-09-30" });
  assert.strictEqual(v.kind, "missing_start");
  assert.strictEqual(v.startValue, "Not scheduled");
  assert.strictEqual(v.showCompletion, true);
  assert.ok(v.completionValue.includes("2026") || v.completionValue.includes("Sep"));
  assert.strictEqual(p.primaryLabel, "Set Project Dates");
  assert.strictEqual(p.continueVisible, false);
});

test("3 start present, completion absent: Target Completion Not scheduled", () => {
  const v = view({ startDate: "2026-09-01", dueDate: "" });
  const p = plan({ startDate: "2026-09-01", dueDate: "" });
  assert.strictEqual(v.kind, "missing_completion");
  assert.strictEqual(v.showCompletion, true);
  assert.strictEqual(v.completionValue, "Not scheduled");
  assert.strictEqual(v.message, "Add the target completion date to continue.");
  assert.strictEqual(p.primaryLabel, "Set Project Dates");
  assert.strictEqual(p.continueVisible, false);
});

test("4 both valid unconfirmed: Confirm Schedule primary, Continue hidden", () => {
  const v = view({ startDate: "2026-09-01", dueDate: "2026-09-30", confirmed: false });
  const p = plan({ startDate: "2026-09-01", dueDate: "2026-09-30", confirmed: false });
  assert.strictEqual(v.kind, "unconfirmed");
  assert.ok(v.notice.includes("Project dates may change due to site conditions"));
  assert.strictEqual(v.readinessCaption, "NEEDS CONFIRMATION — ESTIMATED SCHEDULE");
  assert.strictEqual(p.primaryLabel, "Confirm Schedule");
  assert.strictEqual(p.primaryEnabledCount, 1);
  assert.strictEqual(p.continueVisible, false);
  assert.ok(p.buttons.some((b) => b.label === "Edit Project Dates" && b.style === "ghost"));
  assert.ok(!p.buttons.some((b) => b.label === "Set Project Dates"));
});

test("5 both confirmed: Continue primary, Edit secondary unless frozen", () => {
  const v = view({ startDate: "2026-09-01", dueDate: "2026-09-30", confirmed: true });
  const p = plan({ startDate: "2026-09-01", dueDate: "2026-09-30", confirmed: true });
  assert.strictEqual(v.kind, "confirmed");
  assert.strictEqual(v.readinessCaption, "COMPLETE — ESTIMATED SCHEDULE");
  assert.strictEqual(p.primaryLabel, "Continue");
  assert.strictEqual(p.continueVisible, true);
  assert.ok(p.buttons.some((b) => b.label === "Edit Project Dates" && b.style === "ghost"));
  const frozen = plan({
    startDate: "2026-09-01",
    dueDate: "2026-09-30",
    confirmed: true,
    frozen: true,
  });
  assert.ok(!frozen.buttons.some((b) => b.id === "edit"));
  assert.strictEqual(frozen.primaryLabel, "Continue");
});

test("6 completion before start: block confirm, no persist, open edit", () => {
  const v = view({ startDate: "2026-09-30", dueDate: "2026-09-01" });
  assert.strictEqual(v.kind, "invalid");
  assert.strictEqual(v.message, "Completion date must be on or after the start date.");
  assert.strictEqual(v.persistBlocked, true);
  assert.strictEqual(v.confirmBlocked, true);
  assert.strictEqual(v.readinessCaption, "NEEDS CONFIRMATION — ESTIMATED SCHEDULE");
});

testAsync("6b invalid confirm does not persist or change readiness", async () => {
  let posted = false;
  const runner = ScheduleConfirm.createScheduleConfirmRunner({
    getBusy: () => false,
    getDates: () => ({ startDate: "2026-09-30", dueDate: "2026-09-01" }),
    getIds: () => ({ projectId: "p1", quoteId: "q1" }),
    postJson: async () => {
      posted = true;
      return { ok: true, data: { ok: true } };
    },
  });
  const result = await runner.confirm();
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, "invalid");
  assert.strictEqual(result.posted, false);
  assert.strictEqual(result.openEdit, true);
  assert.strictEqual(result.readinessUnchanged, true);
  assert.strictEqual(posted, false);
});

testAsync("7 HTTP failure does not confirm", async () => {
  let applied = false;
  const runner = ScheduleConfirm.createScheduleConfirmRunner({
    getBusy: () => false,
    isConfirmed: () => false,
    getDates: () => ({ startDate: "2026-09-01", dueDate: "2026-09-30" }),
    getIds: () => ({ projectId: "p1", quoteId: "q1" }),
    getQuote: () => ({ status: "draft", start_date: null, due_date: null }),
    postJson: async () => ({ ok: false, status: 500, data: { ok: false, error: "boom" } }),
    applySuccess: () => {
      applied = true;
    },
  });
  const result = await runner.confirm();
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, "http");
  assert.strictEqual(result.posted, true);
  assert.strictEqual(applied, false);
});

testAsync("8 double click: second call is busy, one POST", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const posts = [];
  const runner = ScheduleConfirm.createScheduleConfirmRunner({
    getBusy: () => false,
    isConfirmed: () => false,
    getDates: () => ({ startDate: "2026-09-01", dueDate: "2026-09-30" }),
    getIds: () => ({ projectId: "p1", quoteId: "q1" }),
    getQuote: () => ({ status: "draft" }),
    postJson: async (_url, body) => {
      posts.push(body);
      await gate;
      return {
        ok: true,
        status: 200,
        data: {
          ok: true,
          setup: {
            project_id: "p1",
            quote_id: "q1",
            schedule_confirmed_at: "2026-09-20T12:00:00.000Z",
            schedule_confirmed_start_date: "2026-09-01",
            schedule_confirmed_due_date: "2026-09-30",
          },
        },
      };
    },
  });
  const first = runner.confirm();
  const second = await runner.confirm();
  assert.strictEqual(second.reason, "busy");
  assert.strictEqual(second.posted, false);
  release();
  const firstResult = await first;
  assert.strictEqual(firstResult.ok, true);
  assert.strictEqual(posts.length, 1);
});

testAsync("9 project change during await is ignored", async () => {
  let applied = false;
  let quoteId = "q-a";
  const runner = ScheduleConfirm.createScheduleConfirmRunner({
    getBusy: () => false,
    isConfirmed: () => false,
    getDates: () => ({ startDate: "2026-09-01", dueDate: "2026-09-30" }),
    getIds: () => ({ projectId: "p1", quoteId }),
    getQuote: () => ({ status: "draft" }),
    postJson: async () => {
      quoteId = "q-b";
      return { ok: true, status: 200, data: { ok: true, quote: {} } };
    },
    applySuccess: () => {
      applied = true;
    },
  });
  const result = await runner.confirm();
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, "stale_project");
  assert.strictEqual(applied, false);
});

test("localStorage is visual cache only and cannot mark COMPLETE", () => {
  const store = memoryStore();
  const source = {
    projectId: "p-a",
    quoteId: "q-a",
    startDate: "2026-09-01",
    dueDate: "2026-09-30",
  };
  ScheduleConfirm.writeStoredConfirmation("p-a", "q-a", "2026-09-01", "2026-09-30", store);
  assert.strictEqual(
    ScheduleConfirm.scheduleConfirmed(source, {}, store),
    false
  );
  const serverSource = {
    ...source,
    scheduleConfirmedAt: "2026-09-20T12:00:00.000Z",
    scheduleConfirmedStart: "2026-09-01",
    scheduleConfirmedDue: "2026-09-30",
    contractSetup: {
      setup: {
        project_id: "p-a",
        quote_id: "q-a",
        schedule_confirmed_at: "2026-09-20T12:00:00.000Z",
        schedule_confirmed_start_date: "2026-09-01",
        schedule_confirmed_due_date: "2026-09-30",
      },
    },
  };
  assert.strictEqual(ScheduleConfirm.scheduleConfirmed(serverSource, {}), true);
  assert.strictEqual(
    ScheduleConfirm.scheduleConfirmed(
      serverSource,
      { startDate: "2026-09-02", dueDate: "2026-09-30" }
    ),
    false
  );
});

test("11 mobile CSS avoids schedule overflow", () => {
  assert.ok(html.includes("overflow-wrap: anywhere"));
  assert.ok(html.includes("#art-schedule .cb-meta-grid { grid-template-columns: 1fr; }"));
});

test("12 preview, print, freeze, portal, and PDF keep dates and notice only", () => {
  assert.ok(art8.includes("Estimated Start Date"));
  assert.ok(art8.includes("Target Completion"));
  assert.ok(art8.includes("Project dates may change due to site conditions"));
  assert.ok(html.includes("@media print"));
  assert.ok(js.includes("Do not send browser flags or dates as freeze authority"));
  assert.ok(js.includes("scheduleConfigured()"));
  assert.ok(!/body\.confirmed_start_date\s*=/.test(js));
  assert.ok(portalSrc.includes("Estimated Start Date"));
  assert.ok(portalSrc.includes("Target Completion"));
  assert.ok(portalSrc.includes("Project dates may change due to site conditions"));
  assert.ok(pdfSrc.includes("Estimated Start Date"));
  assert.ok(pdfSrc.includes("Target Completion"));
  assert.ok(pdfSrc.includes("Project dates may change due to site conditions"));
  assert.ok(!pdfSrc.includes("Schedule source"));
  assert.ok(!portalSrc.includes("Schedule source"));
});

test("13 Article 7 Payment Terms is unchanged", () => {
  assert.ok(art7.includes("Payment Terms"));
  assert.ok(paymentHelperSrc.includes("Confirm Payment Terms"));
  assert.ok(!paymentHelperSrc.includes("Set Project Dates"));
  assert.ok(!paymentHelperSrc.includes("Confirm Schedule"));
  assert.ok(html.includes("contract-payment-confirm.js?v=pt-src-4"));
});

test("14 negative search: no technical schedule copy", () => {
  assert.ok(!art8.includes("Schedule Source"));
  assert.ok(!art8.includes("Schedule source"));
  assert.ok(!art8.includes("Project legacy fallback"));
  assert.ok(!art8.includes("Continue does not change readiness"));
  assert.ok(!art8.includes("Review this article, then Continue"));
  assert.ok(!art8.includes("To be confirmed"));
  assert.ok(!helperSrc.includes("Schedule Source"));
  assert.ok(!helperSrc.includes("Project legacy fallback"));
  assert.ok(!js.includes("Project legacy fallback"));
  assert.ok(!js.includes("scheduleSourceDisplayLabel"));
  assert.ok(!pdfSrc.includes("approved_quote"));
  assert.ok(!portalSrc.includes("project_legacy"));
});

test("no invented today date and no auto-confirm", () => {
  assert.ok(!/startDate\s*=\s*new Date\(\)/.test(helperSrc));
  assert.ok(!helperSrc.includes("toISOString"));
  const empty = view({ startDate: "", dueDate: "" });
  assert.strictEqual(empty.kind, "missing_start");
  const both = view({ startDate: "2026-09-01", dueDate: "2026-09-30" });
  assert.strictEqual(both.kind, "unconfirmed");
  assert.ok(helperSrc.includes("confirm_estimated_schedule: true"));
  assert.ok(helperSrc.includes("SETUP_API"));
  assert.ok(js.includes("saveCanonicalScheduleDates"));
  assert.ok(html.includes("contract-schedule-confirm.js?v=ch012h-1"));
});

test("same-day completion is valid", () => {
  const v = view({ startDate: "2026-09-01", dueDate: "2026-09-01", confirmed: false });
  assert.strictEqual(v.kind, "unconfirmed");
  assert.strictEqual(v.confirmBlocked, false);
});

testAsync("locked quote with dates already present still confirms on the server", async () => {
  let posts = 0;
  const runner = ScheduleConfirm.createScheduleConfirmRunner({
    getBusy: () => false,
    isConfirmed: () => false,
    getDates: () => ({ startDate: "2026-09-01", dueDate: "2026-09-30" }),
    getIds: () => ({ projectId: "p1", quoteId: "q1" }),
    getQuote: () => ({
      status: "accepted",
      start_date: "2026-09-01",
      due_date: "2026-09-30",
    }),
    postJson: async () => {
      posts += 1;
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
          },
        },
      };
    },
    applySuccess: () => {},
  });
  const result = await runner.confirm();
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.posted, true);
  assert.strictEqual(posts, 1);
  assert.strictEqual(result.payload.confirm_estimated_schedule, true);
  assert.ok(!Object.prototype.hasOwnProperty.call(result.payload, "start_date"));
  assert.ok(!Object.prototype.hasOwnProperty.call(result.payload, "due_date"));
});

(async () => {
  for (const item of pending) {
    try {
      await item.fn();
      console.log("PASS", item.name);
      passed += 1;
    } catch (err) {
      console.log("FAIL", item.name, "-", err.message);
      failed += 1;
    }
  }
  console.log("");
  console.log("CH-007D Article 8 Estimated Schedule:", passed, "passed,", failed, "failed");
  process.exit(failed === 0 ? 0 : 1);
})();
