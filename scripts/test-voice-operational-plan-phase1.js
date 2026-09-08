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
const Module = require("module");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const voice = require("../netlify/functions/_lib/voice-operational-plan");
const {
  parseOperationalPublishFields,
  resolveHoursPerDayForLabor,
  persistPublishedInternalPlan,
} = require("../netlify/functions/publish-public-quote")._test;
const {
  buildConfirmRpcBody,
  membershipIdForRpc,
  confirmOperationalPlanAtomic,
} = require("../netlify/functions/_lib/quote-internal-operational-plan-store");
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

function bathroomPlanDocument() {
  return {
    days: [
      { day_number: 1, client_scope: "Protect floors, hallways, and walls" },
      { day_number: 2, client_scope: "Demolition and preparation" },
      { day_number: 3, client_scope: "Waterproof + pan" },
      { day_number: 4, client_scope: "Tile install" },
      { day_number: 5, client_scope: "Grout + glass prep" },
    ],
  };
}

function jsonRes(status, data) {
  const text = JSON.stringify(data);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
  };
}

function throwIfUntypedRpcNulls(body) {
  const keys = [
    "p_membership_id",
    "p_scope_of_work",
    "p_start_date",
    "p_due_date",
    "p_estimated_days",
    "p_estimated_hours",
  ];
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(body, key) && body[key] == null) {
      const err = new Error(
        "Could not find the function public.mg_confirm_quote_operational_plan in the schema cache (PGRST202)"
      );
      err.status = 404;
      throw err;
    }
  }
}

function bustNetlifyFunctionsCache() {
  for (const key of Object.keys(require.cache)) {
    if (key.replace(/\\/g, "/").includes("/netlify/functions/")) {
      delete require.cache[key];
    }
  }
}

