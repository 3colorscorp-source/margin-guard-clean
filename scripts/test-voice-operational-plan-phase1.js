#!/usr/bin/env node
/**
 * Phase 1 Voice Operational Plan Builder.
 * Isolated mocks only. No live Netlify, Zapier, quotes, email, or Supabase writes.
 * Run: node scripts/test-voice-operational-plan-phase1.js
 */
"use strict";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET || "mg-voice-plan-phase1-test-secret";
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "mg-voice-plan-phase1-key";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const voice = require("../netlify/functions/_lib/voice-operational-plan");
const { parseOperationalPublishFields } = require("../netlify/functions/publish-public-quote")._test;
const { handleQuoteInternalOperationalPlan } = require("../netlify/functions/quote-internal-operational-plan")._test;
const { pickPublicEstimateFields, QUOTE_PUBLIC_KEYS } = require("../netlify/functions/get-public-estimate")._test;
const { ACTIVE_STATUSES } = require("../netlify/functions/_lib/sales-capacity-calendar");

require("../public/js/sales-capacity-calendar.js");
const clientVoice = require("../public/js/voice-operational-plan.js");

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function checkSyntax(rel) {
  const r = spawnSync(process.execPath, ["--check", path.join(ROOT, rel)], {
    encoding: "utf8",
  });
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || rel);
}

let passed = 0;
function ok(label, cond) {
  assert.ok(cond, label);
  passed += 1;
  console.log("PASS " + label);
}

function eq(label, a, b) {
  assert.strictEqual(a, b, label + " expected " + JSON.stringify(b) + " got " + JSON.stringify(a));
  passed += 1;
  console.log("PASS " + label);
}

function deepEq(label, a, b) {
  assert.deepStrictEqual(a, b, label);
  passed += 1;
  console.log("PASS " + label);
}

const SETTINGS = { workdaysEnabled: true, hoursPerDay: 8, baseInstaller: 75, baseHelper: 45 };
const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const QUOTE_A = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const QUOTE_B = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";

function sampleDays() {
  return [
    {
      day_id: "day_stable_prep",
      day_number: 1,
      client_scope: "Protect floors and stage materials.",
      internal_tasks: [{ task_id: "task_prep", label: "Mask and cover" }],
      worker_assignments: [
        {
          assignment_id: "asg_prep",
          worker_role: "Installer",
          worker_type: "pro",
          worker_count: 2,
          hours_per_worker: 8,
        },
      ],
      materials_or_tools: ["Drop cloths"],
      dependencies: ["Site access by 7am"],
      gc_client_responsibilities: ["Clear furniture"],
      risks: ["Occupied home"],
      internal_notes: "Call GC before arriving.",
    },
    {
      day_id: "day_stable_paint",
      day_number: 2,
      client_scope: "Paint living areas.",
      internal_tasks: [{ task_id: "task_paint", label: "Cut and roll" }],
      worker_assignments: [
        {
          assignment_id: "asg_paint",
          worker_role: "Assistant",
          worker_type: "helper",
          worker_count: 1,
          hours_per_worker: 8,
        },
      ],
      materials_or_tools: [],
      dependencies: [],
      gc_client_responsibilities: [],
      risks: [],
      internal_notes: "",
    },
  ];
}

function ownerCtx(tenantId) {
  return {
    auth_mode: "owner",
    tenant: { id: tenantId },
    membership: { id: "mem-owner", role: "owner" },
  };
}

