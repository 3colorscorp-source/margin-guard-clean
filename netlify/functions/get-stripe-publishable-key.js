function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "GET") {
      return json(405, { error: "Method not allowed" });
    }
    const key = String(process.env.STRIPE_PUBLISHABLE_KEY || "").trim();
    if (!key) {
      return json(503, { error: "Missing STRIPE_PUBLISHABLE_KEY" });
    }
    return json(200, { publishable_key: key });
  } catch (err) {
    return json(500, { error: err.message || "Unexpected error" });
  }
};
