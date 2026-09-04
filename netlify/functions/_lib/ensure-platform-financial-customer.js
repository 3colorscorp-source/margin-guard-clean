/**
 * Ensure this tenant has exactly one Stripe **platform Customer** used only as
 * Financial Connections `account_holder`.
 *
 * This Customer is an identity container for read-only bank monitoring.
 * It is NOT a Margin Guard SaaS subscription customer, NOT billing authority,
 * NOT a payment method, NOT debit permission, and NOT a Connect account.
 *
 * No subscriptions, PaymentIntents, charges, transfers, payouts, or ACH.
 */
"use strict";

const { stripeRequest } = require("./stripe");
const { supabaseRequest } = require("./supabase-admin");

function looksLikeCustomerId(value) {
  return /^cus_[A-Za-z0-9]+$/.test(String(value || "").trim());
}

function customerFieldsFromTenant(tenant) {
  const tenantId = String(tenant?.id || "").trim();
  const email = String(tenant?.owner_email || "")
    .trim()
    .toLowerCase();
  const name = String(tenant?.name || "").trim();
  const body = {
    "metadata[tenant_id]": tenantId,
    "metadata[purpose]": "financial_connections",
  };
  if (email.includes("@")) {
    body.email = email;
  }
  if (name) {
    body.name = name;
  }
  return body;
}

async function defaultCreateStripeCustomer(fields) {
  return stripeRequest("/customers", { method: "POST", body: fields });
}

/**
 * @param {object} tenant already resolved from authenticated owner session
 * @returns {Promise<{ customerId: string, created: boolean }>}
 */
async function ensurePlatformFinancialCustomer(tenant, deps = {}) {
  const tenantId = String(tenant?.id || "").trim();
  if (!tenantId) {
    throw new Error("tenant_required");
  }

  const requestFn =
    typeof deps.supabaseRequest === "function" ? deps.supabaseRequest : supabaseRequest;
  const createCustomer =
    typeof deps.createStripeCustomer === "function"
      ? deps.createStripeCustomer
      : defaultCreateStripeCustomer;

  const existing = String(tenant.stripe_customer_id || "").trim();
  if (looksLikeCustomerId(existing)) {
    return { customerId: existing, created: false };
  }

  const freshRows = await requestFn(
    `tenants?id=eq.${encodeURIComponent(
      tenantId
    )}&select=id,stripe_customer_id,owner_email,name&limit=1`
  );
  const fresh = Array.isArray(freshRows) ? freshRows[0] : freshRows;
  if (!fresh?.id || String(fresh.id) !== tenantId) {
    throw new Error("tenant_not_found");
  }

  const stored = String(fresh.stripe_customer_id || "").trim();
  if (looksLikeCustomerId(stored)) {
    return { customerId: stored, created: false };
  }

  const fields = customerFieldsFromTenant({
    id: tenantId,
    owner_email: fresh.owner_email || tenant.owner_email,
    name: fresh.name || tenant.name,
  });
  const customer = await createCustomer(fields);
  const customerId = String(customer?.id || "").trim();
  if (!looksLikeCustomerId(customerId)) {
    throw new Error("stripe_customer_create_failed");
  }

  const raceRows = await requestFn(
    `tenants?id=eq.${encodeURIComponent(tenantId)}&select=id,stripe_customer_id&limit=1`
  );
  const race = Array.isArray(raceRows) ? raceRows[0] : raceRows;
  const racedId = String(race?.stripe_customer_id || "").trim();
  if (looksLikeCustomerId(racedId)) {
    return { customerId: racedId, created: false };
  }

  await requestFn(`tenants?id=eq.${encodeURIComponent(tenantId)}`, {
    method: "PATCH",
    body: { stripe_customer_id: customerId },
  });

  return { customerId, created: true };
}

module.exports = {
  customerFieldsFromTenant,
  ensurePlatformFinancialCustomer,
  looksLikeCustomerId,
};
