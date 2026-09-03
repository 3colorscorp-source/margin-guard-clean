/**
 * Mint owner mg_session after verified Supabase Auth JWT.
 * Email-only body authentication is rejected. Stripe is not consulted.
 */
const { buildSessionPayload, createSessionCookie } = require("./_lib/session");
const { linkProfileAuthUserOnLogin } = require("./_lib/profile-auth-link");
const { supabaseRequest } = require("./_lib/supabase-admin");
const { readBearerToken, verifySupabaseAccessToken } = require("./_lib/supabase-jwt");
const {
  AUTH_FAILED,
  resolveUniqueActiveOwnerAccess,
} = require("./_lib/owner-access");

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

function authFail() {
  return json(401, { ok: false, error: AUTH_FAILED });
}

function createHandler(deps = {}) {
  const verifyToken = deps.verifySupabaseAccessToken || verifySupabaseAccessToken;
  const resolveOwner = deps.resolveUniqueActiveOwnerAccess || resolveUniqueActiveOwnerAccess;
  const requestFn = deps.supabaseRequest || supabaseRequest;
  const linkAuth = deps.linkProfileAuthUserOnLogin || linkProfileAuthUserOnLogin;
  const signCookie = deps.createSessionCookie || createSessionCookie;
  const buildPayload = deps.buildSessionPayload || buildSessionPayload;

  return async function handler(event) {
    try {
      if (event.httpMethod !== "POST") {
        return json(405, { ok: false, error: "method_not_allowed" });
      }

      const accessToken = readBearerToken(event);
      if (!accessToken) {
        return authFail();
      }

      const verified = await verifyToken(accessToken, deps);
      if (!verified || !verified.ok) {
        return authFail();
      }

      const access = await resolveOwner(verified.email, { ...deps, supabaseRequest: requestFn });
      if (!access || !access.ok) {
        return authFail();
      }

      const { tenant, profile } = access;
      const tenantId = String(tenant.id);

      try {
        await linkAuth(requestFn, {
          tenantId,
          email: verified.email,
          sessionAuthUserId: verified.userId,
          profile,
        });
      } catch (_err) {
        /* Linking is best-effort; membership already proved access. */
      }

      const payload = buildPayload({
        tenantId,
        email: verified.email,
        userId: verified.userId,
        customerId: "",
        subscriptionId: "",
      });

      const cookie = signCookie(payload);
      return json(
        200,
        {
          ok: true,
          email: payload.e,
          tenant_id: tenantId,
        },
        {
          "Set-Cookie": cookie,
        }
      );
    } catch (_err) {
      return authFail();
    }
  };
}

exports.handler = createHandler();
exports.createHandler = createHandler;
