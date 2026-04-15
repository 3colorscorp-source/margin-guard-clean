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

function pickSiteUrl() {
  return (
    process.env.URL ||
    process.env.DEPLOY_PRIME_URL ||
    process.env.SITE_URL ||
    ""
  ).replace(/\/+$/, "");
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
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

    const siteUrl = pickSiteUrl();
    if (!siteUrl) {
      return json(500, { error: "Missing site URL environment" });
    }

    const country = String(process.env.STRIPE_CONNECT_DEFAULT_COUNTRY || "US").trim() || "US";
    const ownerEmail = String(tenant.owner_email || session.e || "").trim();

    let accountId = String(tenant.stripe_account_id || "").trim();

    if (!accountId) {
      const accForm = new URLSearchParams();
      accForm.set("type", "express");
      accForm.set("country", country);
      if (ownerEmail && ownerEmail.includes("@")) {
        accForm.set("email", ownerEmail);
      }
      accForm.set("metadata[tenant_id]", String(tenant.id));
      accForm.set("capabilities[card_payments][requested]", "true");
      accForm.set("capabilities[transfers][requested]", "true");

      const accRes = await fetch("https://api.stripe.com/v1/accounts", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${stripeSecretKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: accForm.toString(),
      });

      const accText = await accRes.text();
      let accData = {};
      try {
        accData = accText ? JSON.parse(accText) : {};
      } catch {
        accData = {};
      }

      if (!accRes.ok) {
        return json(502, {
          error: accData?.error?.message || accText || "Stripe Connect account creation failed",
        });
      }

      accountId = String(accData.id || "").trim();
      if (!accountId) {
        return json(502, { error: "Stripe did not return a Connect account id." });
      }

      await supabaseRequest(`tenants?id=eq.${encodeURIComponent(tenant.id)}`, {
        method: "PATCH",
        body: {
          stripe_account_id: accountId,
          stripe_charges_enabled: Boolean(accData.charges_enabled),
          stripe_details_submitted: Boolean(accData.details_submitted),
        },
      });
    }

    const refreshUrl = `${siteUrl}/business-settings?stripe_deposit=refresh`;
    const returnUrl = `${siteUrl}/business-settings?stripe_deposit=return`;

    const linkForm = new URLSearchParams();
    linkForm.set("account", accountId);
    linkForm.set("refresh_url", refreshUrl);
    linkForm.set("return_url", returnUrl);
    linkForm.set("type", "account_onboarding");

    const linkRes = await fetch("https://api.stripe.com/v1/account_links", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${stripeSecretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: linkForm.toString(),
    });

    const linkText = await linkRes.text();
    let linkData = {};
    try {
      linkData = linkText ? JSON.parse(linkText) : {};
    } catch {
      linkData = {};
    }

    if (!linkRes.ok) {
      return json(502, {
        error: linkData?.error?.message || linkText || "Stripe Account Link creation failed",
      });
    }

    const url = linkData.url;
    if (!url) {
      return json(502, { error: "Stripe did not return an onboarding URL." });
    }

    return json(200, {
      ok: true,
      url,
      stripe_account_id: accountId,
    });
  } catch (err) {
    return json(500, { error: err.message || "Server error" });
  }
};
