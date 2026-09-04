/**
 * Start Stripe Financial Connections for the authenticated owner tenant.
 *
 * The platform Stripe Customer is loaded or created server-side as FC
 * account_holder only. Cookie session.c is not required and is not trusted.
 * Permissions: balances only. No money movement.
 */
const { buildRefreshedSessionCookie } = require("./_lib/session");
const { requireFcOwnerTenant, json } = require("./_lib/fc-owner-context");
const { supabaseRequest } = require("./_lib/supabase-admin");
const { getStripeKeyForPlatform } = require("./_lib/stripe");
const { ensurePlatformFinancialCustomer } = require("./_lib/ensure-platform-financial-customer");

const fetch = globalThis.fetch;
if (!fetch) {
  throw new Error("Global fetch is not available in this runtime.");
}

const STRIPE_API = "https://api.stripe.com/v1";

async function createFinancialConnectionsSession(stripeCustomerId, deps = {}) {
  const form = new URLSearchParams();
  form.set("account_holder[type]", "customer");
  form.set("account_holder[customer]", stripeCustomerId);
  form.append("permissions[]", "balances");

  const fetchImpl = deps.fetch || fetch;
  const getKey = deps.getStripeKeyForPlatform || getStripeKeyForPlatform;

  const response = await fetchImpl(`${STRIPE_API}/financial_connections/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getKey()}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (_err) {
    data = { raw: text };
  }

  if (!response.ok) {
    const msg = data?.error?.message || "Stripe Financial Connections session failed";
    throw new Error(msg);
  }

  return data;
}

function createHandler(deps = {}) {
  const requireOwner = deps.requireFcOwnerTenant || requireFcOwnerTenant;
  const ensureCustomer = deps.ensurePlatformFinancialCustomer || ensurePlatformFinancialCustomer;
  const createFcSession = deps.createFinancialConnectionsSession || createFinancialConnectionsSession;
  const requestFn = deps.supabaseRequest || supabaseRequest;
  const refreshCookie = deps.buildRefreshedSessionCookie || buildRefreshedSessionCookie;

  return async function handler(event) {
    let cookieHeaders = {};
    try {
      if (event.httpMethod !== "POST") {
        return json(405, { error: "Method not allowed" });
      }

      const gate = await requireOwner(event, deps);
      if (!gate.ok) {
        return gate.response;
      }
      const { session, tenant } = gate;

      const refreshedCookie = refreshCookie(session, tenant);
      if (refreshedCookie) {
        cookieHeaders = { "Set-Cookie": refreshedCookie };
      }

      const ensured = await ensureCustomer(tenant, deps);
      const customerId = String(ensured?.customerId || "").trim();
      if (!customerId) {
        return json(500, { error: "Financial customer unavailable" }, cookieHeaders);
      }

      const fcSession = await createFcSession(customerId, deps);

      const clientSecret = fcSession?.client_secret;
      const stripeFcSessionId = fcSession?.id;
      if (!clientSecret || !stripeFcSessionId) {
        return json(502, { error: "Invalid response from Stripe" }, cookieHeaders);
      }

      const inserted = await requestFn("tenant_bank_connections", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: {
          tenant_id: tenant.id,
          stripe_fc_session_id: stripeFcSessionId,
          stripe_customer_id: customerId,
          status: "pending",
          updated_at: new Date().toISOString(),
        },
      });

      const row = Array.isArray(inserted) ? inserted[0] : inserted;
      const connectionId = row?.id;
      if (!connectionId) {
        return json(500, { error: "Failed to record bank connection" }, cookieHeaders);
      }

      return json(
        200,
        {
          ok: true,
          client_secret: clientSecret,
          connection_id: connectionId,
          financial_connections_session_id: stripeFcSessionId,
        },
        cookieHeaders
      );
    } catch (err) {
      console.error("[fc] session_create_failed");
      return json(500, { error: err.message || "Unexpected error" }, cookieHeaders);
    }
  };
}

exports.createFinancialConnectionsSession = createFinancialConnectionsSession;
exports.createHandler = createHandler;
exports.handler = createHandler();
