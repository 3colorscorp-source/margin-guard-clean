#!/usr/bin/env node
/**
 * MG-SALES-READY-006B-B — Square auto-activation behind kill switch
 * Usage: node scripts/test-mg-sales-ready-006b-b.js
 *
 * Mocked Square/DB only. Does not call production, apply SQL, or set Netlify env.
 */
"use strict";

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "mg-sales-ready-006b-b-test-session-secret";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..");
const { createHandler: createWebhook } = require("../netlify/functions/square-saas-webhook");
const { createHandler: createRegister } = require("../netlify/functions/register-saas-square-invoice");
const { createHandler: createStatus } = require("../netlify/functions/get-saas-onboarding-status");
const checkout = require("../netlify/functions/create-checkout-session");
const { activateTenantFromVerifiedSquareInvoice } = require("../netlify/functions/_lib/saas-square-activate");
const {
  computeSquareSignature,
  getSquareRawBody,
  verifySquareWebhookSignature,
} = require("../netlify/functions/_lib/square-webhook-signature");
const { isAutoActivationEnabled } = require("../netlify/functions/_lib/square-saas-policy");
const { buildSessionPayload, createSessionCookie } = require("../netlify/functions/_lib/session");
const {
  buildDeviceSessionPayload,
  createDeviceSessionCookieFromPayload,
} = require("../netlify/functions/_lib/device-session");

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

function parse(res) {
  try {
    return JSON.parse(res.body || "{}");
  } catch (_err) {
    return {};
  }
}

function walkFiles(dir, acc) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name.startsWith(".qa-")) continue;
      walkFiles(full, acc);
    } else acc.push(full);
  }
  return acc;
}

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const INV_A = "inv_tenant_a_annual";
const INV_B = "inv_tenant_b_annual";
const PAY_A = "pay_tenant_a_1";
const PAY_B = "pay_other";
const URL = "https://marginguardsystem.netlify.app/.netlify/functions/square-saas-webhook";
const SIG_KEY = "test-square-webhook-signature-key";

function moneyPair(statusPaid) {
  return {
    computed_amount_money: { amount: 200000, currency: "USD" },
    total_completed_amount_money: { amount: statusPaid ? 200000 : 0, currency: "USD" },
  };
}

function invoice({ id, status, amount, currency, extra }) {
  const paid = status === "PAID";
  const cents = amount == null ? 200000 : amount;
  const cur = currency || "USD";
  return Object.assign(
    {
      id,
      status,
      order_id: "order-" + id,
      updated_at: "2026-01-15T00:00:00.000Z",
      tipping_enabled: false,
      payment_requests: [
        {
          computed_amount_money: { amount: cents, currency: cur },
          total_completed_amount_money: { amount: paid ? cents : 0, currency: cur },
        },
      ],
    },
    extra || {}
  );
}

function parsePath(pathStr) {
  const q = pathStr.indexOf("?");
  const table = q < 0 ? pathStr : pathStr.slice(0, q);
  const qs = q < 0 ? "" : pathStr.slice(q + 1);
  const filters = [];
  for (const part of qs.split("&")) {
    if (!part) continue;
    const decoded = decodeURIComponent(part);
    const eq = /^([^=]+)=eq\.(.*)$/.exec(decoded);
    if (eq) {
      filters.push({ field: eq[1], op: "eq", value: eq[2] });
      continue;
    }
    const inn = /^([^=]+)=in\.\((.*)\)$/.exec(decoded);
    if (inn) {
      filters.push({ field: inn[1], op: "in", value: inn[2].split(",") });
    }
  }
  return { table, filters };
}

function matchRow(row, filters) {
  for (const f of filters) {
    if (f.field === "select" || f.field === "order" || f.field === "limit") continue;
    const val = row[f.field] == null ? "" : String(row[f.field]);
    if (f.op === "eq" && val !== String(f.value)) return false;
    if (f.op === "in" && !f.value.map(String).includes(val)) return false;
  }
  return true;
}

function uniqueErr() {
  const err = new Error("Supabase HTTP 409: 23505 duplicate key");
  err.status = 409;
  return err;
}

