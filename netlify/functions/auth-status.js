const { clearSessionCookie, readSessionFromEvent } = require("./_lib/session");
const { supabaseRequest } = require("./_lib/supabase-admin");
const { resolveAuthUserIdByEmail } = require("./_lib/auth-resolve-user-id");
const { resolveUniqueActiveOwnerAccess, planIsActive } = require("./_lib/owner-access");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");

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

function createHandler(deps = {}) {
  const readSession = deps.readSessionFromEvent || readSessionFromEvent;
  const resolveTenant = deps.resolveTenantFromSession || resolveTenantFromSession;
  const resolveOwner = deps.resolveUniqueActiveOwnerAccess || resolveUniqueActiveOwnerAccess;
  const loadAdmin = deps.loadPublicUserAdminFlags || loadPublicUserAdminFlags;
  const resolveUserId = deps.resolveAuthUserIdByEmail || resolveAuthUserIdByEmail;

  return async function handler(event) {
    let userId = null;
    let is_admin = false;

    try {
      const session = readSession(event);
      if (!session) {
        debugAuth("ACCESS CHECK", {
          userId: null,
          is_admin: false,
          allowAccess: false,
        });
        return json(200, { active: false, reason: "no_session" });
      }

      const email = String(session.e || "").trim().toLowerCase();

      let sessionUserId = session.u ? String(session.u).trim() : "";
      if (!sessionUserId && email) {
        try {
          sessionUserId = (await resolveUserId(email)) || "";
        } catch (_err) {
          sessionUserId = "";
        }
      }

      const flags = await loadAdmin(sessionUserId || null);
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

      if (!email) {
        debugAuth("ACCESS CHECK", {
          userId,
          is_admin: false,
          allowAccess: false,
        });
        return json(200, {
          active: false,
          reason: "not_entitled",
          userId,
          is_admin: false,
        });
      }

      let tenant = await resolveTenant(session, deps);
      if (!tenant?.id) {
        const ownerAccess = await resolveOwner(email, deps);
        tenant = ownerAccess.ok ? ownerAccess.tenant : null;
      }

      if (!tenant?.id || !planIsActive(tenant)) {
        debugAuth("ACCESS CHECK", {
          userId,
          is_admin: false,
          allowAccess: false,
          source: "tenant_plan_status",
        });
        return json(
          200,
          {
            active: false,
            reason: "not_entitled",
            userId,
            is_admin: false,
            subscription_status: null,
          },
          {
            "Set-Cookie": clearSessionCookie(),
          }
        );
      }

      debugAuth("ACCESS CHECK", {
        userId,
        is_admin: false,
        allowAccess: true,
        source: "tenant_plan_status",
      });
      return json(200, {
        active: true,
        email: session.e || "",
        is_admin: false,
        userId,
        subscription_status: null,
        plan: "Annual",
        renewsAt: null,
        tenantName: tenant.name ? String(tenant.name) : undefined,
        tenant_id: tenant.id,
      });
    } catch (err) {
      debugAuth("ACCESS CHECK", {
        userId,
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
}

exports.handler = createHandler();
exports.createHandler = createHandler;
exports.loadPublicUserAdminFlags = loadPublicUserAdminFlags;
