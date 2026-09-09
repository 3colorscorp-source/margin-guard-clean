#!/usr/bin/env node
/**
 * Invoice Hub Record Payment — modern owner session (email + tenant, no session.c).
 * Isolated: mocked RPC/ledger only. No live Netlify, email, SQL, or production payment.
 * Run: node scripts/test-record-tenant-payment-modern-owner-session.js
 */
"use strict";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET || "mg-record-tenant-payment-modern-session-test-secret";
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "mg-record-tenant-payment-modern-session-test-key";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const { buildSessionPayload, createSessionCookie } = require("../netlify/functions/_lib/session");
const { createHandler } = require("../netlify/functions/record-tenant-payment");

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

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWNER_A = "owner-a@example.com";
const USER_A = "11111111-1111-4111-8111-111111111111";
const CUS_A = "cus_legacyPayTest1";
const INV_A = "11111111-1111-4111-8111-aaaaaaaaaaaa";
const INV_OTHER = "22222222-2222-4222-8222-bbbbbbbbbbbb";
const PROJ_A = "33333333-3333-4333-8333-aaaaaaaaaaaa";
const PROJ_OTHER = "44444444-4444-4444-8444-bbbbbbbbbbbb";
const KEY_A = "aaaaaaaa-aaaa-4aaa-8aaa-ffffffffffff";
const KEY_B = "bbbbbbbb-bbbb-4bbb-8bbb-ffffffffffff";

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

function validBody(extra) {
  return Object.assign(
    {
      invoice_id: INV_A,
      payment_type: "final",
      payment_method: "check",
      amount: 6380.23,
      paid_at: "2026-09-08T12:00:00.000Z",
      notes: "contract final payment",
      idempotency_key: KEY_A,
    },
    extra || {}
  );
}

function handlerFor(store) {
  return createHandler({
    resolveTenantFromSession: async (session) => {
      store.resolveCalls.push({
        e: String(session?.e || ""),
        t: String(session?.t || ""),
        c: String(session?.c || ""),
      });
      if (String(session?.t || "") === TENANT_A) {
        return { id: TENANT_A, owner_email: OWNER_A };
      }
      if (String(session?.c || "") === CUS_A) {
        return { id: TENANT_A, owner_email: OWNER_A };
      }
      return null;
    },
    supabaseRequest: async (pathStr, options = {}) => {
      const method = String(options.method || "GET").toUpperCase();
      const pathName = String(pathStr || "");
      store.calls.push({ path: pathName, method, body: options.body || null });
      if (pathName === "rpc/record_tenant_invoice_payment") {
        store.rpcCalls.push(options.body || {});
        const tenantId = String(options.body?.p_tenant_id || "");
        const invoiceId = String(options.body?.p_invoice_id || "");
        if (tenantId !== TENANT_A || invoiceId === INV_OTHER || invoiceId !== INV_A) {
          const err = new Error("MG_PAY:invoice_not_found");
          throw err;
        }
        return {
          ok: true,
          idempotent: false,
          payment: {
            id: "pay-mock-1",
            tenant_id: tenantId,
            invoice_id: invoiceId,
            payment_type: options.body.p_payment_type,
            amount: options.body.p_amount,
          },
          invoice: { id: invoiceId, status: "paid" },
        };
      }
      if (method === "GET" && pathName.indexOf("tenant_projects?") === 0) {
        store.projectLookups.push(pathName);
        if (pathName.indexOf("id=eq." + encodeURIComponent(PROJ_A)) >= 0 && pathName.indexOf("tenant_id=eq." + encodeURIComponent(TENANT_A)) >= 0) {
          return [{ id: PROJ_A, tenant_id: TENANT_A }];
        }
        return [];
      }
      if (method === "POST" && pathName === "tenant_project_payments") {
        store.restPosts.push(options.body || {});
        return [
          {
            id: "pay-rest-1",
            ...options.body,
          },
        ];
      }
      throw new Error("unmocked " + method + " " + pathName);
    },
  });
}

function newStore() {
  return {
    resolveCalls: [],
    calls: [],
    rpcCalls: [],
    restPosts: [],
    projectLookups: [],
  };
}

