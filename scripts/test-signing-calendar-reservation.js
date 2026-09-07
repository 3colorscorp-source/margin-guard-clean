#!/usr/bin/env node
/**
 * Firmar must not reserve the crew calendar; public accept is canonical.
 * Isolated mocks only. No live Netlify, Zapier, quotes, email, or Supabase writes.
 * Run: node scripts/test-signing-calendar-reservation.js
 */
"use strict";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET || "mg-signing-calendar-reservation-test-secret";
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "mg-signing-calendar-reservation-key";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const { buildSessionPayload, createSessionCookie } = require("../netlify/functions/_lib/session");
const {
  periodsOverlapInclusive,
  blockingProjectOverlapsPeriod,
  ACTIVE_STATUSES,
} = require("../netlify/functions/_lib/sales-capacity-calendar");
const {
  assertQuoteScheduleAvailable,
  quoteHasPublicAcceptance,
  ScheduleConflictError,
  SCHEDULE_CONFLICT_CODE,
  SCHEDULE_CONFLICT_MESSAGE,
  resolveProposedOccupation,
} = require("../netlify/functions/_lib/schedule-accept-guard");

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

let passed = 0;
function ok(label, cond) {
  assert.ok(cond, label);
  passed += 1;
  console.log("PASS " + label);
}

function eq(label, a, b) {
  assert.strictEqual(a, b, label);
  passed += 1;
  console.log("PASS " + label);
}

function jsonRes(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return typeof body === "string" ? body : JSON.stringify(body);
    },
  };
}

function extractPath(url) {
  const s = String(url);
  const idx = s.indexOf("/rest/v1/");
  return idx >= 0 ? s.slice(idx + "/rest/v1/".length) : s;
}

function qp(restPath, key) {
  const q = restPath.split("?")[1] || "";
  const part = q.split("&").find((p) => p.startsWith(key + "="));
  if (!part) return "";
  return decodeURIComponent(part.slice(key.length + 1).replace(/^eq\./, ""));
}

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const QUOTE_A = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const QUOTE_B = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
const PROJECT_A = "11111111-2222-4333-8444-555555555555";
const OWNER_A = "owner-a@example.com";
const USER_A = "11111111-1111-4111-8111-111111111111";

function cookieOwner() {
  return createSessionCookie(
    buildSessionPayload({
      email: OWNER_A,
      tenantId: TENANT_A,
      userId: USER_A,
      customerId: "",
    })
  );
}

const salesSrc = read("public/sales.html");
const firmarClick = salesSrc.slice(
  salesSrc.indexOf("cleanMarkSoldBtn.addEventListener('click'"),
  salesSrc.indexOf("function bindStandaloneSellerSend")
);
const upsertSrc = read("netlify/functions/upsert-tenant-project.js");
const publicSrc = read("netlify/functions/update-public-estimate-status.js");
const bridgeSrc = read("netlify/functions/_lib/quote-accept-bridge.js");
const calendarSrc = read("netlify/functions/_lib/sales-capacity-calendar.js");
const publishSrc = read("netlify/functions/publish-public-quote.js");
const zapierSrc = read("netlify/functions/send-quote-zapier.js");
const appSrc = read("public/js/app.js");
const builderSrc = read("public/js/estimate-builder.js");
const rpcSql = read("SUPABASE_ACCEPT_QUOTE_RESERVE_SCHEDULE.sql");
const diagSql = read("SUPABASE_DIAG_PREMATURE_FIRMAR_OCCUPANCY.sql");

