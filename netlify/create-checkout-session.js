const { getSiteUrl, stripeRequest } = require("./_lib/stripe");

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { error: "Method not allowed" });
    }

    const annualPriceId = process.env.STRIPE_PRICE_ANNUAL_ID;
    if (!annualPriceId) {
      return json(500, { error: "Missing STRIPE_PRICE_ANNUAL_ID" });
    }

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch (_err) {
      return json(400, { error: "Invalid JSON" });
    }

    const email = String(body.email || "").trim();
    if (!email || !email.includes("@")) {
      return json(400, { error: "Valid email is required" });
    }

    const siteUrl = getSiteUrl();
    const session = await stripeRequest("/checkout/sessions", {
      body: {
        mode: "subscription",
        "line_items[0][price]": annualPriceId,
        "line_items[0][quantity]": 1,
        customer_email: email,
        success_url: `${siteUrl}/success.html?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${siteUrl}/cancel.html`,
        allow_promotion_codes: true,
        billing_address_collection: "auto",
        "subscription_data[metadata][product]": "margin-guard",
      },
    });

    return json(200, { url: session.url });
  } catch (err) {
    return json(500, { error: err.message || "Unexpected error" });
  }
};
