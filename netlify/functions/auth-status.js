const { clearSessionCookie, readSessionFromEvent } = require("./_lib/session");
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
    const session = readSessionFromEvent(event);
    if (!session?.s || !session?.c) {
      return json(200, { active: false });
    }

    const subscription = await stripeRequest(`/subscriptions/${encodeURIComponent(session.s)}`, {
      method: "GET",
    });

    if (!subscriptionIsActive(subscription.status)) {
      return json(
        200,
        {
          active: false,
          reason: "subscription_inactive",
        },
        {
          "Set-Cookie": clearSessionCookie(),
        }
      );
    }

    return json(200, {
      active: true,
      email: session.e || "",
      plan: subscription.items?.data?.[0]?.price?.nickname || "Annual",
      renewsAt: subscription.current_period_end ? new Date(subscription.current_period_end * 1000).toISOString() : null,
    });
  } catch (err) {
    return json(200, {
      active: false,
      reason: "validation_error",
      error: err.message || "Unexpected error",
    });
  }
};
