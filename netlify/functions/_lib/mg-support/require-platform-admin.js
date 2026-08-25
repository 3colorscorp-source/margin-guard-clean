/**
 * Platform-admin gate for Support Inbox APIs.
 * HMAC-valid mg_session + public.users.is_admin === true.
 * Does not accept tenant owners via session.e + session.c.
 * Does not read mg_device_session.
 */
"use strict";

const { readSessionFromEvent } = require("../session");
const { loadPlatformAdminFlag } = require("./require-owner-session");
const { resolveAuthUserIdByEmail } = require("../auth-resolve-user-id");

function jsonAuthFail() {
  return { ok: false, result: "not_authorized" };
}

/**
 * @returns {Promise<{ ok: true, admin_user_id: string|null } | { ok: false, result: "not_authorized" }>}
 */
async function assertPlatformAdminSession(event, deps = {}) {
  const readSession = deps.readSessionFromEvent || readSessionFromEvent;
  let session = null;
  try {
    session = readSession(event);
  } catch (_err) {
    return jsonAuthFail();
  }
  if (!session || typeof session !== "object") {
    return jsonAuthFail();
  }

  const adminCheck = deps.isPlatformAdmin || loadPlatformAdminFlag;
  let isAdmin = false;
  try {
    isAdmin = await adminCheck(session);
  } catch (_err) {
    return jsonAuthFail();
  }
  if (!isAdmin) {
    return jsonAuthFail();
  }

  let adminUserId = session.u ? String(session.u).trim() : "";
  if (!adminUserId) {
    const email = String(session.e || "").trim().toLowerCase();
    if (email) {
      const resolve = deps.resolveAuthUserIdByEmail || resolveAuthUserIdByEmail;
      try {
        adminUserId = String((await resolve(email)) || "").trim();
      } catch (_err) {
        adminUserId = "";
      }
    }
  }

  return { ok: true, admin_user_id: adminUserId || null };
}

module.exports = {
  assertPlatformAdminSession,
};
