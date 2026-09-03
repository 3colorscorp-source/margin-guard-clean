function json(statusCode, payload) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  };
}

/**
 * SaaS subscriptions are billed outside Stripe (QuickBooks / Square).
 * This endpoint must not create Stripe Checkout sessions or grant access.
 */
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed" });
  }
  return json(403, { error: "subscription_checkout_disabled" });
};
