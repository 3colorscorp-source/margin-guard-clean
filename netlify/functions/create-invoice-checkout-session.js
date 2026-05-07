const { supabaseRequest } = require("./_lib/supabase-admin");
const { getStripeKey } = require("./_lib/stripe");

const fetch = globalThis.fetch;
if (!fetch) {
  throw new Error("Global fetch is not available in this runtime.");
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function parseBody(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

function invoiceIsBlockedStatus(status) {
  const s = String(status || "").trim().toLowerCase();
  return s === "archived" || s === "deleted" || s === "paid" || s === "void";
}

function money(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0;
}

async function loadPaidToDate({ tenantId, invoiceId, projectId, quoteId }) {
  if (!tenantId) return 0;
  const params = new URLSearchParams();
  params.set("tenant_id", `eq.${tenantId}`);
  params.set("select", "amount");
  params.set("limit", "500");
  if (invoiceId) params.set("invoice_id", `eq.${invoiceId}`);
  else if (projectId) params.set("project_id", `eq.${projectId}`);
  else if (quoteId) params.set("quote_id", `eq.${quoteId}`);
  else return 0;
  try {
    const rows = await supabaseRequest(`tenant_project_payments?${params.toString()}`, { method: "GET" });
    const list = Array.isArray(rows) ? rows : [];
    return list.reduce((sum, row) => {
      const n = Number(row?.amount);
      return sum + (Number.isFinite(n) ? n : 0);
    }, 0);
  } catch (_err) {
    return 0;
  }
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { error: "Method Not Allowed" });
    }

    let stripeSecretKey = "";
    try {
      stripeSecretKey = getStripeKey();
    } catch (_e) {
      return json(500, { error: "Missing env STRIPE_SECRET_KEY or STRIPE_PLATFORM_SECRET_KEY" });
    }

    const body = parseBody(event.body);
    const publicToken = String(body.public_token || "").trim();
    if (!publicToken) {
      return json(400, { error: "public_token_required" });
    }

    const rows = await supabaseRequest(
      `invoices?public_token=eq.${encodeURIComponent(publicToken)}&tenant_id=not.is.null&select=id,tenant_id,invoice_no,status,balance_due,amount,paid_amount,currency,customer_email,project_name,quote_id,project_id&limit=2`,
      { method: "GET" }
    );
    if (!Array.isArray(rows) || rows.length === 0) return json(404, { error: "invoice_not_found" });
    if (rows.length > 1) return json(500, { error: "invalid_invoice_reference" });

    const inv = rows[0];
    const tenantId = String(inv.tenant_id || "").trim();
    const invoiceId = String(inv.id || "").trim();
    if (!tenantId || !invoiceId) return json(404, { error: "invoice_not_found" });
    if (invoiceIsBlockedStatus(inv.status)) return json(409, { error: "invoice_not_payable" });

    const amountRaw = money(inv.amount);
    const paidRaw = money(inv.paid_amount);
    const derivedRemaining = money(Math.max(amountRaw - paidRaw, 0));
    const balanceDueRaw = money(inv.balance_due);
    const remaining = amountRaw > 0 || paidRaw > 0 ? derivedRemaining : money(balanceDueRaw);
    if (!(remaining > 0)) return json(409, { error: "invoice_balance_not_payable" });

    const cents = Math.round(remaining * 100);
    console.log("[invoice checkout amount]", {
      invoiceId,
      tenantId,
      amountDollars: remaining,
      amountCents: cents,
    });
    if (!(cents >= 50)) return json(409, { error: "invoice_balance_too_small" });

    const tenantRows = await supabaseRequest(
      `tenants?id=eq.${encodeURIComponent(tenantId)}&select=id,stripe_account_id,stripe_charges_enabled&limit=1`,
      { method: "GET" }
    );
    const tenant = Array.isArray(tenantRows) ? tenantRows[0] : null;
    const connectAccountId = String(tenant?.stripe_account_id || "").trim();
    const chargesEnabled = Boolean(tenant?.stripe_charges_enabled);
    if (!connectAccountId || !chargesEnabled) {
      return json(409, { error: "tenant_stripe_not_ready" });
    }

    const siteUrl = String(
      process.env.PUBLIC_SITE_URL || process.env.URL || process.env.DEPLOY_PRIME_URL || ""
    )
      .trim()
      .replace(/\/+$/, "");
    if (!siteUrl) return json(500, { error: "missing_site_url" });

    const successUrl = `${siteUrl}/invoice-public.html?token=${encodeURIComponent(publicToken)}&payment=success`;
    const cancelUrl = `${siteUrl}/invoice-public.html?token=${encodeURIComponent(publicToken)}&payment=cancel`;

    const form = new URLSearchParams();
    form.set("mode", "payment");
    form.set("success_url", successUrl);
    form.set("cancel_url", cancelUrl);
    form.set("billing_address_collection", "required");
    form.set("payment_method_types[0]", "card");
    form.set("line_items[0][quantity]", "1");
    form.set("line_items[0][price_data][currency]", "usd");
    form.set("line_items[0][price_data][unit_amount]", String(cents));
    form.set(
      "line_items[0][price_data][product_data][name]",
      `Invoice ${String(inv.invoice_no || "Payment").trim() || "Payment"}`
    );
    form.set(
      "line_items[0][price_data][product_data][description]",
      `Invoice balance payment for ${String(inv.project_name || "project").trim() || "project"}`
    );
    form.set("client_reference_id", publicToken);
    form.set("metadata[tenant_id]", tenantId);
    form.set("metadata[invoice_id]", invoiceId);
    form.set("metadata[invoice_no]", String(inv.invoice_no || "").trim());
    form.set("metadata[public_token]", publicToken);
    if (String(inv.customer_email || "").includes("@")) {
      form.set("customer_email", String(inv.customer_email).trim());
    }

    const stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${stripeSecretKey}`,
        "Stripe-Account": connectAccountId,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });
    const stripeText = await stripeRes.text();
    let stripeData = {};
    try {
      stripeData = stripeText ? JSON.parse(stripeText) : {};
    } catch {
      stripeData = {};
    }
    if (!stripeRes.ok || !stripeData?.url) {
      return json(502, {
        error: stripeData?.error?.message || stripeText || "stripe_checkout_session_failed",
      });
    }

    return json(200, { ok: true, checkout_url: stripeData.url });
  } catch (err) {
    return json(500, { error: err.message || "Server error" });
  }
};
