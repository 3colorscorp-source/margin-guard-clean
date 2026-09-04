/**
 * Platform-admin SaaS customer list helpers.
 * Owner membership is public.profiles role=owner. Never grants public.users.is_admin.
 */
"use strict";

const { supabaseRequest } = require("./supabase-admin");
const { ANNUAL_AMOUNT_CENTS, ANNUAL_CURRENCY } = require("./square-saas-policy");

const TENANT_SELECT = "id,slug,name,owner_email,plan_status,created_at,updated_at";
const ONBOARDING_SELECT =
  "id,tenant_id,provider,external_invoice_id,status,paid_at,activated_at,registered_at,term_start_at,term_expires_at,last_error_code,expected_amount_cents,currency,terms_accepted_at";
const OWNER_SELECT = "id,tenant_id,email,role,status,auth_user_id,invited_at,display_name,full_name";

function deriveAccessStatus(tenant, onboarding, profile) {
  const plan = String(tenant?.plan_status || "").toLowerCase();
  const hasAuth = Boolean(profile && String(profile.auth_user_id || "").trim());
  const invited = Boolean(profile && profile.invited_at);
  if (plan === "active" && hasAuth) return "already_has_access";
  if (plan === "active" && invited) return "already_invited";
  if (plan === "active") return "access_not_sent";
  return "access_blocked";
}

function deriveBadges(tenant, onboarding, profile) {
  const badges = [];
  const plan = String(tenant?.plan_status || "").toLowerCase();
  const obStatus = String(onboarding?.status || "").toLowerCase();
  const expired =
    onboarding?.term_expires_at && Date.parse(onboarding.term_expires_at) < Date.now();
  if (plan === "pending" && !onboarding) badges.push("PENDING SETUP");
  if (plan === "pending" && onboarding && !onboarding.paid_at) badges.push("AWAITING PAYMENT");
  if (onboarding && onboarding.paid_at) badges.push("PAID");
  if (plan === "active") badges.push("ACTIVE");
  if (plan === "active" && !(profile && String(profile.auth_user_id || "").trim()) && !profile?.invited_at) {
    badges.push("ACCESS NOT SENT");
  }
  if (profile && (profile.invited_at || String(profile.auth_user_id || "").trim())) {
    badges.push("ACCESS SENT");
  }
  if (obStatus === "failed" || obStatus === "admin_review" || onboarding?.last_error_code) {
    badges.push("ERROR");
  }
  if (obStatus === "canceled" || expired) badges.push(expired ? "EXPIRED" : "CANCELED");
  return badges;
}

function serializeCustomer(tenant, onboarding, profile) {
  const access = deriveAccessStatus(tenant, onboarding, profile);
  return {
    tenant_id: tenant.id,
    business_name: tenant.name,
    owner_email: tenant.owner_email,
    owner_name: (profile && (profile.full_name || profile.display_name)) || "",
    slug: tenant.slug,
    plan_status: tenant.plan_status,
    square_invoice_id: onboarding ? onboarding.external_invoice_id : null,
    onboarding_status: onboarding ? onboarding.status : null,
    payment_status: onboarding && onboarding.paid_at ? "paid" : onboarding ? "awaiting_payment" : "not_registered",
    subscription_status: String(tenant.plan_status || "").toLowerCase() === "active" ? "active" : "pending",
    registered_at: onboarding ? onboarding.registered_at : null,
    paid_at: onboarding ? onboarding.paid_at : null,
    activated_at: onboarding ? onboarding.activated_at : null,
    term_expires_at: onboarding ? onboarding.term_expires_at : null,
    last_error_code: onboarding ? onboarding.last_error_code : null,
    expected_amount_cents: ANNUAL_AMOUNT_CENTS,
    currency: ANNUAL_CURRENCY,
    provider: "square",
    access_status: access,
    badges: deriveBadges(tenant, onboarding, profile),
    can_send_owner_access: access === "access_not_sent" || access === "already_invited",
  };
}

function pendingCreateEnvelope(extra) {
  return Object.assign(
    {
      tenant_created: true,
      plan_status: "pending",
      expected_amount_cents: ANNUAL_AMOUNT_CENTS,
      currency: ANNUAL_CURRENCY,
      provider: "square",
    },
    extra || {}
  );
}

async function listSaasCustomers(deps = {}) {
  const req = deps.supabaseRequest || supabaseRequest;
  const tenants = await req(`tenants?select=${TENANT_SELECT}&order=created_at.desc&limit=100`);
  const list = Array.isArray(tenants) ? tenants : [];
  const onboardings = await req(`saas_onboarding?select=${ONBOARDING_SELECT}&order=registered_at.desc`);
  const obList = Array.isArray(onboardings) ? onboardings : [];
  const profiles = await req(`profiles?role=eq.owner&select=${OWNER_SELECT}`);
  const profileList = Array.isArray(profiles) ? profiles : [];

  return list.map((tenant) => {
    const onboarding =
      obList.find((row) => String(row.tenant_id) === String(tenant.id)) || null;
    const profile =
      profileList.find((row) => String(row.tenant_id) === String(tenant.id)) || null;
    return serializeCustomer(tenant, onboarding, profile);
  });
}

module.exports = {
  ANNUAL_AMOUNT_CENTS,
  ANNUAL_CURRENCY,
  deriveAccessStatus,
  listSaasCustomers,
  pendingCreateEnvelope,
  serializeCustomer,
};
