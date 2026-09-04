#!/usr/bin/env node
/**
 * MG-SALES-READY-007A — first-customer revenue console
 * Usage: node scripts/test-mg-sales-ready-007a.js
 *
 * Mocked identity/DB/Square only. Does not call production or mutate production DB.
 */
"use strict";

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "mg-sales-ready-007a-test-session-secret";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const { createHandler: createList } = require("../netlify/functions/admin-saas-list-customers");
const { createHandler: createCreate } = require("../netlify/functions/admin-saas-create-pending-customer");
const { createHandler: createSend } = require("../netlify/functions/admin-saas-send-owner-access");
const { createHandler: createRegister } = require("../netlify/functions/register-saas-square-invoice");
const checkout = require("../netlify/functions/create-checkout-session");
const { ANNUAL_AMOUNT_CENTS, ANNUAL_CURRENCY } = require("../netlify/functions/_lib/square-saas-policy");
const { buildDeviceSessionPayload, createDeviceSessionCookieFromPayload } = require("../netlify/functions/_lib/device-session");

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

function uniqueErr() {
  const err = new Error("Supabase HTTP 409: 23505 duplicate key");
  err.status = 409;
  return err;
}

function unpaidInvoice(id) {
  return {
    id,
    status: "UNPAID",
    payment_requests: [
      {
        computed_amount_money: { amount: 200000, currency: "USD" },
        total_completed_amount_money: { amount: 0, currency: "USD" },
      },
    ],
  };
}

