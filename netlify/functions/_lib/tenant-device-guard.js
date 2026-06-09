/**
 * Tenant + device portal guards (skeleton).
 * Not imported by live handlers until Step 3E-C+ wiring approval.
 * @see DEVICE_BOUND_PORTAL_GUARD_SPEC.md
 */

const { readSessionFromEvent } = require("./session");
const { resolveTenantFromSession } = require("./tenant-for-session");
const { supabaseRequest } = require("./supabase-admin");
const { hashSessionToken, readDeviceSessionFromEvent } = require("./device-session");
const {
  membershipIsActive,
  membershipRole,
  resolveMembershipByEmail,
  resolveMembershipById,
} = require("./membership-resolve");

const OWNER_ROLES = new Set(["owner"]);
const PORTAL_ROLES = {
  seller: "seller",
  supervisor: "supervisor",
};

/**
 * @param {number} statusCode
 * @param {string} message
 * @param {string} [code]
 */
function guardError(statusCode, message, code) {
  const err = new Error(String(message || "Forbidden"));
  err.statusCode = Number(statusCode) || 403;
  err.code = code || "guard_error";
  err.isGuardError = true;
  return err;
}

function throwGuard(statusCode, message, code) {
  throw guardError(statusCode, message, code);
}

function normPortal(portalType) {
  return String(portalType || "")
    .trim()
    .toLowerCase();
}

function isOwnerRole(role) {
  return OWNER_ROLES.has(membershipRole({ role }));
}

/**
 * @typedef {object} GuardContext
 * @property {'owner'|'device'} authMode
 * @property {object|null} session
 * @property {object|null} tenant
 * @property {object|null} membership
 * @property {object|null} device
 * @property {object|null} deviceSession
 * @property {string|null} portalType
 */

/**
 * Owner mg_session + active owner membership.
 * @param {object} event
 * @returns {Promise<GuardContext>}
 */
async function requireOwnerMembership(event) {
  const session = readSessionFromEvent(event);
  if (!session?.e || !session?.c) {
    throwGuard(401, "Unauthorized", "no_owner_session");
  }

  const tenant = await resolveTenantFromSession(session);
  if (!tenant?.id) {
    throwGuard(404, "Tenant not found", "tenant_not_found");
  }

  const membership = await resolveMembershipByEmail(supabaseRequest, tenant.id, session.e);
  if (!membership?.id) {
    throwGuard(403, "Membership not found", "membership_not_found");
  }
  if (!membershipIsActive(membership)) {
    throwGuard(403, "Membership is not active", "membership_inactive");
  }
  if (!isOwnerRole(membershipRole(membership))) {
    throwGuard(403, "Owner membership required", "owner_required");
  }

  return {
    authMode: "owner",
    session,
    tenant,
    membership,
    device: null,
    deviceSession: null,
    portalType: null,
  };
}

/**
 * Validate mg_device_session against device_sessions + tenant_devices + profiles.
 * @param {object} event
 * @returns {Promise<GuardContext>}
 */
async function resolveDeviceSession(event) {
  const cookiePayload = readDeviceSessionFromEvent(event);
  if (!cookiePayload) {
    throwGuard(401, "Device session required", "no_device_session");
  }

  const cookies = event?.headers?.cookie || event?.headers?.Cookie || "";
  const tokenMatch = /(?:^|;\s*)mg_device_session=([^;]+)/.exec(cookies);
  const rawToken = tokenMatch ? decodeURIComponent(tokenMatch[1]) : "";
  if (!rawToken) {
    throwGuard(401, "Device session required", "no_device_token");
  }

  const tokenHash = hashSessionToken(rawToken);
  const sessionRows = await supabaseRequest(
    `device_sessions?session_token_hash=eq.${encodeURIComponent(tokenHash)}&status=eq.active&select=*&limit=1`
  );
  const deviceSession = Array.isArray(sessionRows) ? sessionRows[0] : null;
  if (!deviceSession?.id) {
    throwGuard(401, "Invalid or revoked device session", "device_session_invalid");
  }

  const expiresAt = deviceSession.expires_at ? Date.parse(deviceSession.expires_at) : NaN;
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throwGuard(401, "Device session expired", "device_session_expired");
  }

  const tenantId = String(deviceSession.tenant_id || cookiePayload.t || "").trim();
  if (!tenantId) {
    throwGuard(401, "Device session tenant missing", "device_session_tenant_missing");
  }

  if (cookiePayload.t && String(cookiePayload.t) !== tenantId) {
    throwGuard(403, "Device session tenant mismatch", "device_session_tenant_mismatch");
  }

  const deviceRows = await supabaseRequest(
    `tenant_devices?id=eq.${encodeURIComponent(deviceSession.device_id)}&select=*&limit=1`
  );
  const device = Array.isArray(deviceRows) ? deviceRows[0] : null;
  if (!device?.id) {
    throwGuard(403, "Device not found", "device_not_found");
  }
  if (String(device.status || "").trim().toLowerCase() !== "active") {
    throwGuard(403, "Device is not active", "device_not_active");
  }
  if (String(device.tenant_id) !== tenantId) {
    throwGuard(403, "Device tenant mismatch", "device_tenant_mismatch");
  }

  const membership = await resolveMembershipById(
    supabaseRequest,
    tenantId,
    deviceSession.membership_id
  );
  if (!membership?.id) {
    throwGuard(403, "Membership not found", "membership_not_found");
  }
  if (!membershipIsActive(membership)) {
    throwGuard(403, "Membership is not active", "membership_inactive");
  }

  const portalType = normPortal(device.portal_type || deviceSession.portal_type || cookiePayload.p);
  const role = membershipRole(membership);

  if (portalType === PORTAL_ROLES.seller && role !== PORTAL_ROLES.seller) {
    throwGuard(403, "Seller membership required for this device", "seller_role_required");
  }
  if (portalType === PORTAL_ROLES.supervisor && role !== PORTAL_ROLES.supervisor) {
    throwGuard(403, "Supervisor membership required for this device", "supervisor_role_required");
  }
  if (portalType && device.portal_type && normPortal(device.portal_type) !== portalType) {
    throwGuard(403, "Device portal type mismatch", "portal_type_mismatch");
  }

  const tenantRows = await supabaseRequest(
    `tenants?id=eq.${encodeURIComponent(tenantId)}&select=id,slug,name,owner_email,plan_status&limit=1`
  );
  const tenant = Array.isArray(tenantRows) ? tenantRows[0] : null;
  if (!tenant?.id) {
    throwGuard(404, "Tenant not found", "tenant_not_found");
  }

  return {
    authMode: "device",
    session: cookiePayload,
    tenant,
    membership,
    device,
    deviceSession,
    portalType: portalType || null,
  };
}

