function json(statusCode, payload) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  };
}

/**
 * Stripe Billing Portal is not used for Margin Guard SaaS subscriptions.
 */
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed" });
  }
  return json(403, { error: "subscription_portal_disabled" });
};
