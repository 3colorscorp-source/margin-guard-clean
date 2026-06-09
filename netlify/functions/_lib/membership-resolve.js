/**
 * Tenant membership (profiles) lookups — read-only, no auto-create.
 * Skeleton — not wired into handlers until Step 3E-C+.
 */

const PROFILE_SELECT =
  "id,tenant_id,email,role,status,auth_user_id,display_name,full_name,created_at,updated_at";

function normEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

function normId(id) {
  return String(id || "").trim();
}

/**
 * @param {Function} supabaseRequest - from ./_lib/supabase-admin
 * @param {string} tenantId
 * @param {string} email
 * @returns {Promise<object|null>}
 */
async function resolveMembershipByEmail(supabaseRequest, tenantId, email) {
  const tid = normId(tenantId);
  const em = normEmail(email);
  if (!tid || !em) return null;

  const rows = await supabaseRequest(
    `profiles?tenant_id=eq.${encodeURIComponent(tid)}&email=eq.${encodeURIComponent(em)}&select=${PROFILE_SELECT}&limit=1`
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

/**
 * @param {Function} supabaseRequest
 * @param {string} tenantId
 * @param {string} authUserId
 * @returns {Promise<object|null>}
 */
async function resolveMembershipByAuthUser(supabaseRequest, tenantId, authUserId) {
  const tid = normId(tenantId);
  const uid = normId(authUserId);
  if (!tid || !uid) return null;

  const rows = await supabaseRequest(
    `profiles?tenant_id=eq.${encodeURIComponent(tid)}&auth_user_id=eq.${encodeURIComponent(uid)}&select=${PROFILE_SELECT}&limit=1`
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

/**
 * @param {Function} supabaseRequest
 * @param {string} tenantId
 * @param {string} membershipId
 * @returns {Promise<object|null>}
 */
async function resolveMembershipById(supabaseRequest, tenantId, membershipId) {
  const tid = normId(tenantId);
  const mid = normId(membershipId);
  if (!tid || !mid) return null;

  const rows = await supabaseRequest(
    `profiles?id=eq.${encodeURIComponent(mid)}&tenant_id=eq.${encodeURIComponent(tid)}&select=${PROFILE_SELECT}&limit=1`
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

function membershipIsActive(membership) {
  return String(membership?.status || "")
    .trim()
    .toLowerCase() === "active";
}

function membershipRole(membership) {
  return String(membership?.role || "")
    .trim()
    .toLowerCase();
}

module.exports = {
  PROFILE_SELECT,
  membershipIsActive,
  membershipRole,
  resolveMembershipByAuthUser,
  resolveMembershipByEmail,
  resolveMembershipById,
};
