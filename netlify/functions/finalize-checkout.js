function json(statusCode, payload) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  };
}

/**
 * SaaS access is not granted from Stripe Checkout.
 * Owners authenticate with verified Supabase Auth via restore-owner-session.
 */
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed" });
  }
  return json(403, { error: "subscription_checkout_disabled" });
};