function createStore() {
  const tenants = {
    [TENANT_A]: { id: TENANT_A, slug: "acme", name: "Acme", plan_status: "pending", owner_email: "owner-a@example.com" },
    [TENANT_B]: { id: TENANT_B, slug: "beta", name: "Beta", plan_status: "pending", owner_email: "owner-b@example.com" },
  };
  const onboarding = [];
  const events = [];
  let seq = 0;

  async function supabaseRequest(pathStr, options = {}) {
    const method = String(options.method || "GET").toUpperCase();
    const { table, filters } = parsePath(String(pathStr));
    if (table === "tenants") {
      const rows = Object.values(tenants).filter((row) => matchRow(row, filters));
      if (method === "PATCH") {
        const body = options.body || {};
        const updated = [];
        for (const row of rows) {
          Object.assign(row, body);
          updated.push({ ...row });
        }
        return updated;
      }
      return rows.map((row) => ({ ...row }));
    }
    if (table === "saas_onboarding") {
      if (method === "POST") {
        const row = { id: "onb-" + ++seq, ...options.body };
        if (onboarding.some((r) => r.provider === row.provider && r.external_invoice_id === row.external_invoice_id)) {
          throw uniqueErr();
        }
        if (
          row.external_payment_id &&
          onboarding.some((r) => r.provider === row.provider && r.external_payment_id === row.external_payment_id)
        ) {
          throw uniqueErr();
        }
        const open = ["registered", "paid_verified", "failed", "admin_review"];
        if (open.includes(row.status) && onboarding.some((r) => r.tenant_id === row.tenant_id && open.includes(r.status))) {
          throw uniqueErr();
        }
        onboarding.push(row);
        return [{ ...row }];
      }
      const rows = onboarding.filter((row) => matchRow(row, filters));
      if (method === "PATCH") {
        const updated = [];
        for (const row of rows) {
          Object.assign(row, options.body || {});
          updated.push({ ...row });
        }
        return updated;
      }
      return rows.map((row) => ({ ...row }));
    }
    if (table === "saas_square_webhook_events") {
      if (method === "POST") {
        const row = { ...options.body };
        if (events.some((r) => r.event_id === row.event_id)) throw uniqueErr();
        events.push(row);
        return [{ ...row }];
      }
      const rows = events.filter((row) => matchRow(row, filters));
      if (method === "PATCH") {
        const updated = [];
        for (const row of rows) {
          Object.assign(row, options.body || {});
          updated.push({ ...row });
        }
        return updated;
      }
      return rows.map((row) => ({ ...row }));
    }
    return [];
  }

  return { tenants, onboarding, events, supabaseRequest };
}

function signedHeaders(rawBody, extra) {
  const sig = computeSquareSignature(URL, rawBody, SIG_KEY);
  return Object.assign(
    {
      "x-square-hmacsha256-signature": sig,
      "square-environment": "Production",
    },
    extra || {}
  );
}

function webhookEvent(store, env, invoices, payments) {
  return createWebhook({
    env,
    supabaseRequest: store.supabaseRequest,
    getSquareInvoice: async (id) => {
      const inv = invoices[id];
      if (!inv) return { ok: false, code: "square_not_found" };
      return { ok: true, invoice: inv };
    },
    getSquarePayment: async (id) => {
      const pay = payments[id];
      if (!pay) return { ok: false, code: "square_not_found" };
      return { ok: true, payment: pay };
    },
  });
}

function registerEvent(store, env, invoices, admin) {
  return createRegister({
    env,
    supabaseRequest: store.supabaseRequest,
    getSquareInvoice: async (id) => {
      const inv = invoices[id];
      if (!inv) return { ok: false, code: "square_not_found" };
      return { ok: true, invoice: inv };
    },
    readSessionFromEvent: () => (admin ? { e: "admin@example.com", u: "admin-1" } : null),
    assertPlatformAdminSession: async () => (admin ? { ok: true, admin_user_id: "admin-1" } : { ok: false }),
  });
}

function enabledEnv() {
  return {
    SQUARE_SAAS_AUTO_ACTIVATION_ENABLED: "true",
    SQUARE_WEBHOOK_SIGNATURE_KEY: SIG_KEY,
    SQUARE_WEBHOOK_NOTIFICATION_URL: URL,
    SQUARE_ENVIRONMENT: "production",
    SQUARE_ACCESS_TOKEN: "test-token-not-real",
  };
}

function disabledEnv() {
  const env = enabledEnv();
  delete env.SQUARE_SAAS_AUTO_ACTIVATION_ENABLED;
  return env;
}

