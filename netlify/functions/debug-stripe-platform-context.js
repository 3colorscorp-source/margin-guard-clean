/**
 * Temporary diagnostic: which Stripe account the platform secret resolves to,
 * and whether a given Customer id exists for that key.
 * Enable with ALLOW_DEBUG_STRIPE_PLATFORM_CONTEXT=1 in Netlify, then remove this function.
 */

const fetch = globalThis.fetch;
if (!fetch) {
  throw new Error("Global fetch is not available in this runtime.");
}

const DEFAULT_CUSTOMER_ID = "cus_UM5R1onMCkT3H";

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function keyPresence() {
  const platform = String(process.env.STRIPE_PLATFORM_SECRET_KEY || "").trim();
  const standard = String(process.env.STRIPE_SECRET_KEY || "").trim();
  return {
    STRIPE_PLATFORM_SECRET_KEY_present: platform.length > 0,
    STRIPE_SECRET_KEY_present: standard.length > 0,
    key_source: platform.length > 0 ? "STRIPE_PLATFORM_SECRET_KEY" : "STRIPE_SECRET_KEY",
  };
}

function resolvedSecretKey() {
  const platform = String(process.env.STRIPE_PLATFORM_SECRET_KEY || "").trim();
  const standard = String(process.env.STRIPE_SECRET_KEY || "").trim();
  return platform || standard || "";
}

async function stripeGetJson(path, secretKey) {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${secretKey}`,
    },
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch (_e) {
    data = { raw: text };
  }
  return { ok: res.ok, status: res.status, data };
}

exports.handler = async (event) => {
  try {
    if (String(process.env.ALLOW_DEBUG_STRIPE_PLATFORM_CONTEXT || "") !== "1") {
      return json(403, {
        error:
          "Disabled. Set ALLOW_DEBUG_STRIPE_PLATFORM_CONTEXT=1 in Netlify to enable, then unset after debugging.",
      });
    }

    if (event.httpMethod !== "GET") {
      return json(405, { error: "Method not allowed" });
    }

    const presence = keyPresence();
    const secretKey = resolvedSecretKey();

    if (!secretKey) {
      const params = event.queryStringParameters || {};
      const customerId =
        String(params.customer_id || DEFAULT_CUSTOMER_ID).trim() || DEFAULT_CUSTOMER_ID;
      return json(200, {
        ...presence,
        account: null,
        account_fetch_error: "No STRIPE_PLATFORM_SECRET_KEY or STRIPE_SECRET_KEY set",
        customer_id_checked: customerId,
        customer_exists_under_this_key: false,
        customer_fetch_error: "No secret key; customer not requested",
      });
    }

    const accountRes = await stripeGetJson("/account", secretKey);
    let accountPayload = null;
    let accountError = null;
    if (accountRes.ok && accountRes.data && !accountRes.data.error) {
      const a = accountRes.data;
      accountPayload = {
        id: a.id ?? null,
        livemode: typeof a.livemode === "boolean" ? a.livemode : null,
        business_profile_name: a.business_profile?.name ?? null,
      };
    } else {
      accountError =
        accountRes.data?.error?.message ||
        accountRes.data?.raw ||
        `HTTP ${accountRes.status}`;
    }

    const params = event.queryStringParameters || {};
    const customerId = String(params.customer_id || DEFAULT_CUSTOMER_ID).trim() || DEFAULT_CUSTOMER_ID;

    const custRes = await stripeGetJson(
      `/customers/${encodeURIComponent(customerId)}`,
      secretKey
    );

    let customerExists = false;
    let customerError = null;
    if (custRes.ok && custRes.data && !custRes.data.error) {
      customerExists = true;
    } else {
      customerError =
        custRes.data?.error?.message ||
        custRes.data?.raw ||
        `HTTP ${custRes.status}`;
    }

    return json(200, {
      ...presence,
      account: accountPayload,
      account_fetch_error: accountError,
      customer_id_checked: customerId,
      customer_exists_under_this_key: customerExists,
      customer_fetch_error: customerExists ? null : customerError,
    });
  } catch (err) {
    return json(500, { error: err.message || "Unexpected error" });
  }
};
