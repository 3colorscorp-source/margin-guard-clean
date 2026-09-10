/**
 * Owner/Admin session gate.
 * Modern identity: email + tenant. Legacy email + session.c remains valid.
 * Seller/supervisor device cookies are not owner identity.
 */
"use strict";

const { readSessionFromEvent } = require("./session");
const { resolveTenantFromSession } = require("./tenant-for-session");
const { hasOwnerSessionIdentity } = require("./owner-access");
const {
  membershipRole,
  membershipIsActive,
  resolveMembershipByEmail,
} = require("./membership-resolve");
const { throwGuard } = require("./tenant-device-guard");
const { supabaseRequest } = require("./supabase-admin");

const OWNER_ADMIN_ROLES = new Set(["owner", "admin"]);

async function requireOwnerOrAdmin(event) {
  const session = readSessionFromEvent(event);
  if (!hasOwnerSessionIdentity(session)) {
    throwGuard(401, "Unauthorized", "no_session");
  }

  const tenant = await resolveTenantFromSession(session);
  if (!tenant?.id) {
    throwGuard(422, "Tenant not found for this session.", "tenant_not_found");
  }

  const membership = await resolveMembershipByEmail(supabaseRequest, tenant.id, session.e);
  if (!membership?.id) {
    throwGuard(403, "Membership not found", "membership_not_found");
  }
  if (!membershipIsActive(membership)) {
    throwGuard(403, "Membership is not active", "membership_inactive");
  }
  const role = membershipRole(membership);
  if (!OWNER_ADMIN_ROLES.has(role)) {
    throwGuard(403, "Owner or admin membership required", "owner_required");
  }

  return { tenant, membership, session };
}

module.exports = {
  OWNER_ADMIN_ROLES,
  requireOwnerOrAdmin,
};
