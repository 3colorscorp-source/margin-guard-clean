#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  operationalPlanForSupervisorVisibility,
} = require("../netlify/functions/_lib/operational-plan");

const phaseOnly = operationalPlanForSupervisorVisibility([
  { day_number: 1, phase: "Cover floors and walls", workers: [] },
  { day_number: 2, phase: "Demolition of walls", workers: [] },
]);
assert.deepStrictEqual(phaseOnly, [
  { day_number: 1, phase: "Cover floors and walls", workers: [] },
  { day_number: 2, phase: "Demolition of walls", workers: [] },
]);

const appSource = fs.readFileSync(
  path.join(__dirname, "../public/js/app.js"),
  "utf8"
);
const start = appSource.indexOf(
  "function inferSupervisorExecutionEstimatedDays"
);
const end = appSource.indexOf(
  "function supervisorMigratedCurrentPlanDayIndex",
  start
);
assert(start >= 0 && end > start);
const inferenceSource = appSource.slice(start, end);
assert(
  !inferenceSource.includes("supervisorMaxDayNumberFromProgress"),
  "Progress rows must not create or resize the Supervisor execution plan"
);

const resolveStart = appSource.indexOf("function resolveSupervisorExecutionPlan");
const resolveEnd = appSource.indexOf("function formatSupervisorDaysLabel", resolveStart);
assert(resolveStart >= 0 && resolveEnd > resolveStart);
const resolveSource = appSource.slice(resolveStart, resolveEnd);
assert(
  resolveSource.includes("rememberedSupervisorCommittedPlan"),
  "A previously accepted plan must survive a later generic snapshot"
);
assert(
  resolveSource.includes("supervisorPlanIsStickyAccepted"),
  "Only a real accepted plan may be kept; generic fallbacks must not stick"
);
const keepBranch = resolveSource.indexOf("rememberedSupervisorCommittedPlan(project)");
const fallbackBranch = resolveSource.indexOf("buildSupervisorExecutionPlanFallback");
assert(
  keepBranch > fallbackBranch && keepBranch > 0,
  "The accepted plan must be restored after a generic fallback is proposed"
);

console.log("PASS supervisor accepted-plan sync guard");
