#!/usr/bin/env node
/**
 * MG-SALES-READY-006A — manual billing + safe first-customer activation
 * Usage: node scripts/test-mg-sales-ready-006a.js
 *
 * Mocked identity/DB only. Does not call production or apply the migration.
 */
"use strict";

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "mg-sales-ready-006a-test-session-secret";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const { createHandler: createRestoreHandler } = require("../netlify/functions/restore-owner-session");
const { createHandler: createAuthStatusHandler } = require("../netlify/functions/auth-status");
const checkout = require("../netlify/functions/create-checkout-session");
const finalize = require("../netlify/functions/finalize-checkout");
const portal = require("../netlify/functions/create-portal-session");
const { buildSessionPayload, createSessionCookie } = require("../netlify/functions/_lib/session");
const { AUTH_FAILED, planIsActive } = require("../netlify/functions/_lib/owner-access");
const { resolveTenantFromSession } = require("../netlify/functions/_lib/tenant-for-session");

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

function cookieFrom(res) {
  const raw = res.headers && (res.headers["Set-Cookie"] || res.headers["set-cookie"]);
  return raw ? String(raw) : "";
}

function parse(res) {
  try {
    return JSON.parse(res.body || "{}");
  } catch (_err) {
    return {};
  }
}

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const OWNER_EMAIL = "owner@example.com";

function ownerTenant(planStatus) {
  return {
    id: TENANT_A,
    slug: "acme",
    name: "Acme",
    owner_email: OWNER_EMAIL,
    plan_status: planStatus,
    stripe_customer_id: null,
  };
}

function ownerProfile() {
  return {
    id: "p-owner",
    tenant_id: TENANT_A,
    email: OWNER_EMAIL,
    role: "owner",
    status: "active",
    auth_user_id: OWNER_ID,
  };
}

function supabaseForPlan(planStatus) {
  return async (p) => {
    const pathStr = String(p || "");
    if (pathStr.startsWith("profiles?")) return [ownerProfile()];
    if (pathStr.startsWith("tenants?")) return [ownerTenant(planStatus)];
    return [];
  };
}

function restoreEvent() {
  return {
    httpMethod: "POST",
    headers: { Authorization: "Bearer owner-jwt" },
    body: "{}",
  };
}

async function restoreForPlan(planStatus) {
  return createRestoreHandler({
    verifySupabaseAccessToken: async () => ({ ok: true, email: OWNER_EMAIL, userId: OWNER_ID }),
    supabaseRequest: supabaseForPlan(planStatus),
    linkProfileAuthUserOnLogin: async () => ({}),
  })(restoreEvent());
}

