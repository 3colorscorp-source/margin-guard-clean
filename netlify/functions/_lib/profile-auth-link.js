/**
 * Step 3E-C14-C4a — Link profiles.auth_user_id from session on login (non-SQL onboarding).
 * Tenant-scoped; never overwrites an existing non-null auth_user_id.
 */

const { membershipIsActive, membershipRole } = require("./membership-resolve");

const AUTH_LINK_ELIGIBLE_ROLES = new Set(["seller", "supervisor", "owner"]);

const PROFILE_SAFE_SELECT = "id,tenant_id,email,role,status";

function normEmail(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function normId(value) {
  return String(value || "").trim();
}

function toSafeProfileRow(row) {
  if (!row || typeof row !== "object") return row;
  const { auth_user_id: _omit, ...safe } = row;
  return safe;
}

/**
 * @param {Function} supabaseRequest
 * @param {object} params
 * @param {string} params.tenantId
 * @param {string} params.email
 * @param {string} params.sessionAuthUserId - session.u
 * @param {object} params.profile - resolved tenant profile row
 * @returns {Promise<{ profileAuthLinked: boolean, profileAuthLinkStatus: string, profile: object }>}
 */
async function linkProfileAuthUserOnLogin(supabaseRequest, { tenantId, email, sessionAuthUserId, profile }) {
  const tid = normId(tenantId);
  const em = normEmail(email);
  const sessionUid = normId(sessionAuthUserId);
  const current = profile && typeof profile === "object" ? profile : null;

  if (!tid || !em || !sessionUid || !current?.id) {
    return { profileAuthLinked: false, profileAuthLinkStatus: "not_applicable", profile: current };
  }

  if (normId(current.tenant_id) !== tid) {
    return { profileAuthLinked: false, profileAuthLinkStatus: "not_applicable", profile: current };
  }

  if (normEmail(current.email) !== em) {
    return { profileAuthLinked: false, profileAuthLinkStatus: "not_applicable", profile: current };
  }

  if (!membershipIsActive(current)) {
    return { profileAuthLinked: false, profileAuthLinkStatus: "not_applicable", profile: current };
  }

  if (!AUTH_LINK_ELIGIBLE_ROLES.has(membershipRole(current))) {
    return { profileAuthLinked: false, profileAuthLinkStatus: "not_applicable", profile: current };
  }

  const existingAuthUserId = current.auth_user_id ? normId(current.auth_user_id) : "";

  if (existingAuthUserId && existingAuthUserId === sessionUid) {
    return { profileAuthLinked: false, profileAuthLinkStatus: "already_linked", profile: current };
  }

  if (existingAuthUserId && existingAuthUserId !== sessionUid) {
    return { profileAuthLinked: false, profileAuthLinkStatus: "conflict", profile: current };
  }

  const profileId = normId(current.id);
  const patchQuery =
    `profiles?id=eq.${encodeURIComponent(profileId)}` +
    `&tenant_id=eq.${encodeURIComponent(tid)}` +
    `&auth_user_id=is.null`;

  try {
    const patched = await supabaseRequest(patchQuery, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: {
        auth_user_id: sessionUid,
        updated_at: new Date().toISOString(),
      },
    });

    const row = Array.isArray(patched) ? patched[0] : patched;
    if (row?.id) {
      const refreshed = await supabaseRequest(
        `profiles?id=eq.${encodeURIComponent(profileId)}&tenant_id=eq.${encodeURIComponent(tid)}&select=${PROFILE_SAFE_SELECT}&limit=1`
      );
      const safeProfile =
        Array.isArray(refreshed) && refreshed[0] ? refreshed[0] : toSafeProfileRow(row);
      return { profileAuthLinked: true, profileAuthLinkStatus: "linked", profile: safeProfile };
    }
  } catch (_err) {
    // Race or concurrent link — re-read and classify without exposing ids.
    const refreshed = await supabaseRequest(
      `profiles?id=eq.${encodeURIComponent(profileId)}&tenant_id=eq.${encodeURIComponent(tid)}&select=${PROFILE_SAFE_SELECT},auth_user_id&limit=1`
    );
    const row = Array.isArray(refreshed) && refreshed[0] ? refreshed[0] : null;
    if (row?.id) {
      const linkedId = row.auth_user_id ? normId(row.auth_user_id) : "";
      const safeProfile = toSafeProfileRow(row);
      if (linkedId === sessionUid) {
        return { profileAuthLinked: false, profileAuthLinkStatus: "already_linked", profile: safeProfile };
      }
      if (linkedId) {
        return { profileAuthLinked: false, profileAuthLinkStatus: "conflict", profile: safeProfile };
      }
    }
  }

  return { profileAuthLinked: false, profileAuthLinkStatus: "not_applicable", profile: current };
}

module.exports = {
  AUTH_LINK_ELIGIBLE_ROLES,
  linkProfileAuthUserOnLogin,
};
