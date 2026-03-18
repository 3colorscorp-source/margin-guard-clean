const { buildSessionPayload, createSessionCookie } = require("./_lib/session");
const { stripeRequest } = require("./_lib/stripe");

function json(statusCode, payload, extraHeaders) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      ...(extraHeaders || {}),
    },
    body: JSON.stringify(payload),
  };
}

function subscriptionIsActive(status) {
  return ["active", "trialing", "past_due"].includes(status);
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { error: "Method not allowed" });
    }

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch (_err) {
      return json(400, { error: "Invalid JSON" });
    }

    const sessionId = String(body.sessionId || "").trim();
    if (!sessionId) {
      return json(400, { error: "sessionId is required" });
    }

    const checkout = await stripeRequest(`/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=subscription`, {
      method: "GET",
    });

    const subscription = checkout.subscription;
    const subscriptionId = typeof subscription === "string" ? subscription : subscription?.id;
    const subscriptionStatus = typeof subscription === "string" ? "unknown" : subscription?.status;

    if (checkout.status !== "complete" || !subscriptionId) {
      return json(402, { error: "Checkout is not completed" });
    }

    if (!subscriptionIsActive(subscriptionStatus)) {
      return json(402, { error: `Subscription not active (${subscriptionStatus || "unknown"})` });
    }

    const payload = buildSessionPayload({
      customerId: checkout.customer,
      subscriptionId,
      email: checkout.customer_details?.email || checkout.customer_email || "",
    });

    const cookie = createSessionCookie(payload);

    return json(
      200,
      {
        ok: true,
        email: payload.e,
      },
      {
        "Set-Cookie": cookie,
      }
    );
  } catch (err) {
    return json(500, { error: err.message || "Unexpected error" });
  }
};
