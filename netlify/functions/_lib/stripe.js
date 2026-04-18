const STRIPE_API = "https://api.stripe.com/v1";

const fetch = globalThis.fetch;
if (!fetch) {
  throw new Error("Global fetch is not available in this runtime.");
}

/**
 * Secret for Stripe **platform** API calls (subscriptions, platform Customers, Financial Connections
 * without Stripe-Account, and Connect calls that use platform key + Stripe-Account header).
 *
 * Prefer `STRIPE_PLATFORM_SECRET_KEY` when `STRIPE_SECRET_KEY` in Netlify is not the same Dashboard
 * account as your subscription `cus_…` IDs (fixes "No such customer" on FC while Connect still works).
 */
function getStripeKey() {
  const key = String(
    process.env.STRIPE_PLATFORM_SECRET_KEY || process.env.STRIPE_SECRET_KEY || ""
  ).trim();
  if (!key) {
    throw new Error("Missing STRIPE_SECRET_KEY or STRIPE_PLATFORM_SECRET_KEY");
  }
  return key;
}

function getStripeKeyForPlatform() {
  return getStripeKey();
}

function encodeForm(data) {
  return Object.entries(data)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");
}

async function stripeRequest(path, options = {}) {
  const method = options.method || "POST";
  const body = options.body || null;

  const response = await fetch(`${STRIPE_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${getStripeKey()}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body ? encodeForm(body) : undefined,
  });

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (_err) {
    data = { raw: text };
  }

  if (!response.ok) {
    const msg = data?.error?.message || "Stripe request failed";
    throw new Error(msg);
  }

  return data;
}

function getSiteUrl() {
  const raw =
    process.env.SITE_URL ||
    process.env.URL ||
    process.env.DEPLOY_PRIME_URL ||
    "http://localhost:8888";
  return String(raw).replace(/\/+$/, "");
}

/**
 * GET /v1/account for the key returned by getStripeKey() (platform context).
 * Used for diagnostics; does not expose secrets.
 */
async function fetchStripePlatformAccountMeta() {
  const response = await fetch(`${STRIPE_API}/account`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${getStripeKey()}`,
    },
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch (_e) {
    data = {};
  }
  if (!response.ok || data.error) {
    const msg = data?.error?.message || `HTTP ${response.status}`;
    throw new Error(`Stripe GET /v1/account failed: ${msg}`);
  }
  return {
    id: data.id ?? null,
    livemode: typeof data.livemode === "boolean" ? data.livemode : null,
  };
}

module.exports = {
  fetchStripePlatformAccountMeta,
  getSiteUrl,
  getStripeKey,
  getStripeKeyForPlatform,
  stripeRequest,
};
