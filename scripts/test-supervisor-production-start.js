#!/usr/bin/env node
/**
 * Supervisor production start moves the schedule, and a new quote sees that day.
 * Run: node scripts/test-supervisor-production-start.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  analyzeProjectForCrewAvailability,
  productionTargetFromStart,
  productionCalendarDayIndex,
  productionPositionText,
  resolveProjectStart,
} = require("../netlify/functions/_lib/sales-capacity-calendar");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "public/supervisor.html"), "utf8");
const app = fs.readFileSync(path.join(root, "public/js/app.js"), "utf8");
const handler = fs.readFileSync(
  path.join(root, "netlify/functions/update-supervisor-production-start.js"),
  "utf8"
);

let passed = 0;
function ok(label, cond) {
  assert.ok(cond, label);
  passed += 1;
  console.log("PASS " + label);
}

ok("an 8-day plan starting Oct 21 finishes Oct 28", productionTargetFromStart("2026-10-21", 8) === "2026-10-28");
ok("Oct 23 is day 3 of a plan that starts Oct 21", productionCalendarDayIndex("2026-10-21", 8, "2026-10-23") === 3);
ok(
  "the quote names the production day",
  productionPositionText("Erin's Master bathroom", "2026-10-21", 8, "2026-10-28", "2026-10-23") ===
    "Erin's Master bathroom is on Day 3 of 8 in production through Oct 28, 2026."
);
ok(
  "a corrected quote start wins over the old signed date",
  resolveProjectStart(
    { signed_at: "2026-10-05T12:00:00.000Z", quote_id: "q1" },
    null,
    { start_date: "2026-10-21" }
  ) === "2026-10-21"
);

const settings = {
  workdaysEnabled: false,
  scheduleBufferDays: 0,
  crewAvailabilityMode: "advisory",
  allowSellerScheduleOverride: true,
  crewCapacity: 1,
};
const shifted = analyzeProjectForCrewAvailability(
  {
    id: "p1",
    project_name: "Erin's Master bathroom",
    status: "signed",
    signed_at: "2026-10-05T12:00:00.000Z",
    due_date: "2026-10-28",
    estimated_days: 8,
    quote_id: "q1",
  },
  {
    opRow: { commitment_date: "2026-10-28", estimated_days: 8 },
    baseline: null,
    reports: [],
    dayProgressRows: [
      { day_number: 1, status: "completed" },
      { day_number: 2, status: "completed" },
    ],
    quote: { start_date: "2026-10-21", due_date: "2026-10-28" },
  },
  settings,
  "2026-10-23",
  "2026-10-30"
);
ok("the shifted project starts on the corrected date", shifted.start_date === "2026-10-21");
ok("the shifted project is not past its target", shifted.past_target_incomplete !== true);
ok("the shifted project still occupies production", shifted.blocks_capacity === true);

const stale = analyzeProjectForCrewAvailability(
  {
    id: "p1",
    project_name: "Erin's Master bathroom",
    status: "signed",
    signed_at: "2026-10-05T12:00:00.000Z",
    due_date: "2026-10-05",
    estimated_days: 8,
  },
  {
    opRow: { commitment_date: "2026-10-05", estimated_days: 8 },
    baseline: null,
    reports: [],
    dayProgressRows: [{ day_number: 1, status: "completed" }],
    quote: null,
  },
  settings,
  "2026-10-23",
  "2026-10-23"
);
ok("the old same-day target is past due", stale.past_target_incomplete === true);

ok("supervisor can edit the start date", html.includes('id="btnSupEditStart"') && html.includes('id="supStartDateInput"'));
ok("the start date opens in a modal", html.includes('id="supStartEdit"') && html.includes('aria-modal="true"') && html.includes("Move production start"));
ok("the start modal previews the moved plan", app.includes("Today becomes Day"));
ok(
  "the start modal shows the system month calendar",
  html.includes('id="supStartDateCal"') &&
    html.includes('class="sup-start-cal"') &&
    app.includes("sup-start-cal-day") &&
    app.includes("data-sup-start-day")
);
ok("saving the start date posts the production start", app.includes("/.netlify/functions/update-supervisor-production-start"));
ok("a saved start refreshes the supervisor schedule", /update-supervisor-production-start[\s\S]{0,1200}loadSupervisorOperationalSnapshot\(pid, \{ force: true \}\)/.test(app));
ok("the start update keeps the assigned supervisor check", handler.includes("loadTenantProjectForSupervisorAction"));
ok("the start update moves the target with the plan", handler.includes("productionTargetFromStart"));
ok(
  "opening day 2 does not fall back to day 1",
  app.includes("data-sup-day-open") &&
    app.includes("function supervisorCalendarDayNumber") &&
    app.includes('el.getAttribute("data-sup-day-open")') &&
    app.includes("supervisorReportDayFields(entry.date)") &&
    app.includes("supervisorReportDayFields(extra.date)")
);

console.log("\n" + passed + " passed");
