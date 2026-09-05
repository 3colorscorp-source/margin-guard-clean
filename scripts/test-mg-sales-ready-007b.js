#!/usr/bin/env node
/**
 * MG-SALES-READY-007B — Invoice Hub payment integrity freeze
 * Usage: node scripts/test-mg-sales-ready-007b.js
 *
 * Mocked session/DB/RPC only. Does not connect to production.
 * Does not apply the migration. Does not mutate historical payment rows.
 */
"use strict";

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "mg-sales-ready-007b-test-session-secret";
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "mg-sales-ready-007b-test-service-role";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const { createHandler } = require("../netlify/functions/record-tenant-payment");
const { parseInvoiceHubPaymentAmount } = require("../netlify/functions/_lib/invoice-hub-payment-amount");
const { buildSessionPayload, createSessionCookie } = require("../netlify/functions/_lib/session");

const APPLY = "SUPABASE_MG_SALES_READY_007B_INVOICE_PAYMENT_INTEGRITY.sql";
const ROLLBACK = "SUPABASE_MG_SALES_READY_007B_INVOICE_PAYMENT_INTEGRITY_ROLLBACK.sql";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const INV_A = "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const INV_CHILD = "22222222-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const INV_PARENT = "33333333-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const INV_B = "44444444-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROJ_A = "55555555-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const QUOTE_A = "66666666-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

let failed = 0;
let passed = 0;

function assert(name, cond) {
  if (cond) {
    passed += 1;
    console.log("PASS  " + name);
  } else {
    failed += 1;
    console.log("FAIL  " + name);
  }
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function stripSqlComments(src) {
  return String(src || "")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[ \t]*--[^\n]*$/gm, " ");
}

function parse(res) {
  try {
    return JSON.parse(res.body || "{}");
  } catch (_err) {
    return {};
  }
}

function money(n) {
  return Math.round(Number(n) * 100) / 100;
}

function newKey() {
  return crypto.randomUUID();
}

function cookieFor(tenantId) {
  return createSessionCookie(
    buildSessionPayload({
      tenantId,
      email: "owner@example.com",
      userId: "user-a",
      customerId: "cus_test",
      subscriptionId: "sub_test",
    })
  ).split(";")[0];
}

function eventWith(cookie, body) {
  return {
    httpMethod: "POST",
    headers: { cookie },
    body: JSON.stringify(body),
  };
}

function roundDollars(n) {
  return Math.round(Number(n) * 100) / 100;
}

