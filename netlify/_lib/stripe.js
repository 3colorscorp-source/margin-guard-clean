const STRIPE_API = "https://api.stripe.com/v1";

function getStripeKey() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error("Missing STRIPE_SECRET_KEY");
  }
  return key;
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
  return process.env.URL || process.env.DEPLOY_PRIME_URL || "http://localhost:8888";
}

module.exports = {
  getSiteUrl,
  stripeRequest,
};
