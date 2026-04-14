const { readSessionFromEvent } = require("./_lib/session");
const { supabaseRequest } = require("./_lib/supabase-admin");
const { assertPublicDepositAllowed } = require("./_lib/quote-deposit-gate");
const { logStripeSecretDiagnostics } = require("./_lib/stripe-env-log");

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

function isValidEmail(value) {
  const email = String(value || "").trim();
  return email.includes("@") && email.includes(".");
}

function depositRequiredToUsdCents(raw) {
  const dollars = Number(raw);
  if (!Number.isFinite(dollars) || dollars <= 0) {
    return null;
  }
  const cents = Math.round(dollars * 100);
  if (cents < 50) {
    return null;
  }
  return cents;
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

    logStripeSecretDiagnostics(stripeSecretKey, "create-project-deposit-session");
    // Project Deposit: always create a new Checkout Session via Stripe API. We do not read or
    // reuse any stored deposit checkout URL from the quote (no stale test/live link reuse).
    console.log(
      "[create-project-deposit-session] REUSING_STORED_DEPOSIT_CHECKOUT_URL",
      false
    );

    const body = parseBody(event.body);

    const publicToken = pickFirst(
      body.public_token,
      body.publicToken,
      body.token
    );

    if (!publicToken) {
      return json(400, { error: "Missing public_token" });
    }

    const quoteRows = await supabaseRequest(
      `quotes?public_token=eq.${encodeURIComponent(publicToken)}&tenant_id=not.is.null&select=id,deposit_required,tenant_id,project_name,title,client_name,client_email,accepted_at,exclusions_initials,exclusions_acknowledged_at,change_order_acknowledged_at`
    );
    const quote = Array.isArray(quoteRows) ? quoteRows[0] : null;
    if (!quote) {
      return json(404, { error: "Quote not found for this public link." });
    }

    if (!quote.id) {
      return json(400, {
        error: "Quote record is missing an id; cannot create a deposit checkout session."
      });
    }

    if (!quote.tenant_id) {
      return json(400, {
        error:
          "Quote is missing tenant scope; republish the estimate from your account."
      });
    }

    const tenantRows = await supabaseRequest(
      `tenants?id=eq.${encodeURIComponent(String(quote.tenant_id))}&select=stripe_account_id,stripe_charges_enabled`
    );
    const tenantRow = Array.isArray(tenantRows) ? tenantRows[0] : null;
    const connectAccountId = String(tenantRow?.stripe_account_id || "").trim();
    const chargesOk = Boolean(tenantRow?.stripe_charges_enabled);
    if (!connectAccountId || !chargesOk) {
      return json(403, {
        error:
          "Deposit checkout is not available for this business yet. The contractor must connect Stripe for deposits in Business Settings."
      });
    }

    const gate = assertPublicDepositAllowed(quote);
    if (!gate.ok) {
      return json(403, { error: gate.error });
    }

    const session = readSessionFromEvent(event);
    if (session?.e && session?.c) {
      const tenantRows = await supabaseRequest(
        `tenants?stripe_customer_id=eq.${encodeURIComponent(session.c)}&select=id`
      );
      const sessionTenant = Array.isArray(tenantRows) ? tenantRows[0] : null;
      if (!sessionTenant?.id) {
        return json(404, { error: "Tenant not found. Run bootstrap first." });
      }
      if (String(quote.tenant_id) !== String(sessionTenant.id)) {
        return json(403, { error: "Forbidden" });
      }
    }

    const dollarsRaw = quote.deposit_required;
    const dollars = Number(dollarsRaw);
    if (!Number.isFinite(dollars) || dollars <= 0) {
      return json(400, {
        error:
          "Deposit must be greater than zero on the estimate before starting checkout."
      });
    }

    const depositCents = depositRequiredToUsdCents(quote.deposit_required);
    if (depositCents == null) {
      return json(400, {
        error:
          "Deposit amount is below the minimum allowed for card checkout ($0.50). Increase deposit_required on the quote."
      });
    }

    const projectName = pickFirst(
      quote.project_name,
      quote.title,
      body.project_name,
      body.projectName,
      body.title,
      "Project"
    );

    const customerName = pickFirst(
      quote.client_name,
      body.customer_name,
      body.customerName,
      body.client_name,
      body.clientName,
      body.name,
      "Customer"
    );

    const rawEmail = pickFirst(
      quote.client_email,
      body.client_email,
      body.clientEmail,
      body.customer_email,
      body.customerEmail,
      body.email
    );

    const customerEmail = isValidEmail(rawEmail) ? String(rawEmail).trim() : "";

    const siteUrl = (
      process.env.URL ||
      process.env.DEPLOY_PRIME_URL ||
      process.env.SITE_URL ||
      ""
    ).replace(/\/+$/, "");

    if (!siteUrl) {
      return json(500, { error: "Missing site URL environment" });
    }

    const successUrl = `${siteUrl}/deposit-success.html?session_id={CHECKOUT_SESSION_ID}&token=${encodeURIComponent(publicToken)}`;
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
    form.set("metadata[quote_id]", String(quote.id || ""));
    form.set("metadata[tenant_id]", String(quote.tenant_id || ""));
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
        "Stripe-Account": connectAccountId,
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