function simulateRpc(store, args) {
  if (store.denyRpc) {
    const err = new Error("permission denied for function record_tenant_invoice_payment");
    err.status = 401;
    throw err;
  }
  const tenantId = String(args.p_tenant_id || "");
  const invoiceId = String(args.p_invoice_id || "");
  const key = String(args.p_idempotency_key || "").trim();
  const type = String(args.p_payment_type || "").trim().toLowerCase();
  const method = String(args.p_payment_method || "").trim().toLowerCase();
  if (!tenantId || !invoiceId) throw new Error("MG_PAY:invoice_not_found");
  if (!key) throw new Error("MG_PAY:missing_idempotency_key");
  if (!["deposit", "progress", "final", "adjustment"].includes(type)) {
    throw new Error("MG_PAY:invalid_payment_type");
  }
  if (!["check", "cash", "zelle", "stripe", "bank_transfer", "other"].includes(method)) {
    throw new Error("MG_PAY:invalid_payment_method");
  }
  if (args.p_amount == null || !Number.isFinite(Number(args.p_amount))) {
    throw new Error("MG_PAY:invalid_amount");
  }
  const amount = roundDollars(args.p_amount);
  if (amount === 0) throw new Error("MG_PAY:zero_amount");
  if (["deposit", "progress", "final"].includes(type) && amount < 0) {
    throw new Error("MG_PAY:negative_normal_payment");
  }

  const inv = store.invoices.find((row) => row.id === invoiceId && row.tenant_id === tenantId);
  if (!inv) throw new Error("MG_PAY:invoice_not_found");
  const status = String(inv.status || "").trim().toLowerCase();
  if (status === "archived") throw new Error("MG_PAY:invoice_archived");
  if (status === "cancelled" || status === "canceled") throw new Error("MG_PAY:invoice_cancelled");
  if (status === "void") throw new Error("MG_PAY:invoice_void");

  const existing = store.payments.find(
    (row) => row.tenant_id === tenantId && row.idempotency_key === key
  );
  if (existing) {
    return {
      ok: true,
      idempotent: true,
      payment: { ...existing },
      invoice: {
        id: inv.id,
        paid_amount: inv.paid_amount,
        balance_due: inv.balance_due,
        status: inv.status,
        paid_at: inv.paid_at,
      },
    };
  }

  if (store.failRpc) {
    throw new Error("simulated_rpc_failure");
  }

  const ledger = roundDollars(
    store.payments
      .filter((row) => row.tenant_id === tenantId && row.invoice_id === invoiceId)
      .reduce((sum, row) => sum + Number(row.amount || 0), 0)
  );
  const remaining = roundDollars(Number(inv.amount || 0) - ledger);
  const epsilon = 0.005;
  if (["deposit", "progress", "final"].includes(type)) {
    if (remaining <= epsilon) throw new Error("MG_PAY:invoice_already_paid");
    if (amount > remaining + epsilon) throw new Error("MG_PAY:payment_exceeds_remaining_balance");
  }

  const payment = {
    id: "pay-" + String(store.payments.length + 1).padStart(3, "0"),
    tenant_id: tenantId,
    invoice_id: invoiceId,
    quote_id: args.p_quote_id || inv.quote_id || null,
    project_id: args.p_project_id || null,
    payment_type: type,
    payment_method: method,
    amount,
    paid_at: args.p_paid_at || new Date().toISOString(),
    notes: args.p_notes || "",
    created_by: args.p_created_by || null,
    idempotency_key: key,
  };
  store.payments.push(payment);

  const newPaid = roundDollars(
    store.payments
      .filter((row) => row.tenant_id === tenantId && row.invoice_id === invoiceId)
      .reduce((sum, row) => sum + Number(row.amount || 0), 0)
  );
  let newBalance = roundDollars(Number(inv.amount || 0) - newPaid);
  if (newBalance < 0) newBalance = 0;
  inv.paid_amount = newPaid;
  inv.balance_due = newBalance;
  inv.updated_at = new Date().toISOString();
  if (newBalance <= epsilon) {
    inv.balance_due = 0;
    inv.status = "paid";
    inv.paid_at = inv.paid_at || payment.paid_at;
  }

  return {
    ok: true,
    idempotent: false,
    payment: { ...payment },
    invoice: {
      id: inv.id,
      paid_amount: inv.paid_amount,
      balance_due: inv.balance_due,
      status: inv.status,
      paid_at: inv.paid_at,
    },
  };
}

function parseRestPath(pathStr) {
  const q = String(pathStr).indexOf("?");
  const table = q < 0 ? String(pathStr) : String(pathStr).slice(0, q);
  const qs = q < 0 ? "" : String(pathStr).slice(q + 1);
  const filters = [];
  for (const part of qs.split("&")) {
    if (!part) continue;
    const decoded = decodeURIComponent(part);
    const eq = /^([^=]+)=eq\.(.*)$/.exec(decoded);
    if (eq) filters.push({ field: eq[1], value: eq[2] });
  }
  return { table, filters };
}

function matchRow(row, filters) {
  for (const f of filters) {
    if (f.field === "select" || f.field === "order" || f.field === "limit") continue;
    const val = row[f.field] == null ? "" : String(row[f.field]);
    if (val !== String(f.value)) return false;
  }
  return true;
}