function walkFiles(dir, acc) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      walkFiles(full, acc);
    } else if (/\.(js|html|sql)$/.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

async function main() {
  const sql = read("SUPABASE_MG_SALES_READY_006A_SAFE_TENANT_ACTIVATION.sql");
  const rollback = read("SUPABASE_MG_SALES_READY_006A_SAFE_TENANT_ACTIVATION_ROLLBACK.sql");
  const runbook = read("docs/MG_SALES_READY_006A_FIRST_CUSTOMER_RUNBOOK.md");
  const ownerAccessSrc = read("netlify/functions/_lib/owner-access.js");
  const tenantSessionSrc = read("netlify/functions/_lib/tenant-for-session.js");
  const deviceGuardSrc = read("netlify/functions/_lib/tenant-device-guard.js");
  const bootstrapSrc = read("netlify/functions/bootstrap-tenant.js");
  const restoreSrc = read("netlify/functions/restore-owner-session.js");
  const checkoutSrc = read("netlify/functions/create-checkout-session.js");
  const finalizeSrc = read("netlify/functions/finalize-checkout.js");
  const fcCreateSrc = read("netlify/functions/create-financial-connections-session.js");
  const fcHelperSrc = read("netlify/functions/_lib/ensure-platform-financial-customer.js");
  const recoverySrc = read("public/js/owner-recovery-auth.js");
  const sql004a = read("SUPABASE_MG_SALES_READY_004A_PUBLIC_SURFACE_HARDENING.sql");
  const sql004b = read("SUPABASE_MG_SALES_READY_004B_QUOTES_INVOICES_RLS_HARDENING.sql");
  const sql004c = read("SUPABASE_MG_SALES_READY_004C_BUSINESS_BRANDING_GRANT_REVOKE.sql");

  assert("1. new tenant default is NOT active", /SET DEFAULT 'pending'/.test(sql) && !/SET DEFAULT 'active'/.test(sql));
  assert("1b. migration does not UPDATE existing tenant rows", !/^\s*UPDATE\b/im.test(sql) && !/^\s*DELETE\b/im.test(sql));
  assert("9. Three Colors / existing tenants unchanged by SQL", /does NOT UPDATE existing rows/.test(sql) && /Three Colors tenant remains unchanged/.test(sql));
  assert("rollback exists and also does not UPDATE rows", /SET DEFAULT 'active'/.test(rollback) && !/^\s*UPDATE\b/im.test(rollback));

  assert("planIsActive is exact active only", planIsActive({ plan_status: "active" }) === true);
  assert("pending is not active", planIsActive({ plan_status: "pending" }) === false);
  assert("canceled is not active", planIsActive({ plan_status: "canceled" }) === false);
  assert("empty/missing plan_status is not active", planIsActive({}) === false && planIsActive({ plan_status: "ACTIVE" }) === true);

  const pendingLogin = await restoreForPlan("pending");
  assert(
    "2. pending tenant cannot log in",
    pendingLogin.statusCode === 401 && parse(pendingLogin).error === AUTH_FAILED && !cookieFrom(pendingLogin)
  );

  const canceledLogin = await restoreForPlan("canceled");
  assert(
    "3. canceled tenant cannot log in",
    canceledLogin.statusCode === 401 && parse(canceledLogin).error === AUTH_FAILED && !cookieFrom(canceledLogin)
  );

  const activeLogin = await restoreForPlan("active");
  assert("4. active tenant can log in", activeLogin.statusCode === 200 && parse(activeLogin).ok === true && /mg_session=/.test(cookieFrom(activeLogin)));

  const pendingSession = { e: OWNER_EMAIL, t: TENANT_A };
  const pendingResolved = await resolveTenantFromSession(pendingSession, { supabaseRequest: supabaseForPlan("pending") });
  const canceledResolved = await resolveTenantFromSession(pendingSession, { supabaseRequest: supabaseForPlan("canceled") });
  const activeResolved = await resolveTenantFromSession(pendingSession, { supabaseRequest: supabaseForPlan("active") });
  assert("J. pending existing session cannot resolve tenant APIs", pendingResolved == null);
  assert("Jb. canceled existing session cannot resolve tenant APIs", canceledResolved == null);
  assert("Jc. active existing session still resolves", activeResolved && activeResolved.id === TENANT_A);

  const cookieA = createSessionCookie(buildSessionPayload({ tenantId: TENANT_A, email: OWNER_EMAIL, userId: OWNER_ID }));
  const eventA = { httpMethod: "GET", headers: { cookie: cookieA.split(";")[0] } };
  const statusPending = await createAuthStatusHandler({
    resolveTenantFromSession: async () => ownerTenant("pending"),
    resolveUniqueActiveOwnerAccess: async () => ({ ok: false }),
    loadPublicUserAdminFlags: async () => ({ userId: OWNER_ID, is_admin: false }),
    resolveAuthUserIdByEmail: async () => OWNER_ID,
  })(eventA);
  assert(
    "2b. auth-status pending is not entitled and clears cookie",
    parse(statusPending).active === false && /Max-Age=0/.test(cookieFrom(statusPending))
  );

  const publicDir = path.join(ROOT, "public");
  const publicFiles = walkFiles(publicDir, []);
  const publicPlanWrites = publicFiles.filter((file) => {
    const src = fs.readFileSync(file, "utf8");
    return /plan_status/.test(src);
  });
  assert("5. browser cannot set plan_status", publicPlanWrites.length === 0);

  const fnDir = path.join(ROOT, "netlify/functions");
  const fnFiles = walkFiles(fnDir, []);
  const planWriters = fnFiles.filter((file) => {
    const src = fs.readFileSync(file, "utf8");
    if (!/plan_status/.test(src)) return false;
    return /plan_status\s*:/.test(src) && /(method:\s*["'](PATCH|POST|PUT)["']|UPDATE\s+.*plan_status)/.test(src);
  });
  const bootstrapWrites = /method:\s*["'](POST|PATCH|PUT)["']/.test(bootstrapSrc) && /tenants/.test(bootstrapSrc);
  assert("6. tenant cannot self-activate via Netlify", planWriters.length === 0 && !bootstrapWrites);
  assert("6b. bootstrap-tenant only returns plan_status, does not write it", /plan_status: tenant\.plan_status/.test(bootstrapSrc) && !/method:\s*["']PATCH["']/.test(bootstrapSrc));
  assert("E. no public endpoint writes plan_status", !/plan_status/.test(read("netlify/functions/bootstrap-tenant.js").replace(/plan_status: tenant\.plan_status/, "")));

  const checkoutRes = await checkout.handler({ httpMethod: "POST", body: JSON.stringify({ email: OWNER_EMAIL }) });
  const finalizeRes = await finalize.handler({ httpMethod: "POST", body: JSON.stringify({ sessionId: "cs_test_123" }) });
  const portalRes = await portal.handler({ httpMethod: "POST", body: "{}" });
  assert("7. Stripe checkout does not activate SaaS", checkoutRes.statusCode === 403 && parse(checkoutRes).error === "subscription_checkout_disabled");
  assert("7b. finalize-checkout disabled", finalizeRes.statusCode === 403 && !cookieFrom(finalizeRes));
  assert("7c. billing portal disabled", portalRes.statusCode === 403);
  assert("7d. checkout source has no plan_status write", !/plan_status/.test(checkoutSrc) && !/plan_status/.test(finalizeSrc));

  assert("8. QuickBooks/Square are external/manual only", /QuickBooks/.test(runbook) && /Square/.test(runbook) && /external payment evidence/.test(runbook));
  assert("8b. no new billing tables proposed", !/subscription_source/.test(sql) && !/external_invoice_reference/.test(sql) && /No new billing tables/.test(runbook));
  assert("create after payment confirmed", /only after payment is confirmed/.test(runbook) && /Do not set `active` in the same INSERT/.test(runbook));

  assert("10. owner recovery still requires active tenant", /resolveUniqueActiveOwnerAccess/.test(restoreSrc) && /planIsActive/.test(ownerAccessSrc));
  assert("10b. recovery helper still cannot mint without restore-owner-session", /allowMintOwnerSession/.test(recoverySrc) && /restore-owner-session/.test(read("public/js/billing.js")));

  assert("11. 004A file intact", sql004a.includes("'tenant_projects'"));
  assert("11b. 004B file intact", sql004b.includes("'quotes_read_all'"));
  assert("11c. 004C file intact", sql004c.includes("business_branding"));

  assert(
    "12. Financial Connections remains independent of SaaS billing source",
    /balances/.test(fcCreateSrc) &&
      /financial_connections/.test(fcHelperSrc) &&
      !/plan_status/.test(fcCreateSrc) &&
      !/plan_status/.test(fcHelperSrc)
  );

  assert("session recheck on owner APIs", /entitledOwnerTenant/.test(tenantSessionSrc) && /planIsActive\(tenant\)/.test(tenantSessionSrc));
  assert("device portals recheck plan_status", /plan_not_active/.test(deviceGuardSrc) && /planIsActive\(tenant\)/.test(deviceGuardSrc));
  assert("activation is documented as platform-admin SQL", /platform admin/.test(runbook) && /plan_status = 'active'/.test(runbook));

  const pendingRecovery = await restoreForPlan("pending");
  assert("10c. pending owner recovery/login cannot mint session", pendingRecovery.statusCode === 401 && !cookieFrom(pendingRecovery));

  console.log("");
  console.log(passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
