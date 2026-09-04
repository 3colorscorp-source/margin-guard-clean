#!/usr/bin/env node
/**
 * MG-SALES-READY-006B-C — admin Square SaaS dry-run (read-only)
 * Usage: node scripts/test-mg-sales-ready-006b-c.js
 *
 * Mocked Square/DB only. Does not call production, apply SQL, or set Netlify env.
 */
"use strict";

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "mg-sales-ready-006b-c-test-session-secret";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const { createHandler } = require("../netlify/functions/admin-saas-square-dry-run");
const { createHandler: createWebhook } = require("../netlify/functions/square-saas-webhook");
const checkout = require("../netlify/functions/create-checkout-session");
const { isAutoActivationEnabled } = require("../netlify/functions/_lib/square-saas-policy");
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

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ONB_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const INV_A = "inv_tenant_a_annual";

function invoice({ id, status, amount, currency, extra }) {
  const paid = status === "PAID";
  const cents = amount == null ? 200000 : amount;
  const cur = currency || "USD";
  return Object.assign(
    {
      id,
      status,
      invoice_number: "821202558",
      title: "Margin Guard Annual Subscription",
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
  }
  return { table, filters };
}

function matchRow(row, filters) {
  for (const f of filters) {
    if (f.field === "select" || f.field === "order" || f.field === "limit") continue;
    const val = row[f.field] == null ? "" : String(row[f.field]);
    if (f.op === "eq" && val !== String(f.value)) return false;
  }
  return true;
}

function createStore() {
  const tenants = {
    [TENANT_A]: {
      id: TENANT_A,
      slug: "mg-square-test",
      name: "MG Square Test Tenant",
      plan_status: "pending",
      owner_email: "owner-a@example.com",
    },
    [TENANT_B]: {
      id: TENANT_B,
      slug: "beta",
      name: "Beta",
      plan_status: "pending",
      owner_email: "owner-b@example.com",
    },
  };
  const onboarding = [
    {
      id: ONB_A,
      tenant_id: TENANT_A,
      provider: "square",
      external_invoice_id: INV_A,
      expected_amount_cents: 200000,
      currency: "USD",
      status: "registered",
      paid_at: null,
      activated_at: null,
      terms_accepted_at: "2026-09-04T00:00:00.000Z",
    },
  ];
  const writes = [];

  async function supabaseRequest(pathStr, options = {}) {
    const method = String(options.method || "GET").toUpperCase();
    const { table, filters } = parsePath(String(pathStr));
    if (method !== "GET") {
      writes.push({ table, method, body: options.body || null });
    }
    if (table === "tenants") {
      return Object.values(tenants)
        .filter((row) => matchRow(row, filters))
        .map((row) => ({ ...row }));
    }
    if (table === "saas_onboarding") {
      return onboarding.filter((row) => matchRow(row, filters)).map((row) => ({ ...row }));
    }
    return [];
  }

  return { tenants, onboarding, writes, supabaseRequest };
}

function disabledEnv() {
  return {
    SQUARE_ENVIRONMENT: "production",
    SQUARE_ACCESS_TOKEN: "test-token-not-real",
  };
}

function enabledEnv() {
  return {
    SQUARE_SAAS_AUTO_ACTIVATION_ENABLED: "true",
    SQUARE_ENVIRONMENT: "production",
    SQUARE_ACCESS_TOKEN: "test-token-not-real",
  };
}

function dryRun(store, env, invoices, auth) {
  const mode = auth == null ? "admin" : auth;
  return createHandler({
    env,
    supabaseRequest: store.supabaseRequest,
    getSquareInvoice: async (id) => {
      const inv = invoices[id];
      if (!inv) return { ok: false, code: "square_not_found" };
      if (inv === "fail") return { ok: false, code: "square_unavailable" };
      return { ok: true, invoice: inv };
    },
    readSessionFromEvent: () => {
      if (mode === "none") return null;
      if (mode === "owner") return { e: "owner-a@example.com", t: TENANT_A };
      if (mode === "admin") return { e: "admin@example.com", u: "admin-1" };
      return null;
    },
    assertPlatformAdminSession: async () =>
      mode === "admin" ? { ok: true, admin_user_id: "admin-1" } : { ok: false },
  });
}

async function post(handler, body, headers) {
  return handler({
    httpMethod: "POST",
    headers: headers || {},
    body: JSON.stringify(body),
  });
}

async function main() {
  const src = read("netlify/functions/admin-saas-square-dry-run.js");
  const activateSrc = read("netlify/functions/_lib/saas-square-activate.js");
  const webhookSrc = read("netlify/functions/square-saas-webhook.js");
  const docs = read("docs/MG_SALES_READY_006B_B_CONTROLLED_RELEASE.md");

  assert("kill switch still defaults off", isAutoActivationEnabled({}) === false);
  assert("dry-run is POST-only", /httpMethod/.test(src) && /method_not_allowed/.test(src));
  assert("dry-run requires platform admin", /assertPlatformAdminSession/.test(src));
  assert("dry-run does not call activate", !/activateTenantFromVerifiedSquareInvoice/.test(src));
  assert("dry-run does not patch tenants", !/patchTenant/.test(src));
  assert("dry-run does not patch onboarding", !/patchOnboarding/.test(src));
  assert("dry-run does not write plan_status active", !/plan_status:\s*["']active["']/.test(src));
  assert("dry-run does not log access token", !/SQUARE_ACCESS_TOKEN/.test(src));
  assert("webhook file unchanged vs activate-only writer", /isAutoActivationEnabled/.test(activateSrc));
  assert("docs include dry-run curl", /admin-saas-square-dry-run/.test(docs));

  const unpaid = { [INV_A]: invoice({ id: INV_A, status: "UNPAID" }) };

  const unauthStore = createStore();
  const unauth = await post(dryRun(unauthStore, disabledEnv(), unpaid, "none"), { tenant_id: TENANT_A });
  assert("unauthenticated is 401", unauth.statusCode === 401);

  const ownerStore = createStore();
  const ownerRes = await post(dryRun(ownerStore, disabledEnv(), unpaid, "owner"), { tenant_id: TENANT_A });
  assert("tenant owner is 403", ownerRes.statusCode === 403);
  assert("owner dry-run did not write", ownerStore.writes.length === 0);

  const sellerStore = createStore();
  const sellerHandler = createHandler({
    env: disabledEnv(),
    supabaseRequest: sellerStore.supabaseRequest,
    readSessionFromEvent: () => null,
    assertPlatformAdminSession: async () => ({ ok: false }),
  });
  const sellerCookie = createDeviceSessionCookieFromPayload(
    buildDeviceSessionPayload({ tenantId: TENANT_A, email: "seller@example.com", portalType: "seller" })
  ).cookie;
  const sellerRes = await sellerHandler({
    httpMethod: "POST",
    headers: { cookie: sellerCookie.split(";")[0] },
    body: JSON.stringify({ tenant_id: TENANT_A }),
  });
  assert("seller is 401 or 403", sellerRes.statusCode === 401 || sellerRes.statusCode === 403);

  const miss = await post(dryRun(createStore(), disabledEnv(), unpaid, "admin"), {});
  assert("missing tenant_id and onboarding_id is 400", miss.statusCode === 400);

  const store = createStore();
  const res = await post(dryRun(store, disabledEnv(), unpaid, "admin"), { tenant_id: TENANT_A });
  const body = parse(res);
  assert("admin unpaid dry-run is 200", res.statusCode === 200 && body.ok === true && body.mode === "dry_run");
  assert(
    "registered unpaid decision",
    body.decision === "registered_unpaid_no_action" &&
      body.checks.invoice_found === true &&
      body.checks.amount_matches === true &&
      body.checks.currency_matches === true &&
      body.checks.is_paid === false &&
      body.checks.would_mark_paid_verified === false &&
      body.checks.auto_activation_enabled === false &&
      body.checks.would_activate === false
  );
  assert("unpaid dry-run does not activate", store.tenants[TENANT_A].plan_status === "pending");
  assert("unpaid dry-run writes nothing", store.writes.length === 0);
  assert("unpaid square amount is 200000", body.square_invoice.amount_cents === 200000 && body.square_invoice.completed_amount_cents === 0);
  assert("does not return owner email", !JSON.stringify(body).includes("owner-a@example.com"));
  assert("does not return access token", !JSON.stringify(body).includes("test-token-not-real"));

  const byOnb = await post(dryRun(createStore(), disabledEnv(), unpaid, "admin"), { onboarding_id: ONB_A });
  assert("onboarding_id lookup works", parse(byOnb).onboarding && parse(byOnb).onboarding.id === ONB_A);

  const paidStore = createStore();
  const paidRes = await post(
    dryRun(paidStore, disabledEnv(), { [INV_A]: invoice({ id: INV_A, status: "PAID" }) }, "admin"),
    { tenant_id: TENANT_A }
  );
  const paidBody = parse(paidRes);
  assert(
    "paid with kill switch off does not activate",
    paidRes.statusCode === 200 &&
      paidBody.decision === "paid_but_activation_disabled" &&
      paidBody.checks.would_mark_paid_verified === true &&
      paidBody.checks.would_activate === false &&
      paidStore.tenants[TENANT_A].plan_status === "pending" &&
      paidStore.onboarding[0].status === "registered" &&
      paidStore.writes.length === 0
  );

  const paidOnStore = createStore();
  const paidOnRes = await post(
    dryRun(paidOnStore, enabledEnv(), { [INV_A]: invoice({ id: INV_A, status: "PAID" }) }, "admin"),
    { tenant_id: TENANT_A, dry_run_write: true }
  );
  const paidOnBody = parse(paidOnRes);
  assert(
    "paid with kill switch on still does not activate",
    paidOnRes.statusCode === 200 &&
      paidOnBody.decision === "would_activate_if_enabled" &&
      paidOnBody.checks.would_activate === true &&
      paidOnStore.tenants[TENANT_A].plan_status === "pending" &&
      paidOnStore.writes.length === 0
  );

  const amtStore = createStore();
  const amtRes = await post(
    dryRun(amtStore, disabledEnv(), { [INV_A]: invoice({ id: INV_A, status: "UNPAID", amount: 100 }) }, "admin"),
    { tenant_id: TENANT_A }
  );
  assert("amount mismatch", parse(amtRes).decision === "amount_mismatch_admin_review" && amtStore.writes.length === 0);

  const curStore = createStore();
  const curRes = await post(
    dryRun(curStore, disabledEnv(), { [INV_A]: invoice({ id: INV_A, status: "UNPAID", currency: "CAD" }) }, "admin"),
    { tenant_id: TENANT_A }
  );
  assert("currency mismatch", parse(curRes).decision === "currency_mismatch_admin_review");

  const missingInv = await post(dryRun(createStore(), disabledEnv(), {}, "admin"), { tenant_id: TENANT_A });
  assert("invoice not found decision", missingInv.statusCode === 200 && parse(missingInv).decision === "invoice_not_found");

  const failStore = createStore();
  const failRes = await post(dryRun(failStore, disabledEnv(), { [INV_A]: "fail" }, "admin"), { tenant_id: TENANT_A });
  assert("Square API failure is 502", failRes.statusCode === 502 && failStore.writes.length === 0);

  const pendingStore = createStore();
  pendingStore.tenants[TENANT_A].plan_status = "canceled";
  const pendingRes = await post(
    dryRun(pendingStore, disabledEnv(), { [INV_A]: invoice({ id: INV_A, status: "PAID" }) }, "admin"),
    { tenant_id: TENANT_A }
  );
  assert(
    "canceled tenant is tenant_not_pending and not reactivated",
    parse(pendingRes).decision === "tenant_not_pending" && pendingStore.tenants[TENANT_A].plan_status === "canceled"
  );

  const nf = await post(dryRun(createStore(), disabledEnv(), unpaid, "admin"), {
    tenant_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  });
  assert("unknown tenant onboarding is 404", nf.statusCode === 404 && parse(nf).decision === "onboarding_not_found");

  const checkoutRes = await checkout.handler({ httpMethod: "POST", body: "{}" });
  assert("Stripe SaaS checkout remains 403", checkoutRes.statusCode === 403);

  assert("webhook still has no session/cookie gate", !/assertPlatformAdminSession|readSessionFromEvent/.test(webhookSrc));

  assert("webhook still uses shared activate only", /activateTenantFromVerifiedSquareInvoice/.test(webhookSrc));

  console.log("");
  console.log(passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
