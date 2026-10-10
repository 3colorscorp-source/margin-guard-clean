#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  buildLaborAreaBreakdown,
  publicAreasFromBreakdown,
} = require("../netlify/functions/_lib/labor-area-breakdown");

const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
let passed = 0;

function ok(label, value) {
  assert.ok(value, label);
  passed += 1;
  console.log("PASS " + label);
}

function eq(label, actual, expected) {
  assert.strictEqual(actual, expected, label);
  passed += 1;
  console.log("PASS " + label);
}

async function runMultiAreaQuoteV1Tests() {
  const sales = read("public/sales.html");
  const app = read("public/js/app.js");
  const areasUi = read("public/js/seller-operational-plan-areas.js");
  const publicBuilder = read("public/js/estimate-builder.js");
  const pdf = read("public/js/estimate-send-helpers.js");
  const getPublic = read("netlify/functions/get-public-estimate.js");
  const publish = read("netlify/functions/publish-public-quote.js");

  ok("New Quote offers Single Quote", sales.includes('data-quote-mode="single"') && sales.includes("Single Quote"));
  ok("New Quote offers Multi-Area Quote", sales.includes('data-quote-mode="multi_area"') && sales.includes("Multi-Area Quote"));
  ok("new quote stores an explicit quote mode", sales.includes("quote_mode: quoteMode"));
  ok("single quote stays on the global plan", sales.includes("quoteMode === 'multi_area' ? 'active' : 'global'"));
  ok("multi-area selection reaches the reset", app.includes('quoteMode: confirmBtn.dataset.quoteMode === "multi_area"'));
  ok("Cancel can discard unsaved area edits", !sales.includes("host.addEventListener('focusout', onWorkAreaHostEvent)"));
  ok("Save Area captures the complete modal", sales.includes("captureWorkAreaCard(api, doc, card)") && sales.includes("action === 'save-area'"));
  ok("day and crew actions reopen the same area modal", sales.includes("openAreaAfterCommit = key"));

  const rendered = require("../public/js/seller-operational-plan-areas.js").renderWorkAreas({
    quote_mode: "multi_area",
    work_areas_ui: "active",
    internal_operational_plan: {
      schema_version: 1,
      areas: [{ area_ref: "area_1", name: "Kitchen", scope: "Install backsplash tile.", sort_order: 0 }],
      days: [{
        day_id: "day_1",
        day_number: 1,
        area_ref: "area_1",
        client_scope: "Prepare walls.",
        internal_tasks: [{ task_id: "task_1", label: "Protect counters" }],
        worker_assignments: [{ assignment_id: "asg_1", worker_type: "pro", worker_role: "Installer", worker_count: 1, hours_per_worker: 8 }],
      }],
    },
  });
  ok("multi-area workspace renders an area list", rendered.includes("Kitchen") && rendered.includes("Open area"));
  ok("each area has its own modal editor", rendered.includes("data-wa-editor") && rendered.includes('aria-modal="true"'));
  ok("area modal contains the complete public scope", rendered.includes("Scope of Work") && rendered.includes("Install backsplash tile."));
  ok("area modal contains days and crew", rendered.includes("Day 1") && rendered.includes("Worker count") && rendered.includes("Hours per worker"));
  ok("area modal can add more than one crew row", rendered.includes('data-wa-action="add-worker"'));
  ok("area modal ends with Save Area and Add New Area", rendered.includes("Save Area") && rendered.includes("+ Add New Area"));
  ok("the browser area helper still has no UUID minting or pricing", !/randomUUID|calculateQuotePublishFinancials|allocateSellCents/.test(areasUi));
  const helper = require("../public/js/seller-operational-plan-areas.js");
  const multiCrew = helper.replaceDayAssignments({
    areas: [{ area_ref: "area_1", name: "Bath", scope: "", sort_order: 0 }],
    days: [{ day_id: "day_1", day_number: 1, area_ref: "area_1", worker_assignments: [] }],
  }, "day_1", [
    { worker_type: "pro", worker_count: 1, hours_per_worker: 8 },
    { worker_type: "helper", worker_count: 1, hours_per_worker: 6 },
  ]);
  eq("one area day keeps Installer and Assistant", multiCrew.document.days[0].worker_assignments.length, 2);
  eq("multi-crew person-hours use every row", helper.areaPersonHours(multiCrew.document, multiCrew.document.areas[0]), 14);

  const settings = {
    hoursPerDay: 8,
    baseInstaller: 10,
    baseHelper: 5,
    wcPct: 0,
    ficaPct: 0,
    futaPct: 0,
    casuiPct: 0,
    stdHours: 0,
    overheadMonthly: 0,
    profitPct: 0,
    reservePct: 0,
    minimumMarginPct: 15,
  };
  const kitchenId = "11111111-1111-4111-8111-111111111111";
  const bathId = "22222222-2222-4222-8222-222222222222";
  const built = buildLaborAreaBreakdown({
    areasInput: [
      { id: kitchenId, name: "Kitchen", scope: "Install backsplash tile.\nGrout and clean.", sort_order: 0 },
      { id: bathId, name: "Master Bathroom", scope: "Waterproof shower.\nInstall wall and floor tile.", sort_order: 1 },
    ],
    workers: [
      { type: "installer", days: 1, area_id: kitchenId },
      { type: "installer", days: 2, area_id: bathId },
    ],
    tenantSettings: settings,
    total: 240,
  });
  eq("server builds one area breakdown", built.ok, true);
  eq("one breakdown contains both areas", built.breakdown.areas.length, 2);
  eq("area subtotals equal the one contract total", built.publicAreas.reduce((sum, row) => sum + row.sell_subtotal, 0), 240);
  eq("public Kitchen keeps its complete scope", built.publicAreas[0].scope, "Install backsplash tile.\nGrout and clean.");
  eq("public Master Bathroom keeps its complete scope", built.publicAreas[1].scope, "Waterproof shower.\nInstall wall and floor tile.");
  ok("public area response hides ids and internal labor", !/area_id|worker|rate|cost|margin|overhead|profit/.test(JSON.stringify(built.publicAreas)));
  eq("stored breakdown projects to the same two public areas", publicAreasFromBreakdown(built.breakdown).length, 2);

  ok("public estimate renders each area scope and subtotal", publicBuilder.includes("area.scope") && publicBuilder.includes("area.sell_subtotal"));
  ok("PDF renders each area scope and subtotal", pdf.includes("area && area.scope") && pdf.includes("area && area.sell_subtotal"));
  ok("public estimate fetch is tenant-bound", getPublic.includes("tenant_id=not.is.null") && getPublic.includes("labor_area_breakdown"));
  ok("publish still creates one public URL from one token", publish.includes("estimate-public.html?token=") && !/area.*public_token/i.test(publish));
  ok("publish computes one protected quote before the area breakdown", publish.indexOf("calculateQuotePublishFinancials") < publish.indexOf("buildLaborAreaBreakdown"));

  return passed;
}

const EXPECTED = 29;

module.exports = { runMultiAreaQuoteV1Tests, EXPECTED };

if (require.main === module) {
  runMultiAreaQuoteV1Tests()
    .then((count) => {
      if (count !== EXPECTED) throw new Error("expected " + EXPECTED + " got " + count);
      console.log(count + " passed");
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
