const fetch = globalThis.fetch;
if (!fetch) {
  throw new Error("Global fetch is not available in this runtime.");
}

const { supabaseRequest } = require("./_lib/supabase-admin");
const { assertPublicDepositAllowed } = require("./_lib/quote-deposit-gate");
const { loadTenantDisplayForTenantId } = require("./_lib/tenant-display");
const { runDepositPostAutomation } = require("./_lib/deposit-post-automation");

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}

function parseBody(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

async function patchQuote({ supabaseUrl, serviceRoleKey, publicToken, tenantId, payload }) {
  const tenantPart = tenantId
    ? `&tenant_id=eq.${encodeURIComponent(String(tenantId))}`
    : "";
  const response = await fetch(
    `${supabaseUrl}/rest/v1/quotes?public_token=eq.${encodeURIComponent(publicToken)}${tenantPart}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        Prefer: "return=representation"
      },
      body: JSON.stringify(payload)
    }
  );

  const text = await response.text();
  let rows = [];
  try {
    rows = text ? JSON.parse(text) : [];
  } catch {
    rows = [];
  }

  return {
    ok: response.ok,
    status: response.status,
    text,
    rows
  };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { error: "Method Not Allowed" });
    }

    const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
    const supabaseUrl =
      process.env.SUPABASE_URL || "https://yaagobzgozzozibublmj.supabase.co";
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!stripeSecretKey) {
      return json(500, { error: "Missing env STRIPE_SECRET_KEY" });
    }

    if (!serviceRoleKey) {
      return json(500, { error: "Missing env SUPABASE_SERVICE_ROLE_KEY" });
    }

    const body = parseBody(event.body);
    const sessionId = String(body.sessionId || body.session_id || "").trim();
    if (!sessionId) {
      return json(400, { error: "Missing sessionId" });
    }

    const stripeRes = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${stripeSecretKey}`
        }
      }
    );

    const stripeText = await stripeRes.text();
    let session = {};
    try {
      session = stripeText ? JSON.parse(stripeText) : {};
    } catch {
      session = {};
    }

    if (!stripeRes.ok) {
      return json(502, {
        error: session?.error?.message || stripeText || "Unable to retrieve Stripe session"
      });
    }

    const paid =
      String(session.payment_status || "").toLowerCase() === "paid" ||
      String(session.status || "").toLowerCase() === "complete";

    if (!paid) {
      return json(400, { error: "Stripe session is not paid yet" });
    }

    const publicToken =
      session?.metadata?.public_token ||
      session?.client_reference_id ||
      "";

    if (!publicToken) {
      return json(400, { error: "Stripe session missing public_token metadata" });
    }

    const tenantIdFromSession = String(session?.metadata?.tenant_id || "").trim();

    let quoteRows;
    try {
      quoteRows = await supabaseRequest(
        `quotes?public_token=eq.${encodeURIComponent(publicToken)}&tenant_id=not.is.null&select=id,tenant_id,accepted_at,exclusions_initials,exclusions_acknowledged_at,change_order_acknowledged_at,client_name,client_email,project_name,title,currency,business_name,company_name&limit=2`
      );
    } catch (err) {
      return json(502, { error: err.message || "Failed to read quote" });
    }

    if (!Array.isArray(quoteRows) || quoteRows.length === 0) {
      return json(404, { error: "Quote not found for this payment." });
    }
    if (quoteRows.length > 1) {
      return json(500, { error: "Invalid quote reference" });
    }

    const quoteRow = quoteRows[0];
    if (!quoteRow?.tenant_id) {
      return json(404, { error: "Quote not found for this payment." });
    }

    if (
      tenantIdFromSession &&
      String(quoteRow.tenant_id) !== tenantIdFromSession
    ) {
      return json(403, { error: "Payment session does not match this quote." });
    }

    const gate = assertPublicDepositAllowed(quoteRow);
    if (!gate.ok) {
      return json(403, { error: gate.error });
    }

    const quoteTenantId = quoteRow.tenant_id;

    const paidAt = new Date().toISOString();
    const paidAmount = Number(session.amount_total || 0) / 100;

    const payloadVariants = [
      {
        deposit_paid_amount: paidAmount,
        deposit_paid_at: paidAt,
        stripe_checkout_session_id: session.id,
        stripe_payment_status: "paid"
      },
      {
        deposit_paid_amount: paidAmount,
        deposit_paid_at: paidAt
      },
      {
        deposit_paid_at: paidAt
      }
    ];

    let updateOk = null;
    let lastErrorText = "";

    for (const payload of payloadVariants) {
      const result = await patchQuote({
        supabaseUrl,
        serviceRoleKey,
        publicToken,
        tenantId: quoteTenantId,
        payload
      });

      if (result.ok) {
        updateOk = result;
        break;
      }

      lastErrorText = result.text || `Supabase update failed (${result.status})`;
    }

    if (!updateOk) {
      return json(500, {
        error: lastErrorText || "Stripe payment confirmed, but quote update failed"
      });
    }

    const siteUrl = (
      process.env.URL ||
      process.env.DEPLOY_PRIME_URL ||
      process.env.SITE_URL ||
      ""
    ).replace(/\/+$/, "");

    let tenant = { id: String(quoteTenantId) };
    try {
      const td = await loadTenantDisplayForTenantId(quoteTenantId);
      tenant = { id: String(quoteTenantId), ...td };
    } catch (tenantErr) {
      console.error(
        "[finalize-project-deposit] tenant branding load",
        tenantErr?.message || tenantErr
      );
    }

    const payment = {
      amount: paidAmount,
      currency: String(quoteRow.currency || session.currency || "usd"),
      paidAt,
      stripeCheckoutSessionId: session.id,
      publicToken
    };

    try {
      await runDepositPostAutomation({
        quote: quoteRow,
        tenant,
        payment
      });
    } catch (autoErr) {
      console.error(
        "[finalize-project-deposit] runDepositPostAutomation",
        autoErr?.message || autoErr
      );
    }

    return json(200, {
      ok: true,
      public_token: publicToken,
      paid_amount: paidAmount,
      redirect_url: `${siteUrl}/estimate-public.html?token=${encodeURIComponent(publicToken)}&deposit=paid`
    });
  } catch (err) {
    return json(500, { error: err.message || "Server error" });
  }
};