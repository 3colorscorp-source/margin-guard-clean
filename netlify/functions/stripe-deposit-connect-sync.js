const fetch = globalThis.fetch;
if (!fetch) {
  throw new Error("Global fetch is not available in this runtime.");
}

const { readSessionFromEvent } = require("./_lib/session");
const { supabaseRequest } = require("./_lib/supabase-admin");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function fetchStripeAccount(stripeSecretKey, accountId) {
  const res = await fetch(`https://api.stripe.com/v1/accounts/${encodeURIComponent(accountId)}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${stripeSecretKey}`,
    },
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }
  return { ok: res.ok, data, text };
}

exports.handler = async (event) => {
  try {
    const method = event.httpMethod || "GET";
    if (!["GET", "POST"].includes(method)) {
      return json(405, { error: "Method not allowed" });
    }

    const session = readSessionFromEvent(event);
    if (!session?.e || !session?.c) {
      return json(401, { error: "Unauthorized" });
    }

    const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeSecretKey) {
      return json(500, { error: "Missing STRIPE_SECRET_KEY" });
    }

    const tenant = await resolveTenantFromSession(session);
    if (!tenant?.id) {
      return json(404, { error: "Tenant not found. Run bootstrap first." });
    }

    const accountId = String(tenant.stripe_account_id || "").trim();

    const qs = event.queryStringParameters || {};
    let bodyIn = {};
    if (method === "POST") {
      try {
        bodyIn = JSON.parse(event.body || "{}");
      } catch {
        bodyIn = {};
      }
    }
    const refresh =
      qs.refresh === "1" ||
      qs.sync === "1" ||
      bodyIn.refresh === true ||
      bodyIn.sync === true;

    let charges_enabled = Boolean(tenant.stripe_charges_enabled);
    let details_submitted = Boolean(tenant.stripe_details_submitted);

    if (accountId && refresh) {
      const { ok, data } = await fetchStripeAccount(stripeSecretKey, accountId);
      if (!ok) {
        return json(502, {
          error: data?.error?.message || "Unable to load Stripe Connect account",
        });
      }
      charges_enabled = Boolean(data.charges_enabled);
      details_submitted = Boolean(data.details_submitted);

      await supabaseRequest(`tenants?id=eq.${encodeURIComponent(tenant.id)}`, {
        method: "PATCH",
        body: {
          stripe_charges_enabled: charges_enabled,
          stripe_details_submitted: details_submitted,
        },
      });
    }

    const connected = Boolean(accountId && charges_enabled);

    return json(200, {
      ok: true,
      stripe_account_id: accountId || null,
      stripe_charges_enabled: charges_enabled,
      stripe_details_submitted: details_submitted,
      connected,
    });
  } catch (err) {
    return json(500, { error: err.message || "Server error" });
  }
};
