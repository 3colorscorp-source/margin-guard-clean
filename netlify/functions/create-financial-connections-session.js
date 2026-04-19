const { buildRefreshedSessionCookie, readSessionFromEvent } = require("./_lib/session");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");
const { supabaseRequest } = require("./_lib/supabase-admin");
const {
  fetchStripePlatformAccountMeta,
  getStripeKeyForPlatform,
} = require("./_lib/stripe");

const fetch = globalThis.fetch;
if (!fetch) {
  throw new Error("Global fetch is not available in this runtime.");
}

const STRIPE_API = "https://api.stripe.com/v1";

function json(statusCode, payload, extraHeaders = {}) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify(payload),
  };
}

/**
 * Financial Connections runs on the **platform** account (no Stripe-Account header).
 * `account_holder[customer]` must be a platform Customer id for this secret key.
 */
async function createFinancialConnectionsSession(stripeCustomerId) {
  const form = new URLSearchParams();
  form.set("account_holder[type]", "customer");
  form.set("account_holder[customer]", stripeCustomerId);
  form.append("permissions[]", "balances");

  const response = await fetch(`${STRIPE_API}/financial_connections/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getStripeKeyForPlatform()}`,
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

exports.handler = async (event) => {
  let cookieHeaders = {};
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { error: "Method not allowed" });
    }

    const session = readSessionFromEvent(event);
    if (!session?.e || !session?.c) {
      return json(401, { error: "Unauthorized" });
    }

    const tenant = await resolveTenantFromSession(session);
    if (!tenant?.id) {
      return json(404, { error: "Tenant not found" });
    }

    const refreshedCookie = buildRefreshedSessionCookie(session, tenant);
    if (refreshedCookie) {
      cookieHeaders = { "Set-Cookie": refreshedCookie };
    }

    const customerId = String(tenant.stripe_customer_id || "").trim();
    if (!customerId) {
      return json(
        400,
        {
          error: "Missing Stripe customer for tenant. Complete billing setup first.",
        },
        cookieHeaders
      );
    }

    // TEMP: remove after production FC / Stripe key alignment is confirmed
    let platformMeta = { id: null, livemode: null };
    try {
      platformMeta = await fetchStripePlatformAccountMeta();
    } catch (e) {
      console.error("[fc-debug] GET /v1/account failed:", e?.message || e);
    }
    console.log(
      "[fc-debug] stripe_platform_account_id=",
      platformMeta.id,
      "livemode=",
      platformMeta.livemode,
      "customer_id_requested=",
      customerId
    );

    const fcSession = await createFinancialConnectionsSession(customerId);

    const clientSecret = fcSession?.client_secret;
    const stripeFcSessionId = fcSession?.id;
    if (!clientSecret || !stripeFcSessionId) {
      return json(502, { error: "Invalid response from Stripe" }, cookieHeaders);
    }

    const inserted = await supabaseRequest("tenant_bank_connections", {
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
    return json(500, { error: err.message || "Unexpected error" }, cookieHeaders);
  }
};
