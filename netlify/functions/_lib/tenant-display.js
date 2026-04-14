const { supabaseRequest } = require("./supabase-admin");

function pickFirst(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  return "";
}

/**
 * Loads tenant-facing fields from tenants + tenant_branding for multi-tenant quote/invoice payloads.
 */
async function loadTenantDisplayForTenantId(tenantId) {
  if (!tenantId) {
    return {
      business_name: "",
      business_email: "",
      business_phone: "",
      business_address: "",
      logo_url: "",
      fallback_name: "",
      branding_business_name: "",
      branding_company_name: ""
    };
  }

  let tenant = null;
  try {
    const tenants = await supabaseRequest(
      `tenants?id=eq.${encodeURIComponent(tenantId)}&select=id,name`
    );
    tenant = Array.isArray(tenants) ? tenants[0] : null;
  } catch (_e) {
    tenant = null;
  }

  let branding = null;
  try {
    const rows = await supabaseRequest(
      `tenant_branding?tenant_id=eq.${encodeURIComponent(tenantId)}&select=*`
    );
    branding = Array.isArray(rows) ? rows[0] : rows;
  } catch (_e) {
    branding = null;
  }

  const fallbackName = pickFirst(tenant?.name);
  return {
    business_name: pickFirst(branding?.business_name, fallbackName),
    business_email: pickFirst(branding?.business_email),
    business_phone: pickFirst(branding?.business_phone),
    business_address: pickFirst(branding?.business_address),
    logo_url: pickFirst(branding?.logo_url),
    fallback_name: fallbackName,
    /** Raw tenant_branding only (no tenants.name merge) — for public quote header resolution. */
    branding_business_name: pickFirst(branding?.business_name),
    branding_company_name: pickFirst(branding?.company_name)
  };
}

module.exports = { pickFirst, loadTenantDisplayForTenantId };
