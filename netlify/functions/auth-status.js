const { clearSessionCookie, readSessionFromEvent } = require("./_lib/session");
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

/** Set MG_DEBUG_AUTH=1 in Netlify env to log access-check diagnostics (off by default). */
const AUTH_DEBUG = process.env.MG_DEBUG_AUTH === "1";
function debugAuth(...args) {
  if (AUTH_DEBUG) console.log(...args);
}

/**
 * public.users.id matches auth.users.id — lookup admin by primary key.
 */
async function loadPublicUserAdminFlags(sessionUserId) {
  if (!sessionUserId) {
    return { userId: null, is_admin: false };
  }
  try {
    const rows = await supabaseRequest(
      `users?id=eq.${encodeURIComponent(sessionUserId)}&select=id,is_admin`
    );
    const row = Array.isArray(rows) && rows.length ? rows[0] : null;
    return {
      userId: row?.id ?? null,
      is_admin: Boolean(row?.is_admin),
    };
  } catch (err) {
    if (AUTH_DEBUG) {
      console.warn("[auth-status] public.users lookup by id failed:", err?.message || err);
    }
    return { userId: null, is_admin: false };
  }
}

/**
 * When Stripe subscription id in the cookie is stale/missing or Stripe disagrees with DB,
 * still allow dashboard access if the tenant row says active for this customer + owner email.
 */
async function dbTenantAllowsAccess(stripeCustomerId, ownerEmailNorm) {
  const cid = String(stripeCustomerId || "").trim();
  const em = String(ownerEmailNorm || "").trim().toLowerCase();
  if (!cid || !em) {
    return { ok: false, name: null };
  }
  try {
    const rows = await supabaseRequest(
      `tenants?stripe_customer_id=eq.${encodeURIComponent(
        cid
      )}&select=plan_status,owner_email,name`
    );
    const row = Array.isArray(rows) && rows.length ? rows[0] : null;
    if (!row) {
      return { ok: false, name: null };
    }
    const rowEmail = String(row.owner_email || "").trim().toLowerCase();
    if (rowEmail !== em) {
      return { ok: false, name: null };
    }
    const ps = String(row.plan_status || "").trim().toLowerCase();
    if (ps !== "active") {
      return { ok: false, name: null };
    }
    return { ok: true, name: row.name ? String(row.name) : null };
  } catch (err) {
    if (AUTH_DEBUG) {
      console.warn("[auth-status] tenants lookup failed:", err?.message || err);
    }
    return { ok: false, name: null };
  }
}

exports.handler = async (event) => {
  let userId = null;
  let is_admin = false;

  try {
    const session = readSessionFromEvent(event);
    if (!session) {
      debugAuth("ACCESS CHECK", {
        userId: null,
        subscription_status: null,
        is_admin: false,
        allowAccess: false,
      });
      return json(200, { active: false });
    }

    const email = String(session.e || "").trim().toLowerCase();

    let sessionUserId = session.u ? String(session.u).trim() : "";
    if (!sessionUserId && email) {
      try {
        sessionUserId = (await resolveAuthUserIdByEmail(email)) || "";
      } catch (_err) {
        sessionUserId = "";
      }
    }

    const flags = await loadPublicUserAdminFlags(sessionUserId || null);
    userId = flags.userId;
    is_admin = flags.is_admin;

    debugAuth("ADMIN LOOKUP", {
      sessionUserId: sessionUserId || null,
      is_admin,
      allowAccess: is_admin,
    });

    if (is_admin) {
      debugAuth("ACCESS CHECK", {
        userId,
        subscription_status: null,
        is_admin: true,
        allowAccess: true,
      });
      return json(200, {
        active: true,
        email: session.e || "",
        is_admin: true,
        userId,
        subscription_status: null,
        plan: "Admin",
        renewsAt: null,
      });
    }

    if (!session.c || !email) {
      debugAuth("ACCESS CHECK", {
        userId,
        subscription_status: null,
        is_admin: false,
        allowAccess: false,
      });
      return json(200, { active: false, userId, is_admin: false });
    }

    let subscription = null;
    let subscription_status = null;
    let stripeAccess = false;

    if (session.s) {
      try {
        subscription = await stripeRequest(
          `/subscriptions/${encodeURIComponent(session.s)}`,
          { method: "GET" }
        );
        subscription_status = subscription?.status ?? null;
        stripeAccess = subscriptionIsActive(subscription?.status);
      } catch (stripeErr) {
        debugAuth("STRIPE SUBSCRIPTION LOOKUP FAILED", {
          subscriptionId: session.s,
          message: stripeErr?.message || String(stripeErr),
        });
      }
    }

    if (stripeAccess && subscription) {
      debugAuth("ACCESS CHECK", {
        userId,
        subscription_status,
        is_admin: false,
        allowAccess: true,
      });
      return json(200, {
        active: true,
        email: session.e || "",
        is_admin: false,
        userId,
        subscription_status,
        plan: subscription.items?.data?.[0]?.price?.nickname || "Annual",
        renewsAt: subscription.current_period_end
          ? new Date(subscription.current_period_end * 1000).toISOString()
          : null,
      });
    }

    const dbAccess = await dbTenantAllowsAccess(session.c, email);
    if (dbAccess.ok) {
      debugAuth("ACCESS CHECK", {
        userId,
        subscription_status,
        is_admin: false,
        allowAccess: true,
        source: "tenant_plan_status",
      });
      return json(200, {
        active: true,
        email: session.e || "",
        is_admin: false,
        userId,
        subscription_status,
        plan: "Annual",
        renewsAt: subscription?.current_period_end
          ? new Date(subscription.current_period_end * 1000).toISOString()
          : null,
        tenantName: dbAccess.name || undefined,
      });
    }

    debugAuth("ACCESS CHECK", {
      userId,
      subscription_status,
      is_admin: false,
      allowAccess: false,
    });

    return json(
      200,
      {
        active: false,
        reason: stripeAccess === false && session.s ? "subscription_inactive" : "not_entitled",
        userId,
        is_admin: false,
        subscription_status,
      },
      {
        "Set-Cookie": clearSessionCookie(),
      }
    );
  } catch (err) {
    debugAuth("ACCESS CHECK", {
      userId,
      subscription_status: null,
      is_admin,
      allowAccess: false,
    });
    return json(200, {
      active: false,
      reason: "validation_error",
      error: err.message || "Unexpected error",
    });
  }
};