/**
 * @param {object} event
 * @param {{ portals?: string[] }} [opts]
 * @returns {Promise<GuardContext>}
 */
async function requireDeviceSession(event, opts = {}) {
  const ctx = await resolveDeviceSession(event);
  const allowed = Array.isArray(opts.portals) ? opts.portals.map(normPortal) : null;
  if (allowed && allowed.length) {
    assertPortalType(ctx, allowed);
  }
  return ctx;
}

async function requireSellerDevice(event) {
  return requireDeviceSession(event, { portals: [PORTAL_ROLES.seller] });
}

async function requireSupervisorDevice(event) {
  return requireDeviceSession(event, { portals: [PORTAL_ROLES.supervisor] });
}

/**
 * @param {GuardContext} ctx
 * @param {string|string[]} portalType
 */
function assertPortalType(ctx, portalType) {
  const expected = Array.isArray(portalType)
    ? portalType.map(normPortal)
    : [normPortal(portalType)];
  const actual = normPortal(ctx?.portalType);
  if (!actual || !expected.includes(actual)) {
    throwGuard(403, "Portal type not allowed", "portal_type_forbidden");
  }
}

function assertSameTenant(expectedTenantId, rowTenantId) {
  const a = String(expectedTenantId || "").trim();
  const b = String(rowTenantId || "").trim();
  if (!a || !b || a !== b) {
    throwGuard(403, "Tenant scope violation", "tenant_mismatch");
  }
}

/**
 * @param {GuardContext} ctx
 * @param {object} project - tenant_projects row
 */
function assertAssignedSupervisorProject(ctx, project) {
  if (!project || typeof project !== "object") {
    throwGuard(404, "Project not found", "project_not_found");
  }
  assertSameTenant(ctx?.tenant?.id, project.tenant_id);

  if (ctx?.authMode === "owner" || isOwnerRole(ctx?.membership?.role)) {
    return;
  }

  const authUserId = String(ctx?.membership?.auth_user_id || "").trim();
  const assigned = String(project.supervisor_user_id || "").trim();
  if (!authUserId || !assigned || authUserId !== assigned) {
    throwGuard(403, "Supervisor is not assigned to this project", "supervisor_not_assigned");
  }
}

/**
 * @param {GuardContext} ctx
 * @param {object} quote - quotes row
 */
function assertSellerOwnQuote(ctx, quote) {
  if (!quote || typeof quote !== "object") {
    throwGuard(404, "Quote not found", "quote_not_found");
  }
  assertSameTenant(ctx?.tenant?.id, quote.tenant_id);

  if (ctx?.authMode === "owner" || isOwnerRole(ctx?.membership?.role)) {
    return;
  }

  const membershipId = String(ctx?.membership?.id || "").trim();
  const sellerMembershipId = String(quote.seller_membership_id || "").trim();
  if (!membershipId || !sellerMembershipId || membershipId !== sellerMembershipId) {
    throwGuard(403, "Quote not accessible for this seller", "seller_quote_forbidden");
  }
}

module.exports = {
  OWNER_ROLES,
  PORTAL_ROLES,
  assertAssignedSupervisorProject,
  assertPortalType,
  assertSameTenant,
  assertSellerOwnQuote,
  guardError,
  requireDeviceSession,
  requireOwnerMembership,
  requireSellerDevice,
  requireSupervisorDevice,
  resolveDeviceSession,
  throwGuard,
};
