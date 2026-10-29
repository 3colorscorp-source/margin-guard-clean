#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const areas = require("../public/js/seller-operational-plan-areas.js");
const voice = require("../public/js/voice-operational-plan.js");
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

function sliceBetween(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, start);
  return source.slice(from, to);
}

function button() {
  return {
    textContent: "",
    disabled: false,
    classList: { toggle() {}, add() {}, remove() {} },
  };
}

function baseDoc() {
  return {
    schema_version: 1,
    source: "keyboard",
    areas: [
      { area_ref: "area_1", name: "Kitchen", scope: "Old kitchen scope", sort_order: 0 },
      { area_ref: "area_2", name: "Bath", scope: "Keep the bath scope", sort_order: 1 },
    ],
    days: [
      {
        day_id: "day_1",
        day_number: 1,
        area_ref: "area_1",
        client_scope: "Old kitchen day",
        internal_tasks: [{ task_id: "task_1", label: "Old task" }],
        worker_assignments: [],
      },
      {
        day_id: "day_2",
        day_number: 2,
        area_ref: "area_2",
        client_scope: "Waterproof the shower.",
        internal_tasks: [{ task_id: "task_2", label: "Waterproof shower" }],
        worker_assignments: [
          { assignment_id: "asg_2", worker_type: "pro", worker_role: "Installer", worker_count: 2, hours_per_worker: 4 },
        ],
      },
    ],
  };
}

