#!/usr/bin/env node
/**
 * MG-SALES-READY-002B — owner auth hardening + Stripe SaaS decoupling
 * Usage: node scripts/test-mg-sales-ready-002b.js
 *
 * Mocked identity/DB only. Does not call production, Stripe, or mutate tenants.
 */
"use strict";

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "mg-sales-ready-002b-test-session-secret";

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = path.resolve(__dirname, "..");
const { createHandler: createRestoreHandler } = require("../netlify/functions/restore-owner-session");
const { createHandler: createAuthStatusHandler } = require("../netlify/functions/auth-status");
const { createHandler: createTenantContextHandler } = require("../netlify/functions/tenant-context");
const checkout = require("../netlify/functions/create-checkout-session");
const finalize = require("../netlify/functions/finalize-checkout");
const portal = require("../netlify/functions/create-portal-session");
const {
  buildSessionPayload,
  createSessionCookie,
  readSessionFromEvent,
} = require("../netlify/functions/_lib/session");
const { AUTH_FAILED } = require("../netlify/functions/_lib/owner-access");
const { hasOwnerSessionIdentity } = require("../netlify/functions/_lib/owner-access");

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

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const OWNER_EMAIL = "owner@example.com";
const SELLER_EMAIL = "seller@example.com";
const RANDOM_EMAIL = "nobody-" + Date.now() + "@example.test";

function ownerTenant(extra) {
  return Object.assign(
    {
      id: TENANT_A,
      slug: "acme",
      name: "Acme",
      owner_email: OWNER_EMAIL,
      plan_status: "active",
      stripe_customer_id: null,
    },
    extra || {}
  );
}

function ownerProfile(extra) {
  return Object.assign(
    {
      id: "p-owner",
      tenant_id: TENANT_A,
      email: OWNER_EMAIL,
      role: "owner",
      status: "active",
      auth_user_id: OWNER_ID,
    },
    extra || {}
  );
}

function cookieFrom(res) {
  const raw = res.headers && (res.headers["Set-Cookie"] || res.headers["set-cookie"]);
  return raw ? String(raw) : "";
}

function sessionFromCookie(setCookie) {
  const match = /mg_session=([^;]+)/.exec(setCookie || "");
  if (!match) return null;
  return readSessionFromEvent({
    headers: { cookie: "mg_session=" + match[1] },
  });
}

function parse(res) {
  try {
    return JSON.parse(res.body || "{}");
  } catch (_err) {
    return {};
  }
}

