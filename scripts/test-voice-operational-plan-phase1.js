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
const {
  parseOperationalPublishFields,
  resolveHoursPerDayForLabor,
  persistPublishedInternalPlan,
} = require("../netlify/functions/publish-public-quote")._test;
const { handleQuoteInternalOperationalPlan } = require("../netlify/functions/quote-internal-operational-plan")._test;
const { pickPublicEstimateFields, QUOTE_PUBLIC_KEYS } = require("../netlify/functions/get-public-estimate")._test;
const { handlePublicEstimateStatus } = require("../netlify/functions/update-public-estimate-status")._test;
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

const SECRET_PHRASE = "MG_INTERNAL_SECRET_PHRASE_PHASE1_NEVER_PUBLIC";

function editableGuard() {
  return {
    ok: true,
    notFound: false,
    invalidQuoteId: false,
    edit: { is_editable: true, locked: false, lock_reasons: [], warnings: [] },
  };
}

function leakedQuoteRow(extra) {
  return Object.assign(
    {
      id: QUOTE_A,
      tenant_id: TENANT_A,
      title: "Job",
      notes: "Visible note",
      scope_of_work: "Paint living areas.",
      status: "sent",
      client_email: "client@example.com",
      client_name: "Ada",
      business_email: "biz@example.com",
      business_name: "Biz",
      total: 1000,
      deposit_required: 100,
      public_token: "publictoken12345",
      internal_operational_plan: {
        days: [{ internal_notes: SECRET_PHRASE, worker_assignments: [{ worker_count: 9, hours_per_worker: 8 }] }],
      },
      quote_internal_operational_plans: {
        document: { days: [{ internal_notes: SECRET_PHRASE }] },
      },
      internal_notes: SECRET_PHRASE,
      worker_assignments: [{ worker_count: 9 }],
      operational_plan: [
        {
          phase: SECRET_PHRASE,
          workers: [
            {
              worker_role: SECRET_PHRASE,
              worker_type: "pro",
              estimated_hours: 8,
            },
          ],
        },
      ],
    },
    extra || {}
  );
}

function assertNoSecret(label, value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  ok(label, !text.includes(SECRET_PHRASE));
}

function ownerCtx(tenantId) {
  return {
    auth_mode: "owner",
    tenant: { id: tenantId },
    membership: { id: "aaaaaaaa-aaaa-4aaa-8aaa-bbbbbbbbbbbb", role: "owner" },
  };
}