function createStore(seed = {}) {
  const store = {
    invoices: seed.invoices ? seed.invoices.map((r) => ({ ...r })) : [],
    payments: seed.payments ? seed.payments.map((r) => ({ ...r })) : [],
    projects: seed.projects ? seed.projects.map((r) => ({ ...r })) : [],
    quotes: seed.quotes ? seed.quotes.map((r) => ({ ...r })) : [],
    failRpc: false,
    denyRpc: false,
    rpcCalls: [],
    restPosts: [],
    restPatches: [],
  };

  async function supabaseRequest(pathStr, options = {}) {
    const method = String(options.method || "GET").toUpperCase();
    const p = String(pathStr);
    if (p === "rpc/record_tenant_invoice_payment") {
      store.rpcCalls.push(options.body || {});
      return simulateRpc(store, options.body || {});
    }
    const { table, filters } = parseRestPath(p);
    if (method === "POST" && table === "tenant_project_payments") {
      store.restPosts.push(options.body || {});
      const row = {
        id: "pay-rest-" + String(store.payments.length + 1),
        ...options.body,
      };
      if (
        row.idempotency_key &&
        store.payments.some(
          (existing) =>
            existing.tenant_id === row.tenant_id && existing.idempotency_key === row.idempotency_key
        )
      ) {
        const err = new Error("Supabase HTTP 409: 23505 duplicate key");
        err.status = 409;
        throw err;
      }
      store.payments.push(row);
      return [row];
    }
    if (method === "PATCH") {
      store.restPatches.push({ table, body: options.body || {} });
    }
    const rows = (store[table] || store.invoices).filter((row) => matchRow(row, filters));
    if (table === "tenant_project_payments") {
      return store.payments.filter((row) => matchRow(row, filters)).map((row) => ({ ...row }));
    }
    if (table === "tenant_projects") {
      return store.projects.filter((row) => matchRow(row, filters)).map((row) => ({ ...row }));
    }
    if (table === "quotes") {
      return store.quotes.filter((row) => matchRow(row, filters)).map((row) => ({ ...row }));
    }
    if (table === "invoices") {
      return store.invoices.filter((row) => matchRow(row, filters)).map((row) => ({ ...row }));
    }
    return rows;
  }

  return { store, supabaseRequest };
}

function handlerFor(storeApi, tenantId) {
  return createHandler({
    supabaseRequest: storeApi.supabaseRequest,
    resolveTenantFromSession: async () => ({ id: tenantId, owner_email: "owner@example.com" }),
  });
}

function openInvoice(id, tenantId, amount, extra = {}) {
  return {
    id,
    tenant_id: tenantId,
    amount,
    paid_amount: 0,
    balance_due: amount,
    status: extra.status || "sent",
    quote_id: extra.quote_id || null,
    paid_at: extra.paid_at || null,
    ...extra,
  };
}

