/**
 * Pure attribution field builders for M4 columns (nullable writes).
 * Skeleton — not wired into handlers until Step 3E-D+.
 */

function pickDeviceId(ctx) {
  return ctx?.device?.id ?? ctx?.deviceSession?.device_id ?? null;
}

function pickMembershipId(ctx) {
  return ctx?.membership?.id ?? null;
}

function pickAuthUserId(ctx) {
  return ctx?.membership?.auth_user_id ?? ctx?.session?.u ?? null;
}

function pickEmail(ctx) {
  return ctx?.membership?.email ?? ctx?.session?.e ?? null;
}

/**
 * Owner mg_session writes (no device).
 */
function buildOwnerAttribution(ctx) {
  return {
    seller_membership_id: pickMembershipId(ctx),
    seller_user_id: pickAuthUserId(ctx),
    seller_email: pickEmail(ctx),
    source_device_id: null,
    created_by_role: "owner",
    supervisor_membership_id: pickMembershipId(ctx),
  };
}

/**
 * Seller device session writes (quotes, projects).
 */
function buildSellerAttribution(ctx) {
  return {
    seller_membership_id: pickMembershipId(ctx),
    seller_user_id: pickAuthUserId(ctx),
    seller_email: pickEmail(ctx),
    source_device_id: pickDeviceId(ctx),
    created_by_role: "seller",
  };
}

/**
 * Supervisor device session writes (progress, reports, expenses).
 */
function buildSupervisorAttribution(ctx) {
  return {
    supervisor_membership_id: pickMembershipId(ctx),
    source_device_id: pickDeviceId(ctx),
  };
}

module.exports = {
  buildOwnerAttribution,
  buildSellerAttribution,
  buildSupervisorAttribution,
};
