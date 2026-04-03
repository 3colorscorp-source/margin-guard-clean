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

function parseBody(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

async function patchQuote({ supabaseUrl, serviceRoleKey, publicToken, payload }) {
  const response = await fetch(
    `${supabaseUrl}/rest/v1/quotes?public_token=eq.${encodeURIComponent(publicToken)}`,
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