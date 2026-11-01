#!/usr/bin/env node
/**
 * Project hold moves the calendar target and leaves the labor-day index alone.
 * Run: node scripts/test-supervisor-project-hold.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const hold = require("../public/js/supervisor-project-hold.js");

const root = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(root, "public/js/app.js"), "utf8");
const html = fs.readFileSync(path.join(root, "public/supervisor.html"), "utf8");
const handler = fs.readFileSync(
  path.join(root, "netlify/functions/update-supervisor-project-hold.js"),
  "utf8"
);
const persist = fs.readFileSync(
  path.join(root, "netlify/functions/_lib/persist-operational-snapshot.js"),
  "utf8"
);

let passed = 0;
function ok(label, cond) {
  assert.ok(cond, label);
  passed += 1;
  console.log("PASS " + label);
}

const plan = { planLength: 8, actualDays: 5, startIso: "2026-10-15", todayIso: "2026-10-25" };
const laborBefore = hold.laborDayIndex(plan);

let added = hold.addProjectHold([], {
  id: "hold-3",
  reason: "Other trade on site",
  mode: "count",
  amount: 3,
  unit: "days",
  created_at: "2026-10-18T12:00:00.000Z",
});
ok("a 3-day hold is recorded with a reason", added.ok === true && added.holds.length === 1);
let summary = hold.summarizeTarget("2026-10-22", added.holds);
ok("a 3-day hold shifts 10/22 to 10/25", summary.adjustedTarget === "2026-10-25" && summary.holdDays === 3);

const withHold = hold.evaluateSchedule({
  originalTarget: "2026-10-22",
  holds: added.holds,
  today: "2026-10-25",
  estimatedDays: 8,
  actualDays: 5,
  planLength: 8,
  startIso: "2026-10-15",
});
const withoutHold = hold.evaluateSchedule({
  originalTarget: "2026-10-22",
  holds: [],
  today: "2026-10-25",
  estimatedDays: 8,
  actualDays: 5,
  planLength: 8,
  startIso: "2026-10-15",
});
ok("the labor day index does not increase because of the hold", withHold.laborDayIndex === laborBefore);
ok("the labor day index is the same with or without the hold", withHold.laborDayIndex === withoutHold.laborDayIndex);
ok("worked days choose the labor day, not the hold", withHold.laborDayIndex === 6);

ok(
  "behind is false when today is on the adjusted target and labor is on pace",
  withHold.behind === false && withHold.laborLate === false && withHold.calendarBehindDays === 0
);

const past = hold.evaluateSchedule({
  originalTarget: "2026-10-22",
  holds: added.holds,
  today: "2026-10-26",
  estimatedDays: 8,
  actualDays: 5,
  planLength: 8,
  startIso: "2026-10-15",
});
ok(
  "a saved hold clears behind when labor is on pace even one day past the adjusted target",
  past.behind === false && past.laborLate === false && past.calendarBehindDays === 1
);
ok("being past the adjusted target still does not move the labor day", past.laborDayIndex === withHold.laborDayIndex);

const erinPace = hold.evaluateSchedule({
  originalTarget: "2026-10-22",
  holds: added.holds,
  today: "2026-11-01",
  estimatedDays: 8,
  actualDays: 5,
  planLength: 8,
  startIso: "2026-10-15",
});
ok(
  "3-day hold on 2026-11-01 does not show behind when the labor day index is on pace",
  erinPace.adjustedTarget === "2026-10-25" &&
    erinPace.laborDayIndex === 6 &&
    erinPace.laborLate === false &&
    erinPace.behind === false
);

const erinLate = hold.evaluateSchedule({
  originalTarget: "2026-10-22",
  holds: added.holds,
  today: "2026-11-01",
  estimatedDays: 8,
  actualDays: 9,
  planLength: 8,
  startIso: "2026-10-15",
});
ok(
  "the same 2026-11-01 dates stay behind when worked labor days are past the plan",
  erinLate.behind === true && erinLate.laborLate === true && erinLate.laborDayIndex === 8
);

const noHoldPast = hold.evaluateSchedule({
  originalTarget: "2026-10-22",
  holds: [],
  today: "2026-11-01",
  estimatedDays: 8,
  actualDays: 5,
  planLength: 8,
  startIso: "2026-10-15",
});
ok(
  "with zero holds, today past the target is still behind",
  noHoldPast.holdDays === 0 && noHoldPast.behind === true && noHoldPast.calendarBehindDays === 10
);

const laborOver = hold.evaluateSchedule({
  originalTarget: "2026-10-22",
  holds: added.holds,
  today: "2026-10-25",
  estimatedDays: 8,
  actualDays: 9,
  planLength: 8,
  startIso: "2026-10-15",
});
ok("labor that is past the worked-day plan stays behind inside the adjusted target", laborOver.behind === true && laborOver.laborLate === true);

const removed = hold.removeProjectHold(added.holds, "hold-3");
ok("removing the hold succeeds", removed.ok === true && removed.holds.length === 0);
const restored = hold.summarizeTarget("2026-10-22", removed.holds);
ok("removing the hold restores 10/22", restored.adjustedTarget === "2026-10-22" && restored.holdDays === 0);

const second = hold.addProjectHold(added.holds, {
  id: "hold-week",
  reason: "Other trade on site",
  mode: "count",
  amount: 1,
  unit: "weeks",
});
ok("a second hold adds to the first", second.ok === true && hold.summarizeTarget("2026-10-22", second.holds).holdDays === 10);
ok(
  "one week is seven calendar days on top of the 3-day hold",
  hold.summarizeTarget("2026-10-22", second.holds).adjustedTarget === "2026-11-01"
);

const ranged = hold.createHoldFromInput({
  id: "hold-range",
  reason: "Other trade on site",
  mode: "range",
  range_start: "2026-10-16",
  range_end: "2026-10-18",
});
ok("a date range counts inclusive calendar days", ranged.ok === true && ranged.hold.days === 3);

const blank = hold.createHoldFromInput({ mode: "count", amount: 3, unit: "days", reason: "  " });
ok("a hold without a reason is rejected", blank.ok === false && blank.code === "reason_required");

const stored = hold.planValueWithHolds(
  [{ day_number: 1, phase: "Protect the site" }, { day_number: 2, phase: "Demo" }],
  added.holds
);
ok("holds sit beside the labor days in the existing plan json", Array.isArray(stored.days) && stored.days.length === 2);
ok("reading the plan json returns the same hold", hold.extractProjectHolds(stored)[0].days === 3);
const daysOnly = hold.planValueWithHolds(stored.days, []);
ok("clearing every hold restores a labor-day array", Array.isArray(daysOnly) && daysOnly.length === 2);

const statusFn = app.slice(
  app.indexOf("function supervisorResolveDayDisplayStatus"),
  app.indexOf("function supervisorDayStatusLabel")
);
ok(
  "completed labor is decided before a day can be marked late",
  statusFn.indexOf('progStatus === "completed"') >= 0 &&
    statusFn.indexOf('progStatus === "completed"') < statusFn.indexOf('return "behind"')
);
ok("day status does not read project holds", !statusFn.includes("project_holds"));
ok("the labor day index helper ignores holds", app.includes("laborDayIndex") && app.includes("MgSupervisorProjectHold"));
ok("the pause control is on the supervisor project header", html.includes('id="btnSupPauseProject"') && html.includes("Pause / other trade"));
ok(
  "pause date range uses the same month calendar as edit start",
  html.includes('id="supHoldRangeStartCal"') &&
    html.includes('id="supHoldRangeEndCal"') &&
    html.includes('class="sup-start-cal"') &&
    app.includes("function renderSupervisorDayCalendar") &&
    app.includes("supHoldRangeStartCal") &&
    app.includes("supHoldRangeEndCal") &&
    app.includes("data-sup-start-day")
);
ok(
  "a picked pause day stays yyyy-mm-dd for the existing range parser",
  html.includes('id="supHoldRangeStart"') &&
    html.includes('id="supHoldRangeEnd"') &&
    app.includes('input.value = btn.getAttribute("data-sup-start-day")')
);
ok("the page loads the hold clock before the app", html.indexOf("/js/supervisor-project-hold.js") < html.indexOf("/js/app.js"));
ok("edit start remains on the page", html.includes('id="btnSupEditStart"'));
ok("the hold save posts to the hold endpoint", app.includes("/.netlify/functions/update-supervisor-project-hold"));
ok("the hold endpoint does not rewrite the stored finish date", !/due_date\s*:/.test(handler) && !/commitment_date\s*:/.test(handler.replace("commitment_date: null", "")));
ok("the hold endpoint keeps the assigned supervisor check", handler.includes("loadTenantProjectForSupervisorAction"));
ok("a later plan save keeps recorded holds", persist.includes("planValueWithHolds") && persist.includes("extractProjectHolds"));
ok(
  "the snapshot writer can load the hold module",
  persist.includes('require("../../../public/js/supervisor-project-hold.js")')
);
require("../netlify/functions/_lib/persist-operational-snapshot.js");
ok("requiring the snapshot writer does not throw", true);

console.log("\n" + passed + " passed");
