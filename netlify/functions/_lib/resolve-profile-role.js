/**
 * Resolve profiles.role for the signed-in session within a tenant (server-side only).
 */

const { supabaseRequest } = require("./supabase-admin");

const FINANCIAL_ROLES = new Set(["owner"]);

function normRole(role) {
  return String(role || "")
    .trim()
    .toLowerCase();
}

/**
 * @param {object} session - from readSessionFromEvent
 * @param {string} tenantId - uuid
 * @returns {Promise<string|null>} normalized role or null if profile missing
 */
async function resolveProfileRoleForSession(session, tenantId) {
  const email = String(session?.e || "")
    .trim()
    .toLowerCase();
  const tid = String(tenantId || "").trim();
  if (!email || !tid) return null;

  const rows = await supabaseRequest(
    `profiles?tenant_id=eq.${encodeURIComponent(tid)}&email=eq.${encodeURIComponent(email)}&select=role&limit=1`
  );
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) return null;
  return normRole(row.role);
}

function roleMayAccessFinancialSnapshot(role) {
  return FINANCIAL_ROLES.has(normRole(role));
}

module.exports = {
  resolveProfileRoleForSession,
  roleMayAccessFinancialSnapshot,
  normRole,
  FINANCIAL_ROLES,
};