async function main() {
  [
    "netlify/functions/_lib/voice-operational-plan.js",
    "netlify/functions/quote-internal-operational-plan.js",
    "netlify/functions/publish-public-quote.js",
    "netlify/functions/get-public-estimate.js",
    "public/js/voice-operational-plan.js",
    "public/js/sales-capacity-calendar.js",
    "public/js/estimate-send-helpers.js",
    "public/js/estimate-public-send.js",
  ].forEach(checkSyntax);
  ok("syntax on Phase 1 JavaScript files", true);

  const confirmed = voice.normalizeDocument(
    { schema_version: 1, source: "keyboard", days: sampleDays() },
    { startDate: "2026-09-07", settings: SETTINGS }
  );
  const draftRaw = voice.cloneJson(confirmed);
  draftRaw.days[0].client_scope = "Protect floors, then stage all materials.";
  draftRaw.days.push({
    day_id: "day_stable_punch",
    day_number: 3,
    client_scope: "Punch and walkthrough.",
    internal_tasks: [{ task_id: "task_punch", label: "Touch up" }],
    worker_assignments: [
      {
        assignment_id: "asg_punch",
        worker_role: "Installer",
        worker_type: "pro",
        worker_count: 1,
        hours_per_worker: 4,
      },
    ],
    materials_or_tools: [],
    dependencies: [],
    gc_client_responsibilities: [],
    risks: ["Walkthrough delay"],
    internal_notes: "Do not bill extra hours.",
  });
  const session = voice.createPreviewSession(confirmed, draftRaw, {
    startDate: "2026-09-07",
    settings: SETTINGS,
  });

  const cancelled = voice.cancelPreview(session);
  eq("1. cancel preview changed=false", cancelled.changed, false);
  eq("1. cancel keeps confirmed day count", cancelled.applied.days.length, confirmed.days.length);
  eq("1. cancel keeps first client_scope", cancelled.applied.days[0].client_scope, confirmed.days[0].client_scope);
  eq("1. cancel keeps first day_id", cancelled.applied.days[0].day_id, "day_stable_prep");
  ok("1. cancel does not add punch day", cancelled.applied.days.every((d) => d.day_id !== "day_stable_punch"));

  const confirmedApply = voice.confirmPreview(session, {
    startDate: "2026-09-07",
    settings: SETTINGS,
  });
  eq("2. confirm changed=true", confirmedApply.changed, true);
  eq("2. confirm applies three days", confirmedApply.applied.days.length, 3);
  eq(
    "2. confirm applies revised public scope",
    confirmedApply.applied.days[0].client_scope,
    "Protect floors, then stage all materials."
  );
  eq("2. confirm keeps stable day_id", confirmedApply.applied.days[2].day_id, "day_stable_punch");

  eq("3. estimatedDaysFromDays uses max day_number", voice.estimatedDaysFromDays([{ day_number: 1 }, { day_number: 5 }]), 5);
  eq("3. confirmed estimated_days is max day_number", confirmedApply.applied.estimated_days, 3);

  eq(
    "4. finish inclusive Mon+5 = Friday",
    voice.finishFromStartAndDays("2026-09-07", 5, SETTINGS),
    "2026-09-11"
  );
  eq(
    "4. finish omits weekend for 3-day job starting Friday",
    voice.finishFromStartAndDays("2026-09-11", 3, SETTINGS),
    "2026-09-15"
  );

  eq("5. server Saturday snap", voice.snapStartDate("2026-09-05", SETTINGS), "2026-09-07");
  eq("5. server Sunday snap", voice.snapStartDate("2026-09-06", SETTINGS), "2026-09-07");
  eq("5. client Saturday snap", clientVoice.snapStartDate("2026-09-05", SETTINGS), "2026-09-07");
  eq("5. client Sunday snap", clientVoice.snapStartDate("2026-09-06", SETTINGS), "2026-09-07");
  eq(
    "5. client/server Saturday finish match",
    clientVoice.finishFromStartAndDays("2026-09-05", 5, SETTINGS),
    voice.finishFromStartAndDays("2026-09-05", 5, SETTINGS)
  );
  eq("5. Saturday start 5-day finish is Friday", voice.finishFromStartAndDays("2026-09-05", 5, SETTINGS), "2026-09-11");
  eq(
    "5. public calendar Saturday snap",
    globalThis.MarginGuardSalesCapacity.nextWorkdayOnOrAfter("2026-09-05", SETTINGS),
    "2026-09-07"
  );
  eq(
    "5. public calendar Saturday finish",
    globalThis.MarginGuardSalesCapacity.projectFinishFromStart("2026-09-05", 5, SETTINGS),
    "2026-09-11"
  );

  const publicScope = voice.buildPublicClientScope(confirmedApply.applied);
  ok("6. public narrative has client scope", /Paint living areas/.test(publicScope.narrative));
  ok("6. public narrative omits internal notes", !/Do not bill extra hours/.test(publicScope.narrative));
  ok("6. public narrative omits worker counts", !/worker_count/.test(JSON.stringify(publicScope)));
  ok("6. public payload helper detects internal keys", voice.publicPayloadContainsInternal(confirmedApply.applied));
  ok(
    "6. scrubbed document has no internal keys",
    !voice.publicPayloadContainsInternal(voice.scrubPublicPayload(confirmedApply.applied))
  );

  const leakedRow = {
    title: "Job",
    notes: "Visible note",
    scope_of_work: publicScope.narrative,
    internal_operational_plan: confirmedApply.applied,
    internal_notes: "secret",
    worker_assignments: [{ worker_count: 9 }],
    total: 1000,
    deposit_required: 100,
  };
  const publicFields = pickPublicEstimateFields(leakedRow);
  ok("6. public estimate keys omit internal_operational_plan", !Object.prototype.hasOwnProperty.call(publicFields, "internal_operational_plan"));
  ok("6. QUOTE_PUBLIC_KEYS omits internal plan", !QUOTE_PUBLIC_KEYS.includes("internal_operational_plan"));
  ok("6. QUOTE_PUBLIC_KEYS omits operational_plan", !QUOTE_PUBLIC_KEYS.includes("operational_plan"));
  const scrubbedEstimate = voice.scrubPublicPayload(publicFields);
  ok("6. scrubbed public estimate has no risks/workers", !voice.publicPayloadContainsInternal(scrubbedEstimate));

  const helpersSrc = read("public/js/estimate-send-helpers.js");
  ok("6. PDF helper no longer falls back to projectNotes", !/data\.projectNotes/.test(helpersSrc));
  ok("6. PDF helper no longer falls back to quoteNotes", !/data\.quoteNotes/.test(helpersSrc));
  const helperSandbox = { window: {}, console };
  helperSandbox.window.window = helperSandbox.window;
  vm.runInNewContext(helpersSrc + "\nthis.__H = window.__MG_ESTIMATE_SEND_HELPERS__;", helperSandbox);
  const pdfItems = helperSandbox.__H.resolvePublicPdfScopeItems({
    scope_of_work: "Day 1: Protect floors.",
    projectNotes: "Call GC before arriving. 2 workers 8 hours. Occupied home risk.",
    quoteNotes: "Do not bill extra hours.",
    internal_operational_plan: confirmedApply.applied,
    internal_notes: "secret",
  });
  ok("6. PDF uses public scope", pdfItems.some((l) => /Protect floors/.test(l)));
  ok("6. PDF omits internal notes from notes fallback", pdfItems.every((l) => !/Do not bill extra hours/.test(l)));

  const zapierSrc = read("netlify/functions/send-quote-zapier.js");
  const zapierBodySlice = zapierSrc.slice(zapierSrc.indexOf("const zapierBody"), zapierSrc.indexOf("if (!String(zapierBody.public_quote_url"));
  ok("6. email/Zapier payload omits internal plan", !/internal_operational_plan|internal_notes|worker_assignments/.test(zapierBodySlice));

  const getPublicSrc = read("netlify/functions/get-public-estimate.js");
  ok("6. public fetch select omits internal_operational_plan", !/internal_operational_plan/.test(getPublicSrc.split("QUOTE_PUBLIC_KEYS")[1].split("QUOTE_DATE_KEYS")[0]));

  const withRates = voice.normalizeDocument(
    {
      days: [
        {
          day_id: "day_rate",
          day_number: 1,
          client_scope: "Prep",
          hourly_rate: 999,
          worker_assignments: [
            {
              worker_role: "Installer",
              worker_count: 1,
              hours_per_worker: 8,
              hourly_rate: 999,
              labor_rate: 500,
            },
          ],
        },
      ],
    },
    { startDate: "2026-09-07", settings: SETTINGS }
  );
  ok("7. stripped document has no hourly_rate", !JSON.stringify(withRates).includes("hourly_rate"));
  ok("7. stripped document has no labor_rate", !JSON.stringify(withRates).includes("labor_rate"));
  const previewCost = voice.previewLaborCost(withRates.days, SETTINGS);
  eq("7. preview cost uses tenant settings rate 75*8", previewCost, 600);
  const clientRateIgnored = voice.previewLaborCost(withRates.days, {
    ...SETTINGS,
    baseInstaller: 10,
  });
  eq("7. cost follows settings not JSON", clientRateIgnored, 80);

  const published = parseOperationalPublishFields(
    {
      start_date: "2026-09-05",
      internal_operational_plan: {
        days: [
          {
            day_number: 1,
            client_scope: "Prep",
            hourly_rate: 321,
            worker_assignments: [
              {
                worker_role: "Installer",
                worker_count: 1,
                hours_per_worker: 8,
                hourly_rate: 321,
              },
            ],
          },
        ],
      },
    },
    SETTINGS
  );
  ok("7. publish fields include internal plan", published.include);
  ok("7. publish strips rates from stored JSON", !JSON.stringify(published.fields.internal_operational_plan).includes("hourly_rate"));
  eq("7. publish estimated_days from max day_number", published.fields.estimated_days, 1);
  eq("7. publish snaps Saturday start", published.fields.start_date, "2026-09-07");

  const calls = [];
  async function mockSupabase(reqPath, opts) {
    calls.push({ path: String(reqPath), method: (opts && opts.method) || "GET", body: opts && opts.body });
    if (String(reqPath).startsWith("tenant_snapshots")) {
      return [{ payload: { storage: { mg_settings_v2: SETTINGS } } }];
    }
    if (String(reqPath).startsWith("quotes?") && (!opts || opts.method === "GET")) {
      if (String(reqPath).includes("tenant_id=eq." + TENANT_B)) return [];
      if (!String(reqPath).includes("tenant_id=eq." + TENANT_A)) return [];
      if (String(reqPath).includes("id=eq." + QUOTE_B)) return [];
      return [
        {
          id: QUOTE_A,
          tenant_id: TENANT_A,
          seller_membership_id: "mem-a",
          status: "READY_TO_SEND",
          start_date: "2026-09-07",
          internal_operational_plan: confirmed,
        },
      ];
    }
    if (opts && opts.method === "PATCH") {
      return [{ id: QUOTE_A, tenant_id: TENANT_A }];
    }
    return [];
  }

  const getOwn = await handleQuoteInternalOperationalPlan(
    { httpMethod: "GET", queryStringParameters: { quote_id: QUOTE_A } },
    {
      resolveOwnerOrSellerContext: async () => ownerCtx(TENANT_A),
      supabaseRequest: mockSupabase,
    }
  );
  eq("8. tenant A can read own plan", getOwn.statusCode, 200);
  const getOwnBody = JSON.parse(getOwn.body);
  ok("8. own GET returns document", Array.isArray(getOwnBody.document && getOwnBody.document.days));

  const getCross = await handleQuoteInternalOperationalPlan(
    { httpMethod: "GET", queryStringParameters: { quote_id: QUOTE_B } },
    {
      resolveOwnerOrSellerContext: async () => ownerCtx(TENANT_A),
      supabaseRequest: mockSupabase,
    }
  );
  eq("8. tenant A cannot read tenant B plan", getCross.statusCode, 404);
  ok(
    "8. GET always scopes tenant_id",
    calls.some((c) => c.method === "GET" && c.path.includes("tenant_id=eq." + TENANT_A) && c.path.includes("id=eq." + QUOTE_B))
  );

  const patchCallsBefore = calls.length;
  const postCross = await handleQuoteInternalOperationalPlan(
    {
      httpMethod: "POST",
      body: JSON.stringify({
        action: "confirm",
        quote_id: QUOTE_B,
        start_date: "2026-09-07",
        document: { days: sampleDays(), hourly_rate: 50 },
      }),
    },
    {
      resolveOwnerOrSellerContext: async () => ownerCtx(TENANT_A),
      supabaseRequest: mockSupabase,
    }
  );
  eq("8. tenant A cannot confirm tenant B plan", postCross.statusCode, 404);
  ok(
    "8. failed cross-tenant confirm does not PATCH",
    !calls.slice(patchCallsBefore).some((c) => c.method === "PATCH")
  );

  const postOwn = await handleQuoteInternalOperationalPlan(
    {
      httpMethod: "POST",
      body: JSON.stringify({
        action: "confirm",
        quote_id: QUOTE_A,
        start_date: "2026-09-07",
        document: {
          days: sampleDays(),
          hourly_rate: 88,
          notes: "should not land in quotes.notes",
        },
      }),
    },
    {
      resolveOwnerOrSellerContext: async () => ownerCtx(TENANT_A),
      supabaseRequest: mockSupabase,
    }
  );
  eq("8. tenant A can confirm own plan", postOwn.statusCode, 200);
  const patch = calls.find((c) => c.method === "PATCH");
  ok("8. confirm PATCH is tenant scoped", patch && String(patch.path).includes("tenant_id=eq." + TENANT_A));
  ok("8. confirm does not write quotes.notes", patch && patch.body && patch.body.notes === undefined);
  ok("8. confirm strips rates", patch && !JSON.stringify(patch.body).includes("hourly_rate"));
  eq("8. confirm estimated_days is max day_number", patch.body.estimated_days, 2);

  const endpointSrc = read("netlify/functions/quote-internal-operational-plan.js");
  const publishSrc = read("netlify/functions/publish-public-quote.js");
  const sendSrc = read("public/js/estimate-public-send.js");
  ok("9. internal plan endpoint never writes tenant_projects", !/tenant_projects/.test(endpointSrc));
  ok("9. publish-public-quote still does not create tenant_projects", !/tenant_projects/.test(publishSrc));
  ok("9. send pipeline does not create tenant_projects", !/tenant_projects/.test(sendSrc));
  deepEq("9. ACTIVE_STATUSES unchanged", ACTIVE_STATUSES, ["signed", "deposit_paid", "assigned", "in_progress"]);
  ok("9. send still does not treat publish as reservation", !/ACTIVE_STATUSES/.test(sendSrc));

  const moved = voice.moveDay(confirmedApply.applied.days, "day_stable_punch", -1);
  eq("10. move preserves punch day_id", moved.find((d) => d.day_id === "day_stable_punch").day_id, "day_stable_punch");
  eq("10. move punch up becomes day 2", moved.find((d) => d.day_id === "day_stable_punch").day_number, 2);
  const inserted = voice.insertDayAfter(moved, "day_stable_prep", 8);
  ok("10. insert keeps existing day_ids", inserted.some((d) => d.day_id === "day_stable_prep"));
  ok("10. insert adds a new stable day_id", inserted.some((d) => d.day_id && d.day_id !== "day_stable_prep" && d.day_id !== "day_stable_paint" && d.day_id !== "day_stable_punch"));
  const deleted = voice.deleteDay(inserted, "day_stable_paint");
  ok("10. delete removes by day_id", deleted.every((d) => d.day_id !== "day_stable_paint"));
  eq("10. delete renumbers remaining days", deleted[deleted.length - 1].day_number, deleted.length);

  const salesSrc = read("public/sales.html");
  ok("UI has Review & confirm plan", /btnReviewConfirmOperationalPlan/.test(salesSrc));
  ok("UI has Confirm and apply", /Confirm and apply/.test(salesSrc));
  ok("UI has dual preview columns", /voicePlanClientPreview/.test(salesSrc) && /voicePlanInternalPreview/.test(salesSrc));
  ok("migration file exists and is unapplied in repo", fs.existsSync(path.join(ROOT, "SUPABASE_QUOTES_INTERNAL_OPERATIONAL_PLAN.sql")));
  ok("migration comment forbids remote apply from this PR", /DO NOT apply this file to remote Supabase/.test(read("SUPABASE_QUOTES_INTERNAL_OPERATIONAL_PLAN.sql")));

  console.log("\nPassed " + passed + " assertions.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
