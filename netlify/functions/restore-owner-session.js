const { buildSessionPayload, createSessionCookie } = require("./_lib/session");
const { stripeRequest } = require("./_lib/stripe");
const { supabaseRequest } = require("./_lib/supabase-admin");
const { resolveAuthUserIdByEmail } = require("./_lib/auth-resolve-user-id");

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
    if (event.httpMethod !== "POST") {
      return json(405, { error: "Method not allowed" });
    }

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch (_err) {
      return json(400, { error: "Invalid JSON" });
    }

    const rawEmail = String(body.email || "").trim();
    const emailNorm = rawEmail.toLowerCase();
    if (!emailNorm || !emailNorm.includes("@")) {
      return json(400, { error: "Valid email is required" });
    }

    const rows = await supabaseRequest(
      `tenants?owner_email=eq.${encodeURIComponent(emailNorm)}&select=id,plan_status,stripe_customer_id,owner_email`
    );
    const tenant = Array.isArray(rows) && rows.length ? rows[0] : null;
    if (!tenant?.id) {
      return json(404, { error: "No tenant found for this email" });
    }

    const ps = String(tenant.plan_status || "").trim().toLowerCase();
    if (ps !== "active") {
      return json(403, { error: "Plan is not active for this tenant" });
    }

    const customerId = String(tenant.stripe_customer_id || "").trim();
    if (!customerId) {
      return json(409, { error: "Tenant has no Stripe customer id; complete checkout first" });
    }

    let pickedSubId;
    try {
      const list = await stripeRequest(
        `/subscriptions?customer=${encodeURIComponent(customerId)}&status=all&limit=10`,
        { method: "GET" }
      );
      const data = Array.isArray(list?.data) ? list.data : [];
      const pick = data.find((sub) => subscriptionIsActive(sub?.status));
      if (pick?.id) {
        pickedSubId = String(pick.id);
      }
    } catch (_stripeErr) {
      /* Session can still work with c+e only; auth-status uses tenants.plan_status fallback. */
    }

    let authUserId = null;
    try {
      authUserId = await resolveAuthUserIdByEmail(emailNorm);
    } catch (_err) {
      authUserId = null;
    }

    const payload = buildSessionPayload({
      customerId,
      subscriptionId: pickedSubId,
      email: rawEmail,
      userId: authUserId,
    });

    const cookie = createSessionCookie(payload);

    return json(
      200,
      { ok: true, email: payload.e },
      { "Set-Cookie": cookie }
    );
  } catch (err) {
    return json(500, { error: err.message || "Unexpected error" });
  }
};