async function main() {
  const applySrc = read(APPLY);
  const rollbackSrc = read(ROLLBACK);
  const applyLive = stripSqlComments(applySrc);
  const paySrc = read("netlify/functions/record-tenant-payment.js");
  const amountSrc = read("netlify/functions/_lib/invoice-hub-payment-amount.js");
  const appSrc = read("public/js/app.js");
  const listPaySrc = read("netlify/functions/list-tenant-payments.js");
  const listInvSrc = read("netlify/functions/list-tenant-invoices.js");
  const pubInvSrc = read("netlify/functions/get-public-invoice.js");
  const sendSrc = read("netlify/functions/send-invoice-zapier.js");
  const reminderSrc = read("netlify/functions/send-invoice-payment-reminder.js");
  const pubEstSrc = read("netlify/functions/get-public-estimate.js");
  const depositSrc = read("netlify/functions/finalize-project-deposit.js");
  const supportChat = read("netlify/functions/mg-support-chat.js");
  const fcSrc = read("netlify/functions/create-financial-connections-session.js");
  const saasHtml = read("public/saas-admin.html");
  const saasJs = read("public/js/saas-admin.js");
  const stripeWh = read("netlify/functions/stripe-invoice-webhook.js");
  const remainingSrc = read("netlify/functions/create-remaining-balance-invoice.js");

  assert("0a. apply migration exists", applySrc.length > 200);
  assert("0b. rollback exists separately", rollbackSrc.length > 50);
  assert("0c. migration is unapplied SQL only", /UNAPPLIED/.test(applySrc) && /^\s*BEGIN;/m.test(applySrc));
  assert("0d. dollars column stays numeric", /amount numeric\(14, 2\)/.test(read("SUPABASE_TENANT_PROJECT_PAYMENTS.sql")));
  assert("0e. idempotency column + unique partial index", /idempotency_key text/.test(applyLive) && /unique index[\s\S]*tenant_id, idempotency_key/i.test(applyLive) && /WHERE idempotency_key IS NOT NULL/i.test(applyLive));
  assert("0f. FOR UPDATE lock", /FOR UPDATE/.test(applyLive));
  assert("0g. search_path hardened", /SET search_path = public, pg_temp/.test(applyLive));
  assert("0h. EXECUTE revoked from PUBLIC/anon/authenticated", /REVOKE ALL ON FUNCTION[\s\S]*FROM PUBLIC/.test(applyLive) && /FROM anon/.test(applyLive) && /FROM authenticated/.test(applyLive));
  assert("0i. EXECUTE granted only to service_role", /GRANT EXECUTE ON FUNCTION[\s\S]*TO service_role/.test(applyLive));
  assert("0j. not SECURITY DEFINER", !/SECURITY DEFINER/.test(applyLive));
  assert("0k. no dollars-to-cents write", !/\*\s*100/.test(applyLive) && !/p_amount\s*\*\s*100/.test(applySrc));
  assert("0l. overpay raises closed error", /payment_exceeds_remaining_balance/.test(applyLive) && !/clamp/.test(applyLive));
  assert("0m. does not write void status", !/\bSET\b[\s\S]{0,120}status = 'void'/.test(applyLive) && /v_status = 'void'/.test(applyLive));
  assert("0n. paid status is production-valid paid", /status = 'paid'/.test(applyLive));
  assert("0o. migration does not touch historical rows", !/\bUPDATE\s+public\.tenant_project_payments\b/i.test(applyLive) && !/\bDELETE\s+FROM\s+public\.tenant_project_payments\b/i.test(applyLive));
  assert("0p. does not drop invoices_tenant_quote_unique", !/invoices_tenant_quote_unique/.test(applyLive));

  const one = parseInvoiceHubPaymentAmount(1, "deposit");
  const hundred = parseInvoiceHubPaymentAmount(100, "progress");
  const hist = parseInvoiceHubPaymentAmount(12954.14, "progress");
  assert("1. $1.00 normalizes to 1", one.ok && one.amount === 1);
  assert("2. $100 normalizes to 100", hundred.ok && hundred.amount === 100);
  assert("3. $12954.14 stays 12954.14", hist.ok && hist.amount === 12954.14);
  assert("4. helper does not store cents", amountSrc.includes("Math.round(n * 100) / 100") && /remains numeric dollars/.test(amountSrc));
  assert("5. 12954.14 never becomes 1295414 in helper", hist.amount !== 1295414 && hist.amount === 12954.14);
  assert("10. zero rejected", parseInvoiceHubPaymentAmount(0, "deposit").error === "zero_amount");
  assert("11. negative normal payment rejected", parseInvoiceHubPaymentAmount(-1, "final").error === "negative_normal_payment");
  assert("12. NaN/invalid rejected", parseInvoiceHubPaymentAmount("nope", "deposit").error === "invalid_amount");
  assert("12b. Infinity rejected", parseInvoiceHubPaymentAmount(Infinity, "deposit").error === "invalid_amount");
  assert("12c. empty rejected", parseInvoiceHubPaymentAmount("", "deposit").error === "invalid_amount");

  const cookieA = cookieFor(TENANT_A);

  {
    const api = createStore({
      invoices: [openInvoice(INV_A, TENANT_A, 50)],
    });
    const handler = handlerFor(api, TENANT_A);
    const res = await handler(
      eventWith(cookieA, {
        invoice_id: INV_A,
        payment_type: "deposit",
        payment_method: "check",
        amount: 1,
        idempotency_key: newKey(),
      })
    );
    const body = parse(res);
    assert("1b. $1.00 stores exactly 1.00", res.statusCode === 200 && Number(body.payment.amount) === 1 && Number(api.store.payments[0].amount) === 1);
  }

  {
    const api = createStore({ invoices: [openInvoice(INV_A, TENANT_A, 100)] });
    const handler = handlerFor(api, TENANT_A);
    const res = await handler(
      eventWith(cookieA, {
        invoice_id: INV_A,
        payment_type: "final",
        payment_method: "check",
        amount: 100,
        idempotency_key: newKey(),
      })
    );
    const body = parse(res);
    assert("2b. $100 stores exactly 100.00", res.statusCode === 200 && Number(body.payment.amount) === 100 && Number(api.store.invoices[0].paid_amount) === 100);
  }

  {
    const api = createStore({ invoices: [openInvoice(INV_A, TENANT_A, 21118.75)] });
    const handler = handlerFor(api, TENANT_A);
    const res = await handler(
      eventWith(cookieA, {
        invoice_id: INV_A,
        payment_type: "progress",
        payment_method: "check",
        amount: 12954.14,
        idempotency_key: newKey(),
      })
    );
    const body = parse(res);
    const stored = Number(api.store.payments[0].amount);
    assert(
      "3b. $12954.14 stores exactly 12954.14",
      res.statusCode === 200 && stored === 12954.14 && Number(body.payment.amount) === 12954.14 && stored !== 1295414
    );
    assert("5b. current path cannot create 1295414 from 12954.14", stored === 12954.14 && api.store.payments.length === 1);
  }

  {
    const api = createStore({ invoices: [openInvoice(INV_A, TENANT_A, 500)] });
    const handler = handlerFor(api, TENANT_A);
    const key = newKey();
    const payload = {
      invoice_id: INV_A,
      payment_type: "progress",
      payment_method: "check",
      amount: 40,
      idempotency_key: key,
    };
    const r1 = await handler(eventWith(cookieA, payload));
    const r2 = await handler(eventWith(cookieA, payload));
    const b1 = parse(r1);
    const b2 = parse(r2);
    assert("6. same idempotency_key creates one ledger row", r1.statusCode === 200 && r2.statusCode === 200 && api.store.payments.length === 1);
    assert("7. same key does not increase paid_amount twice", Number(api.store.invoices[0].paid_amount) === 40 && b2.idempotent === true && Number(b1.payment.amount) === 40);
  }

  {
    const api = createStore({ invoices: [openInvoice(INV_A, TENANT_A, 500)] });
    const handler = handlerFor(api, TENANT_A);
    const r1 = await handler(
      eventWith(cookieA, {
        invoice_id: INV_A,
        payment_type: "progress",
        payment_method: "check",
        amount: 10,
        idempotency_key: newKey(),
      })
    );
    const r2 = await handler(
      eventWith(cookieA, {
        invoice_id: INV_A,
        payment_type: "progress",
        payment_method: "check",
        amount: 15,
        idempotency_key: newKey(),
      })
    );
    assert(
      "8. two different keys create two payments",
      r1.statusCode === 200 && r2.statusCode === 200 && api.store.payments.length === 2 && Number(api.store.invoices[0].paid_amount) === 25
    );
  }

  {
    const api = createStore({ invoices: [openInvoice(INV_A, TENANT_A, 50)] });
    const handler = handlerFor(api, TENANT_A);
    const res = await handler(
      eventWith(cookieA, {
        invoice_id: INV_A,
        payment_type: "progress",
        payment_method: "check",
        amount: 50.02,
        idempotency_key: newKey(),
      })
    );
    const body = parse(res);
    assert(
      "9. payment > remaining returns 422 and writes nothing",
      res.statusCode === 422 &&
        body.error === "payment_exceeds_remaining_balance" &&
        api.store.payments.length === 0 &&
        Number(api.store.invoices[0].paid_amount) === 0
    );
  }

  {
    const api = createStore({ invoices: [openInvoice(INV_A, TENANT_A, 50)] });
    const handler = handlerFor(api, TENANT_A);
    const zero = await handler(
      eventWith(cookieA, {
        invoice_id: INV_A,
        payment_type: "deposit",
        payment_method: "check",
        amount: 0,
        idempotency_key: newKey(),
      })
    );
    const neg = await handler(
      eventWith(cookieA, {
        invoice_id: INV_A,
        payment_type: "deposit",
        payment_method: "check",
        amount: -5,
        idempotency_key: newKey(),
      })
    );
    const nan = await handler(
      eventWith(cookieA, {
        invoice_id: INV_A,
        payment_type: "deposit",
        payment_method: "check",
        amount: "abc",
        idempotency_key: newKey(),
      })
    );
    assert("10b. zero rejected by handler", zero.statusCode === 400 && parse(zero).error === "zero_amount" && api.store.payments.length === 0);
    assert("11b. negative normal payment rejected by handler", neg.statusCode === 400 && parse(neg).error === "negative_normal_payment");
    assert("12d. invalid amount rejected by handler", nan.statusCode === 400 && parse(nan).error === "invalid_amount");
  }

  {
    const api = createStore({
      invoices: [openInvoice(INV_B, TENANT_B, 80), openInvoice(INV_A, TENANT_A, 80)],
    });
    const handler = handlerFor(api, TENANT_A);
    const res = await handler(
      eventWith(cookieA, {
        invoice_id: INV_B,
        payment_type: "progress",
        payment_method: "check",
        amount: 10,
        idempotency_key: newKey(),
        tenant_id: TENANT_B,
      })
    );
    assert("13. cross-tenant invoice rejected", res.statusCode === 404 && parse(res).error === "invoice_not_found" && api.store.payments.length === 0);
    assert("19. browser tenant_id is ignored as authority", api.store.rpcCalls[0] && api.store.rpcCalls[0].p_tenant_id === TENANT_A);
  }

  {
    const api = createStore({ invoices: [openInvoice(INV_A, TENANT_A, 80, { status: "archived" })] });
    const handler = handlerFor(api, TENANT_A);
    const res = await handler(
      eventWith(cookieA, {
        invoice_id: INV_A,
        payment_type: "progress",
        payment_method: "check",
        amount: 10,
        idempotency_key: newKey(),
      })
    );
    assert("14. archived invoice rejected", res.statusCode === 422 && parse(res).error === "invoice_archived" && api.store.payments.length === 0);
  }

  {
    const api = createStore({ invoices: [openInvoice(INV_A, TENANT_A, 80, { status: "cancelled" })] });
    const handler = handlerFor(api, TENANT_A);
    const res = await handler(
      eventWith(cookieA, {
        invoice_id: INV_A,
        payment_type: "progress",
        payment_method: "check",
        amount: 10,
        idempotency_key: newKey(),
      })
    );
    assert("15. cancelled invoice rejected", res.statusCode === 422 && parse(res).error === "invoice_cancelled");
  }

  {
    const api = createStore({
      invoices: [openInvoice(INV_A, TENANT_A, 80, { status: "paid", paid_amount: 80, balance_due: 0 })],
      payments: [
        {
          id: "pay-old",
          tenant_id: TENANT_A,
          invoice_id: INV_A,
          amount: 80,
          idempotency_key: "00000000-0000-4000-8000-000000000001",
        },
      ],
    });
    const handler = handlerFor(api, TENANT_A);
    const res = await handler(
      eventWith(cookieA, {
        invoice_id: INV_A,
        payment_type: "final",
        payment_method: "check",
        amount: 1,
        idempotency_key: newKey(),
      })
    );
    assert("16. fully paid invoice rejected", res.statusCode === 422 && parse(res).error === "invoice_already_paid" && api.store.payments.length === 1);
  }

  {
    const api = createStore({ invoices: [openInvoice(INV_A, TENANT_A, 80)] });
    api.store.failRpc = true;
    const handler = handlerFor(api, TENANT_A);
    const res = await handler(
      eventWith(cookieA, {
        invoice_id: INV_A,
        payment_type: "progress",
        payment_method: "check",
        amount: 10,
        idempotency_key: newKey(),
      })
    );
    assert(
      "17. ledger insert + invoice rollup are atomic",
      res.statusCode === 500 && api.store.payments.length === 0 && Number(api.store.invoices[0].paid_amount) === 0 && api.store.restPatches.length === 0
    );
    assert("17b. invoice path uses RPC only", /rpc\/record_tenant_invoice_payment/.test(paySrc) && !/syncInvoiceRollupFromLedger/.test(paySrc));
  }

  {
    const api = createStore({ invoices: [openInvoice(INV_A, TENANT_A, 80)] });
    const handler = handlerFor(api, TENANT_A);
    const res = await handler(
      eventWith(cookieA, {
        invoice_id: INV_A,
        payment_type: "progress",
        payment_method: "check",
        amount: "not-a-number",
        idempotency_key: newKey(),
      })
    );
    assert("18. validation failure writes nothing", res.statusCode === 400 && api.store.payments.length === 0 && api.store.rpcCalls.length === 0);
  }

  assert("20. service_role RPC only", /GRANT EXECUTE[\s\S]*TO service_role/.test(applyLive));
  assert("21. anon RPC denied", /REVOKE ALL ON FUNCTION[\s\S]*FROM anon/.test(applyLive));
  assert("22. authenticated RPC denied", /REVOKE ALL ON FUNCTION[\s\S]*FROM authenticated/.test(applyLive));

  assert("23. Record Payment UI still posts to record-tenant-payment", /submitHubRecordPayment/.test(appSrc) && /\/\.netlify\/functions\/record-tenant-payment/.test(appSrc));
  assert("23b. submit disabled while in flight", /btnHubRecordPaySubmit/.test(appSrc) && /submitBtn\.disabled = true/.test(appSrc));
  assert("23c. idempotency_key generated per modal open and reused on retry", /hubRecordPayModalCtx\.idempotencyKey = newHubPaymentIdempotencyKey/.test(appSrc) && /idempotency_key: hubRecordPayModalCtx\.idempotencyKey/.test(appSrc));
  assert("23d. success cannot be processed twice visually", /hubRecordPayModalCtx\.successHandled/.test(appSrc));
  assert("23e. overpay copy no longer invites submit", /The server will reject this payment/.test(appSrc) && !/You can still submit if intended/.test(appSrc));
  assert("24. Mark Paid local path unchanged; server ledger is Record Payment", /function markHubInvoicePaid/.test(appSrc) && /action === "record-payment"/.test(appSrc) && /openHubRecordPaymentModal/.test(appSrc));
  assert("25. payment history still loads list-tenant-payments", /list-tenant-payments/.test(appSrc) && /tenant_id/.test(listPaySrc) && /resolveTenantFromSession/.test(listPaySrc));

  {
    const api = createStore({
      invoices: [
        openInvoice(INV_PARENT, TENANT_A, 10000, { quote_id: QUOTE_A }),
        openInvoice(INV_CHILD, TENANT_A, 200, { quote_id: null }),
      ],
    });
    const handler = handlerFor(api, TENANT_A);
    const res = await handler(
      eventWith(cookieA, {
        invoice_id: INV_CHILD,
        payment_type: "progress",
        payment_method: "check",
        amount: 25,
        idempotency_key: newKey(),
      })
    );
    const parent = api.store.invoices.find((row) => row.id === INV_PARENT);
    const child = api.store.invoices.find((row) => row.id === INV_CHILD);
    assert("26. Project Billing child payment stays on child invoice", res.statusCode === 200 && api.store.payments[0].invoice_id === INV_CHILD && Number(child.paid_amount) === 25);
    assert("27. parent invoice is NOT patched with a child payment", Number(parent.paid_amount) === 0 && parent.status !== "paid");
  }

  assert("28. public invoice unchanged", /public_token=eq/.test(pubInvSrc) && /invoice-public\.html/.test(pubInvSrc) && !/record_tenant_invoice_payment/.test(pubInvSrc));
  assert("29. send/resend unchanged", /send-invoice-zapier/.test(appSrc) && /Zapier/.test(sendSrc) && !/record_tenant_invoice_payment/.test(sendSrc));
  assert("30. manual payment reminder unchanged", /send-invoice-payment-reminder/.test(appSrc) && !/record_tenant_invoice_payment/.test(reminderSrc));
  assert("31. quote/deposit workflow unchanged", /public_token=eq/.test(pubEstSrc) && /deposit_paid_amount/.test(depositSrc) && !/record_tenant_invoice_payment/.test(depositSrc) && !/record_tenant_invoice_payment/.test(pubEstSrc));
  assert("32. Support unchanged", /mg-support-chat/.test(supportChat) && !/record_tenant_invoice_payment/.test(supportChat) && !/saas-admin/.test(supportChat));
  assert("33. Stripe Financial Connections unchanged", /permissions\[\]", "balances"/.test(fcSrc) && !/permissions\[\]", "transactions"/.test(fcSrc) && !/record_tenant_invoice_payment/.test(fcSrc));
  assert("34. SaaS admin unchanged", /saas-admin/.test(saasHtml) && !/record-tenant-payment/.test(saasJs) && !/record_tenant_invoice_payment/.test(saasJs));
  assert("35. Stripe webhook still does not write tenant_project_payments", !/tenant_project_payments/.test(stripeWh));
  assert("36. remaining-balance invoices still avoid quote_id unique collision", /Do not set quote_id/.test(remainingSrc));
  assert("37. handler still tenant-scoped for 004B freeze", /tenant_id=eq/.test(paySrc) && /tenant_project_payments/.test(paySrc) && /resolveTenantFromSession/.test(paySrc));
  assert("38. list-tenant-invoices still tenant-scoped", /tenant_id/.test(listInvSrc) && /resolveTenantFromSession/.test(listInvSrc));
  assert("39. no Invoice Hub redesign markers", /id="hubRecordPaymentModal"/.test(read("public/estimates-invoices.html")) && /Save to ledger/.test(read("public/estimates-invoices.html")));

  const rpcAmount = String(paySrc.match(/p_amount:\s*amount/) || "");
  assert("40. RPC receives already-normalized dollars", rpcAmount.includes("p_amount: amount") && !/p_amount:\s*amount\s*\*\s*100/.test(paySrc));

  if (failed) {
    console.log("\nFAILED " + failed + "  passed " + passed);
    process.exit(1);
  }
  console.log("\nAll " + passed + " checks passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