async function runMultiAreaVoiceScopeTests() {
  const sales = read("public/sales.html");
  const areasSrc = read("public/js/seller-operational-plan-areas.js");
  const voiceSrc = read("public/js/voice-operational-plan.js");
  const commandSrc = read("netlify/functions/voice-operational-plan-command.mjs");
  const publish = read("netlify/functions/publish-public-quote.js");
  const pdf = read("public/js/estimate-send-helpers.js");
  const publicBuilder = read("public/js/estimate-builder.js");

  ok("area dictation reuses the shared capture", voiceSrc.includes("function bindSpeechDictation") && voiceSrc.includes("createVoiceDictationCapture") && voiceSrc.includes("prefersInterimSpeechResults"));
  ok("seller area modal calls the shared dictation binder", sales.includes("bindSpeechDictation("));
  eq("seller keeps one SpeechRecognition constructor", (sales.match(/webkitSpeechRecognition/g) || []).length, 1);
  ok("area helper does not implement SpeechRecognition", !/SpeechRecognition|webkitSpeechRecognition/.test(areasSrc));

  const textarea = { value: "typed by hand", readOnly: false, blur() {} };
  const manual = voice.bindSpeechDictation({ textarea, newButton: button(), continueButton: button(), languageSelect: { value: "es-US" } });
  const manualStart = manual.startNew();
  eq("manual typing works without Speech API", manualStart.speech, false);
  eq("manual transcript stays in the textarea", textarea.value, "typed by hand");

  let recognition = null;
  function FakeRecognition() { recognition = this; }
  FakeRecognition.prototype.start = function () { if (this.onstart) this.onstart(); };
  FakeRecognition.prototype.stop = function () { if (this.onend) this.onend(); };
  const mobileField = { value: "", readOnly: false, blur() {} };
  const newButton = button();
  const continueButton = button();
  const mobile = voice.bindSpeechDictation({
    textarea: mobileField,
    newButton,
    continueButton,
    languageSelect: { value: "es-US" },
    Recognition: FakeRecognition,
    userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel) AppleWebKit Chrome/120.0.0.0 Mobile",
  });
  mobile.startNew();
  recognition.onresult(voice.makeSpeechRecognitionEvent(0, [{ transcript: "Dia 1 proteger", isFinal: true }]));
  recognition.onresult(voice.makeSpeechRecognitionEvent(1, [
    { transcript: "Dia 1 proteger", isFinal: true },
    { transcript: "Dia 1 proteger pisos", isFinal: true },
  ]));
  eq("growing mobile dictation does not duplicate words", mobileField.value, "Dia 1 proteger pisos");
  eq("listening button says Stop", newButton.textContent, "Stop");
  mobile.startNew();
  eq("Stop ends the current dictation", recognition === null || mobile.isListening() === false, true);
  continueButton.textContent = "Continue dictation";
  mobileField.value = "Dia 1 proteger pisos";
  mobile.continueDictation();
  ok("Continue dictation starts from the existing text", mobile.isListening() === true || mobileField.value.indexOf("Dia 1 proteger pisos") === 0);
  mobile.cancel();
  recognition = { stop() {}, onresult() {} };
  const ignored = voice.createVoiceDictationCapture({ maxChars: 6000 });
  const generation = ignored.start("kept");
  ignored.cancel();
  const late = ignored.applyEvent(voice.makeSpeechRecognitionEvent(0, [{ transcript: "late words", isFinal: true }]), generation);
  eq("Cancel ignores a late speech result", late.ignored, true);

  const rendered = areas.renderWorkAreas({
    quote_mode: "multi_area",
    work_areas_ui: "active",
    labor_from_work_areas: true,
    internal_operational_plan: baseDoc(),
  });
  ok("the review modal keeps the same dictation textarea", sales.includes('id="voicePlanTranscript"') && sales.includes('maxlength="6000"'));
  ok("the review modal keeps the same language labels", sales.includes("Dictation language") && sales.includes("Client document"));
  ok("area modal does not open a second dictation screen", !rendered.includes("Voice dictation") && !rendered.includes("Interpret area") && !rendered.includes(">Instructions<textarea"));
  ok("multi adds Area name on the same review modal", sales.includes('id="voicePlanAreaNameField" hidden') && sales.includes('id="voicePlanAreaName"') && sales.includes(">Area name") && sales.includes("Interpret and preview"));
  ok("Add area opens the same quote review", sales.includes("openVoicePlanPreviewModal({ newArea: true })"));
  ok("multi confirm applies a blank area name", sales.includes('id="voicePlanPreviewFooterStatus"') && sales.includes("areaName = 'Work area'") && sales.includes("const storedPlan = namedArea || applied") && !sales.includes("Enter an area name before confirming."));
  ok("named area confirm keeps the page document", sales.includes("function applyNamedAreaPlan(plan, applied)") && sales.includes("document.getElementById('salesMessageToClient')"));
  ok("multi confirm previews canonical area ids before saving", sales.includes("previewSellerOperationalPlanAreas(namedArea, { commit: false })"));
  const sendAt = sales.indexOf("let stateFresh = await ensureCanonicalAreaPlanForPublish");
  const publishAt = sales.indexOf("buildPublishPublicQuoteBody({", sendAt);
  ok("send prepares canonical area ids before publish", sendAt >= 0 && publishAt > sendAt);
  const filed = areas.addArea({ schema_version: 1, source: "keyboard", areas: [], days: [] }, { name: "Work area", scope: "" });
  const replaced = areas.replaceAreaPlan(filed.document, filed.area_ref, [{
    day_number: 1,
    client_scope: "Protect work area",
    internal_tasks: [{ label: "Protect work area" }],
    worker_assignments: [{ worker_role: "Assistant", worker_type: "helper", worker_count: 1, hours_per_worker: 8 }],
  }]);
  eq("a blank area name still files the interpreted day", replaced.ok && replaced.document.areas.length === 1 && replaced.document.days.length === 1 && replaced.document.areas[0].name === "Work area", true);
  const publishApi = require("../netlify/functions/publish-public-quote.js");
  const serverVoice = require("../netlify/functions/_lib/voice-operational-plan.js");
  const blockedSend = publishApi._test.assertCanonicalOperationalPlanAreas({
    internal_operational_plan: replaced.document,
    labor_areas: [],
    workers: [],
  });
  eq("publish rejects a temporary area_ref plan", blockedSend.ok, false);
  eq("publish rejection is unresolved_area_ref", blockedSend.code, "unresolved_area_ref");
  const canonicalPlan = serverVoice.normalizeDocument(replaced.document, {
    startDate: "2026-10-12",
    settings: { hoursPerDay: 8 },
    hoursPerDay: 8,
    createId: function () { return require("crypto").randomUUID(); },
  });
  const projectedLabor = areas.projectLabor(canonicalPlan, { hoursPerDay: 8, pricingMode: "hour" });
  const allowedSend = publishApi._test.assertCanonicalOperationalPlanAreas({
    internal_operational_plan: canonicalPlan,
    labor_areas: projectedLabor.laborAreas,
    workers: projectedLabor.workers,
  });
  eq("publish accepts the previewed area plan", allowedSend.ok, true);
  ok("area modal keeps Name, Scope of Work, and crew", rendered.includes(">Name<input") && rendered.includes("Scope of Work") && rendered.includes("Worker count") && rendered.includes("Hours per worker") && rendered.includes("Add day"));
  ok("Save Area and Add New Area stay in the production footer", rendered.includes('data-wa-action="save-area"') && rendered.includes("+ Add New Area") && !rendered.includes('data-wa-action="cancel-area"'));
  ok("Review stays outside the area renderer", !rendered.includes("btnReviewConfirmOperationalPlan"));
  ok("Review remains below the area list", sales.indexOf('id="btnReviewConfirmOperationalPlan"') > sales.indexOf('id="salesWorkAreasHost"'));
  ok("dictation textarea uses the dark premium background", sales.includes("mg-area-dictation") && sales.includes("rgba(6, 10, 20, 0.82)") && !sales.includes("background:#fff") && !sales.includes("background: white"));
  ok("area controls wrap inside narrow viewports", sales.includes(".mg-area-voice__actions { display: flex; flex-wrap: wrap;"));

  const kitchenDays = [
    {
      day_number: 1,
      client_scope: "Protect floors, walls, and kitchen cabinets.",
      internal_tasks: [{ label: "Protect floors, walls, and cabinets." }],
      worker_assignments: [],
    },
    {
      day_number: 2,
      client_scope: "Demolish and remove the existing floor. The labor rate is $75.",
      internal_tasks: [{ label: "Demolish and remove the existing floor." }],
      worker_assignments: [
        { worker_type: "pro", worker_role: "Installer", worker_count: 1, hours_per_worker: 6 },
      ],
    },
  ];
  const snapshot = baseDoc();
  const applied = areas.acceptAreaInterpretation({
    document: snapshot,
    proposedDays: kitchenDays,
    requestGeneration: 2,
    activeGeneration: 2,
    requestAreaKey: "area_1",
    activeAreaKey: "area_1",
  });
  eq("interpretation does not publish or price", applied.published === false && applied.priced === false, true);
  eq("kitchen day keeps its temporary area_ref", applied.document.days.filter((day) => day.area_ref === "area_1").length, 2);
  eq("bath day is unchanged", applied.document.days.find((day) => day.area_ref === "area_2").client_scope, "Waterproof the shower.");
  eq("undictated day does not invent crew", applied.document.days.find((day) => day.area_ref === "area_1" && day.day_number === 1).worker_assignments.length, 0);
  eq("dictated crew is kept", applied.document.days.find((day) => day.client_scope.indexOf("Demolish") === 0).worker_assignments[0].hours_per_worker, 6);
  eq("person-hours use worker count times hours", areas.areaPersonHours(applied.document, applied.document.areas[0]), 6);
  ok("public scope drops the financial sentence", !/\$|rate|margin|overhead|reserve|area_id/.test(areas.publicScopeText(applied.document)));
  ok("public scope still groups both areas", areas.publicScopeText(applied.document).includes("Kitchen") && areas.publicScopeText(applied.document).includes("Bath"));
  ok("internal review groups both areas", areas.internalReviewText(applied.document).includes("Kitchen") && areas.internalReviewText(applied.document).includes("Bath"));
  const issues = areas.inspectDocument(applied.document, { labor_from_work_areas: true });
  eq("a day without crew still blocks Confirm", issues.some((issue) => issue.code === "needs_crew"), true);
  eq("the crew block does not publish or price", applied.published === false && applied.priced === false, true);
  const restored = areas.restoreAreaSnapshot(snapshot);
  eq("Cancel restores the area snapshot", restored.document.days.find((day) => day.area_ref === "area_1").client_scope, "Old kitchen day");
  const lateArea = areas.acceptAreaInterpretation({
    document: snapshot,
    proposedDays: kitchenDays,
    requestGeneration: 1,
    activeGeneration: 2,
    requestAreaKey: "area_1",
    activeAreaKey: "area_2",
  });
  eq("a late response does not enter another area", lateArea.ignored, true);
  eq("a late response leaves the document untouched", lateArea.document, snapshot);

  const requestDoc = areas.areaRequestDocument(snapshot, "area_1");
  eq("the interpreter request contains only the active area", requestDoc.days.length, 1);
  ok("the interpreter request has no tenant id", !Object.prototype.hasOwnProperty.call(requestDoc, "tenant_id"));
  const saved = areas.commitAreaSlice(snapshot, "area_1", applied.document);
  eq("Save Area does not publish or price", saved.published === false && saved.priced === false, true);

  const canonical = areas.replaceAreaPlan({
    areas: [{ id: "11111111-1111-4111-8111-111111111111", name: "Kitchen", scope: "", sort_order: 0 }],
    days: [],
  }, "11111111-1111-4111-8111-111111111111", [{
    day_number: 1,
    client_scope: "Install tile.",
    internal_tasks: [{ label: "Install tile." }],
    worker_assignments: [{ worker_type: "helper", worker_role: "Assistant", worker_count: 2, hours_per_worker: 3 }],
  }]);
  eq("canonical days keep area_id and not area_ref", canonical.document.days[0].area_id, "11111111-1111-4111-8111-111111111111");
  eq("canonical days do not also carry area_ref", canonical.document.days[0].area_ref, undefined);
  eq("helper person-hours stay on that area", areas.areaPersonHours(canonical.document, canonical.document.areas[0]), 6);

  const interpretSlice = sliceBetween(sales, "async function interpretAreaFromEditor", "function handleAreaVoiceAction");
  ok("Interpret area calls the existing endpoint", interpretSlice.includes("/.netlify/functions/voice-operational-plan-command") && interpretSlice.includes('interpretation_scope: \'area\''));
  ok("Interpret area does not publish, send, or price", !/publish-public-quote|send-quote|calculateQuotePublishFinancials|previewLaborCost|tenant_id/.test(interpretSlice));
  ok("Single Quote still uses the global reset", sales.includes("quoteMode === 'multi_area' ? 'active' : 'global'") && sales.includes("Interpret and preview"));
  ok("Single Quote hides Add work area", !areas.renderWorkAreas({ quote_mode: "single", work_areas_ui: "global" }).includes("Add work area"));
  ok("Single Quote hides the labor Add area button", sales.includes("allowAdd: state.quote_mode !== 'single'"));
  ok("Confirm and apply source does not call send-quote", !/send-quote|publish-public-quote|calculateQuotePublishFinancials/.test(sliceBetween(sales, "async function applyWorkAreasConfirm", "function openVoicePlanPreviewModal")));
  const confirmed = areas.applyConfirmedWorkAreas({
    state: { quoteId: "", _sellerDraftId: "sd_test" },
    document: {
      areas: [{ id: "11111111-1111-4111-8111-111111111111", name: "Kitchen", scope: "Install tile.", sort_order: 0 }],
      days: [{
        day_id: "day_9",
        day_number: 1,
        area_id: "11111111-1111-4111-8111-111111111111",
        client_scope: "Install tile.",
        internal_tasks: [{ task_id: "task_9", label: "Install tile." }],
        worker_assignments: [{ assignment_id: "asg_9", worker_type: "pro", worker_role: "Installer", worker_count: 1, hours_per_worker: 4 }],
      }],
    },
    settings: { hoursPerDay: 8, pricingMode: "hour" },
  });
  eq("Confirm and apply does not publish or price", confirmed.published === false && confirmed.priced === false, true);
  ok("a later publish still creates one quote and one PDF path", publish.includes("estimate-public.html?token=") && publish.indexOf("calculateQuotePublishFinancials") < publish.indexOf("buildLaborAreaBreakdown"));
  ok("public estimate and PDF show each area scope without a sell price", publicBuilder.includes("area.scope") && !publicBuilder.includes("area.sell_subtotal") && pdf.includes("area && area.scope") && !pdf.includes("area.sell_subtotal"));
  ok(
    "public scope and client PDF include quote terms in Scope of Work without area sell prices",
    publicBuilder.includes("mg-terms-in-scope") &&
      publicBuilder.includes("safe(next && next.terms)") &&
      publicBuilder.includes('style="white-space:pre-wrap;margin-top:16px;"') &&
      !publicBuilder.includes("next.notes") &&
      !publicBuilder.includes("area.sell_subtotal") &&
      pdf.includes("terms-in-scope") &&
      pdf.includes("drawQuoteTermsInScope(quoteTerms)") &&
      pdf.includes("drawSectionTitle('Project Investment')") &&
      !pdf.includes("area.sell_subtotal") &&
      !pdf.includes("data.notes")
  );

  const { createHandler } = await import("../netlify/functions/voice-operational-plan-command.mjs");
  const transcript = [
    "Día 1: proteger pisos, paredes y gabinetes de la cocina.",
    "Día 2: demoler y retirar el piso existente. One Installer for 6 hours.",
  ].join("\n");
  let fetchCalls = 0;
  const originalFetch = global.fetch;
  global.fetch = async function () {
    fetchCalls += 1;
    throw new Error("external call");
  };
  const seenTenants = [];
  let interpreted = 0;
  const handler = createHandler({
    resolveContext: async () => ({ tenant: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }, auth_mode: "owner" }),
    loadSettings: async (tenantId) => {
      seenTenants.push(tenantId);
      return { hoursPerDay: 8 };
    },
    interpret: async () => {
      interpreted += 1;
      return {
        summary: "Kitchen only",
        warnings: [],
        document: {
          schema_version: 1,
          source: "voice",
          days: [1, 2].map((dayNumber) => ({
            day_id: "",
            day_number: dayNumber,
            client_scope: dayNumber === 1 ? "Protect floors, walls, and kitchen cabinets." : "Demolish and remove the existing floor.",
            internal_tasks: [{ task_id: "", label: dayNumber === 1 ? "Protect floors, walls, and cabinets." : "Demolish and remove the existing floor." }],
            worker_assignments: [{ assignment_id: "", worker_role: "Installer", worker_type: "pro", worker_count: 1, hours_per_worker: 8 }],
            materials_or_tools: [],
            dependencies: [],
            gc_client_responsibilities: [],
            risks: [],
            internal_notes: "",
          })),
        },
      };
    },
  });
  const rejected = await handler(new Request("https://example.test/voice", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transcript, tenant_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", interpretation_scope: "area", current_document: { schema_version: 1, source: "voice", days: [] } }),
  }));
  const rejectedBody = await rejected.json();
  eq("browser tenant_id is rejected", rejected.status, 400);
  eq("rejected tenant request does not interpret", interpreted, 0);
  const accepted = await handler(new Request("https://example.test/voice", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      transcript,
      interpretation_scope: "area",
      client_language: "en",
      current_document: { schema_version: 1, source: "voice", days: [] },
    }),
  }));
  const acceptedBody = await accepted.json();
  eq("area interpretation uses the session tenant", seenTenants.join(","), "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  eq("area interpretation makes no external call", fetchCalls, 0);
  eq("area response is not priced", acceptedBody.priced, false);
  eq("area response does not return a derived cost", acceptedBody.labor_preview.derived_cost, undefined);
  eq("day without dictated crew has no Installer", acceptedBody.proposed_document.days[0].worker_assignments.length, 0);
  eq("day with dictated crew keeps the stated hours", acceptedBody.proposed_document.days[1].worker_assignments[0].hours_per_worker, 6);
  ok("area command does not read a browser tenant id", commandSrc.includes('code: "tenant_id_rejected"'));
  global.fetch = originalFetch;

  return passed;
}

const EXPECTED = 69;

module.exports = { runMultiAreaVoiceScopeTests, EXPECTED };

if (require.main === module) {
  runMultiAreaVoiceScopeTests()
    .then((count) => {
      if (count !== EXPECTED) throw new Error("expected " + EXPECTED + " got " + count);
      console.log(count + " passed");
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