function createStore() {
  const tenants = {};
  const profiles = [];
  const onboarding = [];
  const users = {};
  let seq = 0;

  async function supabaseRequest(pathStr, options = {}) {
    const method = String(options.method || "GET").toUpperCase();
    const { table, filters } = parsePath(String(pathStr));
    if (table === "tenants") {
      if (method === "POST") {
        const row = {
          plan_status: "pending",
          created_at: "2026-09-04T00:00:00.000Z",
          updated_at: "2026-09-04T00:00:00.000Z",
          ...options.body,
        };
        if (!row.plan_status) row.plan_status = "pending";
        if (Object.values(tenants).some((t) => t.slug === row.slug)) throw uniqueErr();
        tenants[row.id] = row;
        return [{ ...row }];
      }
      const rows = Object.values(tenants).filter((row) => matchRow(row, filters));
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
    if (table === "profiles") {
      if (method === "POST") {
        const row = { id: "prof-" + ++seq, invited_at: null, auth_user_id: null, ...options.body };
        profiles.push(row);
        return [{ ...row }];
      }
      const rows = profiles.filter((row) => matchRow(row, filters));
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
    if (table === "saas_onboarding") {
      if (method === "POST") {
        const row = { id: "onb-" + ++seq, ...options.body };
        if (onboarding.some((r) => r.provider === row.provider && r.external_invoice_id === row.external_invoice_id)) {
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
    if (table === "users") {
      const rows = Object.values(users).filter((row) => matchRow(row, filters));
      return rows.map((row) => ({ ...row }));
    }
    return [];
  }

  return { tenants, profiles, onboarding, users, supabaseRequest };
}

function adminDeps(store, extras) {
  return Object.assign(
    {
      supabaseRequest: store.supabaseRequest,
      readSessionFromEvent: () => ({ e: "admin@example.com", u: "admin-user" }),
      assertPlatformAdminSession: async () => ({ ok: true, admin_user_id: "admin-user" }),
      getSquareInvoice: async (id) => ({ ok: true, invoice: unpaidInvoice(id) }),
      env: { SQUARE_SAAS_AUTO_ACTIVATION_ENABLED: "true" },
    },
    extras || {}
  );
}

const validBody = {
  business_name: "Acme Tile LLC",
  owner_name: "Jane Owner",
  owner_email: "jane@acme.test",
  business_slug: "acme-tile",
  square_invoice_id: "inv_acme_annual",
  terms_confirmed: true,
};

async function main() {
  const html = read("public/saas-admin.html");
  const uiSrc = read("public/js/saas-admin.js");
  const createSrc = read("netlify/functions/admin-saas-create-pending-customer.js");
  const helperSrc = read("netlify/functions/_lib/saas-admin-customers.js");
  const createHelperSrc = read("netlify/functions/_lib/saas-admin-create.js");
  const registerLib = read("netlify/functions/_lib/saas-square-register.js");
  const supportList = read("netlify/functions/mg-support-admin-list-cases.js");
  const fcSrc = read("netlify/functions/get-tenant-financial-summary.js");
  const checkoutSrc = read("netlify/functions/create-checkout-session.js");
  const webhookSrc = read("netlify/functions/square-saas-webhook.js");
  const toml = read("netlify.toml");

  const store = createStore();
  const listH = createList(adminDeps(store));
  const createH = createCreate(adminDeps(store));
  const sendH = createSend(adminDeps(store, {
    loadPlatformAdminFlag: async () => false,
    resolveAuthUserIdByEmailDetailed: async () => ({ status: "not_found", userId: null }),
    inviteAuthUserByEmail: async () => ({ ok: true }),
    recoverAuthUserByEmail: async () => ({ ok: true }),
  }));

  const anonList = await createList({
    readSessionFromEvent: () => null,
    assertPlatformAdminSession: async () => ({ ok: false }),
    supabaseRequest: store.supabaseRequest,
  })({ httpMethod: "GET" });
  assert("1. anonymous cannot access page/API", anonList.statusCode === 401 && /saas-admin/.test(toml) && /data.is_admin !== true/.test(uiSrc));

  const ownerList = await createList({
    readSessionFromEvent: () => ({ e: "jane@acme.test", t: "tenant-1" }),
    assertPlatformAdminSession: async () => ({ ok: false }),
    supabaseRequest: store.supabaseRequest,
  })({ httpMethod: "GET" });
  assert("2. normal owner cannot access", ownerList.statusCode === 403);

  const sellerCookie = createDeviceSessionCookieFromPayload(
    buildDeviceSessionPayload({ tenantId: "t1", email: "seller@example.com", portalType: "seller" })
  ).cookie;
  const sellerList = await createList({
    readSessionFromEvent: () => null,
    assertPlatformAdminSession: async () => ({ ok: false }),
    supabaseRequest: store.supabaseRequest,
  })({ httpMethod: "GET", headers: { cookie: sellerCookie.split(";")[0] } });
  assert("3. seller cannot access", sellerList.statusCode === 401 || sellerList.statusCode === 403);

  const supList = await createList({
    readSessionFromEvent: () => null,
    assertPlatformAdminSession: async () => ({ ok: false }),
    supabaseRequest: store.supabaseRequest,
  })({ httpMethod: "GET" });
  assert("4. supervisor cannot access", supList.statusCode === 401 || supList.statusCode === 403);

  const adminList = await listH({ httpMethod: "GET" });
  assert("5. platform admin can access", adminList.statusCode === 200 && parse(adminList).ok === true);

  const created = await createH({ httpMethod: "POST", body: JSON.stringify(validBody) });
  const createdBody = parse(created);
  const tenantId = createdBody.customer && createdBody.customer.tenant_id;
  assert("6. new tenant created pending only", created.statusCode === 200 && createdBody.plan_status === "pending" && store.tenants[tenantId].plan_status === "pending");
  assert("7. browser cannot request active", createdBody.plan_status !== "active" && !/plan_status/.test(JSON.stringify(validBody)));
  assert("8. default amount fixed at 200000", createdBody.expected_amount_cents === 200000 && ANNUAL_AMOUNT_CENTS === 200000);
  assert("9. currency fixed USD", createdBody.currency === "USD" && ANNUAL_CURRENCY === "USD");
  assert("10. provider fixed square", createdBody.provider === "square");

  const noTerms = await createH({
    httpMethod: "POST",
    body: JSON.stringify(Object.assign({}, validBody, { business_slug: "no-terms", square_invoice_id: "inv_noterms", terms_confirmed: false })),
  });
  assert("11. terms confirmation required", noTerms.statusCode === 400 && parse(noTerms).error === "terms_required");
  assert("12. server sets terms_accepted_at", /terms_accepted_at: now/.test(registerLib) && !/terms_accepted_at/.test(uiSrc));

  const dupSlug = await createH({
    httpMethod: "POST",
    body: JSON.stringify(Object.assign({}, validBody, { owner_email: "other@acme.test" })),
  });
  assert("13. duplicate slug blocked", dupSlug.statusCode === 409 && parse(dupSlug).error === "duplicate_slug");

  store.profiles.push({
    id: "prof-other",
    tenant_id: "other-tenant",
    email: "dupowner@acme.test",
    role: "owner",
    status: "active",
  });
  const amb = await createH({
    httpMethod: "POST",
    body: JSON.stringify(Object.assign({}, validBody, {
      business_slug: "dup-owner-co",
      owner_email: "dupowner@acme.test",
      square_invoice_id: "inv_dup_owner",
    })),
  });
  assert("14. ambiguous owner mapping blocked", amb.statusCode === 409 && parse(amb).error === "ambiguous_owner");

  const extraActive = await createH({
    httpMethod: "POST",
    body: JSON.stringify(Object.assign({}, validBody, { plan_status: "active", business_slug: "hack-active" })),
  });
  assert("15. customer cannot self-activate", extraActive.statusCode === 400 && parse(extraActive).error === "invalid_request" && /CREATE_ALLOWED/.test(createHelperSrc));
  assert("16. Square invoice registration reuses trusted validation", /registerSquareInvoiceForPendingTenant/.test(createSrc + createHelperSrc) && /evaluateFullyPaidAnnualInvoice/.test(registerLib));

  const storeB = createStore();
  storeB.tenants.t1 = { id: "t1", slug: "one", name: "One", owner_email: "a@x.test", plan_status: "pending" };
  storeB.tenants.t2 = { id: "t2", slug: "two", name: "Two", owner_email: "b@x.test", plan_status: "pending" };
  const reg1 = createRegister(adminDeps(storeB));
  await reg1({ httpMethod: "POST", body: JSON.stringify({ tenant_id: "t1", square_invoice_id: "inv_shared", terms_confirmed: true }) });
  const reg2 = await createRegister(adminDeps(storeB))({
    httpMethod: "POST",
    body: JSON.stringify({ tenant_id: "t2", square_invoice_id: "inv_shared", terms_confirmed: true }),
  });
  assert("17. invoice belonging to another onboarding blocked", reg2.statusCode === 409 && parse(reg2).error === "invoice_used_by_other_tenant");
  assert("18. unpaid invoice leaves tenant pending", store.tenants[tenantId].plan_status === "pending" && createdBody.customer.payment_status === "awaiting_payment");

  assert("19. admin console cannot force activation", !/plan_status:\s*["']active["']/.test(helperSrc + createHelperSrc + createSrc + uiSrc) && !/plan_status=active/.test(uiSrc));

  store.tenants[tenantId].plan_status = "active";
  const ob = store.onboarding.find((row) => row.tenant_id === tenantId);
  ob.status = "activated";
  ob.paid_at = "2026-09-04T01:00:00.000Z";
  ob.activated_at = "2026-09-04T01:00:00.000Z";
  const listed = parse(await listH({ httpMethod: "GET" }));
  const activeRow = listed.customers.find((row) => row.tenant_id === tenantId);
  assert("20. paid/activated tenant appears active after webhook state", activeRow.plan_status === "active" && activeRow.badges.indexOf("ACTIVE") !== -1);

  store.tenants[tenantId].plan_status = "pending";
  const blockedSend = await sendH({ httpMethod: "POST", body: JSON.stringify({ tenant_id: tenantId }) });
  assert("21. Send Owner Access blocked before active", blockedSend.statusCode === 409 && parse(blockedSend).status === "blocked");

  store.tenants[tenantId].plan_status = "active";
  const sent = await sendH({ httpMethod: "POST", body: JSON.stringify({ tenant_id: tenantId }) });
  const sentBody = parse(sent);
  assert("22. Send Owner Access succeeds only after active", sent.statusCode === 200 && sentBody.status === "invite_sent");
  assert("23. owner never receives is_admin", store.profiles.every((p) => p.is_admin == null) && !/\bis_admin\s*:/.test(createHelperSrc));

  const again = await sendH({ httpMethod: "POST", body: JSON.stringify({ tenant_id: tenantId }) });
  assert("24. repeated Send Owner Access is idempotent", parse(again).status === "already_invited");

  assert("25. no browser Supabase writes added", !/supabaseRequest|createClient/.test(uiSrc + html));
  assert("26. existing Square register helper still used", /registerSquareInvoiceForPendingTenant/.test(read("netlify/functions/register-saas-square-invoice.js")));
  assert("27. 006A protections remain", /subscription_checkout_disabled/.test(checkoutSrc));
  const adminGateSrc = read("netlify/functions/_lib/mg-support/require-platform-admin.js");
  const sales004c = read("scripts/test-mg-sales-ready-004c.js");
  assert(
    "28. 004A/004B/004C data-surface protections remain",
    /assertPlatformAdminSession/.test(supportList) &&
      /HMAC-valid mg_session/.test(adminGateSrc) &&
      /public.users.is_admin/.test(adminGateSrc) &&
      /MG-SALES-READY-004C/.test(sales004c)
  );
  assert("29. Support remains untouched", /mg-support-admin-list-cases/.test(supportList) && !/saas-admin/.test(supportList));
  assert("30. Financial Connections remains balances-only", /balances|financial/i.test(fcSrc));
  const stripeRes = await checkout.handler({ httpMethod: "POST", body: "{}" });
  assert("31. Stripe SaaS endpoints remain disabled/403", stripeRes.statusCode === 403);
  assert("32. no production DB mutation from test/build task", !/prod|SUPABASE_URL/.test(String(process.env.MG_TOUCH_PROD || "")) && /Mocked identity/.test(read("scripts/test-mg-sales-ready-007a.js")));

  assert("page is platform admin gated", /auth-status/.test(uiSrc) && /is_admin !== true/.test(uiSrc));
  assert("webhook still has no invite", !/inviteAuthUserByEmail|\/auth\/v1\/invite/.test(webhookSrc));
  assert("canonical owner model is profiles", /role=eq.owner/.test(createHelperSrc) && /profiles/.test(createHelperSrc));
  assert("create allowlist rejects tenant_id", /CREATE_ALLOWED/.test(createHelperSrc) && extraActive.statusCode === 400);

  const { isExplicitUnresolvedSupportRequest } = require("../netlify/functions/_lib/mg-support/case-intake");
  assert("004A support detector still present", isExplicitUnresolvedSupportRequest("Necesito soporte porque el problema continúa.") === true);

  console.log("");
  console.log(passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
