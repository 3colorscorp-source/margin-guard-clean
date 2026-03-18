const { readSessionFromEvent } = require("./_lib/session");
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

    const session = readSessionFromEvent(event);
    if (!session?.c) {
      return json(401, { error: "Unauthorized" });
    }

    const portal = await stripeRequest("/billing_portal/sessions", {
      body: {
        customer: session.c,
        return_url: `${getSiteUrl()}/dashboard.html`,
      },
    });

    return json(200, { url: portal.url });
  } catch (err) {
    return json(500, { error: err.message || "Unexpected error" });
  }
};
