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

  ok("public estimate renders each area scope without a sell price", publicBuilder.includes("area.scope") && !publicBuilder.includes("mg-public-area__sell") && !publicBuilder.includes("area.sell_subtotal"));
  ok("PDF renders each area scope without a sell price", pdf.includes("area && area.scope") && !pdf.includes("area.sell_subtotal"));
  ok(
    "public scope and client PDF include quote terms in Scope of Work without area sell prices",
    publicBuilder.includes("mg-terms-in-scope") &&
      publicBuilder.includes("safe(next && next.terms)") &&
      publicBuilder.includes('style="white-space:pre-wrap;margin-top:16px;"') &&
      !publicBuilder.includes("next.notes") &&
      !publicBuilder.includes("mg-public-area__sell") &&
      !publicBuilder.includes("area.sell_subtotal") &&
      pdf.includes("terms-in-scope") &&
      pdf.includes("data.terms") &&
      pdf.includes("drawQuoteTermsInScope(quoteTerms)") &&
      pdf.includes("drawSectionTitle('Project Investment')") &&
      !pdf.includes("area.sell_subtotal") &&
      !pdf.includes("data.notes")
  );
  const renderTermsSrc = publicBuilder.slice(
    publicBuilder.indexOf("function renderTerms"),
    publicBuilder.indexOf("function renderTotals")
  );
  ok(
    "public Terms card keeps the short scheduling notice and does not repeat quote.terms",
    renderTermsSrc.includes("The Initial Scheduling Payment will be applied toward your final invoice.") &&
      renderTermsSrc.includes("Deposits are non-refundable in the event of project cancellation by the client.") &&
      !renderTermsSrc.includes("next.terms") &&
      !renderTermsSrc.includes("textContent")
  );
  ok("public PDF download keeps the modal area subtotals", publicBuilder.includes("laborAreas: Array.isArray(next.labor_areas)") && sales.includes("doc.text('Subtotal  ' + formatUsd(area && area.sell_subtotal), right, y, { align: 'right' })"));
  ok("public estimate fetch is tenant-bound", getPublic.includes("tenant_id=not.is.null") && getPublic.includes("labor_area_breakdown"));
  ok("publish still creates one public URL from one token", publish.includes("estimate-public.html?token=") && !/area.*public_token/i.test(publish));
  ok("publish computes one protected quote before the area breakdown", publish.indexOf("calculateQuotePublishFinancials") < publish.indexOf("buildLaborAreaBreakdown"));

  const areaApi = require("../public/js/seller-operational-plan-areas.js");
  const repeatedScope = [
    "Protect work area, floors, and walls if necessary.",
    "Install tile.",
    "Grout and clean the entire work area.",
  ].join("\n");
  const repeatedWithSpace = repeatedScope.replace("necessary.", "necessary. ");
  eq(
    "area scope keeps each repeated day line once",
    areaApi.deriveAreaScope({ scope: "" }, [
      { client_scope: repeatedScope },
      { client_scope: repeatedWithSpace },
      { client_scope: repeatedScope },
    ]),
    repeatedScope
  );
  eq(
    "area scope keeps a line that belongs to only one day",
    areaApi.deriveAreaScope({ scope: repeatedScope }, [
      { client_scope: repeatedScope },
      { client_scope: repeatedWithSpace },
      { client_scope: "Complete planned work for day 1 including floor demolition." },
    ]),
    repeatedScope + "\nComplete planned work for day 1 including floor demolition."
  );
  eq(
    "distinct day lines all stay on the area",
    areaApi.deriveAreaScope({ scope: "" }, [
      { client_scope: "Preparation of walls." },
      { client_scope: "Waterproofing of shower floor." },
      { client_scope: "Installation of tile on the floor." },
    ]),
    "Preparation of walls.\nWaterproofing of shower floor.\nInstallation of tile on the floor."
  );
  ok(
    "public estimate shows each scope line once",
    publicBuilder.includes("function uniquePublicScopeLines(scope)") &&
      publicBuilder.includes('uniquePublicScopeLines(area && area.scope).join("\\n")')
  );
  ok(
    "estimate PDFs show each scope line once",
    pdf.includes("function uniquePublicScopeLines(scope)") &&
      pdf.includes("uniquePublicScopeLines(area && area.scope)") &&
      sales.includes("function uniquePublicScopeLines(scope)") &&
      sales.includes("const scopeLines = uniquePublicScopeLines(area && area.scope)")
  );

  return passed;
}

const EXPECTED = 37;

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
