const { linkProfileAuthUserOnLogin } = require("./_lib/profile-auth-link");
const { readSessionFromEvent } = require("./_lib/session");
const { supabaseRequest } = require("./_lib/supabase-admin");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");
const { hasOwnerSessionIdentity } = require("./_lib/owner-access");
const {
  membershipIsActive,
  membershipRole,
  resolveMembershipByEmail,
} = require("./_lib/membership-resolve");

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  };
}

function buildResponse(tenant, profile, email) {
  return {
    ok: true,
    tenant_id: tenant.id,
    user_id: profile.id,
    email: profile.email || email,
    tenant: {
      id: tenant.id,
      slug: tenant.slug,
      name: tenant.name,
      owner_email: tenant.owner_email,
      plan_status: tenant.plan_status
    },
    profile: {
      id: profile.id,
      email: profile.email,
      role: profile.role,
      status: profile.status
    }
  };
}

exports.handler = async (event) => {
  try {
    if (!["GET", "POST"].includes(event.httpMethod)) {
      return json(405, { error: "Method not allowed" });
    }

    const session = readSessionFromEvent(event);
    if (!hasOwnerSessionIdentity(session)) {
      return json(401, { error: "Unauthorized" });
    }

    const email = String(session.e || "").trim().toLowerCase();
    const tenant = await resolveTenantFromSession(session);
    if (!tenant?.id) {
      return json(403, {
        error: "No membership found for this account.",
        code: "membership_not_found",
      });
    }

    const profile = await resolveMembershipByEmail(supabaseRequest, tenant.id, email);
    if (!profile?.id) {
      return json(403, {
        error: "No membership found for this account.",
        code: "membership_not_found",
      });
    }

    if (membershipRole(profile) !== "owner" || !membershipIsActive(profile)) {
      return json(403, {
        error: "This membership is not active. Contact your company owner for access.",
        code: "membership_not_active",
      });
    }

    const sessionAuthUserId = session.u ? String(session.u).trim() : "";
    const authLink = await linkProfileAuthUserOnLogin(supabaseRequest, {
      tenantId: tenant.id,
      email,
      sessionAuthUserId,
      profile,
    });
    const linkedProfile = authLink.profile || profile;

    return json(200, {
      ...buildResponse(tenant, linkedProfile, email),
      profileAuthLinked: authLink.profileAuthLinked === true,
      profileAuthLinkStatus: authLink.profileAuthLinkStatus,
    });
  } catch (err) {
    return json(500, { error: err.message || "Bootstrap failed" });
  }
};