async function main() {
  [
    "netlify/functions/_lib/voice-operational-plan.js",
    "netlify/functions/_lib/quote-internal-operational-plan-store.js",
    "netlify/functions/quote-internal-operational-plan.js",
    "netlify/functions/publish-public-quote.js",
    "netlify/functions/get-public-estimate.js",
    "netlify/functions/update-public-estimate-status.js",
    "public/js/voice-operational-plan.js",
    "public/js/app.js",
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

  const leakedRow = leakedQuoteRow();
  const publicFields = pickPublicEstimateFields(leakedRow);
  ok("6. public estimate keys omit internal_operational_plan", !Object.prototype.hasOwnProperty.call(publicFields, "internal_operational_plan"));
  ok("6. public estimate keys omit quote_internal_operational_plans", !Object.prototype.hasOwnProperty.call(publicFields, "quote_internal_operational_plans"));
  ok("6. QUOTE_PUBLIC_KEYS omits internal plan", !QUOTE_PUBLIC_KEYS.includes("internal_operational_plan"));
  ok("6. QUOTE_PUBLIC_KEYS omits operational_plan", !QUOTE_PUBLIC_KEYS.includes("operational_plan"));
  const scrubbedEstimate = voice.sanitizePublicQuoteRow(voice.scrubPublicPayload(publicFields));
  ok("6. scrubbed public estimate has no risks/workers", !voice.publicPayloadContainsInternal(scrubbedEstimate));
  assertNoSecret("6. get-public-estimate fields omit secret phrase", scrubbedEstimate);
  const directlySanitizedRow = voice.sanitizePublicQuoteRow(leakedRow);
  ok(
    "6. public row strips legacy operational_plan",
    !Object.prototype.hasOwnProperty.call(directlySanitizedRow, "operational_plan")
  );
  ok(
    "6. public row strips legacy crew/hour fields recursively",
    !/workers|worker_role|worker_type|estimated_hours|hours_per_day_used/.test(
      JSON.stringify(directlySanitizedRow)
    )
  );
  assertNoSecret("6. public row strips secret stored in legacy operational_plan", directlySanitizedRow);

  const helpersSrc = read("public/js/estimate-send-helpers.js");
  ok("6. PDF helper no longer falls back to projectNotes", !/data\.projectNotes/.test(helpersSrc));
  ok("6. PDF helper no longer falls back to quoteNotes", !/data\.quoteNotes/.test(helpersSrc));
  const helperSandbox = { window: {}, console };
  helperSandbox.window.window = helperSandbox.window;
  vm.runInNewContext(helpersSrc + "\nthis.__H = window.__MG_ESTIMATE_SEND_HELPERS__;", helperSandbox);
  const pdfItems = helperSandbox.__H.resolvePublicPdfScopeItems({
    scope_of_work: "Day 1: Protect floors.",
    projectNotes: "Call GC before arriving. 2 workers 8 hours. Occupied home risk. " + SECRET_PHRASE,
    quoteNotes: "Do not bill extra hours. " + SECRET_PHRASE,
    internal_operational_plan: confirmedApply.applied,
    internal_notes: SECRET_PHRASE,
  });
  ok("6. PDF uses public scope", pdfItems.some((l) => /Protect floors/.test(l)));
  ok("6. PDF omits internal notes from notes fallback", pdfItems.every((l) => !/Do not bill extra hours/.test(l)));
  assertNoSecret("6. PDF items omit secret phrase", pdfItems);

  const zapierSrc = read("netlify/functions/send-quote-zapier.js");
  const zapierBodySlice = zapierSrc.slice(zapierSrc.indexOf("const zapierBody"), zapierSrc.indexOf("if (!String(zapierBody.public_quote_url"));
  ok("6. email/Zapier payload omits internal plan", !/internal_operational_plan|internal_notes|worker_assignments|quote_internal_operational_plans/.test(zapierBodySlice));
  ok("6. Zapier source never selects internal table", !/quote_internal_operational_plans/.test(zapierSrc));

  const getPublicSrc = read("netlify/functions/get-public-estimate.js");
  ok("6. public fetch select omits internal_operational_plan", !/internal_operational_plan/.test(getPublicSrc.split("QUOTE_PUBLIC_KEYS")[1].split("QUOTE_DATE_KEYS")[0]));
  ok("6. get-public-estimate never selects internal table", !/quote_internal_operational_plans/.test(getPublicSrc));
  ok("6. get-public-estimate sanitizes estimate payload", /sanitizePublicQuoteRow/.test(getPublicSrc));

  const acceptSrc = read("netlify/functions/update-public-estimate-status.js");
  ok("6. public accept sanitizes returned rows", (acceptSrc.match(/sanitizePublicQuoteRow/g) || []).length >= 4);
  ok("6. public accept never selects internal table", !/quote_internal_operational_plans/.test(acceptSrc));
  ok("6. accepted webhook allowlist omits internal plan", !/internal_operational_plan|internal_notes|worker_assignments/.test(acceptSrc.slice(acceptSrc.indexOf("const outbound"), acceptSrc.indexOf("originalPayloadJson"))));

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
      hours_per_day: 100,
      internal_operational_plan: {
        days: [
          {
            day_number: 1,
            client_scope: "Prep",
            hourly_rate: 321,
            hours_per_day_used: 100,
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
  ok("7. publish fields include derived plan", published.include);
  ok("7. quotes payload does not store internal_operational_plan", published.fields.internal_operational_plan == null);
  ok("7. publish keeps internal document off quotes fields", !Object.prototype.hasOwnProperty.call(published.fields, "internal_operational_plan"));
  ok("7. publish strips rates from dedicated document", !JSON.stringify(published.internalDocument).includes("hourly_rate"));
  eq("7. publish estimated_days from max day_number", published.fields.estimated_days, 1);
  eq("7. publish snaps Saturday start", published.fields.start_date, "2026-09-07");
  eq("7. body.hours_per_day 100 is ignored", published.internalDocument.hours_per_day_used, 8);
  eq("7. resolveHoursPerDayForLabor uses Business Settings", resolveHoursPerDayForLabor({ hoursPerDay: 8 }), 8);

  const hpdPublish = parseOperationalPublishFields(
    {
      hours_per_day: 100,
      operational_plan: [
        { day_number: 1, phase: "Prep", workers: [{ role: "Installer", estimated_days: 1 }] },
      ],
    },
    SETTINGS
  );
  eq("7. operational hours use tenant hoursPerDay not body 100", hpdPublish.fields.estimated_hours, 8);

  const tooManyDays = {
    days: Array.from({ length: voice.DOCUMENT_LIMITS.MAX_DAYS + 1 }, (_, i) => ({
      day_id: "day_" + i,
      day_number: i + 1,
      client_scope: "Scope",
      worker_assignments: [{ assignment_id: "asg_" + i, worker_count: 1, hours_per_worker: 8 }],
    })),
  };
  const limitDays = voice.validateIncomingDocument(tooManyDays);
  eq("7. too many days rejected", limitDays.ok, false);
  ok("7. too many days error code", limitDays.errors.some((e) => e.code === "too_many_days"));

  const dupIds = voice.validateIncomingDocument({
    days: [
      {
        day_id: "day_dup",
        day_number: 1,
        client_scope: "A",
        internal_tasks: [
          { task_id: "task_dup", label: "one" },
          { task_id: "task_dup", label: "two" },
        ],
        worker_assignments: [
          { assignment_id: "asg_dup", worker_count: 1, hours_per_worker: 8 },
          { assignment_id: "asg_dup", worker_count: 1, hours_per_worker: 8 },
        ],
      },
      {
        day_id: "day_dup",
        day_number: 2,
        client_scope: "B",
        worker_assignments: [{ assignment_id: "asg_other", worker_count: 1, hours_per_worker: 8 }],
      },
    ],
  });
  eq("7. duplicate ids rejected", dupIds.ok, false);
  ok("7. duplicate day_id", dupIds.errors.some((e) => e.code === "duplicate_day_id"));
  ok("7. duplicate task_id", dupIds.errors.some((e) => e.code === "duplicate_task_id"));
  ok("7. duplicate assignment_id", dupIds.errors.some((e) => e.code === "duplicate_assignment_id"));

  const invalidWorkers = voice.validateIncomingDocument({
    days: [
      {
        day_id: "day_bad",
        day_number: 1,
        worker_assignments: [{ worker_count: 99, hours_per_worker: 40 }],
      },
    ],
  });
  eq("7. invalid workers/hours rejected", invalidWorkers.ok, false);
  ok("7. worker_count limit", invalidWorkers.errors.some((e) => e.code === "invalid_worker_count"));
  ok("7. hours_per_worker limit", invalidWorkers.errors.some((e) => e.code === "invalid_hours_per_worker"));

  const calls = [];
  async function mockSupabase(reqPath, opts) {
    calls.push({ path: String(reqPath), method: (opts && opts.method) || "GET", body: opts && opts.body });
    if (String(reqPath).startsWith("tenant_snapshots")) {
      return [{ payload: { storage: { mg_settings_v2: SETTINGS } } }];
    }
    if (String(reqPath) === "rpc/mg_confirm_quote_operational_plan") {
      return { ok: true, persisted: true, quote_id: opts && opts.body && opts.body.p_quote_id };
    }
    if (String(reqPath).startsWith("quote_internal_operational_plans")) {
      if (!String(reqPath).includes("tenant_id=eq." + TENANT_A) && (opts && opts.method !== "POST")) return [];
      if (opts && (opts.method === "POST" || opts.method === "PATCH")) {
        return [{ id: "plan-a", quote_id: QUOTE_A, tenant_id: TENANT_A, document: opts.body && opts.body.document }];
      }
      return [
        {
          id: "plan-a",
          quote_id: QUOTE_A,
          tenant_id: TENANT_A,
          document: confirmed,
          schema_version: 1,
        },
      ];
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
        },
      ];
    }
    if (opts && opts.method === "PATCH") {
      return [{ id: QUOTE_A, tenant_id: TENANT_A }];
    }
    return [];
  }

  const planDeps = {
    resolveOwnerOrSellerContext: async () => ownerCtx(TENANT_A),
    supabaseRequest: mockSupabase,
    evaluateQuoteEditGuard: async () => editableGuard(),
  };

  const getOwn = await handleQuoteInternalOperationalPlan(
    { httpMethod: "GET", queryStringParameters: { quote_id: QUOTE_A } },
    planDeps
  );
  eq("8. tenant A can read own plan", getOwn.statusCode, 200);
  const getOwnBody = JSON.parse(getOwn.body);
  ok("8. own GET returns document", Array.isArray(getOwnBody.document && getOwnBody.document.days));

  const getCross = await handleQuoteInternalOperationalPlan(
    { httpMethod: "GET", queryStringParameters: { quote_id: QUOTE_B } },
    planDeps
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
    planDeps
  );
  eq("8. tenant A cannot confirm tenant B plan", postCross.statusCode, 404);
  ok(
    "8. failed cross-tenant confirm does not PATCH",
    !calls.slice(patchCallsBefore).some((c) => c.method === "PATCH" || c.method === "POST")
  );

  const postOwn = await handleQuoteInternalOperationalPlan(
    {
      httpMethod: "POST",
      body: JSON.stringify({
        action: "confirm",
        quote_id: QUOTE_A,
        hours_per_day: 100,
        start_date: "2026-09-07",
        document: {
          days: sampleDays(),
          hourly_rate: 88,
          notes: "should not land in quotes.notes",
          hours_per_day_used: 100,
        },
      }),
    },
    planDeps
  );
  eq("8. tenant A can confirm own plan", postOwn.statusCode, 200);
  const ownBody = JSON.parse(postOwn.body);
  eq("8. confirm persisted=true", ownBody.persisted, true);
  eq("8. confirm ok=true", ownBody.ok, true);
  eq("8. confirm hours_per_day from settings not body 100", ownBody.document.hours_per_day_used, 8);
  const atomicWrite = calls.find((c) => c.method === "POST" && c.path === "rpc/mg_confirm_quote_operational_plan");
  ok("8. confirm uses one atomic RPC", !!atomicWrite);
  eq("8. atomic RPC is tenant scoped", atomicWrite.body.p_tenant_id, TENANT_A);
  eq("8. atomic RPC is quote scoped", atomicWrite.body.p_quote_id, QUOTE_A);
  ok("8. confirm does not write quotes.notes", atomicWrite.body.notes === undefined);
  ok("8. confirm does not write quotes.internal_operational_plan", atomicWrite.body.internal_operational_plan === undefined);
  ok("8. confirm strips rates from atomic payload", !JSON.stringify(atomicWrite.body).includes("hourly_rate"));
  eq("8. confirm estimated_days is max day_number", atomicWrite.body.p_estimated_days, 2);
  ok("8. confirm persists dedicated document through RPC", !!atomicWrite.body.p_document);

  const lockedRes = await handleQuoteInternalOperationalPlan(
    {
      httpMethod: "POST",
      body: JSON.stringify({ action: "confirm", quote_id: QUOTE_A, document: { days: sampleDays() } }),
    },
    {
      ...planDeps,
      evaluateQuoteEditGuard: async () => ({
        ok: true,
        edit: { is_editable: false, locked: true, lock_reasons: ["quote_archived_status"], warnings: [] },
      }),
    }
  );
  eq("8. locked quote cannot confirm", lockedRes.statusCode, 422);
  eq("8. locked persisted=false", JSON.parse(lockedRes.body).persisted, false);
  eq("8. locked code", JSON.parse(lockedRes.body).code, "quote_locked");

  const acceptedRes = await handleQuoteInternalOperationalPlan(
    {
      httpMethod: "POST",
      body: JSON.stringify({ action: "confirm", quote_id: QUOTE_A, document: { days: sampleDays() } }),
    },
    {
      ...planDeps,
      evaluateQuoteEditGuard: async () => ({
        ok: true,
        edit: { is_editable: false, locked: true, lock_reasons: ["quote_accepted_status"], warnings: [] },
      }),
    }
  );
  eq("8. accepted quote cannot confirm", acceptedRes.statusCode, 422);
  eq("8. accepted persisted=false", JSON.parse(acceptedRes.body).persisted, false);

  const writesBeforeSent = calls.length;
  const sentRes = await handleQuoteInternalOperationalPlan(
    {
      httpMethod: "POST",
      body: JSON.stringify({ action: "confirm", quote_id: QUOTE_A, document: { days: sampleDays() } }),
    },
    {
      ...planDeps,
      evaluateQuoteEditGuard: async () => ({
        ok: true,
        edit: { is_editable: true, locked: false, lock_reasons: [], warnings: ["quote_viewed_or_sent"] },
      }),
    }
  );
  eq("8. sent/viewed without flag is 409", sentRes.statusCode, 409);
  eq("8. sent/viewed code", JSON.parse(sentRes.body).code, "sent_quote_confirmation_required");
  eq("8. sent/viewed persisted=false", JSON.parse(sentRes.body).persisted, false);
  ok(
    "8. sent/viewed without flag does not write",
    !calls.slice(writesBeforeSent).some(
      (c) => c.method === "PATCH" || (c.method === "POST" && String(c.path).includes("mg_confirm_quote_operational_plan"))
    )
  );

  const sentConfirm = await handleQuoteInternalOperationalPlan(
    {
      httpMethod: "POST",
      body: JSON.stringify({
        action: "confirm",
        quote_id: QUOTE_A,
        confirm_sent_update: true,
        document: { days: sampleDays() },
      }),
    },
    {
      ...planDeps,
      evaluateQuoteEditGuard: async () => ({
        ok: true,
        edit: { is_editable: true, locked: false, lock_reasons: [], warnings: ["quote_viewed_or_sent"] },
      }),
    }
  );
  eq("8. sent/viewed with explicit confirm persists", sentConfirm.statusCode, 200);
  eq("8. sent/viewed confirm persisted=true", JSON.parse(sentConfirm.body).persisted, true);

  const missingTable = await handleQuoteInternalOperationalPlan(
    {
      httpMethod: "POST",
      body: JSON.stringify({ action: "confirm", quote_id: QUOTE_A, document: { days: sampleDays() } }),
    },
    {
      ...planDeps,
      supabaseRequest: async (reqPath, opts) => {
        if (String(reqPath) === "rpc/mg_confirm_quote_operational_plan") {
          const err = new Error("Could not find the function public.mg_confirm_quote_operational_plan in the schema cache (PGRST202)");
          throw err;
        }
        return mockSupabase(reqPath, opts);
      },
    }
  );
  eq("8. missing table is 503 not success", missingTable.statusCode, 503);
  const missingBody = JSON.parse(missingTable.body);
  eq("8. missing table persisted=false", missingBody.persisted, false);
  eq("8. missing table column_missing", missingBody.column_missing, true);

  const failedAtomic = await handleQuoteInternalOperationalPlan(
    {
      httpMethod: "POST",
      body: JSON.stringify({ action: "confirm", quote_id: QUOTE_A, document: { days: sampleDays() } }),
    },
    {
      ...planDeps,
      confirmOperationalPlanAtomic: async () => {
        throw new Error("transaction aborted");
      },
    }
  );
  eq("8. atomic confirm failure is not success", failedAtomic.statusCode, 500);
  eq("8. atomic confirm failure persisted=false", JSON.parse(failedAtomic.body).persisted, false);

  const publishAtomicCalls = [];
  const publishArgs = {
    tenantId: TENANT_A,
    quoteId: QUOTE_A,
    document: confirmed,
    membershipId: null,
    quotePatch: {
      operational_plan: voice.deriveLegacyOperationalPlan(confirmed),
      estimated_days: confirmed.estimated_days,
      estimated_hours: confirmed.estimated_hours,
      start_date: confirmed.start_date,
      due_date: confirmed.due_date,
      scope_of_work: voice.buildPublicClientScope(confirmed).narrative,
    },
  };
  const publishRollback = await persistPublishedInternalPlan(
    async (reqPath, opts) => {
      publishAtomicCalls.push({ path: String(reqPath), method: (opts && opts.method) || "GET" });
      if (String(reqPath).startsWith("rpc/")) throw new Error("transaction aborted");
      if (opts && opts.method === "DELETE") return [{ id: QUOTE_A }];
      return [];
    },
    publishArgs
  );
  eq("8. publish persistence failure is not success", publishRollback.ok, false);
  eq("8. publish rollback makes retry safe", publishRollback.retrySafe, true);
  eq("8. publish rollback needs no manual repair", publishRollback.needsManualRepair, false);
  ok(
    "8. publish rollback deletes only the new tenant-scoped quote",
    publishAtomicCalls.some(
      (c) => c.method === "DELETE" && c.path.includes("id=eq." + QUOTE_A) && c.path.includes("tenant_id=eq." + TENANT_A)
    )
  );

  const publishRollbackFailed = await persistPublishedInternalPlan(
    async (reqPath, opts) => {
      if (String(reqPath).startsWith("rpc/")) throw new Error("transaction aborted");
      if (opts && opts.method === "DELETE") throw new Error("rollback blocked");
      return [];
    },
    publishArgs
  );
  eq("8. failed publish rollback remains non-success", publishRollbackFailed.ok, false);
  eq("8. failed publish rollback is not retry safe", publishRollbackFailed.retrySafe, false);
  eq("8. failed publish rollback flags manual repair", publishRollbackFailed.needsManualRepair, true);

  let publishDeleteCount = 0;
  const publishAtomicOk = await persistPublishedInternalPlan(
    async (reqPath, opts) => {
      if (opts && opts.method === "DELETE") publishDeleteCount += 1;
      return { ok: true, persisted: true, quote_id: QUOTE_A };
    },
    publishArgs
  );
  eq("8. successful publish atomic persistence succeeds", publishAtomicOk.ok, true);
  eq("8. successful publish never rolls back quote", publishDeleteCount, 0);

  const endpointSrc = read("netlify/functions/quote-internal-operational-plan.js");
  const publishSrc = read("netlify/functions/publish-public-quote.js");
  const sendSrc = read("public/js/estimate-public-send.js");
  ok("9. internal plan endpoint never writes tenant_projects", !/tenant_projects/.test(endpointSrc));
  ok("9. endpoint uses evaluateQuoteEditGuard", /evaluateQuoteEditGuard/.test(endpointSrc));
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

  const acceptToken = "publictoken12345";
  const acceptDepsBase = {
    getSupabaseConfig: () => ({ url: "https://example.supabase.co", key: "service" }),
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => "" }),
    sendEstimateAcceptedWebhook: async () => ({ sent: false, skipped: true }),
    applyOperationalSnapshotForProject: async () => {},
  };
  const alreadyAccepted = await handlePublicEstimateStatus(
    { httpMethod: "POST", body: JSON.stringify({ token: acceptToken, status: "accepted" }) },
    {
      ...acceptDepsBase,
      fetchQuoteByPublicToken: async () => leakedQuoteRow({ status: "accepted", accepted_at: "2026-09-01T00:00:00.000Z" }),
      bridgeAcceptedQuoteToProject: async () => ({ ok: true, project_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", reserved: true }),
    }
  );
  eq("11. already-accepted returns 200", alreadyAccepted.statusCode, 200);
  assertNoSecret("11. already-accepted row omits secret", JSON.parse(alreadyAccepted.body));

  const acceptedOk = await handlePublicEstimateStatus(
    { httpMethod: "POST", body: JSON.stringify({ token: acceptToken, status: "accepted" }) },
    {
      ...acceptDepsBase,
      fetchQuoteByPublicToken: async () => leakedQuoteRow({ status: "sent" }),
      assertQuoteScheduleAvailable: async (row) => ({ proposed: { start_date: row.start_date } }),
      tryAtomicAcceptQuoteReservingSchedule: async () => ({
        ok: true,
        project_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        action: "create",
      }),
    }
  );
  eq("11. accept success returns 200", acceptedOk.statusCode, 200);
  assertNoSecret("11. accept success row omits secret", JSON.parse(acceptedOk.body));

  const declined = await handlePublicEstimateStatus(
    { httpMethod: "POST", body: JSON.stringify({ token: acceptToken, status: "declined" }) },
    {
      ...acceptDepsBase,
      fetchQuoteByPublicToken: async () => leakedQuoteRow({ status: "sent" }),
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify([leakedQuoteRow({ status: "declined" })]),
      }),
    }
  );
  eq("11. decline returns 200", declined.statusCode, 200);
  assertNoSecret("11. decline row omits secret", JSON.parse(declined.body));

  const salesSrc = read("public/sales.html");
  ok("UI has Review & confirm plan", /btnReviewConfirmOperationalPlan/.test(salesSrc));
  const appSrc = read("public/js/app.js");
  const appBelowMatch = appSrc.match(
    /function isSalesPriceBelowRecommendation\(metrics\) \{([\s\S]*?)\n  \}/
  );
  ok("owner recommendation-status comparator is available", appBelowMatch);
  const appBelow = vm.runInNewContext(
    "(function isSalesPriceBelowRecommendation(metrics) {" + appBelowMatch[1] + "\n})"
  );
  eq("owner equal current/recommended is ready", appBelow({ offered: 6342.9, recommended: 6342.9 }), false);
  eq("owner lower current is below recommendation", appBelow({ offered: 6300, recommended: 6342.9 }), true);

  const sellerBelowMatch = salesSrc.match(
    /function isSellerPriceBelowRecommendation\(metrics\) \{([\s\S]*?)\n      \}/
  );
  ok("seller recommendation-status comparator is available", sellerBelowMatch);
  const sellerBelow = vm.runInNewContext(
    "(function isSellerPriceBelowRecommendation(metrics) {" + sellerBelowMatch[1] + "\n})"
  );
  eq("seller equal current/recommended is ready", sellerBelow({ offered: 6342.9, recommended: 6342.9 }), false);
  eq("seller lower current is below recommendation", sellerBelow({ offered: 6300, recommended: 6342.9 }), true);

  ok(
    "flow headline uses direct price-position result instead of margin advisory",
    /salesFlowHeadline[\s\S]{0,180}belowRecommendation \? ["']Below recommendation["']/.test(appSrc) &&
      /salesFlowHeadline[\s\S]{0,180}belowRecommendation \? 'Bajo recomendado'/.test(salesSrc)
  );
  ok(
    "seller layout completeness requires Review & confirm plan",
    /function isDirectSellerDomLayoutComplete[\s\S]{0,2500}querySelector\('#btnReviewConfirmOperationalPlan'\)/.test(salesSrc)
  );
  ok(
    "seller owner rebuild preserves or restores Review & confirm plan",
    /function ensureSellerOperationalPlanReviewButton\(actionBar, existingButton\)/.test(salesSrc) &&
      /id="btnReviewConfirmOperationalPlan"/.test(salesSrc) &&
      /Review &(?:amp;)? confirm plan/.test(salesSrc) &&
      /var reviewPlanBtn = document\.getElementById\('btnReviewConfirmOperationalPlan'\);/.test(salesSrc) &&
      /ensureSellerOperationalPlanReviewButton\(actionBar, reviewPlanBtn\)/.test(salesSrc) &&
      /var addDayWrap = left\.querySelector\('\.inline-actions'\);[\s\S]{0,250}var reviewPlanBtn = document\.getElementById\('btnReviewConfirmOperationalPlan'\);/.test(salesSrc)
  );
  ok(
    "restored Review & confirm plan opens the preview modal",
    /function bindVoicePlanReviewButton\(reviewBtn\)[\s\S]{0,450}openVoicePlanPreviewModal\(\)/.test(salesSrc) &&
      /function bindVoicePlanPreviewStandalone\(\)[\s\S]{0,180}bindVoicePlanReviewButton\(/.test(salesSrc)
  );
  ok("UI has Confirm and apply", /Confirm and apply/.test(salesSrc));
  ok("UI has dual preview columns", /voicePlanClientPreview/.test(salesSrc) && /voicePlanInternalPreview/.test(salesSrc));
  ok("UI waits for persisted=true before applying", /data\.persisted === true/.test(salesSrc));
  ok("UI shows Saving… while persisting", /Saving…/.test(salesSrc));
  ok("UI does not apply on fire-and-forget fetch", !/\.catch\(function \(\) \{ \/\* local confirm already applied/.test(salesSrc));
  ok("UI requires confirm_sent_update retry", /confirm_sent_update/.test(salesSrc));
  ok("old quotes.internal_operational_plan migration is gone", !fs.existsSync(path.join(ROOT, "SUPABASE_QUOTES_INTERNAL_OPERATIONAL_PLAN.sql")));
  ok("dedicated table migration exists", fs.existsSync(path.join(ROOT, "SUPABASE_QUOTE_INTERNAL_OPERATIONAL_PLANS.sql")));
  const sql = read("SUPABASE_QUOTE_INTERNAL_OPERATIONAL_PLANS.sql");
  ok("migration comment forbids remote apply from this PR", /DO NOT apply this file to remote Supabase/.test(sql));
  ok("migration enables RLS", /enable row level security/.test(sql));
  ok("migration revokes anon/authenticated", /revoke all on table public\.quote_internal_operational_plans from anon/.test(sql) && /from authenticated/.test(sql));
  ok("migration grants service_role only", /grant select, insert, update, delete on table public\.quote_internal_operational_plans to service_role/.test(sql));
  ok("migration checks document is object", /jsonb_typeof\(document\) = 'object'/.test(sql));
  ok("migration defines atomic confirm RPC", /create or replace function public\.mg_confirm_quote_operational_plan/.test(sql));
  ok("atomic RPC locks the tenant quote", /q\.tenant_id = p_tenant_id[\s\S]*for update/.test(sql));
  ok("atomic RPC updates quote and internal row in one function", /update public\.quotes[\s\S]*insert into public\.quote_internal_operational_plans/.test(sql));
  ok("atomic RPC rechecks accepted status while quote is locked", /v_quote\.accepted_at is not null/.test(sql));
  ok("atomic RPC rechecks projects and payments", /from public\.tenant_projects[\s\S]*from public\.tenant_project_payments/.test(sql));
  ok("atomic RPC uses SECURITY INVOKER", /security invoker/.test(sql) && !/security definer/.test(sql));
  ok("atomic RPC search_path is empty", /set search_path = ''/.test(sql));
  ok("atomic RPC does not call auth.role()", !/auth\.role\s*\(/.test(sql));
  ok("atomic RPC revokes PUBLIC execute", /revoke all on function public\.mg_confirm_quote_operational_plan[\s\S]*from public/.test(sql));
  ok("atomic RPC revokes anon execute", /revoke all on function public\.mg_confirm_quote_operational_plan[\s\S]*from anon/.test(sql));
  ok("atomic RPC revokes authenticated execute", /revoke all on function public\.mg_confirm_quote_operational_plan[\s\S]*from authenticated/.test(sql));
  ok("atomic RPC grants only service_role execute", /grant execute on function public\.mg_confirm_quote_operational_plan[\s\S]*to service_role/.test(sql));
  ok("atomic RPC has no execute grant except service_role", !/grant execute on function public\.mg_confirm_quote_operational_plan[\s\S]*to (public|anon|authenticated)\b/.test(sql));

  console.log("\nPassed " + passed + " assertions.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
