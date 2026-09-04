const { supabaseRequest } = require("./supabase-admin");
const { planIsActive, resolveUniqueActiveOwnerAccess } = require("./owner-access");
const { membershipIsActive, membershipRole, resolveMembershipByEmail } = require("./membership-resolve");

const TENANT_SELECT_FIELDS =
  "id,owner_email,stripe_customer_id,stripe_account_id,stripe_charges_enabled,stripe_details_submitted,plan_status,name,slug";

function looksLikeStripeCustomerId(value) {
  return /^cus_[A-Za-z0-9]+$/.test(String(value || "").trim());
}

/** Only plan_status === "active" may use owner SaaS APIs. Rechecked on every resolve. */
function entitledOwnerTenant(tenant) {
  if (!tenant?.id || !planIsActive(tenant)) return null;
  return tenant;
}

/**
 * Resolve the signed-in owner's tenant.
 * Authority: signed session email + server membership. Optional session.t.
 * Stripe customer id is a legacy lookup only, never required.
 */
async function resolveTenantFromSession(session, deps = {}) {
  if (!session?.e) {
    return null;
  }
  const email = String(session.e || "").trim().toLowerCase();
  const requestFn = typeof deps.supabaseRequest === "function" ? deps.supabaseRequest : supabaseRequest;
  const tenantIdHint = String(session.t || "").trim();

  if (tenantIdHint) {
    try {
      const membership = await resolveMembershipByEmail(requestFn, tenantIdHint, email);
      if (
        membership &&
        membershipIsActive(membership) &&
        membershipRole(membership) === "owner"
      ) {
        const rows = await requestFn(
          `tenants?id=eq.${encodeURIComponent(tenantIdHint)}&select=${TENANT_SELECT_FIELDS}&limit=1`
        );
        const tenant = Array.isArray(rows) ? rows[0] : null;
        const entitled = entitledOwnerTenant(tenant);
        if (entitled) return entitled;
      }
    } catch (_err) {
      /* fall through */
    }
  }

  const ownerAccess = await resolveUniqueActiveOwnerAccess(email, { ...deps, supabaseRequest: requestFn });
  if (ownerAccess.ok && ownerAccess.tenant?.id) {
    if (tenantIdHint && String(ownerAccess.tenant.id) !== tenantIdHint) {
      return null;
    }
    return entitledOwnerTenant(ownerAccess.tenant);
  }

  const legacyCustomer = String(session.c || "").trim();
  if (looksLikeStripeCustomerId(legacyCustomer)) {
    try {
      const rows = await requestFn(
        `tenants?stripe_customer_id=eq.${encodeURIComponent(legacyCustomer)}&select=${TENANT_SELECT_FIELDS}`
      );
      const tenant = Array.isArray(rows) ? rows[0] : null;
      if (tenant?.id) {
        const membership = await resolveMembershipByEmail(requestFn, tenant.id, email);
        if (
          membership &&
          membershipIsActive(membership) &&
          membershipRole(membership) === "owner"
        ) {
          return entitledOwnerTenant(tenant);
        }
      }
    } catch (_err) {
      return null;
    }
  }

  return null;
}

module.exports = { resolveTenantFromSession, looksLikeStripeCustomerId };