async function main() {
  const src = read("netlify/functions/record-tenant-payment.js");
  const appSrc = read("public/js/app.js");

  ok("record-tenant-payment uses hasOwnerSessionIdentity", /hasOwnerSessionIdentity\(session\)/.test(src));
  ok("record-tenant-payment does not require session.c", !/session\?\.e \|\| !session\?\.c/.test(src));
  ok(
    "still resolves tenant from session",
    /resolveTenantFromSession/.test(src) && /resolveTenant\(session/.test(src)
  );
  ok("invoice path still uses tenant-scoped RPC", /rpc\/record_tenant_invoice_payment/.test(src) && /p_tenant_id: tenantId/.test(src));
  ok(
    "project lookup still tenant-scoped",
    /tenant_projects\?id=eq\.\$\{encodeURIComponent\(projectId\)\}&tenant_id=eq\.\$\{tidEnc\}/.test(src)
  );
  ok("quote lookup still tenant-scoped", /quotes\?id=eq\.\$\{encodeURIComponent\(quoteId\)\}&tenant_id=eq\.\$\{tidEnc\}/.test(src));
  ok("still validates payment type", /PAYMENT_TYPES\.has\(paymentType\)/.test(src));
  ok("still validates amount", /parseInvoiceHubPaymentAmount/.test(src));
  ok("still validates idempotency", /parseIdempotencyKey/.test(src));
  ok("no Zapier in record-tenant-payment", !/zapier/i.test(src));
  ok("no email send in record-tenant-payment", !/send.*email|nodemailer|resend/i.test(src));
  ok(
    "Hub maps Unauthorized to a friendly record-payment error",
    /Could not record payment\. Refresh the page and try again/.test(appSrc)
  );

  const modern = { e: OWNER_A, t: TENANT_A, u: USER_A, c: "" };
  const legacy = { e: OWNER_A, c: CUS_A };

  {
    const store = newStore();
    const handler = handlerFor(store);
    const none = await handler(eventFor(null, validBody()));
    eq("no cookie is 401", none.statusCode, 401);
    eq("unauthorized body", parse(none).error, "Unauthorized");
    eq("no cookie does not resolve tenant", store.resolveCalls.length, 0);
    eq("no cookie does not call RPC", store.rpcCalls.length, 0);
  }

  {
    const store = newStore();
    const handler = handlerFor(store);
    const res = await handler(eventFor(modern, validBody()));
    eq("modern owner session is 200", res.statusCode, 200);
    const body = parse(res);
    ok("modern payment ok", body.ok === true);
    eq("modern payment type final", body.payment.payment_type, "final");
    eq("modern amount unchanged", body.payment.amount, 6380.23);
    eq("modern RPC once", store.rpcCalls.length, 1);
    eq("RPC tenant is session tenant", store.rpcCalls[0].p_tenant_id, TENANT_A);
    eq("RPC invoice is requested invoice", store.rpcCalls[0].p_invoice_id, INV_A);
    eq("RPC payment_type final", store.rpcCalls[0].p_payment_type, "final");
    ok("modern session.c empty still authorized", store.resolveCalls[0].c === "");
  }

  {
    const store = newStore();
    const handler = handlerFor(store);
    const res = await handler(eventFor(legacy, validBody({ idempotency_key: KEY_B })));
    eq("legacy e+c is 200", res.statusCode, 200);
    ok("legacy payment ok", parse(res).ok === true);
    eq("legacy reached RPC", store.rpcCalls.length, 1);
  }

  {
    const store = newStore();
    const handler = handlerFor(store);
    const res = await handler(eventFor(modern, validBody({ invoice_id: INV_OTHER })));
    eq("other-tenant invoice is 404", res.statusCode, 404);
    eq("other-tenant reason", parse(res).reason, "invoice_not_found");
    eq("cross-tenant still sent session tenant to RPC", store.rpcCalls[0].p_tenant_id, TENANT_A);
    eq("no rest ledger insert on other-tenant invoice", store.restPosts.length, 0);
  }

  {
    const store = newStore();
    const handler = handlerFor(store);
    const res = await handler(
      eventFor(modern, validBody({ invoice_id: null, project_id: PROJ_OTHER, quote_id: null }))
    );
    eq("other-tenant project is 404", res.statusCode, 404);
    eq("other-tenant project reason", parse(res).reason, "project_not_found");
    eq("no RPC for project-only other tenant", store.rpcCalls.length, 0);
    eq("no rest ledger insert on other-tenant project", store.restPosts.length, 0);
    ok(
      "project lookup included tenant_id",
      store.projectLookups.some((p) => p.indexOf("tenant_id=eq." + encodeURIComponent(TENANT_A)) >= 0)
    );
  }

  {
    const store = newStore();
    const handler = handlerFor(store);
    const res = await handler(eventFor(modern, validBody({ amount: 0 })));
    eq("zero amount is 400", res.statusCode, 400);
    eq("zero amount reason", parse(res).reason, "zero_amount");
    eq("invalid amount does not call RPC", store.rpcCalls.length, 0);
  }

  {
    const store = newStore();
    const handler = handlerFor(store);
    const res = await handler(eventFor(modern, validBody({ amount: "nope" })));
    eq("invalid amount is 400", res.statusCode, 400);
    eq("invalid amount reason", parse(res).reason, "invalid_amount");
    eq("invalid amount does not insert", store.rpcCalls.length + store.restPosts.length, 0);
  }

  {
    const store = newStore();
    const handler = handlerFor(store);
    const res = await handler(eventFor(modern, validBody({ idempotency_key: "" })));
    eq("missing idempotency is 400", res.statusCode, 400);
    eq("missing idempotency reason", parse(res).reason, "missing_idempotency_key");
    eq("missing idempotency does not call RPC", store.rpcCalls.length, 0);
  }

  {
    const store = newStore();
    const handler = handlerFor(store);
    const res = await handler(
      eventFor(modern, validBody({ invoice_id: null, project_id: PROJ_A }))
    );
    eq("same-tenant project-only reaches insert", res.statusCode, 200);
    eq("project-only rest insert once", store.restPosts.length, 1);
    eq("project-only insert tenant", store.restPosts[0].tenant_id, TENANT_A);
    eq("project-only insert type final", store.restPosts[0].payment_type, "final");
    eq("project-only does not use invoice RPC", store.rpcCalls.length, 0);
  }

  console.log("\n" + passed + " passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