async function runOwnerInternalPlanPublishHandlerTests() {
  const originalLoad = Module._load;
  const originalFetch = globalThis.fetch;
  const envBackup = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    URL: process.env.URL,
  };
  const FAKE_QUOTE_ID = "22222222-2222-4222-8222-222222222222";
  const OWNER_PROFILE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-bbbbbbbbbbbb";
  const SELLER_MEMBERSHIP_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const insertCalls = [];
  const rpcBodies = [];
  const rpcPrefers = [];
  const allocatePrefers = [];
  const quoteInsertPrefers = [];
  const profileCalls = [];
  const deleteCalls = [];
  let rpcShouldFail = false;
  let authCtx = {
    auth_mode: "owner",
    tenant: { id: TENANT_A },
    session: { e: "owner@test.example" },
  };

  process.env.SUPABASE_URL = "http://127.0.0.1:9";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "isolated-owner-plan-service-role";
  process.env.URL = "https://marginguardsystem.netlify.app";

  async function mockFetch(url, options) {
    const u = String(url);
    const method = String((options && options.method) || "GET").toUpperCase();
    if (/netlify|zapier/i.test(u) || !u.startsWith("http://127.0.0.1:9")) {
      throw new Error("blocked non-isolated fetch: " + u);
    }
    const parsed = new URL(u);
    const pathname = parsed.pathname;
    const body = options && options.body ? JSON.parse(options.body) : {};

    if (pathname === "/rest/v1/tenant_snapshots") {
      return jsonRes(200, [
        {
          payload: {
            storage: {
              mg_settings_v2: {
                hoursPerDay: 8,
                baseInstaller: 75,
                baseHelper: 45,
                wcPct: 0,
                ficaPct: 0,
                futaPct: 0,
                casuiPct: 0,
                stdHours: 160,
                overheadMonthly: 0,
                profitPct: 30,
                reservePct: 5,
              },
            },
          },
        },
      ]);
    }
    if (pathname === "/rest/v1/rpc/allocate_next_quote_number") {
      allocatePrefers.push(options && options.headers && options.headers.Prefer);
      return jsonRes(200, {
        quote_year: 2026,
        quote_sequence: 1,
        quote_number_display: "2026-001",
      });
    }
    if (pathname === "/rest/v1/rpc/mg_confirm_quote_operational_plan") {
      rpcPrefers.push(options && options.headers && options.headers.Prefer);
      rpcBodies.push(body);
      if (rpcShouldFail === "pgrst202-omitted-membership") {
        if (!Object.prototype.hasOwnProperty.call(body, "p_membership_id")) {
          return {
            ok: false,
            status: 404,
            text: async () =>
              JSON.stringify({
                code: "PGRST202",
                message:
                  "Could not find the function public.mg_confirm_quote_operational_plan(p_tenant_id, p_quote_id, p_document, p_schema_version, p_operational_plan, p_estimated_days, p_estimated_hours, p_start_date, p_due_date) in the schema cache",
                details:
                  "Searched for the function public.mg_confirm_quote_operational_plan with named parameters p_tenant_id, p_quote_id, p_document, p_schema_version, p_operational_plan, p_estimated_days, p_estimated_hours, p_start_date, p_due_date, but no matches were found in the schema cache.",
              }),
          };
        }
      }
      if (rpcShouldFail === true) {
        return {
          ok: false,
          status: 500,
          text: async () =>
            JSON.stringify({
              code: "22023",
              message: "p_operational_plan must be a JSON array",
            }),
        };
      }
      try {
        throwIfUntypedRpcNulls(body);
      } catch (err) {
        return {
          ok: false,
          status: 404,
          text: async () =>
            JSON.stringify({
              code: "PGRST202",
              message: err.message,
            }),
        };
      }
      return jsonRes(200, {
        ok: true,
        persisted: true,
        quote_id: body.p_quote_id || FAKE_QUOTE_ID,
      });
    }
    if (pathname === "/rest/v1/profiles") {
      profileCalls.push(u);
      return jsonRes(200, [{ id: OWNER_PROFILE_ID }]);
    }
    if (pathname === "/rest/v1/tenants" || pathname === "/rest/v1/tenant_branding") {
      return jsonRes(200, []);
    }
    if (pathname === "/rest/v1/quotes" && method === "GET") {
      return jsonRes(200, []);
    }
    if (pathname === "/rest/v1/quotes" && method === "POST") {
      quoteInsertPrefers.push(options && options.headers && options.headers.Prefer);
      insertCalls.push(body);
      return jsonRes(201, [{ id: FAKE_QUOTE_ID, tenant_id: TENANT_A, total: body.total }]);
    }
    if (pathname === "/rest/v1/quotes" && method === "DELETE") {
      deleteCalls.push(u);
      return jsonRes(200, [{ id: FAKE_QUOTE_ID }]);
    }
    if (pathname === "/rest/v1/tenant_contacts") {
      return jsonRes(200, []);
    }
    throw new Error("unexpected isolated fetch: " + method + " " + u);
  }

  Module._load = function patchedLoad(request, parent, isMain) {
    const n = String(request || "").replace(/\\/g, "/");
    if (n === "./_lib/tenant-device-guard" || n.endsWith("/_lib/tenant-device-guard")) {
      return {
        resolveOwnerOrSellerContext: async () => authCtx,
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  globalThis.fetch = mockFetch;

  try {
    bustNetlifyFunctionsCache();
    const publishMod = require("../netlify/functions/publish-public-quote");
    const publishBody = {
      workers: [{ name: "Pro 1", type: "installer", days: 0, hours: 50 }],
      pricing_stage: 2,
      project_name: "Bathroom remodel",
      client_name: "Test Client",
      client_email: "client@test.example",
      start_date: "2026-09-10",
      target_finish_date: "2026-09-16",
      status: "READY_TO_SEND",
      internal_operational_plan: bathroomPlanDocument(),
    };

    insertCalls.length = 0;
    rpcBodies.length = 0;
    rpcPrefers.length = 0;
    allocatePrefers.length = 0;
    quoteInsertPrefers.length = 0;
    profileCalls.length = 0;
    deleteCalls.length = 0;
    rpcShouldFail = false;
    const okRes = await publishMod.handler({
      httpMethod: "POST",
      headers: {},
      body: JSON.stringify(publishBody),
    });
    const okBody = JSON.parse(okRes.body || "{}");
    eq("8. owner internal-plan publish status 200", okRes.statusCode, 200);
    eq("8. owner internal-plan publish inserts once", insertCalls.length, 1);
    eq("8. owner internal-plan publish calls confirm RPC once", rpcBodies.length, 1);
    eq("8. owner internal-plan publish does not rollback", deleteCalls.length, 0);
    eq("8. owner RPC omits p_membership_id when session has no membership", Object.prototype.hasOwnProperty.call(rpcBodies[0] || {}, "p_membership_id"), false);
    eq("8. owner publish never looks up profiles.id as a stand-in uuid", profileCalls.length, 0);
    eq("8. owner confirm RPC omits Prefer return=representation", rpcPrefers[0], undefined);
    eq("8. allocate_next_quote_number still sends Prefer return=representation", allocatePrefers[0], "return=representation");
    eq("8. quotes INSERT still sends Prefer return=representation", quoteInsertPrefers[0], "return=representation");
    ok("8. owner publish returns public_url for Zapier", Boolean(okBody.public_url && okBody.quote_id && okBody.public_token));

    insertCalls.length = 0;
    rpcBodies.length = 0;
    deleteCalls.length = 0;
    rpcShouldFail = "pgrst202-omitted-membership";
    const secondRetryRes = await publishMod.handler({
      httpMethod: "POST",
      headers: {},
      body: JSON.stringify(publishBody),
    });
    const secondRetryBody = JSON.parse(secondRetryRes.body || "{}");
    eq("8. second production retry is 503", secondRetryRes.statusCode, 503);
    eq("8. second production retry still omits p_membership_id for Owner", Object.prototype.hasOwnProperty.call(rpcBodies[0] || {}, "p_membership_id"), false);
    eq("8. second production retry rolls back the inserted quote", deleteCalls.length, 1);
    ok("8. second production retry never returns public_url so Zapier is not called", !secondRetryBody.public_url && !secondRetryBody.public_token);
    eq("8. second production retry code is internal_plan_persist_failed", secondRetryBody.code, "internal_plan_persist_failed");
    ok(
      "8. second production retry message is actionable",
      /operational plan could not be saved/i.test(String(secondRetryBody.error || ""))
    );

    insertCalls.length = 0;
    rpcBodies.length = 0;
    profileCalls.length = 0;
    deleteCalls.length = 0;
    rpcShouldFail = false;
    authCtx = {
      auth_mode: "device",
      tenant: { id: TENANT_A },
      membership: { id: SELLER_MEMBERSHIP_ID },
      session: null,
    };
    const sellerRes = await publishMod.handler({
      httpMethod: "POST",
      headers: {},
      body: JSON.stringify(publishBody),
    });
    const sellerBody = JSON.parse(sellerRes.body || "{}");
    eq("8. seller internal-plan publish status 200", sellerRes.statusCode, 200);
    eq("8. seller RPC sends session membership id", sellerBody && rpcBodies[0] && rpcBodies[0].p_membership_id, SELLER_MEMBERSHIP_ID);
    eq("8. seller publish never looks up profiles as a stand-in", profileCalls.length, 0);
    ok("8. seller publish returns public_url", Boolean(sellerBody.public_url && sellerBody.quote_id));

    insertCalls.length = 0;
    rpcBodies.length = 0;
    deleteCalls.length = 0;
    rpcShouldFail = true;
    authCtx = {
      auth_mode: "owner",
      tenant: { id: TENANT_A },
      session: { e: "owner@test.example" },
    };
    const failRes = await publishMod.handler({
      httpMethod: "POST",
      headers: {},
      body: JSON.stringify(publishBody),
    });
    const failBody = JSON.parse(failRes.body || "{}");
    eq("8. persist failure is 503", failRes.statusCode, 503);
    eq("8. persist failure rolls back the new quote", deleteCalls.length, 1);
    eq("8. persist failure inserts once", insertCalls.length, 1);
    ok("8. persist failure omits public_url so Zapier is not called", !failBody.public_url && !failBody.public_token);
    eq("8. persist failure code is internal_plan_persist_failed", failBody.code, "internal_plan_persist_failed");
    ok(
      "8. persist failure message is actionable",
      /operational plan could not be saved/i.test(String(failBody.error || ""))
    );
    ok("8. persist failure does not include SQL file names", !/SUPABASE_/i.test(String(failBody.error || "")));
  } finally {
    Module._load = originalLoad;
    globalThis.fetch = originalFetch;
    process.env.SUPABASE_URL = envBackup.SUPABASE_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = envBackup.SUPABASE_SERVICE_ROLE_KEY;
    process.env.URL = envBackup.URL;
    bustNetlifyFunctionsCache();
  }
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

  const cap = globalThis.MarginGuardSalesCapacity;
  const futureSafeDate = "2099-09-11";
  const advisoryCalendar = {
    next_available_start_date: futureSafeDate,
    crew_availability_mode: "advisory",
  };
  const strictCalendar = {
    next_available_start_date: futureSafeDate,
    crew_availability_mode: "strict",
  };
  eq("5. advisory picker minimum is today", cap.effectiveStartMin(advisoryCalendar), cap.todayYmd());
  eq("5. advisory safe recommendation stays visible", cap.recommendedStart(advisoryCalendar), futureSafeDate);
  eq("5. strict picker minimum enforces safe date", cap.effectiveStartMin(strictCalendar), futureSafeDate);
  eq("5. strict safe recommendation stays visible", cap.recommendedStart(strictCalendar), futureSafeDate);
  eq("5. advisory tentative start is not blocked", cap.isStartBlocked(advisoryCalendar, cap.todayYmd()), false);
  eq("5. strict early start remains blocked", cap.isStartBlocked(strictCalendar, cap.todayYmd()), true);

  const advisoryInput = {
    value: cap.todayYmd(),
    min: "",
    setAttribute(name, value) {
      if (name === "min") this.min = value;
    },
  };
  const reconciledAdvisory = cap.reconcileStartDateWithCapacity(advisoryCalendar, advisoryInput, {});
  eq("5. advisory reconciliation leaves today selectable", advisoryInput.min, cap.todayYmd());
  eq("5. advisory reconciliation preserves selected date", reconciledAdvisory.value, cap.todayYmd());

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

  const ownerRpcBody = buildConfirmRpcBody({
    tenantId: TENANT_A,
    quoteId: QUOTE_A,
    document: confirmed,
    membershipId: null,
    quotePatch: publishArgs.quotePatch,
  });
  ok("8. owner RPC omits untyped p_membership_id null", !Object.prototype.hasOwnProperty.call(ownerRpcBody, "p_membership_id"));
  ok("8. owner RPC omits empty p_operational_plan array", !Object.prototype.hasOwnProperty.call(ownerRpcBody, "p_operational_plan") || (Array.isArray(ownerRpcBody.p_operational_plan) && ownerRpcBody.p_operational_plan.length > 0));
  const emptyPlanRpcBody = buildConfirmRpcBody({
    tenantId: TENANT_A,
    quoteId: QUOTE_A,
    document: confirmed,
    membershipId: null,
    quotePatch: { operational_plan: [] },
  });
  ok("8. empty derived plan omits untyped p_operational_plan []", !Object.prototype.hasOwnProperty.call(emptyPlanRpcBody, "p_operational_plan"));
  ok("8. owner RPC omits empty p_scope_of_work null", !Object.prototype.hasOwnProperty.call(ownerRpcBody, "p_scope_of_work") || ownerRpcBody.p_scope_of_work);
  eq("8. owner membershipIdForRpc is null", membershipIdForRpc(""), null);
  eq("8. owner membershipIdForRpc rejects non-uuid", membershipIdForRpc("owner"), null);
  eq(
    "8. seller membership UUID is kept",
    membershipIdForRpc("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"),
    "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
  );
  const ownerWithLookableProfile = buildConfirmRpcBody({
    tenantId: TENANT_A,
    quoteId: QUOTE_A,
    document: confirmed,
    membershipId: membershipIdForRpc(null),
    quotePatch: publishArgs.quotePatch,
  });
  ok(
    "8. owner with a lookable profiles.id still omits p_membership_id without a session membership",
    !Object.prototype.hasOwnProperty.call(ownerWithLookableProfile, "p_membership_id")
  );
  const sellerRpcBody = buildConfirmRpcBody({
    tenantId: TENANT_A,
    quoteId: QUOTE_A,
    document: confirmed,
    membershipId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    quotePatch: publishArgs.quotePatch,
  });
  eq("8. seller RPC body uses session membership id", sellerRpcBody.p_membership_id, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");

  function throwIfUntypedRpcNulls(body) {
    const keys = [
      "p_membership_id",
      "p_scope_of_work",
      "p_start_date",
      "p_due_date",
      "p_estimated_days",
      "p_estimated_hours",
    ];
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(body, key) && body[key] == null) {
        const err = new Error(
          "Could not find the function public.mg_confirm_quote_operational_plan in the schema cache (PGRST202)"
        );
        err.status = 404;
        throw err;
      }
    }
  }

  let legacyNullThrew = false;
  try {
    throwIfUntypedRpcNulls({
      p_tenant_id: TENANT_A,
      p_quote_id: QUOTE_A,
      p_document: confirmed,
      p_schema_version: 1,
      p_membership_id: null,
      p_operational_plan: [],
      p_estimated_days: 5,
      p_estimated_hours: 40,
      p_start_date: "2026-09-10",
      p_due_date: "2026-09-16",
      p_scope_of_work: null,
    });
  } catch (err) {
    legacyNullThrew = /PGRST202/.test(String(err && err.message));
  }
  ok("8. production owner null membership reproduces PGRST202", legacyNullThrew);

  const ownerAtomicCalls = [];
  const ownerAtomic = await confirmOperationalPlanAtomic(
    async (reqPath, opts) => {
      ownerAtomicCalls.push(opts);
      throwIfUntypedRpcNulls(opts && opts.body);
      return { ok: true, persisted: true, quote_id: QUOTE_A };
    },
    {
      tenantId: TENANT_A,
      quoteId: QUOTE_A,
      document: confirmed,
      membershipId: null,
      quotePatch: publishArgs.quotePatch,
    }
  );
  eq("8. owner confirm RPC succeeds without membership", ownerAtomic.ok, true);
  ok("8. owner confirm RPC did not send p_membership_id", !Object.prototype.hasOwnProperty.call(ownerAtomicCalls[0].body, "p_membership_id"));
  eq("8. owner confirm RPC sets prefer false only for this call", ownerAtomicCalls[0].prefer, false);

  await runOwnerInternalPlanPublishHandlerTests();

  const endpointSrc = read("netlify/functions/quote-internal-operational-plan.js");
  const publishSrc = read("netlify/functions/publish-public-quote.js");
  const storeSrc = read("netlify/functions/_lib/quote-internal-operational-plan-store.js");
  const adminSrc = read("netlify/functions/_lib/supabase-admin.js");
  const sendSrc = read("public/js/estimate-public-send.js");
  ok("8. publish does not resolve profiles.id as p_membership_id", !/resolveMembershipIdForRpc/.test(publishSrc) && !/profiles\?email=/.test(storeSrc));
  ok("8. publish uses session membership only", /membershipIdForRpc\(ctx\.membership && ctx\.membership\.id\)/.test(publishSrc));
  ok("8. confirm RPC is the only supabaseRequest that sets prefer false", /prefer:\s*false/.test(storeSrc));
  ok("8. supabase-admin does not skip Prefer for every rpc path", !/startsWith\(["']rpc\//.test(adminSrc));
  ok("8. supabase-admin still defaults Prefer return=representation", /Prefer:[\s\S]*return=representation/.test(adminSrc));
  function listJsFiles(dir, acc) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) listJsFiles(p, acc);
      else if (/\.(js|mjs)$/.test(ent.name)) acc.push(p);
    }
    return acc;
  }
  const preferFalseFiles = listJsFiles(path.join(ROOT, "netlify"), []).filter((p) =>
    /prefer:\s*false/.test(fs.readFileSync(p, "utf8"))
  );
  deepEq(
    "8. prefer false exists only on the confirm RPC store",
    preferFalseFiles.map((p) => path.relative(ROOT, p).replace(/\\/g, "/")),
    ["netlify/functions/_lib/quote-internal-operational-plan-store.js"]
  );
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
  ok("single send click is guarded by sellerSendInFlight", /if \(sellerSendInFlight\) return false/.test(salesSrc) && /sellerSendInFlight = true/.test(salesSrc));
  ok("owner send path still does not require device_session", !/device_session/.test(salesSrc.slice(salesSrc.indexOf("async function runSellerSend"), salesSrc.indexOf("window.runMarginGuardSellerSend"))));
  const fbSrc = read("public/js/quote-send-feedback.js");
  ok(
    "send UI maps persist failure to an actionable message",
    /operational plan could not be saved/i.test(fbSrc) && /internal_plan_persist_failed/.test(fbSrc)
  );
  ok("send UI maps second-retry PostgREST dump without persist copy", /mg_confirm_quote_operational_plan/.test(fbSrc));
  ok("send UI maps document_invalid", /document_invalid/.test(fbSrc));
  ok(
    "send UI cache-busts quote-send-feedback.js",
    /quote-send-feedback\.js\?v=owner-total-parity-1/.test(salesSrc)
  );
  ok("send UI throws publish failures with code", /throwFromPublishResponse/.test(salesSrc));
  ok(
    "send UI maps missing storage without leaking SQL file names",
    /Operational plan storage is not ready/.test(fbSrc) && !/SUPABASE_QUOTE_INTERNAL_OPERATIONAL_PLANS/.test(fbSrc)
  );
  ok("send UI keeps unknown errors generic", /Something went wrong\. Please try again\./.test(fbSrc));
  ok("old quotes.internal_operational_plan migration is gone", !fs.existsSync(path.join(ROOT, "SUPABASE_QUOTES_INTERNAL_OPERATIONAL_PLAN.sql")));
  ok("dedicated table migration exists", fs.existsSync(path.join(ROOT, "SUPABASE_QUOTE_INTERNAL_OPERATIONAL_PLANS.sql")));
  ok(
    "production inspect SQL is read-only",
    fs.existsSync(path.join(ROOT, "SUPABASE_QUOTE_INTERNAL_OPERATIONAL_PLANS_INSPECT.sql"))
  );
  ok(
    "production align SQL was not needed",
    !fs.existsSync(path.join(ROOT, "SUPABASE_QUOTE_INTERNAL_OPERATIONAL_PLANS_ALIGN_PROD.sql"))
  );
  const sql = read("SUPABASE_QUOTE_INTERNAL_OPERATIONAL_PLANS.sql");
  const inspectSql = read("SUPABASE_QUOTE_INTERNAL_OPERATIONAL_PLANS_INSPECT.sql");
  const inspectBody = inspectSql.replace(/^--.*$/gm, "").replace(/\r/g, "");
  ok("inspect SQL forbids writes", /^-- READ ONLY/.test(inspectSql) && !/\b(insert|update|delete|drop|create|alter)\b/i.test(inspectBody));
  ok(
    "inspect SQL is one export statement with section and payload_json",
    /^\s*with\b/m.test(inspectBody) &&
      /select section, payload_json/.test(inspectSql) &&
      (inspectBody.match(/\bunion all\b/gi) || []).length === 11 &&
      (inspectBody.match(/;/g) || []).length <= 1
  );
  ok("inspect SQL does not use pg_get_function_arg_default", !/pg_get_function_arg_default/.test(inspectSql));
  ok(
    "inspect SQL uses documented argument/default helpers",
    /pg_get_function_arguments/.test(inspectSql) &&
      /pg_get_function_identity_arguments/.test(inspectSql) &&
      /pg_get_expr\(p\.proargdefaults, 0\)/.test(inspectSql) &&
      /proargtypes::oid\[\]/.test(inspectSql)
  );
  ok("inspect SQL captures pg_get_functiondef", /pg_get_functiondef\(p\.oid\)/.test(inspectSql));
  ok("inspect SQL captures function owner and ACL", /function_owner/.test(inspectSql) && /aclexplode/.test(inspectSql));
  ok("inspect SQL captures security model", /SECURITY INVOKER/.test(inspectSql) && /prosecdef/.test(inspectSql));
  ok(
    "inspect SQL scopes pg_depend by classid and refclassid",
    /d\.classid = 'pg_proc'::regclass/.test(inspectSql) &&
      /d\.refclassid = 'pg_proc'::regclass/.test(inspectSql)
  );
  ok("inspect SQL captures function dependencies", /pg_depend/.test(inspectSql) && /pg_describe_object/.test(inspectSql));
  ok("inspect SQL labels policy OID 0 as PUBLIC", /when u\.oid = 0 then 'PUBLIC'::name/.test(inspectSql));
  ok("inspect SQL captures table columns and defaults", /pg_attribute/.test(inspectSql) && /column_default/.test(inspectSql));
  ok("inspect SQL captures constraints indexes policies RLS", /pg_constraint/.test(inspectSql) && /pg_index/.test(inspectSql) && /pg_policy/.test(inspectSql) && /relforcerowsecurity/.test(inspectSql));
  ok("inspect SQL captures table owner grants and triggers", /table_owner/.test(inspectSql) && /pg_get_triggerdef/.test(inspectSql));
  ok("live inspect found matching 11-arg RPC defaults", /11 arguments and 8 defaults/.test(sql) && /p_membership_id DEFAULT NULL/.test(sql));
  ok("live inspect found complete table and reloaded schema cache", /quote_internal_operational_plans is complete/.test(sql) && /NOTIFY pgrst, 'reload schema'/.test(sql));
  ok("migration comment forbids remote apply from this PR", /DO NOT apply this file to remote Supabase/.test(sql));
  ok("migration enables RLS", /enable row level security/.test(sql));
  ok("migration revokes anon/authenticated", /revoke all on table public\.quote_internal_operational_plans from anon/.test(sql) && /from authenticated/.test(sql));
  ok("migration grants service_role only", /grant select, insert, update, delete on table public\.quote_internal_operational_plans to service_role/.test(sql));
  ok("migration checks document is object", /jsonb_typeof\(document\) = 'object'/.test(sql));
  ok("migration defines atomic confirm RPC", /create or replace function public\.mg_confirm_quote_operational_plan/.test(sql));
  ok("atomic RPC p_membership_id is optional uuid default null", /p_membership_id uuid default null/.test(sql));
  ok(
    "atomic RPC writes p_membership_id only to last_updated_by_membership_id",
    /last_updated_by_membership_id,[\s\S]*p_membership_id,/.test(sql)
  );
  ok(
    "membership audit column has no FK and is nullable when the session has none",
    /last_updated_by_membership_id uuid null/.test(sql) &&
      /when the session has one/.test(sql) &&
      !/last_updated_by_membership_id uuid null references/.test(sql)
  );
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
