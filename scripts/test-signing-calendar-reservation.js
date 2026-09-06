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
ok("3. Firmar opens public signing in a new window", /window\.open\(publicUrl/.test(firmarClick));
ok(
  "3b. Firmar copy says closing does not block other quotes",
  /does not block other quotes|does not reserve the schedule/.test(firmarClick)
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

  const syntaxFiles = [
    "netlify/functions/_lib/schedule-accept-guard.js",
    "netlify/functions/_lib/sales-capacity-calendar.js",
    "netlify/functions/_lib/quote-accept-bridge.js",
    "netlify/functions/update-public-estimate-status.js",
    "netlify/functions/upsert-tenant-project.js",
    "netlify/functions/hub-quote-manual-step.js",
    "public/js/estimate-builder.js",
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
