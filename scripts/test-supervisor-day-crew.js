#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const {
  appendCrewTrailer,
  crewFromStoredRow,
  sanitizeSupervisorCrew,
  splitCrewFromNote,
} = require("../netlify/functions/_lib/supervisor-day-crew");
const {
  mapDeviceExpenseRow,
  mapDeviceReportRow,
} = require("../netlify/functions/_lib/supervisor-device-field-dto");

let passed = 0;
function ok(name, cond) {
  if (!cond) {
    console.error("FAIL", name);
    process.exit(1);
  }
  passed += 1;
  console.log("PASS", name);
}

const crew = sanitizeSupervisorCrew([
  { role: "installer", name: "Luis" },
  { worker_type: "helper", name: "Ana" },
  { role: "visitor", name: "Nope" },
]);
ok("pro and assistant are kept", crew.length === 2 && crew[0].role === "pro" && crew[1].role === "assistant");

const packed = appendCrewTrailer("tile prep", crew);
const split = splitCrewFromNote(packed);
ok("the note stays readable", split.note === "tile prep" && split.crew[1].name === "Ana");

const fromColumn = crewFromStoredRow({
  note: packed,
  crew: [{ role: "pro", name: "Luis" }],
});
ok("a saved crew column wins over the note copy", fromColumn.note === "tile prep" && fromColumn.crew.length === 1);

const report = mapDeviceReportRow({
  entry_date: "2026-10-21",
  hours: 8,
  days: 1,
  note: packed,
  tenant_id: "secret",
  created_by: "user",
});
ok("a device labor row exposes the crew and hides the marker", report.note === "tile prep" && report.crew.length === 2 && report.tenant_id == null);

const expense = mapDeviceExpenseRow({
  id: "exp-1",
  project_id: "proj-1",
  expense_date: "2026-10-21",
  amount: 20,
  note: "gas\n[[mg-crew:v1]]" + JSON.stringify([{ role: "assistant", name: "Ana" }]),
});
ok("a device expense row exposes the assistant", expense.note === "gas" && expense.crew[0].role === "assistant");
ok(
  "an expense without crew keeps the old fields",
  Object.keys(
    mapDeviceExpenseRow({
      id: "exp-2",
      project_id: "proj-1",
      expense_date: "2026-10-21",
      amount: 5,
      note: "tape",
    })
  )
    .sort()
    .join(",") === "amount,expense_date,id,note,project_id"
);

const html = fs.readFileSync(path.join(ROOT, "public/supervisor.html"), "utf8");
const app = fs.readFileSync(path.join(ROOT, "public/js/app.js"), "utf8");
const reportHandler = fs.readFileSync(path.join(ROOT, "netlify/functions/save-project-report.js"), "utf8");
const expenseHandler = fs.readFileSync(path.join(ROOT, "netlify/functions/save-project-expense.js"), "utf8");
ok("labor and expense modals ask who worked", html.includes('id="supEntryCrew"') && html.includes('id="supExtraCrew"'));
ok("the crew editor saves with the report", app.includes("supervisorCrewForSave") && app.includes("crew: entry.crew") && app.includes("crew: extra.crew"));
ok("the server requires the day's crew", reportHandler.includes("crew_required") && expenseHandler.includes("crew_required"));
ok("the server keeps the crew when the column is missing", reportHandler.includes("appendCrewTrailer") && expenseHandler.includes("appendCrewTrailer"));

console.log("\n" + passed + " passed");
