/**
 * Owner SaaS access: verified identity + active owner membership + plan_status.
 * Stripe customer/subscription is not an access authority.
 */
"use strict";

const { supabaseRequest } = require("./supabase-admin");
const {
  membershipIsActive,
  membershipRole,
} = require("./membership-resolve");

const OWNER_PROFILE_SELECT = "id,tenant_id,email,role,status,auth_user_id";
const TENANT_SELECT = "id,slug,name,owner_email,plan_status,stripe_customer_id";
const AUTH_FAILED = "authentication_failed";

function normEmail(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function planIsActive(tenant) {
  return String(tenant?.plan_status || "")
    .trim()
    .toLowerCase() === "active";
}

function hasOwnerSessionIdentity(session) {
  const email = String(session?.e || "").trim();
  const tenantId = String(session?.t || "").trim();
  const legacyCustomer = String(session?.c || "").trim();
  return Boolean(email && (tenantId || legacyCustomer));
}

async function resolveUniqueActiveOwnerAccess(email, deps = {}) {
  const em = normEmail(email);
  if (!em || !em.includes("@")) {
    return { ok: false };
  }

  const requestFn = typeof deps.supabaseRequest === "function" ? deps.supabaseRequest : supabaseRequest;

  let rows;
  try {
    rows = await requestFn(
      `profiles?email=eq.${encodeURIComponent(em)}&role=eq.owner&select=${OWNER_PROFILE_SELECT}`
    );
  } catch (_err) {
    return { ok: false };
  }

  const list = Array.isArray(rows) ? rows : [];
  const activeOwners = list.filter((row) => membershipIsActive(row) && membershipRole(row) === "owner");
  if (activeOwners.length !== 1) {
    return { ok: false };
  }

  const profile = activeOwners[0];
  const tenantId = String(profile.tenant_id || "").trim();
  if (!tenantId) {
    return { ok: false };
  }

  let tenantRows;
  try {
    tenantRows = await requestFn(
      `tenants?id=eq.${encodeURIComponent(tenantId)}&select=${TENANT_SELECT}&limit=1`
    );
  } catch (_err) {
    return { ok: false };
  }

  const tenant = Array.isArray(tenantRows) ? tenantRows[0] : null;
  if (!tenant?.id || !planIsActive(tenant)) {
    return { ok: false };
  }

  return { ok: true, tenant, profile };
}

module.exports = {
  AUTH_FAILED,
  OWNER_PROFILE_SELECT,
  TENANT_SELECT,
  hasOwnerSessionIdentity,
  planIsActive,
  resolveUniqueActiveOwnerAccess,
};
