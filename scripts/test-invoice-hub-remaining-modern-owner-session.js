#!/usr/bin/env node
/**
 * Invoice Hub remaining owner endpoints — modern owner session (email + tenant, no session.c).
 * Isolated: mocked Supabase only. No live Netlify, email, SQL, Zapier, or production mutation.
 * Run: node scripts/test-invoice-hub-remaining-modern-owner-session.js
 */
"use strict";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET || "mg-hub-remaining-modern-session-test-secret";
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "mg-hub-remaining-modern-session-test-key";
delete process.env.ZAPIER_INVOICE_REMINDER_WEBHOOK;
delete process.env.ZAPIER_WEBHOOK_SECRET;

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
const CUS_A = "cus_legacyHubRemaining1";
const INV_A = "11111111-1111-4111-8111-aaaaaaaaaaaa";
const INV_OTHER = "22222222-2222-4222-8222-bbbbbbbbbbbb";
const INV_PAID = "33333333-3333-4333-8333-aaaaaaaaaaaa";
const QUOTE_A = "44444444-4444-4444-8444-aaaaaaaaaaaa";
const QUOTE_OTHER = "55555555-5555-4555-8555-bbbbbbbbbbbb";

const FILES = [
  "list-tenant-payments.js",
  "patch-tenant-invoice-contact.js",
  "duplicate-tenant-invoice.js",
  "hub-invoice-archive-delete.js",
  "send-invoice-payment-reminder.js",
  "create-remaining-balance-invoice.js",
  "create-material-cost-invoice.js",
  "hub-quote-manual-step.js",
  "upsert-tenant-invoice-draft.js",
  "get-tenant-quote-edit.js",
  "update-tenant-quote-edit.js",
  "get-tenant-invoice.js",
];

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

function eventFor(fields, extra) {
  const ev = Object.assign(
    {
      httpMethod: "POST",
      headers: fields ? { cookie: cookieFor(fields), host: "example.test" } : { host: "example.test" },
      body: "{}",
      queryStringParameters: {},
    },
    extra || {}
  );
  if (extra && extra.body && typeof extra.body === "object") {
    ev.body = JSON.stringify(extra.body);
  }
  return ev;
}