async function postWebhook(handler, payload, extraHeaders, rawOverride) {
  const raw = rawOverride != null ? rawOverride : JSON.stringify(payload);
  return handler({
    httpMethod: "POST",
    headers: signedHeaders(raw, extraHeaders),
    body: raw,
  });
}

async function main() {
  const sql = read("SUPABASE_MG_SALES_READY_006B_SAAS_SQUARE_ONBOARDING.sql");
  const rollback = read("SUPABASE_MG_SALES_READY_006B_SAAS_SQUARE_ONBOARDING_ROLLBACK.sql");
  const activateSrc = read("netlify/functions/_lib/saas-square-activate.js");
  const webhookSrc = read("netlify/functions/square-saas-webhook.js");
  const registerSrc = read("netlify/functions/register-saas-square-invoice.js");
  const release = read("docs/MG_SALES_READY_006B_B_CONTROLLED_RELEASE.md");

  assert("1. activation kill switch defaults off", isAutoActivationEnabled({}) === false);
  assert("1b. only exact true enables", isAutoActivationEnabled({ SQUARE_SAAS_AUTO_ACTIVATION_ENABLED: "TRUE" }) === false);
  assert("activate library checks kill switch", /isAutoActivationEnabled/.test(activateSrc));
  assert("SQL does not UPDATE tenants", !/^\s*UPDATE\b/im.test(sql));
  assert("38. service-role only tables", /REVOKE ALL ON TABLE public\.%I FROM anon/.test(sql) && /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\.%I TO service_role/.test(sql));
  assert("rollback does not touch tenants plan_status", !/plan_status/.test(rollback));
  assert("does not alter square_webhook_events", !/ALTER TABLE public\.square_webhook_events/.test(sql));
  assert("O. webhook does not send Auth invite", /does not send a Supabase Auth invite/.test(release) && !/inviteUserByEmail|auth\.admin/.test(webhookSrc));

  const knownBody = '{"event_id":"evt_vector","type":"invoice.payment_made"}';
  const expectedSig = computeSquareSignature(URL, knownBody, SIG_KEY);
  assert(
    "4. signature is URL + raw body HMAC-SHA256 base64",
    expectedSig ===
      crypto.createHmac("sha256", SIG_KEY).update(URL + knownBody, "utf8").digest("base64")
  );
  assert(
    "4b. known vector verifies",
    verifySquareWebhookSignature({
      rawBody: knownBody,
      signatureHeader: expectedSig,
      signatureKey: SIG_KEY,
      notificationUrl: URL,
    }) === true
  );

  const store0 = createStore();
  const wh0 = webhookEvent(store0, disabledEnv(), { [INV_A]: invoice({ id: INV_A, status: "PAID" }) }, {});
  const badSig = await wh0({
    httpMethod: "POST",
    headers: { "x-square-hmacsha256-signature": "aaaa", "square-environment": "Production" },
    body: knownBody,
  });
  assert("2. invalid signature rejected", badSig.statusCode === 403 && store0.tenants[TENANT_A].plan_status === "pending");

  const miss = await wh0({
    httpMethod: "POST",
    headers: { "square-environment": "Production" },
    body: knownBody,
  });
  assert("3. missing signature rejected", miss.statusCode === 403);

  const b64raw = JSON.stringify({ event_id: "evt_b64", type: "invoice.payment_made", data: { type: "invoice", id: INV_A } });
  const b64 = Buffer.from(b64raw, "utf8").toString("base64");
  const b64res = await wh0({
    httpMethod: "POST",
    isBase64Encoded: true,
    headers: signedHeaders(b64raw),
    body: b64,
  });
  assert("5. base64 Netlify body handled", getSquareRawBody({ body: b64, isBase64Encoded: true }) === b64raw);
  assert("5b. signed base64 request is not 403", b64res.statusCode !== 403);

  const mal = await postWebhook(wh0, {}, {}, '{"not json');
  assert("6. malformed JSON after valid signature is 400", mal.statusCode === 400);

  const invoicesPaid = { [INV_A]: invoice({ id: INV_A, status: "PAID" }), [INV_B]: invoice({ id: INV_B, status: "PAID" }) };
  const payments = {
    [PAY_A]: { id: PAY_A, order_id: "order-" + INV_A },
    [PAY_B]: { id: PAY_B, order_id: "order-other" },
  };

  const storeU = createStore();
  const unreg = webhookEvent(storeU, enabledEnv(), invoicesPaid, payments);
  const unregRes = await postWebhook(unreg, {
    event_id: "evt_unreg",
    type: "invoice.payment_made",
    data: { type: "invoice", id: INV_A },
  });
  assert("8. unregistered invoice does not activate", unregRes.statusCode === 200 && parse(unregRes).ignored === true && storeU.tenants[TENANT_A].plan_status === "pending");

  const storeR = createStore();
  const regDisabled = registerEvent(storeR, disabledEnv(), { [INV_A]: invoice({ id: INV_A, status: "UNPAID" }) }, true);
  const regRes = await regDisabled({
    httpMethod: "POST",
    headers: {},
    body: JSON.stringify({ tenant_id: TENANT_A, square_invoice_id: INV_A, terms_confirmed: true }),
  });
  assert("33. platform admin can register valid pending tenant invoice", regRes.statusCode === 200 && parse(regRes).registered === true);
  assert("10. terms_confirmed required path exists", /terms_confirmed !== true/.test(registerSrc));
  const noTerms = await registerEvent(storeR, disabledEnv(), { [INV_A]: invoice({ id: INV_A, status: "UNPAID" }) }, true)({
    httpMethod: "POST",
    body: JSON.stringify({ tenant_id: TENANT_A, square_invoice_id: INV_A, terms_confirmed: false }),
  });
  assert("10b. terms false rejected", noTerms.statusCode === 400);

  const ownerReg = createRegister({
    env: enabledEnv(),
    supabaseRequest: storeR.supabaseRequest,
    getSquareInvoice: async () => ({ ok: true, invoice: invoice({ id: INV_A, status: "UNPAID" }) }),
    readSessionFromEvent: () => ({ e: "owner-a@example.com", t: TENANT_A }),
    assertPlatformAdminSession: async () => ({ ok: false }),
  });
  const ownerRes = await ownerReg({
    httpMethod: "POST",
    body: JSON.stringify({ tenant_id: TENANT_A, square_invoice_id: INV_A, terms_confirmed: true }),
  });
  assert("30. tenant owner cannot call register", ownerRes.statusCode === 403);

  const sellerReg = createRegister({
    env: enabledEnv(),
    supabaseRequest: storeR.supabaseRequest,
    readSessionFromEvent: () => null,
    assertPlatformAdminSession: async () => ({ ok: false }),
  });
  const sellerCookie = createDeviceSessionCookieFromPayload(
    buildDeviceSessionPayload({ tenantId: TENANT_A, email: "seller@example.com", portalType: "seller" })
  ).cookie;
  const sellerRes = await sellerReg({
    httpMethod: "POST",
    headers: { cookie: sellerCookie.split(";")[0] },
    body: JSON.stringify({ tenant_id: TENANT_A, square_invoice_id: INV_A, terms_confirmed: true }),
  });
  assert("31. seller cannot call register", sellerRes.statusCode === 401 || sellerRes.statusCode === 403);

  const supRes = await sellerReg({
    httpMethod: "POST",
    headers: { cookie: createDeviceSessionCookieFromPayload(buildDeviceSessionPayload({ tenantId: TENANT_A, email: "sup@example.com", portalType: "supervisor" })).cookie.split(";")[0] },
    body: JSON.stringify({ tenant_id: TENANT_A, square_invoice_id: INV_A, terms_confirmed: true }),
  });
  assert("32. supervisor cannot call register", supRes.statusCode === 401 || supRes.statusCode === 403);

  const unauth = await sellerReg({ httpMethod: "POST", headers: {}, body: "{}" });
  assert("unauthenticated register rejected", unauth.statusCode === 401);

  async function registerThenWebhook(opts) {
    const store = createStore();
    if (opts.tenantStatus) store.tenants[TENANT_A].plan_status = opts.tenantStatus;
    if (opts.tenantBStatus) store.tenants[TENANT_B].plan_status = opts.tenantBStatus;
    const invs = opts.invoices || invoicesPaid;
    const env = opts.env || enabledEnv();
    const reg = registerEvent(store, env, invs, true);
    if (!opts.skipRegister) {
      await reg({
        httpMethod: "POST",
        body: JSON.stringify({
          tenant_id: opts.tenantId || TENANT_A,
          square_invoice_id: opts.invoiceId || INV_A,
          terms_confirmed: true,
        }),
      });
    }
    const wh = webhookEvent(store, env, invs, opts.payments || payments);
    const res = await postWebhook(wh, opts.payload || {
      event_id: opts.eventId || "evt1",
      type: opts.type || "invoice.payment_made",
      data: { type: "invoice", id: opts.invoiceId || INV_A },
    });
    return { store, res, body: parse(res) };
  }

  const kill = await registerThenWebhook({
    env: disabledEnv(),
    invoices: { [INV_A]: invoice({ id: INV_A, status: "PAID" }) },
    eventId: "evt_kill",
  });
  assert("1c. kill switch blocks plan_status change", kill.store.tenants[TENANT_A].plan_status === "pending");
  assert("1d. kill switch is not a 5xx loop", kill.res.statusCode === 200);

  {
    const store = createStore();
    store.onboarding.push({
      id: "onb-paid",
      tenant_id: TENANT_A,
      provider: "square",
      external_invoice_id: INV_A,
      expected_amount_cents: 200000,
      currency: "USD",
      status: "registered",
      terms_accepted_at: new Date().toISOString(),
    });
    const wh = webhookEvent(store, enabledEnv(), { [INV_A]: invoice({ id: INV_A, status: "PAID" }) }, {});
    const paidRes = await postWebhook(wh, {
      event_id: "evt_paid",
      type: "invoice.payment_made",
      data: { type: "invoice", id: INV_A },
    });
    assert("11. invoice GET required in activate", /getSquareInvoice/.test(activateSrc));
    assert("13. exact 200000 USD PAID activates", store.tenants[TENANT_A].plan_status === "active" && parse(paidRes).activated === true);
  }

  const payloadOnly = await registerThenWebhook({
    invoices: { [INV_A]: invoice({ id: INV_A, status: "UNPAID" }) },
    eventId: "evt_payload_only",
  });
  assert("12. webhook payload alone cannot activate", payloadOnly.store.tenants[TENANT_A].plan_status === "pending");

  for (const [status, num] of [
    ["PARTIALLY_PAID", "14"],
    ["PAYMENT_PENDING", "15"],
    ["UNPAID", "16"],
    ["REFUNDED", "17"],
    ["CANCELED", "18"],
  ]) {
    const r = await registerThenWebhook({
      invoices: { [INV_A]: invoice({ id: INV_A, status, extra: status === "UNPAID" ? {} : undefined }) },
      skipRegister: status !== "UNPAID" && status !== "SCHEDULED",
      eventId: "evt_" + status,
    });
    if (status === "UNPAID") {
      assert(num + ". UNPAID -> no activation", r.store.tenants[TENANT_A].plan_status === "pending");
    } else {
      const store = createStore();
      store.onboarding.push({
        id: "onb-pre",
        tenant_id: TENANT_A,
        provider: "square",
        external_invoice_id: INV_A,
        expected_amount_cents: 200000,
        currency: "USD",
        status: "registered",
        terms_accepted_at: new Date().toISOString(),
      });
      const wh = webhookEvent(store, enabledEnv(), { [INV_A]: invoice({ id: INV_A, status }) }, {});
      const res = await postWebhook(wh, {
        event_id: "evt_st_" + status,
        type: "invoice.payment_made",
        data: { type: "invoice", id: INV_A },
      });
      assert(num + ". " + status + " -> no activation", store.tenants[TENANT_A].plan_status === "pending" && res.statusCode === 200);
    }
  }

  {
    const store = createStore();
    store.onboarding.push({
      id: "onb-amt",
      tenant_id: TENANT_A,
      provider: "square",
      external_invoice_id: INV_A,
      expected_amount_cents: 200000,
      currency: "USD",
      status: "registered",
      terms_accepted_at: new Date().toISOString(),
    });
    const whAmt = webhookEvent(store, enabledEnv(), { [INV_A]: invoice({ id: INV_A, status: "PAID", amount: 150000 }) }, {});
    await postWebhook(whAmt, { event_id: "evt_amt", type: "invoice.payment_made", data: { type: "invoice", id: INV_A } });
    assert("19. wrong amount -> no activation", store.tenants[TENANT_A].plan_status === "pending");
  }
  {
    const store = createStore();
    store.onboarding.push({
      id: "onb-cur",
      tenant_id: TENANT_A,
      provider: "square",
      external_invoice_id: INV_A,
      expected_amount_cents: 200000,
      currency: "USD",
      status: "registered",
      terms_accepted_at: new Date().toISOString(),
    });
    const whCur = webhookEvent(store, enabledEnv(), { [INV_A]: invoice({ id: INV_A, status: "PAID", currency: "CAD" }) }, {});
    await postWebhook(whCur, { event_id: "evt_cur", type: "invoice.payment_made", data: { type: "invoice", id: INV_A } });
    assert("20. wrong currency -> no activation", store.tenants[TENANT_A].plan_status === "pending");
  }

  {
    const store = createStore();
    store.onboarding.push({
      id: "onb-a",
      tenant_id: TENANT_A,
      provider: "square",
      external_invoice_id: INV_A,
      expected_amount_cents: 200000,
      currency: "USD",
      status: "registered",
      terms_accepted_at: new Date().toISOString(),
    });
    const wh = webhookEvent(store, enabledEnv(), invoicesPaid, payments);
    await postWebhook(wh, { event_id: "evt_cross", type: "invoice.payment_made", data: { type: "invoice", id: INV_A } });
    assert("21. invoice registered to A does not activate B", store.tenants[TENANT_B].plan_status === "pending" && store.tenants[TENANT_A].plan_status === "active");
  }

  {
    const store = createStore();
    store.onboarding.push({
      id: "onb-a2",
      tenant_id: TENANT_A,
      provider: "square",
      external_invoice_id: INV_A,
      expected_amount_cents: 200000,
      currency: "USD",
      status: "registered",
      terms_accepted_at: new Date().toISOString(),
    });
    const dup = registerEvent(store, enabledEnv(), invoicesPaid, true);
    const dupRes = await dup({
      httpMethod: "POST",
      body: JSON.stringify({ tenant_id: TENANT_B, square_invoice_id: INV_A, terms_confirmed: true }),
    });
    assert("22. one invoice cannot register two tenants", dupRes.statusCode === 409 && store.tenants[TENANT_B].plan_status === "pending");
  }

  {
    const store = createStore();
    store.onboarding.push({
      id: "onb-pay",
      tenant_id: TENANT_A,
      provider: "square",
      external_invoice_id: INV_A,
      external_payment_id: PAY_A,
      expected_amount_cents: 200000,
      currency: "USD",
      status: "registered",
      terms_accepted_at: new Date().toISOString(),
    });
    store.onboarding.push({
      id: "onb-pay-b",
      tenant_id: TENANT_B,
      provider: "square",
      external_invoice_id: INV_B,
      expected_amount_cents: 200000,
      currency: "USD",
      status: "registered",
      terms_accepted_at: new Date().toISOString(),
    });
    const act = await activateTenantFromVerifiedSquareInvoice(
      { onboardingId: "onb-pay-b", paymentId: PAY_A },
      {
        env: enabledEnv(),
        supabaseRequest: store.supabaseRequest,
        getSquareInvoice: async () => ({ ok: true, invoice: invoice({ id: INV_B, status: "PAID" }) }),
        getSquarePayment: async () => ({ ok: true, payment: { id: PAY_A, order_id: "order-" + INV_A } }),
      }
    );
    assert("23. one payment cannot activate two tenants", act.ok === false && store.tenants[TENANT_B].plan_status === "pending");
  }

  {
    const store = createStore();
    store.onboarding.push({
      id: "onb-idemp",
      tenant_id: TENANT_A,
      provider: "square",
      external_invoice_id: INV_A,
      expected_amount_cents: 200000,
      currency: "USD",
      status: "registered",
      terms_accepted_at: new Date().toISOString(),
    });
    const wh = webhookEvent(store, enabledEnv(), invoicesPaid, payments);
    const payload = { event_id: "evt_dup", type: "invoice.payment_made", data: { type: "invoice", id: INV_A } };
    const first = await postWebhook(wh, payload);
    const term1 = store.onboarding[0].term_expires_at;
    const second = await postWebhook(wh, payload);
    assert("7. duplicate event id is 200", second.statusCode === 200 && parse(second).duplicate === true);
    assert("24. same event twice does not extend term", store.onboarding[0].term_expires_at === term1);
    assert("25. same payment retry idempotent", first.statusCode === 200 && store.tenants[TENANT_A].plan_status === "active");
  }

  {
    const store = createStore();
    store.tenants[TENANT_A].plan_status = "active";
    store.onboarding.push({
      id: "onb-old",
      tenant_id: TENANT_A,
      provider: "square",
      external_invoice_id: INV_A,
      external_payment_id: PAY_A,
      expected_amount_cents: 200000,
      currency: "USD",
      status: "activated",
      terms_accepted_at: new Date().toISOString(),
      activated_at: "2026-01-15T00:00:00.000Z",
      term_start_at: "2026-01-15T00:00:00.000Z",
      term_expires_at: "2027-01-15T00:00:00.000Z",
    });
    const act = await activateTenantFromVerifiedSquareInvoice(
      { onboardingId: "onb-old", paymentId: PAY_B },
      {
        env: enabledEnv(),
        supabaseRequest: store.supabaseRequest,
        getSquareInvoice: async () => ({ ok: true, invoice: invoice({ id: INV_A, status: "PAID" }) }),
        getSquarePayment: async () => ({ ok: true, payment: { id: PAY_B, order_id: "order-" + INV_A } }),
      }
    );
    assert("26. different payment against already-active tenant -> conflict", act.ok === false && act.code === "active_conflict_different_payment");
    assert("26b. term dates unchanged", store.onboarding[0].term_expires_at === "2027-01-15T00:00:00.000Z");
  }

  {
    const store = createStore();
    store.tenants[TENANT_A].plan_status = "canceled";
    store.onboarding.push({
      id: "onb-can",
      tenant_id: TENANT_A,
      provider: "square",
      external_invoice_id: INV_A,
      expected_amount_cents: 200000,
      currency: "USD",
      status: "registered",
      terms_accepted_at: new Date().toISOString(),
    });
    const act = await activateTenantFromVerifiedSquareInvoice(
      { onboardingId: "onb-can" },
      {
        env: enabledEnv(),
        supabaseRequest: store.supabaseRequest,
        getSquareInvoice: async () => ({ ok: true, invoice: invoice({ id: INV_A, status: "PAID" }) }),
      }
    );
    assert("27. canceled tenant does not auto-reactivate", act.ok === false && store.tenants[TENANT_A].plan_status === "canceled");
  }
  {
    const store = createStore();
    store.tenants[TENANT_A].plan_status = "expired";
    store.onboarding.push({
      id: "onb-exp",
      tenant_id: TENANT_A,
      provider: "square",
      external_invoice_id: INV_A,
      expected_amount_cents: 200000,
      currency: "USD",
      status: "registered",
      terms_accepted_at: new Date().toISOString(),
    });
    const act = await activateTenantFromVerifiedSquareInvoice(
      { onboardingId: "onb-exp" },
      {
        env: enabledEnv(),
        supabaseRequest: store.supabaseRequest,
        getSquareInvoice: async () => ({ ok: true, invoice: invoice({ id: INV_A, status: "PAID" }) }),
      }
    );
    assert("28. expired tenant does not auto-reactivate", act.ok === false && store.tenants[TENANT_A].plan_status === "expired");
  }

  {
    const store = createStore();
    const pendingInv = { [INV_A]: invoice({ id: INV_A, status: "UNPAID" }) };
    const reg = registerEvent(store, enabledEnv(), pendingInv, true);
    await reg({
      httpMethod: "POST",
      body: JSON.stringify({ tenant_id: TENANT_A, square_invoice_id: INV_A, terms_confirmed: true }),
    });
    store.tenants[TENANT_A].plan_status = "active";
    const notPending = await reg({
      httpMethod: "POST",
      body: JSON.stringify({ tenant_id: TENANT_B, square_invoice_id: INV_B, terms_confirmed: true }),
    });
    store.tenants[TENANT_B].plan_status = "active";
    const store2 = createStore();
    store2.tenants[TENANT_A].plan_status = "active";
    const reg2 = registerEvent(store2, enabledEnv(), { [INV_A]: invoice({ id: INV_A, status: "UNPAID" }) }, true);
    const res2 = await reg2({
      httpMethod: "POST",
      body: JSON.stringify({ tenant_id: TENANT_A, square_invoice_id: INV_A, terms_confirmed: true }),
    });
    assert("9. registered tenant must be pending", res2.statusCode === 409);
  }

  {
    const store = createStore();
    const paidInv = { [INV_A]: invoice({ id: INV_A, status: "PAID" }) };
    const reg = registerEvent(store, enabledEnv(), paidInv, true);
    const res = await reg({
      httpMethod: "POST",
      body: JSON.stringify({ tenant_id: TENANT_A, square_invoice_id: INV_A, terms_confirmed: true }),
    });
    assert("34. already-paid registration uses shared activate", /activateTenantFromVerifiedSquareInvoice/.test(registerSrc) && parse(res).activated === true && store.tenants[TENANT_A].plan_status === "active");
  }

  {
    const store = createStore();
    store.onboarding.push({
      id: "onb-ref",
      tenant_id: TENANT_A,
      provider: "square",
      external_invoice_id: INV_A,
      expected_amount_cents: 200000,
      currency: "USD",
      status: "registered",
      terms_accepted_at: new Date().toISOString(),
    });
    const wh = webhookEvent(store, enabledEnv(), invoicesPaid, payments);
    const res = await postWebhook(wh, { event_id: "evt_ref", type: "invoice.refunded", data: { type: "invoice", id: INV_A } });
    assert("37. refund event never activates", res.statusCode === 200 && parse(res).reason === "refund_or_dispute" && store.tenants[TENANT_A].plan_status === "pending");
    assert("37b. refund marks admin_review", store.onboarding[0].status === "admin_review");
  }

  const checkoutRes = await checkout.handler({ httpMethod: "POST", body: "{}" });
  assert("35. Stripe SaaS checkout remains 403", checkoutRes.statusCode === 403);

  assert("36. QuickBooks cannot trigger Square activation", !/QuickBooks/.test(webhookSrc) && !/QuickBooks/.test(activateSrc));

  const publicHits = walkFiles(path.join(ROOT, "public"), []).filter((f) => {
    const src = fs.readFileSync(f, "utf8");
    return /SQUARE_ACCESS_TOKEN|SQUARE_WEBHOOK_SIGNATURE_KEY/.test(src);
  });
  assert("39. no Square secrets in public/", publicHits.length === 0);

  const publicTables = walkFiles(path.join(ROOT, "public"), []).filter((f) => {
    if (!/\.(js|html)$/.test(f)) return false;
    return /\.from\(\s*['"]saas_onboarding['"]|\.from\(\s*['"]saas_square_webhook_events['"]/.test(fs.readFileSync(f, "utf8"));
  });
  assert("40. no new direct browser Supabase table access", publicTables.length === 0);

  const publicPlan = walkFiles(path.join(ROOT, "public"), []).filter((f) => /\.(js|html)$/.test(f) && /plan_status/.test(fs.readFileSync(f, "utf8")));
  assert("29. browser cannot set plan_status", publicPlan.length === 0);

  const writers = walkFiles(path.join(ROOT, "netlify/functions"), [])
    .filter((f) => f.endsWith(".js"))
    .filter((f) => {
      const src = fs.readFileSync(f, "utf8");
      return /plan_status:\s*["']active["']/.test(src) || /plan_status = 'active'/.test(src);
    })
    .map((f) => path.relative(ROOT, f).replace(/\\/g, "/"));
  assert(
    "only activate library writes plan_status active",
    writers.length === 1 && writers[0] === "netlify/functions/_lib/saas-square-activate.js"
  );

  assert("9b. register requires pending", /tenant_not_pending/.test(registerSrc));
  assert("logging does not print access token", !/console\.(log|error).*SQUARE_ACCESS_TOKEN/.test(webhookSrc + activateSrc + registerSrc));

  const noTermsOnb = createStore();
  noTermsOnb.onboarding.push({
    id: "onb-noterms",
    tenant_id: TENANT_A,
    provider: "square",
    external_invoice_id: INV_A,
    expected_amount_cents: 200000,
    currency: "USD",
    status: "registered",
    terms_accepted_at: null,
  });
  const noTermsAct = await activateTenantFromVerifiedSquareInvoice(
    { onboardingId: "onb-noterms" },
    {
      env: enabledEnv(),
      supabaseRequest: noTermsOnb.supabaseRequest,
      getSquareInvoice: async () => ({ ok: true, invoice: invoice({ id: INV_A, status: "PAID" }) }),
    }
  );
  assert("10c. activate requires terms_accepted_at", noTermsAct.ok === false && noTermsAct.code === "terms_required");

  console.log("");
  console.log(passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
