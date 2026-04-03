const fetch = globalThis.fetch;
if (!fetch) {
  throw new Error("Global fetch is not available in this runtime.");
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}

function pickFirst(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  return "";
}

function parseBody(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

function toUsdCents(value, fallback = 100000) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.round(num * 100);
}

function isValidEmail(value) {
  const email = String(value || "").trim();
  return email.includes("@") && email.includes(".");
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { error: "Method Not Allowed" });
    }

    const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeSecretKey) {
      return json(500, { error: "Missing env STRIPE_SECRET_KEY" });
    }

    const body = parseBody(event.body);

    const publicToken = pickFirst(
      body.public_token,
      body.publicToken,
      body.token
    );

    if (!publicToken) {
      return json(400, { error: "Missing public_token" });
    }

    const projectName = pickFirst(
      body.project_name,
      body.projectName,
      body.title,
      "Project"
    );

    const customerName = pickFirst(
      body.customer_name,
      body.customerName,
      body.client_name,
      body.clientName,
      body.name,
      "Customer"
    );

    const rawEmail = pickFirst(
      body.client_email,
      body.clientEmail,
      body.customer_email,
      body.customerEmail,
      body.email
    );

    const customerEmail = isValidEmail(rawEmail) ? String(rawEmail).trim() : "";

    const depositCents = toUsdCents(
      body.deposit_required ?? body.depositRequired ?? body.amount,
      100000
    );

    const siteUrl = (
      process.env.URL ||
      process.env.DEPLOY_PRIME_URL ||
      process.env.SITE_URL ||
      ""
    ).replace(/\/+$/, "");

    if (!siteUrl) {
      return json(500, { error: "Missing site URL environment" });
    }

    const successUrl = `${siteUrl}/deposit-success.html?session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${siteUrl}/estimate-public.html?token=${encodeURIComponent(publicToken)}&checkout=cancelled`;

    const form = new URLSearchParams();
    form.set("mode", "payment");
    form.set("success_url", successUrl);
    form.set("cancel_url", cancelUrl);
    form.set("billing_address_collection", "required");
    form.set("customer_creation", "always");
    form.set("phone_number_collection[enabled]", "false");
    form.set("allow_promotion_codes", "false");

    form.set("line_items[0][quantity]", "1");
    form.set("line_items[0][price_data][currency]", "usd");
    form.set("line_items[0][price_data][unit_amount]", String(depositCents));
    form.set("line_items[0][price_data][product_data][name]", "Project Deposit");
    form.set(
      "line_items[0][price_data][product_data][description]",
      "Required deposit to reserve your project start date. Applied toward final invoice."
    );

    form.set("client_reference_id", publicToken);
    form.set("metadata[purpose]", "project_deposit");
    form.set("metadata[public_token]", publicToken);
    form.set("metadata[project_name]", projectName);
    form.set("metadata[customer_name]", customerName);

    if (customerEmail) {
      form.set("customer_email", customerEmail);
      form.set("metadata[customer_email]", customerEmail);
    }

    const stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${stripeSecretKey}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: form.toString()
    });

    const stripeText = await stripeRes.text();
    let stripeData = {};
    try {
      stripeData = stripeText ? JSON.parse(stripeText) : {};
    } catch {
      stripeData = {};
    }

    if (!stripeRes.ok) {
      return json(502, {
        error: stripeData?.error?.message || stripeText || "Stripe session creation failed"
      });
    }

    return json(200, {
      ok: true,
      session_id: stripeData.id,
      url: stripeData.url
    });
  } catch (err) {
    return json(500, { error: err.message || "Server error" });
  }
};