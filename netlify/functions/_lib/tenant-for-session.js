const { supabaseRequest } = require("./supabase-admin");

const TENANT_SELECT_FIELDS =
  "id,owner_email,stripe_customer_id,stripe_account_id,stripe_charges_enabled,stripe_details_submitted";

/**
 * Resolve the signed-in user's tenant row (same pattern as save-tenant-snapshot / bootstrap).
 */
async function resolveTenantFromSession(session) {
  if (!session?.e || !session?.c) {
    return null;
  }
  const email = String(session.e || "").trim().toLowerCase();

  let rows = await supabaseRequest(
    `tenants?stripe_customer_id=eq.${encodeURIComponent(session.c)}&select=${TENANT_SELECT_FIELDS}`
  );
  let tenant = Array.isArray(rows) ? rows[0] : null;

  if (!tenant?.id && email) {
    rows = await supabaseRequest(
      `tenants?owner_email=eq.${encodeURIComponent(email)}&select=${TENANT_SELECT_FIELDS}`
    );
    tenant = Array.isArray(rows) ? rows[0] : null;

    if (tenant?.id && session.c && tenant.stripe_customer_id !== session.c) {
      try {
        await supabaseRequest(`tenants?id=eq.${encodeURIComponent(tenant.id)}`, {
          method: "PATCH",
          body: { stripe_customer_id: session.c },
        });
        tenant.stripe_customer_id = session.c;
      } catch (_err) {
        /* ignore */
      }
    }
  }

  return tenant;
}

module.exports = { resolveTenantFromSession };
