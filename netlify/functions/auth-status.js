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
    console.warn("[auth-status] public.users lookup by id failed:", err?.message || err);
    return { userId: null, is_admin: false };
  }
}

exports.handler = async (event) => {
  let userId = null;
  let is_admin = false;

  try {
    const session = readSessionFromEvent(event);
    if (!session) {
      console.log("ACCESS CHECK", {
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

    console.log("ADMIN LOOKUP", {
      sessionUserId: sessionUserId || null,
      is_admin,
      allowAccess: is_admin,
    });

    if (is_admin) {
      console.log("ACCESS CHECK", {
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

    if (!session.s || !session.c) {
      console.log("ACCESS CHECK", {
        userId,
        subscription_status: null,
        is_admin: false,
        allowAccess: false,
      });
      return json(200, { active: false, userId, is_admin: false });
    }

    const subscription = await stripeRequest(`/subscriptions/${encodeURIComponent(session.s)}`, {
      method: "GET",
    });

    const subscription_status = subscription?.status ?? null;
    const allowAccess = subscriptionIsActive(subscription.status);

    console.log("ACCESS CHECK", {
      userId,
      subscription_status,
      is_admin: false,
      allowAccess,
    });

    if (!allowAccess) {
      return json(
        200,
        {
          active: false,
          reason: "subscription_inactive",
          userId,
          is_admin: false,
          subscription_status,
        },
        {
          "Set-Cookie": clearSessionCookie(),
        }
      );
    }

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
  } catch (err) {
    console.log("ACCESS CHECK", {
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
