#!/usr/bin/env node
/**
 * Create Invoice — modern owner session (email + tenant, no session.c).
 * Isolated: mocked Supabase only. No live Netlify, email, or DB writes.
 * Run: node scripts/test-create-manual-invoice-modern-owner-session.js
 */
"use strict";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET || "mg-manual-invoice-modern-session-test-secret";
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "mg-manual-invoice-modern-session-test-key";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const { buildSessionPayload, createSessionCookie } = require("../netlify/functions/_lib/session");

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
  assert.strictEqual(a, b, label + " expected " + JSON.stringify(b) + " got " + JSON.stringify(a));
  passed += 1;
  console.log("PASS " + label);
}

function parse(res) {
  try {
    return JSON.parse(res.body || "{}");
  } catch (_err) {
    return {};
  }
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

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER_A = "owner-a@example.com";
const USER_A = "11111111-1111-4111-8111-111111111111";

function cookieFor(fields) {
  return createSessionCookie(
    buildSessionPayload({
      email: fields.e || "",
      tenantId: fields.t || "",
      userId: fields.u || "",
      customerId: fields.c || "",
    })
  );
}

function eventFor(fields, body) {
  return {
    httpMethod: "POST",
    headers: fields ? { cookie: cookieFor(fields) } : {},
    body: JSON.stringify(body || {}),
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

function loadHandler() {
  [
    "../netlify/functions/_lib/supabase-admin",
    "../netlify/functions/_lib/membership-resolve",
    "../netlify/functions/_lib/owner-access",
    "../netlify/functions/_lib/tenant-for-session",
    "../netlify/functions/create-manual-invoice",
  ].forEach((rel) => {
    delete require.cache[require.resolve(rel)];
  });
  return require("../netlify/functions/create-manual-invoice");
}

async function withDb(fn) {
  const prev = globalThis.fetch;
  const snapshots = {
    [TENANT_A]: [
      {
        payload: {
          storage: {
            mg_settings_v2: {
              baseInstaller: 80,
              baseHelper: 50,
              pricingMode: "hour",
              hoursPerDay: 8,
              stdHours: 160,
              overheadMonthly: 0,
              wcPct: 10,
              ficaPct: 7.65,
              futaPct: 0.6,
              casuiPct: 3.4,
              profitPct: 30,
              minimumMarginPct: 15,
              salesCommissionPct: 10,
              supervisorBonusPct: 1,
              reservePct: 5,
            },
          },
        },
      },
    ],
  };

  globalThis.fetch = async (url, init) => {
    const restPath = extractPath(url);
    const table = restPath.split("?")[0];
    const method = String((init && init.method) || "GET").toUpperCase();
    if (table === "profiles") {
      const email = qp(restPath, "email");
      const tenantId = qp(restPath, "tenant_id");
      if (email === OWNER_A && (!tenantId || tenantId === TENANT_A)) {
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
      return jsonRes(200, []);
    }
    if (table === "tenants") {
      const id = qp(restPath, "id");
      if (!id || id === TENANT_A) {
        return jsonRes(200, [
          {
            id: TENANT_A,
            slug: "tenant-a",
            name: "Tenant A",
            owner_email: OWNER_A,
            plan_status: "active",
            stripe_customer_id: null,
          },
        ]);
      }
      return jsonRes(200, []);
    }
    if (table === "tenant_snapshots") {
      const tenantId = qp(restPath, "tenant_id");
      return jsonRes(200, snapshots[tenantId] || []);
    }
    if (table === "invoices") {
      if (method === "POST") {
        let payload = {};
        try {
          payload = JSON.parse((init && init.body) || "{}");
        } catch (_err) {
          payload = {};
        }
        const row = {
          id: "inv-manual-1",
          tenant_id: TENANT_A,
          invoice_no: payload.invoice_no || "INV-1",
          customer_name: payload.customer_name || "",
          customer_email: payload.customer_email || "",
          project_name: payload.project_name || "",
          amount: payload.amount,
          balance_due: payload.balance_due,
          status: payload.status || "draft",
          due_date: payload.due_date || null,
          notes: payload.notes || "",
        };
        snapshots._invoice = row;
        return jsonRes(201, [row]);
      }
      return jsonRes(200, snapshots._invoice ? [snapshots._invoice] : []);
    }
    return jsonRes(404, { message: "unmocked " + restPath });
  };

  try {
    return await fn(loadHandler());
  } finally {
    globalThis.fetch = prev;
  }
}

async function main() {
  const src = read("netlify/functions/create-manual-invoice.js");
  const appSrc = read("public/js/app.js");

  ok("create-manual-invoice uses hasOwnerSessionIdentity", /hasOwnerSessionIdentity\(session\)/.test(src));
  ok("create-manual-invoice does not require session.c", !/session\?\.e \|\| !session\?\.c/.test(src));
  ok("preview still posts to create-manual-invoice", /preview_system_rates:\s*true/.test(appSrc));
  ok("modal open does not display raw Unauthorized", !/setNotice\("hubFormFeedback", errRaw/.test(appSrc));

  const modern = { e: OWNER_A, t: TENANT_A, u: USER_A, c: "" };

  await withDb(async (handler) => {
    const none = await handler.handler(eventFor(null, { preview_system_rates: true }));
    eq("no cookie is 401", none.statusCode, 401);

    const preview = await handler.handler(eventFor(modern, { preview_system_rates: true }));
    eq("modern owner preview is 200", preview.statusCode, 200);
    const body = parse(preview);
    ok("preview ok", body.ok === true);
    ok("hourly rate is a positive number", Number(body.system_hourly_rate) > 0);
    ok("daily rate is a positive number", Number(body.system_daily_rate) > 0);
    ok("helper hourly rate is a positive number", Number(body.system_helper_hourly_rate) > 0);
    ok("helper daily rate is a positive number", Number(body.system_helper_daily_rate) > 0);
    ok("helper hourly is not the pro hourly", Number(body.system_helper_hourly_rate) !== Number(body.system_hourly_rate));
    ok("preview does not return an invoice row", body.invoice == null);
  });

  ok("modal has addable workers", /hub-manual-add-day-worker/.test(appSrc) && /hubManualWorkersList/.test(appSrc));
  ok("modal can charge by hour or day", /Charge by/.test(appSrc) && /data-hub-charge="hourly"/.test(appSrc) && /data-hub-charge="daily"/.test(appSrc));
  ok("manual create uses ultra-pro calendar", /hub-mini-cal/.test(appSrc) && /today_plus/.test(appSrc) && /is-manual-create/.test(appSrc) && /cancelLabel: "Cancel"/.test(appSrc));
  ok("description has dictation and interpret review", /hubManualDescMicNew/.test(appSrc) && /Interpret and review/.test(appSrc) && /Confirm and apply/.test(appSrc));
  ok("description interpret does not create the invoice", /interpret-manual-invoice-description/.test(appSrc) && /Create Invoice is still required to save/.test(appSrc));
  ok("workers are billed by selected days", /hubManualWorkCal/.test(appSrc) && /Days billed/.test(appSrc) && /work_days:/.test(appSrc));
  ok("submit still sends workers array", /workers: billing_type === "flat_amount" \? \[\] : crew\.map/.test(appSrc));
  ok("server parses workers", /parseManualInvoiceWorkers/.test(src));
  ok("server parses work days", /parseManualInvoiceWorkDays/.test(src));

  await withDb(async (handler) => {
    const modern = { e: OWNER_A, t: TENANT_A, u: USER_A, c: "" };
    const preview = await handler.handler(eventFor(modern, { preview_system_rates: true }));
    const rates = parse(preview);
    const created = await handler.handler(
      eventFor(modern, {
        client_name: "Matthew",
        client_email: "maloney58@icloud.com",
        project_title: "Pepper",
        description: "208 sqf membrane installation",
        billing_type: "hourly",
        workers: [
          { role: "installer", quantity: 66 },
          { role: "assistant", quantity: 80 },
        ],
        materials_cost: 496,
      })
    );
    const createBody = parse(created);
    eq("worker invoice is 200", created.statusCode, 200);
    ok("worker invoice ok", createBody.ok === true);
    const expected = Math.round(
      (66 * Number(rates.system_hourly_rate) + 80 * Number(rates.system_helper_hourly_rate) + 496) * 100
    ) / 100;
    eq("worker invoice amount uses pro and assistant hours", createBody.invoice.amount, expected);

    const byDay = await handler.handler(
      eventFor(modern, {
        client_name: "Matthew",
        client_email: "maloney58@icloud.com",
        project_title: "Pepper",
        description: "208 sqf membrane installation",
        billing_type: "hourly",
        work_days: [
          {
            date: "2026-09-28",
            workers: [
              { role: "installer", quantity: 8 },
              { role: "assistant", quantity: 8 },
            ],
          },
          {
            date: "2026-09-29",
            workers: [{ role: "installer", quantity: 6 }],
          },
        ],
        materials_cost: 496,
      })
    );
    const byDayBody = parse(byDay);
    eq("work-day invoice is 200", byDay.statusCode, 200);
    const expectedDays = Math.round(
      ((8 + 6) * Number(rates.system_hourly_rate) + 8 * Number(rates.system_helper_hourly_rate) + 496) * 100
    ) / 100;
    eq("work-day invoice amount sums hours per day", byDayBody.invoice.amount, expectedDays);
    ok("work-day notes include first billed date", /Sep 28, 2026/.test(String(byDayBody.debug_notes_preview || "")));
    ok("work-day notes include two-day billing length", Number(byDayBody.debug_notes_length) >= 280);
  });

  console.log("\n" + passed + " passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