function extractPath(url) {
  const s = String(url);
  if (/^https?:\/\//i.test(s) && s.indexOf("/rest/v1/") < 0) return s;
  const idx = s.indexOf("/rest/v1/");
  return idx >= 0 ? s.slice(idx + "/rest/v1/".length) : s;
}

function qp(restPath, key) {
  const q = restPath.split("?")[1] || "";
  const part = q.split("&").find((p) => p.startsWith(key + "="));
  if (!part) return "";
  return decodeURIComponent(part.slice(key.length + 1).replace(/^eq\./, ""));
}

function loadHandlers() {
  const mods = [
    "../netlify/functions/_lib/supabase-admin",
    "../netlify/functions/_lib/membership-resolve",
    "../netlify/functions/_lib/owner-access",
    "../netlify/functions/_lib/tenant-for-session",
    "../netlify/functions/_lib/quote-edit-guard",
    "../netlify/functions/_lib/tenant-device-guard",
  ].concat(FILES.map((f) => "../netlify/functions/" + f));
  mods.forEach((rel) => {
    try {
      delete require.cache[require.resolve(rel)];
    } catch (_e) {}
  });
  const out = {};
  FILES.forEach((f) => {
    out[f] = require("../netlify/functions/" + f);
  });
  return out;
}

async function withDb(fn) {
  const prev = globalThis.fetch;
  const gets = [];
  const writes = [];
  const deletes = [];
  const zapierCalls = [];

  globalThis.fetch = async (url, opts) => {
    const method = String((opts && opts.method) || "GET").toUpperCase();
    const restPath = extractPath(url);
    if (/^https?:\/\//i.test(restPath) && restPath.indexOf("hooks.zapier.com") >= 0) {
      zapierCalls.push({ url: restPath, method });
      return jsonRes(200, { ok: true });
    }
    const table = restPath.split("?")[0];
    if (method === "DELETE") {
      deletes.push({ table, path: restPath.slice(0, 220) });
      return jsonRes(200, []);
    }
    if (method !== "GET") {
      writes.push({ method, table, path: restPath.slice(0, 220) });
      if (table === "invoices" && restPath.indexOf(INV_OTHER) >= 0) {
        return jsonRes(200, []);
      }
      return jsonRes(200, [{ id: INV_A, tenant_id: TENANT_A }]);
    }
    gets.push({ table, path: restPath, tenantId: qp(restPath, "tenant_id"), id: qp(restPath, "id") });
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
      const cus = qp(restPath, "stripe_customer_id");
      if (cus === CUS_A || !id || id === TENANT_A) {
        return jsonRes(200, [
          {
            id: TENANT_A,
            slug: "tenant-a",
            name: "Tenant A",
            owner_email: OWNER_A,
            plan_status: "active",
            stripe_customer_id: CUS_A,
          },
        ]);
      }
      return jsonRes(200, []);
    }
    if (table === "invoices") {
      const tenantId = qp(restPath, "tenant_id");
      const id = qp(restPath, "id");
      if (tenantId !== TENANT_A) return jsonRes(200, []);
      if (id === INV_OTHER) return jsonRes(200, []);
      if (id === INV_PAID) {
        return jsonRes(200, [
          {
            id: INV_PAID,
            tenant_id: TENANT_A,
            status: "paid",
            quote_id: null,
            amount: 100,
            paid_amount: 100,
            balance_due: 0,
          },
        ]);
      }
      if (id === INV_A || !id) {
        return jsonRes(200, [
          {
            id: INV_A,
            tenant_id: TENANT_A,
            status: "sent",
            quote_id: QUOTE_A,
            amount: 100,
            paid_amount: 0,
            balance_due: 100,
            customer_email: "client@example.com",
            public_token: "tok_hub_a",
            invoice_no: "INV-A",
          },
        ]);
      }
      return jsonRes(200, []);
    }
    if (table === "quotes") {
      const tenantId = qp(restPath, "tenant_id");
      const id = qp(restPath, "id");
      if (tenantId === TENANT_A && (!id || id === QUOTE_A)) {
        return jsonRes(200, [
          {
            id: QUOTE_A,
            tenant_id: TENANT_A,
            status: "sent",
            accepted_at: null,
            client_name: "Client",
            total: 100,
          },
        ]);
      }
      return jsonRes(200, []);
    }
    if (table === "tenant_project_payments") {
      return jsonRes(200, []);
    }
    return jsonRes(200, []);
  };

  try {
    return await fn(loadHandlers(), { gets, writes, deletes, zapierCalls });
  } finally {
    globalThis.fetch = prev;
  }
}

