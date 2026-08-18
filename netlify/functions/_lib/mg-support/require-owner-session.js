/**
 * Owner session gate for Support AI Stage 1.
 * Matches authenticated-app semantics from auth-status.js without loading
 * tenant invoices, quotes, payments, projects, or financial rows.
 *
 * Allowed:
 * - HMAC-valid mg_session with owner email + Stripe customer id (same as
 *   bootstrap-tenant and most owner Netlify functions)
 * - HMAC-valid mg_session for a platform admin (public.users.is_admin),
 *   which auth-status allows even when session.c is missing
 *
 * Not allowed:
 * - no cookie / invalid cookie
 * - seller/supervisor device sessions (mg_device_session is never read)
 * - email-only non-admin cookies
 */
"use strict";

const { supabaseRequest } = require("../supabase-admin");
const { resolveAuthUserIdByEmail } = require("../auth-resolve-user-id");

function hasOwnerEmailAndCustomer(session) {
  const email = String(session?.e || "").trim();
  const customerId = String(session?.c || "").trim();
  return Boolean(email && customerId);
}

async function loadPlatformAdminFlag(session) {
  let sessionUserId = session?.u ? String(session.u).trim() : "";
  const email = String(session?.e || "").trim().toLowerCase();
  if (!sessionUserId && email) {
    try {
      sessionUserId = (await resolveAuthUserIdByEmail(email)) || "";
    } catch (_err) {
      sessionUserId = "";
    }
  }
  if (!sessionUserId) return false;
  try {
    const rows = await supabaseRequest(
      `users?id=eq.${encodeURIComponent(sessionUserId)}&select=id,is_admin`
    );
    const row = Array.isArray(rows) && rows.length ? rows[0] : null;
    return Boolean(row?.is_admin);
  } catch (_err) {
    return false;
  }
}

/**
 * @returns {Promise<{ ok: true } | { ok: false }>}
 */
async function assertOwnerSupportSession(session, deps = {}) {
  if (!session || typeof session !== "object") {
    return { ok: false };
  }
  if (hasOwnerEmailAndCustomer(session)) {
    return { ok: true };
  }
  const adminCheck = deps.isPlatformAdmin || loadPlatformAdminFlag;
  try {
    const isAdmin = await adminCheck(session);
    if (isAdmin) return { ok: true };
  } catch (_err) {
    return { ok: false };
  }
  return { ok: false };
}

module.exports = {
  hasOwnerEmailAndCustomer,
  loadPlatformAdminFlag,
  assertOwnerSupportSession,
};