async function main() {
  const restoreSrc = read("netlify/functions/restore-owner-session.js");
  const billingSrc = read("public/js/billing.js");
  const indexSrc = read("public/index.html");
  const authStatusSrc = read("netlify/functions/auth-status.js");
  const checkoutSrc = read("netlify/functions/create-checkout-session.js");
  const finalizeSrc = read("netlify/functions/finalize-checkout.js");
  const sessionSrc = read("netlify/functions/_lib/session.js");
  const debugPath = path.join(ROOT, "netlify/functions/debug-stripe-platform-context.js");

  assert("0a. restore does not lookup tenant by body email", !/body\.email/.test(restoreSrc));
  assert("0b. billing posts Bearer not email-only restore", /Authorization:\s*["']Bearer /.test(billingSrc) && !/restore-owner-session[\s\S]{0,80}\{ email \}/.test(billingSrc));
  assert("0c. landing page has no Stripe checkout CTA", !/Suscribirme anual|Checkout seguro con Stripe/.test(indexSrc));
  assert("0d. auth-status does not call Stripe", !/stripeRequest/.test(authStatusSrc));
  assert("0e. checkout disabled", /subscription_checkout_disabled/.test(checkoutSrc) && !/STRIPE_PRICE_ANNUAL_ID/.test(checkoutSrc));
  assert("0f. finalize disabled", /subscription_checkout_disabled/.test(finalizeSrc) && !/createSessionCookie/.test(finalizeSrc));
  assert("0g. cookie flags remain", /HttpOnly; Secure; SameSite=Lax/.test(sessionSrc));
  assert("14. debug-stripe-platform-context.js is absent", !fs.existsSync(debugPath));
  assert(
    "14b. no ALLOW_DEBUG_STRIPE_PLATFORM_CONTEXT references",
    !/ALLOW_DEBUG_STRIPE_PLATFORM_CONTEXT/.test(restoreSrc + billingSrc + authStatusSrc + checkoutSrc + finalizeSrc)
  );

  const emailOnly = await createRestoreHandler({
    verifySupabaseAccessToken: async () => {
      throw new Error("must not verify without bearer");
    },
    resolveUniqueActiveOwnerAccess: async () => {
      throw new Error("must not lookup owner from email body");
    },
  })({
    httpMethod: "POST",
    headers: {},
    body: JSON.stringify({ email: OWNER_EMAIL }),
  });
  assert(
    "1. email-only request cannot mint mg_session",
    emailOnly.statusCode === 401 &&
      parse(emailOnly).error === AUTH_FAILED &&
      !cookieFrom(emailOnly)
  );

  const randomEmail = await createRestoreHandler({
    verifySupabaseAccessToken: async () => ({ ok: true, email: RANDOM_EMAIL, userId: "u-rand" }),
    resolveUniqueActiveOwnerAccess: async () => ({ ok: false }),
  })({
    httpMethod: "POST",
    headers: { Authorization: "Bearer fake" },
    body: JSON.stringify({ email: RANDOM_EMAIL }),
  });
  assert(
    "2. random email cannot mint mg_session",
    randomEmail.statusCode === 401 &&
      parse(randomEmail).error === AUTH_FAILED &&
      !cookieFrom(randomEmail)
  );
  assert(
    "9a. failed auth does not disclose existence",
    parse(randomEmail).error === AUTH_FAILED &&
      parse(emailOnly).error === AUTH_FAILED &&
      !/not found|no tenant|Plan is not active/i.test(randomEmail.body + emailOnly.body)
  );

  const ownerRes = await createRestoreHandler({
    verifySupabaseAccessToken: async (token) => {
      if (token !== "owner-jwt") return { ok: false };
      return { ok: true, email: OWNER_EMAIL, userId: OWNER_ID };
    },
    resolveUniqueActiveOwnerAccess: async (email) => {
      if (email !== OWNER_EMAIL) return { ok: false };
      return { ok: true, tenant: ownerTenant(), profile: ownerProfile() };
    },
    linkProfileAuthUserOnLogin: async () => ({ profileAuthLinked: true, profileAuthLinkStatus: "linked" }),
  })({
    httpMethod: "POST",
    headers: { Authorization: "Bearer owner-jwt" },
    body: JSON.stringify({ tenant_id: TENANT_B, email: "attacker@example.com" }),
  });
  const ownerSession = sessionFromCookie(cookieFrom(ownerRes));
  assert("3. verified owner can authenticate", ownerRes.statusCode === 200 && parse(ownerRes).ok === true);
  assert("7. tenant_id comes from server membership", ownerSession && ownerSession.t === TENANT_A && parse(ownerRes).tenant_id === TENANT_A);
  assert(
    "8. request-body tenant_id cannot override it",
    ownerSession && ownerSession.t === TENANT_A && ownerSession.t !== TENANT_B
  );
  assert(
    "12. Stripe customer id is not required",
    ownerSession && (!ownerSession.c || ownerSession.c === "") && parse(ownerRes).ok === true
  );
  assert(
    "13a. Stripe subscription is not stored as auth authority",
    ownerSession && (!ownerSession.s || ownerSession.s === "")
  );
  assert(
    "10. cookie security remains intact",
    /HttpOnly/.test(cookieFrom(ownerRes)) &&
      /Secure/.test(cookieFrom(ownerRes)) &&
      /SameSite=Lax/.test(cookieFrom(ownerRes)) &&
      ownerSession &&
      ownerSession.e === OWNER_EMAIL &&
      ownerSession.u === OWNER_ID
  );

  const sellerRes = await createRestoreHandler({
    verifySupabaseAccessToken: async () => ({ ok: true, email: SELLER_EMAIL, userId: "u-seller" }),
    resolveUniqueActiveOwnerAccess: async () => ({ ok: false }),
  })({
    httpMethod: "POST",
    headers: { Authorization: "Bearer seller-jwt" },
    body: "{}",
  });
  assert(
    "4. non-owner cannot receive owner session",
    sellerRes.statusCode === 401 && !cookieFrom(sellerRes) && parse(sellerRes).error === AUTH_FAILED
  );
  assert("11. seller/supervisor cannot escalate", sellerRes.statusCode === 401 && !cookieFrom(sellerRes));

  const cross = await createRestoreHandler({
    verifySupabaseAccessToken: async () => ({ ok: true, email: OWNER_EMAIL, userId: OWNER_ID }),
    resolveUniqueActiveOwnerAccess: async () => ({
      ok: true,
      tenant: ownerTenant(),
      profile: ownerProfile(),
    }),
    linkProfileAuthUserOnLogin: async () => ({}),
  })({
    httpMethod: "POST",
    headers: { Authorization: "Bearer owner-jwt", "x-tenant-id": TENANT_B },
    body: JSON.stringify({ tenant_id: TENANT_B }),
  });
  const crossSession = sessionFromCookie(cookieFrom(cross));
  assert("5. tenant A identity cannot select tenant B", crossSession && crossSession.t === TENANT_A);

  const suspended = await createRestoreHandler({
    verifySupabaseAccessToken: async () => ({ ok: true, email: OWNER_EMAIL, userId: OWNER_ID }),
    resolveUniqueActiveOwnerAccess: async () => ({ ok: false }),
  })({
    httpMethod: "POST",
    headers: { Authorization: "Bearer owner-jwt" },
    body: "{}",
  });
  assert(
    "6. suspended/inactive membership cannot authenticate",
    suspended.statusCode === 401 && parse(suspended).error === AUTH_FAILED && !cookieFrom(suspended)
  );

  const cookieA = createSessionCookie(
    buildSessionPayload({ tenantId: TENANT_A, email: OWNER_EMAIL, userId: OWNER_ID })
  );
  const eventA = { httpMethod: "GET", headers: { cookie: cookieA.split(";")[0] } };

  const statusActive = await createAuthStatusHandler({
    resolveTenantFromSession: async () => ownerTenant(),
    resolveUniqueActiveOwnerAccess: async () => ({ ok: true, tenant: ownerTenant() }),
    loadPublicUserAdminFlags: async () => ({ userId: OWNER_ID, is_admin: false }),
    resolveAuthUserIdByEmail: async () => OWNER_ID,
  })(eventA);
  assert(
    "13b. auth-status uses plan_status not Stripe subscription",
    parse(statusActive).active === true && parse(statusActive).subscription_status == null
  );

  const statusCanceled = await createAuthStatusHandler({
    resolveTenantFromSession: async () => ownerTenant({ plan_status: "canceled" }),
    resolveUniqueActiveOwnerAccess: async () => ({
      ok: false,
    }),
    loadPublicUserAdminFlags: async () => ({ userId: OWNER_ID, is_admin: false }),
    resolveAuthUserIdByEmail: async () => OWNER_ID,
  })(eventA);
  assert("13c. inactive plan is not entitled without Stripe", parse(statusCanceled).active === false);

  const ctx = await createTenantContextHandler({
    resolveTenantFromSession: async (session) => {
      if (session.t === TENANT_B) return ownerTenant({ id: TENANT_B });
      return ownerTenant();
    },
    supabaseRequest: async (p) => {
      if (String(p).includes(TENANT_B)) return [ownerProfile({ tenant_id: TENANT_B, role: "seller" })];
      return [ownerProfile()];
    },
  })(eventA);
  assert("5b. tenant-context uses server tenant", parse(ctx).ok === true && parse(ctx).tenant_id === TENANT_A);

  const checkoutRes = await checkout.handler({ httpMethod: "POST", body: JSON.stringify({ email: OWNER_EMAIL }) });
  const finalizeRes = await finalize.handler({
    httpMethod: "POST",
    body: JSON.stringify({ sessionId: "cs_test_123" }),
  });
  const portalRes = await portal.handler({ httpMethod: "POST", body: "{}" });
  assert("13d. create-checkout-session disabled", checkoutRes.statusCode === 403 && !cookieFrom(checkoutRes));
  assert("13e. finalize-checkout disabled", finalizeRes.statusCode === 403 && !cookieFrom(finalizeRes));
  assert("13f. create-portal-session disabled", portalRes.statusCode === 403);

  assert("identity helper requires tenant or legacy key", hasOwnerSessionIdentity({ e: OWNER_EMAIL }) === false);
  assert("identity helper accepts session.t", hasOwnerSessionIdentity({ e: OWNER_EMAIL, t: TENANT_A }) === true);

  const zisiHref = pathToFileURL(
    path.join(
      ROOT,
      ".qa-ch013a48/netlify-cli-pkg/node_modules/netlify-cli/node_modules/@netlify/zip-it-and-ship-it/dist/main.js"
    )
  ).href;
  const localZisi = fs.existsSync(
    path.join(
      ROOT,
      ".qa-ch013a48/netlify-cli-pkg/node_modules/netlify-cli/node_modules/@netlify/zip-it-and-ship-it/dist/main.js"
    )
  );
  if (localZisi) {
    const { listFunctions } = await import(zisiHref);
    const listed = await listFunctions(path.join(ROOT, "netlify/functions"));
    const names = (listed || []).map((fn) => fn.name);
    assert("14c. zip-it bundle omits debug-stripe-platform-context", !names.includes("debug-stripe-platform-context"));
    assert("14d. zip-it still includes restore-owner-session", names.includes("restore-owner-session"));
  } else {
    const fnFiles = fs.readdirSync(path.join(ROOT, "netlify/functions"));
    assert(
      "14c. function dir omits debug-stripe-platform-context",
      !fnFiles.includes("debug-stripe-platform-context.js")
    );
    assert("14d. restore-owner-session remains", fnFiles.includes("restore-owner-session.js"));
  }

  console.log("");
  console.log(passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