async function main() {
  FILES.forEach((f) => {
    const src = read("netlify/functions/" + f);
    ok(f + " uses hasOwnerSessionIdentity", /hasOwnerSessionIdentity\(session\)/.test(src));
    ok(f + " does not require session.c", !/session\?\.e \|\| !session\?\.c/.test(src));
    ok(f + " still resolves tenant from session", /resolveTenantFromSession\(session\)/.test(src));
  });

  const archiveSrc = read("netlify/functions/hub-invoice-archive-delete.js");
  ok(
    "archive DELETE still only for action delete + draft/sent",
    /action === "delete"/.test(archiveSrc) &&
      /Delete is only allowed for draft or sent invoices/.test(archiveSrc) &&
      /method:\s*"DELETE"/.test(archiveSrc)
  );
  ok("archive still PATCHes archived", /status:\s*"archived"/.test(archiveSrc));
  ok("reminder still uses Zapier webhook env", /ZAPIER_INVOICE_REMINDER_WEBHOOK/.test(read("netlify/functions/send-invoice-payment-reminder.js")));

  const modern = { e: OWNER_A, t: TENANT_A, u: USER_A, c: "" };
  const legacy = { e: OWNER_A, c: CUS_A };

  await withDb(async (h, { gets, writes, deletes, zapierCalls }) => {
    const cases = [
      { name: "list-tenant-payments", fn: h["list-tenant-payments.js"].handler, ev: eventFor(null, { httpMethod: "GET" }) },
      { name: "get-tenant-invoice", fn: h["get-tenant-invoice.js"].handler, ev: eventFor(null, { httpMethod: "GET", queryStringParameters: { id: INV_A } }) },
      { name: "patch-tenant-invoice-contact", fn: h["patch-tenant-invoice-contact.js"].handler, ev: eventFor(null, { body: { invoice_id: INV_A, customer_name: "A" } }) },
      { name: "duplicate-tenant-invoice", fn: h["duplicate-tenant-invoice.js"].handler, ev: eventFor(null, { body: { invoice_id: INV_A } }) },
      { name: "hub-invoice-archive-delete", fn: h["hub-invoice-archive-delete.js"].handler, ev: eventFor(null, { body: { invoice_id: INV_A, action: "archive" } }) },
      { name: "send-invoice-payment-reminder", fn: h["send-invoice-payment-reminder.js"].handler, ev: eventFor(null, { body: { invoice_id: INV_A } }) },
      { name: "create-remaining-balance-invoice", fn: h["create-remaining-balance-invoice.js"].handler, ev: eventFor(null, { body: { source_invoice_id: INV_A } }) },
      { name: "create-material-cost-invoice", fn: h["create-material-cost-invoice.js"].handler, ev: eventFor(null, { body: { source_invoice_id: INV_A, material_cost: 10 } }) },
      { name: "hub-quote-manual-step", fn: h["hub-quote-manual-step.js"].handler, ev: eventFor(null, { body: { quote_id: QUOTE_A, action: "accept" } }) },
      { name: "upsert-tenant-invoice-draft", fn: h["upsert-tenant-invoice-draft.js"].handler, ev: eventFor(null, { body: {} }) },
      { name: "get-tenant-quote-edit", fn: h["get-tenant-quote-edit.js"].handler, ev: eventFor(null, { httpMethod: "GET", queryStringParameters: { quote_id: QUOTE_A } }) },
      { name: "update-tenant-quote-edit", fn: h["update-tenant-quote-edit.js"].handler, ev: eventFor(null, { body: { quote_id: QUOTE_A } }) },
    ];

    for (const c of cases) {
      const res = await c.fn(c.ev);
      eq(c.name + " no cookie is 401", res.statusCode, 401);
    }
    eq("no cookie did not write", writes.length, 0);
    eq("no cookie did not DELETE", deletes.length, 0);
    eq("no cookie did not call Zapier", zapierCalls.length, 0);

    const noIdentity = { e: OWNER_A, t: "", c: "" };
    for (const c of cases) {
      const res = await c.fn(
        eventFor(noIdentity, {
          httpMethod: c.ev.httpMethod,
          queryStringParameters: c.ev.queryStringParameters,
          body: c.ev.body ? JSON.parse(c.ev.body) : {},
        })
      );
      eq(c.name + " email-only session is 401", res.statusCode, 401);
    }
    eq("no identity did not write", writes.length, 0);
    eq("no identity did not DELETE", deletes.length, 0);
    eq("no identity did not call Zapier", zapierCalls.length, 0);

    async function not401(label, fn, ev) {
      const res = await fn(ev);
      ok(label + " is not 401 (got " + res.statusCode + ")", res.statusCode !== 401);
      return res;
    }

    await not401(
      "modern list-tenant-payments",
      h["list-tenant-payments.js"].handler,
      eventFor(modern, { httpMethod: "GET" })
    );
    await not401(
      "legacy list-tenant-payments",
      h["list-tenant-payments.js"].handler,
      eventFor(legacy, { httpMethod: "GET" })
    );
    await not401(
      "modern get-tenant-invoice",
      h["get-tenant-invoice.js"].handler,
      eventFor(modern, { httpMethod: "GET", queryStringParameters: { id: INV_A } })
    );
    await not401(
      "legacy get-tenant-invoice",
      h["get-tenant-invoice.js"].handler,
      eventFor(legacy, { httpMethod: "GET", queryStringParameters: { id: INV_A } })
    );

    const otherInv = await h["get-tenant-invoice.js"].handler(
      eventFor(modern, { httpMethod: "GET", queryStringParameters: { id: INV_OTHER } })
    );
    eq("other-tenant get-tenant-invoice is 404", otherInv.statusCode, 404);
    ok(
      "get-tenant-invoice lookup used tenant_id",
      gets.some((g) => g.table === "invoices" && g.tenantId === TENANT_A && g.id === INV_OTHER)
    );

    const otherPay = await h["list-tenant-payments.js"].handler(
      eventFor(modern, { httpMethod: "GET", queryStringParameters: { invoice_id: INV_OTHER } })
    );
    eq("list-tenant-payments other invoice still 200 scoped", otherPay.statusCode, 200);
    ok(
      "list-tenant-payments query used tenant_id",
      gets.some((g) => g.table === "tenant_project_payments" && g.path.indexOf("tenant_id=eq." + encodeURIComponent(TENANT_A)) >= 0)
    );

    const otherPatch = await h["patch-tenant-invoice-contact.js"].handler(
      eventFor(modern, { body: { invoice_id: INV_OTHER, customer_name: "X" } })
    );
    eq("other-tenant patch contact is 404", otherPatch.statusCode, 404);

    const otherDup = await h["duplicate-tenant-invoice.js"].handler(
      eventFor(modern, { body: { invoice_id: INV_OTHER } })
    );
    eq("other-tenant duplicate is 404", otherDup.statusCode, 404);

    const otherArch = await h["hub-invoice-archive-delete.js"].handler(
      eventFor(modern, { body: { invoice_id: INV_OTHER, action: "archive" } })
    );
    eq("other-tenant archive is 404", otherArch.statusCode, 404);

    const paidDel = await h["hub-invoice-archive-delete.js"].handler(
      eventFor(modern, { body: { invoice_id: INV_PAID, action: "delete" } })
    );
    eq("paid invoice delete still blocked", paidDel.statusCode, 422);
    eq("paid delete did not call DELETE", deletes.length, 0);

    const otherRem = await h["send-invoice-payment-reminder.js"].handler(
      eventFor(modern, { body: { invoice_id: INV_OTHER } })
    );
    eq("other-tenant reminder is 404", otherRem.statusCode, 404);
    eq("reminder did not call Zapier", zapierCalls.length, 0);

    const otherRemain = await h["create-remaining-balance-invoice.js"].handler(
      eventFor(modern, { body: { source_invoice_id: INV_OTHER } })
    );
    eq("other-tenant remaining-balance is 404", otherRemain.statusCode, 404);

    const otherMat = await h["create-material-cost-invoice.js"].handler(
      eventFor(modern, { body: { source_invoice_id: INV_OTHER, material_cost: 25 } })
    );
    eq("other-tenant material-cost is 404", otherMat.statusCode, 404);

    await not401(
      "modern hub-quote-manual-step",
      h["hub-quote-manual-step.js"].handler,
      eventFor(modern, { body: { quote_id: "not-a-uuid", action: "accept" } })
    );
    await not401(
      "legacy hub-quote-manual-step",
      h["hub-quote-manual-step.js"].handler,
      eventFor(legacy, { body: { quote_id: "not-a-uuid", action: "accept" } })
    );

    await not401(
      "modern get-tenant-quote-edit",
      h["get-tenant-quote-edit.js"].handler,
      eventFor(modern, { httpMethod: "GET", queryStringParameters: {} })
    );
    await not401(
      "legacy update-tenant-quote-edit",
      h["update-tenant-quote-edit.js"].handler,
      eventFor(legacy, { body: {} })
    );

    const otherDraft = await h["upsert-tenant-invoice-draft.js"].handler(
      eventFor(modern, { body: { id: INV_OTHER, customer_name: "X" } })
    );
    eq("other-tenant upsert draft is 404", otherDraft.statusCode, 404);

    const otherQuote = await h["get-tenant-quote-edit.js"].handler(
      eventFor(modern, { httpMethod: "GET", queryStringParameters: { quote_id: QUOTE_OTHER } })
    );
    eq("other-tenant get-tenant-quote-edit is 404", otherQuote.statusCode, 404);

    await not401(
      "modern upsert-tenant-invoice-draft missing fields",
      h["upsert-tenant-invoice-draft.js"].handler,
      eventFor(modern, { body: { id: INV_A } })
    );

    ok(
      "invoice lookups stayed tenant-scoped",
      gets.filter((g) => g.table === "invoices").every((g) => !g.tenantId || g.tenantId === TENANT_A)
    );
    eq("Zapier still unused after authorized other-tenant checks", zapierCalls.length, 0);
  });

  console.log("\n" + passed + " passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
