/**
 * TEMPORARY: creates a platform Customer for debugging. Remove after use.
 */

const { stripeRequest } = require("./_lib/stripe");

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

const EMAIL = "3colorscorp@gmail.com";
const NAME = "Three Colors Corp";

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { error: "Method not allowed" });
    }

    const customer = await stripeRequest("/customers", {
      method: "POST",
      body: {
        email: EMAIL,
        name: NAME,
      },
    });

    console.log("Created customer:", customer.id);

    return json(200, { ok: true, customer_id: customer.id });
  } catch (err) {
    return json(500, { ok: false, error: err.message || "Unexpected error" });
  }
};
