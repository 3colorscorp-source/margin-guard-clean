/**
 * Step 3E-C14-E2G-B — Link active supervisor membership from verified Supabase JWT.
 * No mg_session, owner session, or device session required.
 */

const { getSupabaseConfig, supabaseRequest } = require("./_lib/supabase-admin");
const { linkProfileAuthUserOnLogin } = require("./_lib/profile-auth-link");
const { membershipIsActive, membershipRole } = require("./_lib/membership-resolve");

const LOG_PREFIX = "[link-membership-auth]";
const PROFILE_SELECT = "id,tenant_id,email,role,status,auth_user_id";

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  };
}

function fail(statusCode, error) {
  return json(statusCode, { ok: false, error });
}

function success(status) {
  return json(200, { ok: true, status });
}

function safeLog(event, detail) {
  console.info(LOG_PREFIX, event, detail);
}

function readBearerToken(event) {
  const header = String(event.headers?.authorization || event.headers?.Authorization || "").trim();
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : "";
}

async function verifySupabaseAccessToken(accessToken) {
  const token = String(accessToken || "").trim();
  if (!token) {
    return { ok: false };
  }

  const { url, key } = getSupabaseConfig();
  let response;
  try {
    response = await fetch(`${url}/auth/v1/user`, {
      method: "GET",
      headers: {
        apikey: key,
        Authorization: `Bearer ${token}`,
      },
    });
  } catch (_err) {
    return { ok: false };
  }

  let data = {};
  try {
    data = await response.json();
  } catch (_err) {
    data = {};
  }

  if (!response.ok) {
    return { ok: false };
  }

  const email = String(data.email || "")
    .trim()
    .toLowerCase();
  const userId = String(data.id || "").trim();
  if (!email || !userId) {
    return { ok: false };
  }

  return { ok: true, email, userId };
}

async function findActiveSupervisorProfiles(email) {
  const em = encodeURIComponent(email);
  const rows = await supabaseRequest(
    `profiles?email=eq.${em}&role=eq.supervisor&status=eq.active&select=${PROFILE_SELECT}`
  );
  return Array.isArray(rows) ? rows : [];
}

function mapLinkStatus(linkStatus) {
  const status = String(linkStatus || "").trim();
  if (status === "linked") return success("linked");
  if (status === "already_linked") return success("already_linked");
  if (status === "conflict") return fail(409, "conflict");
  if (status === "not_applicable") return fail(404, "membership_not_found");
  return fail(502, "link_failed");
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return fail(405, "method_not_allowed");
    }

    const accessToken = readBearerToken(event);
    if (!accessToken) {
      safeLog("invalid_token", { reason: "missing_bearer" });
      return fail(401, "invalid_token");
    }

    const verified = await verifySupabaseAccessToken(accessToken);
    if (!verified.ok) {
      safeLog("invalid_token", { reason: "verify_failed" });
      return fail(401, "invalid_token");
    }

    const profiles = await findActiveSupervisorProfiles(verified.email);
    if (!profiles.length) {
      safeLog("membership_not_found", { role: "supervisor" });
      return fail(404, "membership_not_found");
    }
    if (profiles.length > 1) {
      safeLog("ambiguous_membership", { count: profiles.length });
      return fail(409, "ambiguous_membership");
    }

    const profile = profiles[0];
    const role = membershipRole(profile);
    if (role !== "supervisor") {
      safeLog("not_supervisor_membership", { role });
      return fail(403, "not_supervisor_membership");
    }
    if (!membershipIsActive(profile)) {
      safeLog("membership_not_active", { role, status: profile.status || "" });
      return fail(403, "membership_not_active");
    }

    const linkResult = await linkProfileAuthUserOnLogin(supabaseRequest, {
      tenantId: profile.tenant_id,
      email: verified.email,
      sessionAuthUserId: verified.userId,
      profile,
    });

    const mapped = mapLinkStatus(linkResult.profileAuthLinkStatus);
    safeLog("link_result", {
      status: linkResult.profileAuthLinkStatus || "unknown",
      ok: linkResult.profileAuthLinked === true,
    });
    return mapped;
  } catch (_err) {
    safeLog("link_failed", { code: "link_failed" });
    return fail(500, "link_failed");
  }
};