ok(
  "1. Firmar click does not call upsert-tenant-project",
  !/fetch\(\s*['\"]\/.netlify\/functions\/upsert-tenant-project['\"]/.test(firmarClick)
);
ok(
  "2. Firmar click does not PATCH quotes accepted",
  !/status:\s*'accepted'|status:\s*\"accepted\"/.test(firmarClick)
);
ok(
  "3. Firmar opens public signing via user-gesture link",
  /openPublicSigningFromUserGesture/.test(firmarClick) &&
    /noopener noreferrer/.test(firmarClick)
);
ok(
  "3b. Firmar copy is informational, not a pop-up error",
  /Dates are reserved only after the client completes acceptance/.test(firmarClick) &&
    !/Allow pop-ups/.test(firmarClick)
);
ok(
  "3c. Firmar does not treat window.open noopener return as proof",
  !/window\.open\(publicUrl,\s*['\"]_blank['\"],\s*['\"]noopener/.test(firmarClick)
);
ok("4. publish-public-quote does not insert tenant_projects", !/tenant_projects/.test(publishSrc));
ok("5. send-quote-zapier does not insert tenant_projects", !/tenant_projects/.test(zapierSrc));
ok(
  "upsert refuses signed occupancy before public accept",
  /public_acceptance_required/.test(upsertSrc)
);
ok(
  "upsert no longer PATCHes quote status accepted",
  !/status:\s*"accepted"/.test(upsertSrc)
);
ok("public accept returns 409 schedule_conflict", /schedule_conflict/.test(publicSrc) && /409/.test(publicSrc));
ok("public accept uses canonical calendar assert", /assertQuoteScheduleAvailable/.test(publicSrc));
ok("accept bridge checks occupancy before create", /assertQuoteScheduleAvailable/.test(bridgeSrc));
ok("accept bridge rethrows schedule_conflict", /isScheduleConflictError/.test(bridgeSrc));
ok(
  "6/7. public accept still creates signed project via bridge or RPC",
  /status:\s*"signed"/.test(bridgeSrc) && /tryAtomicAcceptQuoteReservingSchedule/.test(publicSrc)
);
ok(
  "9. ACTIVE_STATUSES still signed,deposit_paid,assigned,in_progress",
  Array.isArray(ACTIVE_STATUSES) &&
    ACTIVE_STATUSES.join(",") === "signed,deposit_paid,assigned,in_progress"
);
ok(
  "calendar occupancy query still uses those four statuses",
  /status=in\.\(\$\{statusList\}\)/.test(calendarSrc) &&
    calendarSrc.includes('["signed", "deposit_paid", "assigned", "in_progress"]')
);
ok("owner and seller still share get-sales-capacity-calendar dual-auth", /resolveOwnerOrSellerContext/.test(read("netlify/functions/get-sales-capacity-calendar.js")));
ok("app.js Firmar no longer upserts a local signed project", !/upsertSignedProject\(project\)/.test(appSrc));
{
  const appFirmar = appSrc.slice(
    appSrc.indexOf("const btnMarkSold"),
    appSrc.indexOf("const btnProjComplete")
  );
  ok(
    "app.js Firmar uses secure link helper, not window.open noopener return",
    /openPublicSigningFromUserGesture/.test(appFirmar) &&
      !/window\.open\(publicUrl,\s*["']_blank["'],\s*["']noopener/.test(appFirmar)
  );
  ok(
    "app.js Firmar info copy does not mention Allow pop-ups",
    /Dates are reserved only after the client completes acceptance/.test(appFirmar) &&
      !/Allow pop-ups/.test(appFirmar)
  );
}
ok("public client sees friendly 409 copy", /error_es/.test(builderSrc) && /ya no están disponibles/.test(builderSrc));
ok("RPC file is marked do-not-apply", /do not apply to production/i.test(rpcSql));
ok("RPC uses advisory lock and schedule_conflict", /pg_advisory_xact_lock/.test(rpcSql) && /schedule_conflict/.test(rpcSql));
ok("diagnostic SQL is read-only", /DO NOT RUN WRITES/.test(diagSql));
ok(
  "conversion remains idempotent via already_accepted path",
  /already_accepted/.test(publicSrc) && /action = "reuse"/.test(bridgeSrc)
);

eq("quote READY_TO_SEND is not public acceptance", quoteHasPublicAcceptance({ status: "READY_TO_SEND" }), false);
eq("quote accepted is public acceptance", quoteHasPublicAcceptance({ status: "accepted" }), true);

ok(
  "period overlap: identical week overlaps",
  periodsOverlapInclusive("2026-09-07", "2026-09-11", "2026-09-07", "2026-09-11")
);
ok(
  "period overlap: interior day overlaps",
  periodsOverlapInclusive("2026-09-07", "2026-09-11", "2026-09-09", "2026-09-10")
);
ok(
  "period overlap: adjacent after last inclusive day does not overlap",
  !periodsOverlapInclusive("2026-09-07", "2026-09-11", "2026-09-12", "2026-09-16")
);

ok(
  "blocking analysis uses occupation_end",
  blockingProjectOverlapsPeriod(
    {
      blocks_capacity: true,
      released: false,
      start_date: "2026-09-07",
      occupation_end: "2026-09-11",
    },
    "2026-09-09",
    "2026-09-15"
  )
);
ok(
  "9. legitimately signed project still blocks overlapping period",
  blockingProjectOverlapsPeriod(
    {
      blocks_capacity: true,
      released: false,
      start_date: "2026-09-07",
      occupation_end: "2026-09-11",
      target_finish_date: "2026-09-11",
    },
    "2026-09-07",
    "2026-09-11"
  )
);

{
  const proposed = resolveProposedOccupation(
    { start_date: "2026-09-07", due_date: "2026-09-11", estimated_days: 5 },
    { workdaysEnabled: true }
  );
  eq("proposed occupation keeps quote dates", proposed.start_date, "2026-09-07");
  eq("proposed occupation keeps target finish", proposed.due_date, "2026-09-11");
}

async function fakeCalendarForTenant(store) {
  return async function compute({ tenantId, excludeProjectId }) {
    const blocking = store
      .filter(
        (row) =>
          row.tenantId === tenantId && String(row.project_id) !== String(excludeProjectId || "")
      )
      .map((row) => ({
        project_id: row.project_id,
        project_name: row.project_name,
        start_date: row.start_date,
        occupation_end: row.occupation_end,
        target_finish_date: row.occupation_end,
        blocks_capacity: true,
        released: false,
      }));
    return { ok: true, blocking_projects: blocking };
  };
}

(async () => {
  const store = [];
  const compute = await fakeCalendarForTenant(store);
  const quoteA = {
    id: QUOTE_A,
    tenant_id: TENANT_A,
    status: "READY_TO_SEND",
    start_date: "2026-09-07",
    due_date: "2026-09-11",
    estimated_days: 5,
  };
  const quoteB = {
    id: QUOTE_B,
    tenant_id: TENANT_A,
    status: "READY_TO_SEND",
    start_date: "2026-09-09",
    due_date: "2026-09-14",
    estimated_days: 4,
  };
  const quoteTenantB = {
    ...quoteB,
    tenant_id: TENANT_B,
    id: "cccccccc-dddd-4eee-8fff-000000000000",
  };

  await assertQuoteScheduleAvailable(quoteA, { computeCalendar: compute });
  ok("10. first available period is allowed", true);

  store.push({
    tenantId: TENANT_A,
    project_id: PROJECT_A,
    project_name: "Accepted A",
    start_date: "2026-09-07",
    occupation_end: "2026-09-11",
  });

  let conflicted = false;
  try {
    await assertQuoteScheduleAvailable(quoteB, { computeCalendar: compute });
  } catch (err) {
    conflicted = err instanceof ScheduleConflictError && err.code === SCHEDULE_CONFLICT_CODE;
    ok("11. overlapping second accept throws schedule_conflict", conflicted);
    ok("friendly conflict message is set", err.message === SCHEDULE_CONFLICT_MESSAGE);
  }
  if (!conflicted) throw new Error("expected overlapping quote B to conflict");

  await assertQuoteScheduleAvailable(quoteTenantB, { computeCalendar: compute });
  ok("13. Tenant B is not blocked by Tenant A occupancy", true);

  await assertQuoteScheduleAvailable(quoteA, {
    computeCalendar: compute,
    excludeProjectId: PROJECT_A,
  });
  ok("8. conversion is idempotent when excluding the same project", true);

  const prev = globalThis.fetch;
  const posts = [];
  const patches = [];
  globalThis.fetch = async (url, init) => {
    const restPath = extractPath(url);
    const table = restPath.split("?")[0];
    const method = String(init?.method || "GET").toUpperCase();
    if (table === "profiles") {
      const email = String(qp(restPath, "email") || "").toLowerCase();
      if (email && email !== OWNER_A) return jsonRes(200, []);
      return jsonRes(200, [
        {
          id: "prof-a",
          tenant_id: TENANT_A,
          email: OWNER_A,
          role: "owner",
          status: "active",
          auth_user_id: USER_A,
        },
      ]);
    }
    if (table === "tenants") {
      const id = qp(restPath, "id");
      if (id && id !== TENANT_A) return jsonRes(200, []);
      return jsonRes(200, [
        {
          id: TENANT_A,
          slug: "co-a",
          name: "Co A",
          owner_email: OWNER_A,
          plan_status: "active",
          stripe_customer_id: null,
        },
      ]);
    }
    if (table === "quotes" && method === "GET") {
      return jsonRes(200, [
        {
          id: QUOTE_A,
          tenant_id: TENANT_A,
          total: 1000,
          status: "READY_TO_SEND",
          accepted_at: null,
          seller_membership_id: null,
          created_by_role: "owner",
          contact_id: null,
        },
      ]);
    }
    if (table === "quotes" && method === "PATCH") {
      patches.push(JSON.parse(init.body || "{}"));
      return jsonRes(200, []);
    }
    if (table === "tenant_projects" && method === "GET") {
      return jsonRes(200, []);
    }
    if (table === "tenant_projects" && method === "POST") {
      posts.push(JSON.parse(init.body || "{}"));
      return jsonRes(201, [{ id: PROJECT_A }]);
    }
    if (table === "tenant_snapshots") return jsonRes(200, []);
    return jsonRes(200, []);
  };

  [
    "../netlify/functions/_lib/supabase-admin",
    "../netlify/functions/_lib/membership-resolve",
    "../netlify/functions/_lib/owner-access",
    "../netlify/functions/_lib/tenant-for-session",
    "../netlify/functions/_lib/tenant-device-guard",
    "../netlify/functions/upsert-tenant-project",
  ].forEach((rel) => {
    delete require.cache[require.resolve(rel)];
  });
  const upsertMod = require("../netlify/functions/upsert-tenant-project");
  const upsertRes = await upsertMod.handler({
    httpMethod: "POST",
    headers: { cookie: cookieOwner().split(";")[0] },
    body: JSON.stringify({
      quote_id: QUOTE_A,
      status: "signed",
      start_date: "2026-09-07",
      due_date: "2026-09-11",
      project_name: "Should not create",
    }),
  });
  const upsertBody = JSON.parse(upsertRes.body || "{}");
  eq("1b. premature upsert returns 409", upsertRes.statusCode, 409);
  eq("1c. premature upsert code", upsertBody.code, "public_acceptance_required");
  eq("1d. premature upsert creates no tenant_projects", posts.length, 0);
  eq("2b. premature upsert does not PATCH quote accepted", patches.length, 0);
  globalThis.fetch = prev;

  require("../public/js/sales-capacity-calendar.js");
  const {
    handlePublicEstimateStatus,
  } = require("../netlify/functions/update-public-estimate-status")._test;
  const { hubAcceptQuote } = require("../netlify/functions/hub-quote-manual-step")._test;
  const { RESERVATION_FAILED_CODE } = require("../netlify/functions/_lib/schedule-accept-guard");

  const PUBLIC_TOKEN = "publictoken01";
  function baseQuote(overrides) {
    return {
      id: QUOTE_A,
      tenant_id: TENANT_A,
      public_token: PUBLIC_TOKEN,
      status: "READY_TO_SEND",
      accepted_at: null,
      start_date: "2026-09-07",
      due_date: "2026-09-11",
      estimated_days: 5,
      client_email: "client@example.com",
      business_email: "biz@example.com",
      client_name: "Client",
      business_name: "Biz",
      total: 1500,
      ...overrides,
    };
  }

  const proposed = { start_date: "2026-09-07", due_date: "2026-09-11", estimated_days: 5 };

  async function runPublicAccept(opts) {
    const quote = opts.quote || baseQuote();
    const webhookCalls = [];
    const revertCalls = [];
    const bridgeCalls = [];
    const atomicCalls = [];
    const snapshotCalls = [];
    const patchCalls = [];
    const res = await handlePublicEstimateStatus(
      {
        httpMethod: "POST",
        body: JSON.stringify({ token: PUBLIC_TOKEN, status: "accepted" }),
      },
      {
        getSupabaseConfig: () => ({ url: "https://example.supabase.co", key: "service-key" }),
        fetchQuoteByPublicToken: async () => quote,
        assertQuoteScheduleAvailable: opts.assertQuoteScheduleAvailable || (async () => ({
          ok: true,
          proposed,
        })),
        tryAtomicAcceptQuoteReservingSchedule: async (...args) => {
          atomicCalls.push(args);
          if (typeof opts.atomic === "function") return opts.atomic(...args);
          return opts.atomic;
        },
        bridgeAcceptedQuoteToProject: async (...args) => {
          bridgeCalls.push(args);
          if (typeof opts.bridge === "function") return opts.bridge(...args);
          return opts.bridge;
        },
        applyOperationalSnapshotForProject: async (...args) => {
          snapshotCalls.push(args);
          if (typeof opts.snapshot === "function") return opts.snapshot(...args);
          return true;
        },
        revertQuoteAcceptance: async (...args) => {
          revertCalls.push(args);
          if (typeof opts.revert === "function") return opts.revert(...args);
          return opts.revert || { ok: true, restored_status: quote.status, restored_accepted_at: quote.accepted_at };
        },
        sendEstimateAcceptedWebhook: async (payload) => {
          webhookCalls.push(payload);
          return { sent: true };
        },
        fetchImpl:
          opts.fetchImpl ||
          (async (_url, init) => {
            const method = String(init?.method || "GET").toUpperCase();
            if (method === "PATCH") {
              patchCalls.push(JSON.parse(init.body || "{}"));
              return jsonRes(200, [
                {
                  ...quote,
                  status: "accepted",
                  accepted_at: "2026-09-05T12:00:00.000Z",
                },
              ]);
            }
            return jsonRes(200, []);
          }),
      }
    );
    return {
      res,
      body: JSON.parse(res.body || "{}"),
      webhookCalls,
      revertCalls,
      bridgeCalls,
      atomicCalls,
      snapshotCalls,
      patchCalls,
    };
  }

  {
    const out = await runPublicAccept({
      atomic: { ok: false, code: "rpc_missing" },
      bridge: { ok: true, project_id: PROJECT_A, snapshot_ok: true },
    });
    eq("RPC missing: Function detects rpc_missing", out.atomicCalls.length, 1);
    eq("RPC missing: fallback PATCH ran", out.patchCalls.length, 1);
    eq("RPC missing: bridge created project → 200", out.res.statusCode, 200);
    eq("RPC missing: reserved true", out.body.reserved, true);
    eq("RPC missing: project_id present", out.body.project_id, PROJECT_A);
    eq("RPC missing: webhook fired once", out.webhookCalls.length, 1);
  }

  {
    const out = await runPublicAccept({
      atomic: { ok: false, code: "rpc_missing" },
      bridge: { ok: false, project_id: null },
    });
    eq("RPC missing: bridge {ok:false} → 503", out.res.statusCode, 503);
    eq("RPC missing: code reservation_failed", out.body.code, RESERVATION_FAILED_CODE);
    eq("RPC missing: quote reverted", out.revertCalls.length, 1);
    eq("RPC missing: revert restores prior status", out.revertCalls[0][1], "READY_TO_SEND");
    eq("RPC missing: revert restores prior accepted_at", out.revertCalls[0][0].accepted_at, null);
    eq("RPC missing: no webhook on {ok:false}", out.webhookCalls.length, 0);
  }

  {
    const out = await runPublicAccept({
      atomic: { ok: false, code: "rpc_missing" },
      bridge: async () => {
        throw new Error("tenant_projects insert failed");
      },
    });
    eq("RPC missing: generic bridge throw → 503", out.res.statusCode, 503);
    eq("RPC missing: generic throw reverts", out.revertCalls.length, 1);
    eq("RPC missing: no webhook on generic throw", out.webhookCalls.length, 0);
  }

  {
    const out = await runPublicAccept({
      atomic: { ok: false, code: "rpc_missing" },
      bridge: async () => {
        throw new ScheduleConflictError({ conflict_project_id: PROJECT_A });
      },
    });
    eq("RPC missing: schedule_conflict → 409", out.res.statusCode, 409);
    eq("RPC missing: conflict code", out.body.code, SCHEDULE_CONFLICT_CODE);
    eq("RPC missing: conflict reverts PATCH", out.revertCalls.length, 1);
    eq("RPC missing: no webhook on 409", out.webhookCalls.length, 0);
  }

  {
    const priorAcceptedAt = "2026-08-01T00:00:00.000Z";
    const out = await runPublicAccept({
      quote: baseQuote({ accepted_at: priorAcceptedAt }),
      atomic: { ok: false, code: "rpc_missing" },
      bridge: { ok: false },
      revert: async (row, status) => ({
        ok: true,
        restored_status: status,
        restored_accepted_at: row.accepted_at,
      }),
    });
    // accepted_at set makes quoteAlreadyAccepted true → heal path, no PATCH revert
    eq("already_accepted without project → 503", out.res.statusCode, 503);
    eq("already_accepted heal does not fire webhook", out.webhookCalls.length, 0);
  }

  {
    const out = await runPublicAccept({
      atomic: { ok: false, code: "rpc_missing" },
      bridge: { ok: false },
      revert: async () => ({ ok: false, needs_manual_repair: true }),
    });
    eq("rollback failure → 503", out.res.statusCode, 503);
    eq("rollback failure needs_manual_repair", out.body.needs_manual_repair, true);
    eq("rollback failure never webhooks", out.webhookCalls.length, 0);
  }

  {
    const out = await runPublicAccept({
      atomic: { ok: true, code: "created", action: "create", project_id: PROJECT_A },
      bridge: async () => {
        throw new Error("bridge must not run after atomic success");
      },
    });
    eq("RPC installed: atomic success → 200", out.res.statusCode, 200);
    eq("RPC installed: quote reserved", out.body.reserved, true);
    eq("RPC installed: project signed id returned", out.body.project_id, PROJECT_A);
    eq("RPC installed: fallback PATCH skipped", out.patchCalls.length, 0);
    eq("RPC installed: bridge not called", out.bridgeCalls.length, 0);
    eq("RPC installed: webhook fired", out.webhookCalls.length, 1);
  }

  {
    const out = await runPublicAccept({
      atomic: { ok: false, code: "schedule_conflict" },
      bridge: { ok: true, project_id: PROJECT_A },
    });
    eq("RPC installed: schedule_conflict → 409", out.res.statusCode, 409);
    eq("RPC installed: conflict does not PATCH", out.patchCalls.length, 0);
    eq("RPC installed: conflict does not bridge", out.bridgeCalls.length, 0);
    eq("RPC installed: conflict no webhook", out.webhookCalls.length, 0);
  }

  {
    const out = await runPublicAccept({
      atomic: { ok: true, code: "created", action: "create", project_id: PROJECT_A },
      snapshot: async () => {
        throw new Error("snapshot persist failed");
      },
    });
    eq("RPC snapshot fail still 200", out.res.statusCode, 200);
    eq("RPC snapshot fail keeps reservation", out.body.reserved, true);
    eq("RPC snapshot fail keeps project_id", out.body.project_id, PROJECT_A);
    eq("RPC snapshot fail snapshot_ok false", out.body.snapshot_ok, false);
    eq("RPC snapshot fail does not claim missing reservation", out.body.code == null, true);
    eq("RPC snapshot fail still webhooks", out.webhookCalls.length, 1);
    eq("RPC snapshot fail does not revert quote", out.revertCalls.length, 0);
  }

  async function runHub(opts) {
    const quote = opts.quote || baseQuote();
    const revertCalls = [];
    const bridgeCalls = [];
    const atomicCalls = [];
    const patchCalls = [];
    const snapshotCalls = [];
    const res = await hubAcceptQuote(quote, {
      tenantId: TENANT_A,
      quoteId: QUOTE_A,
      nowIso: "2026-09-05T12:00:00.000Z",
      assertQuoteScheduleAvailable: opts.assertQuoteScheduleAvailable || (async () => ({
        ok: true,
        proposed,
      })),
      tryAtomicAcceptQuoteReservingSchedule: async (...args) => {
        atomicCalls.push(args);
        if (typeof opts.atomic === "function") return opts.atomic(...args);
        return opts.atomic;
      },
      supabaseRequest: async (path, init) => {
        if (String(init?.method || "").toUpperCase() === "PATCH") {
          patchCalls.push(init.body);
        }
        return [{}];
      },
      fetchQuoteForTenant: async () => ({ ...quote, status: "accepted", accepted_at: "2026-09-05T12:00:00.000Z" }),
      bridgeAcceptedQuoteToProject: async (...args) => {
        bridgeCalls.push(args);
        if (typeof opts.bridge === "function") return opts.bridge(...args);
        return opts.bridge;
      },
      revertQuoteAcceptance: async (...args) => {
        revertCalls.push(args);
        if (typeof opts.revert === "function") return opts.revert(...args);
        return { ok: true };
      },
      applyOperationalSnapshotForProject: async (...args) => {
        snapshotCalls.push(args);
        if (typeof opts.snapshot === "function") return opts.snapshot(...args);
        return true;
      },
    });
    return {
      res,
      body: JSON.parse(res.body || "{}"),
      revertCalls,
      bridgeCalls,
      atomicCalls,
      patchCalls,
      snapshotCalls,
    };
  }

  {
    const out = await runHub({
      atomic: { ok: false, code: "rpc_missing" },
      bridge: { ok: true, project_id: PROJECT_A, snapshot_ok: true },
    });
    eq("Hub RPC missing + project → 200", out.res.statusCode, 200);
    eq("Hub success includes project_id", out.body.project_id, PROJECT_A);
  }

  {
    const out = await runHub({
      atomic: { ok: false, code: "rpc_missing" },
      bridge: { ok: false },
    });
    eq("Hub fail-closed without project_id → 503", out.res.statusCode, 503);
    eq("Hub does not leave quote accepted on reservation fail", out.revertCalls.length, 1);
    eq("Hub 503 code", out.body.code, RESERVATION_FAILED_CODE);
  }

  {
    const out = await runHub({
      atomic: { ok: false, code: "rpc_missing" },
      bridge: async () => {
        throw new Error("generic hub bridge failure");
      },
    });
    eq("Hub generic throw → 503", out.res.statusCode, 503);
    eq("Hub generic throw reverts", out.revertCalls.length, 1);
  }

  {
    const out = await runHub({
      atomic: { ok: true, code: "created", action: "create", project_id: PROJECT_A },
      bridge: async () => {
        throw new Error("hub must not double-bridge");
      },
    });
    eq("Hub RPC success → 200", out.res.statusCode, 200);
    eq("Hub RPC success does not fallback PATCH", out.patchCalls.length, 0);
    eq("Hub RPC success does not call bridge", out.bridgeCalls.length, 0);
  }

  {
    const cap = globalThis.MarginGuardSalesCapacity;
    ok("Firmar helper is exported on MarginGuardSalesCapacity", typeof cap.openPublicSigningFromUserGesture === "function");
    const clicks = [];
    const created = [];
    const fakeDoc = {
      createElement(tag) {
        const el = {
          tagName: String(tag).toLowerCase(),
          href: "",
          target: "",
          rel: "",
          parentNode: null,
          click() {
            clicks.push({ href: this.href, target: this.target, rel: this.rel });
          },
        };
        created.push(el);
        return el;
      },
      body: {
        appendChild(el) {
          el.parentNode = this;
        },
        removeChild(el) {
          el.parentNode = null;
        },
      },
    };
    const opened = cap.openPublicSigningFromUserGesture(
      "https://example.com/estimate-public.html?token=abc",
      fakeDoc
    );
    eq("Firmar helper reports ok", opened.ok, true);
    eq("Firmar helper uses target=_blank", clicks[0].target, "_blank");
    eq("Firmar helper uses noopener noreferrer", clicks[0].rel, "noopener noreferrer");
    eq("Firmar helper clicked once from user gesture", clicks.length, 1);
  }

  const syntaxFiles = [
    "netlify/functions/_lib/schedule-accept-guard.js",
    "netlify/functions/_lib/sales-capacity-calendar.js",
    "netlify/functions/_lib/quote-accept-bridge.js",
    "netlify/functions/update-public-estimate-status.js",
    "netlify/functions/upsert-tenant-project.js",
    "netlify/functions/hub-quote-manual-step.js",
    "public/js/estimate-builder.js",
    "public/js/sales-capacity-calendar.js",
    "scripts/test-signing-calendar-reservation.js",
  ];
  for (const rel of syntaxFiles) {
    const r = spawnSync(process.execPath, ["--check", path.join(ROOT, rel)], { encoding: "utf8" });
    eq("syntax " + rel, r.status, 0);
  }

  console.log("\nSigning calendar reservation tests: " + passed + " passed");
})().catch((err) => {
  console.error("FAIL", err && err.stack ? err.stack : err);
  process.exit(1);
});
