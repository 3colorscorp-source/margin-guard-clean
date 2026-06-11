/**
 * Step 3E-C14-E2B — Owner-only: send Supabase Auth invite for an active supervisor membership.
 * Input: membership_id only (tenant-scoped). No client email or redirect override.
 */

const { resolveAuthUserIdByEmailDetailed } = require("./_lib/auth-resolve-user-id");
const {
  membershipIsActive,
  membershipRole,
  resolveMembershipById,
} = require("./_lib/membership-resolve");
const {
  inviteAuthUserByEmail,
  isValidInviteEmail,
  normEmail,
} = require("./_lib/supervisor-auth-invite");
const { supabaseRequest } = require("./_lib/supabase-admin");
const { requireOwnerMembership } = require("./_lib/tenant-device-guard");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const LOG_PREFIX = "[invite-supervisor-auth]";

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  };
}

function parseBody(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return null;
  }
}

function fail(statusCode, code) {
  return json(statusCode, { ok: false, error: code });
}

function success(status, message) {
  const payload = { ok: true, status };
  if (message) {
    payload.message = message;
  }
  return json(200, payload);
}

function safeLog(event, detail) {
  console.info(LOG_PREFIX, event, detail);
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return fail(405, "method_not_allowed");
    }

    const ctx = await requireOwnerMembership(event);
    const body = parseBody(event.body);
    if (body == null) {
      return fail(400, "invalid_json");
    }

    const membershipId = String(body.membership_id || body.membershipId || "").trim();
    if (!membershipId) {
      return fail(400, "missing_membership_id");
    }
    if (!UUID_RE.test(membershipId)) {
      return fail(400, "missing_membership_id");
    }

    const membership = await resolveMembershipById(
      supabaseRequest,
      ctx.tenant.id,
      membershipId
    );
    if (!membership?.id) {
      safeLog("membership_not_found", { role: null, status: null });
      return fail(404, "membership_not_found");
    }

    const role = membershipRole(membership);
    const status = String(membership.status || "")
      .trim()
      .toLowerCase();

    if (role !== "supervisor") {
      safeLog("not_supervisor_membership", { role, status });
      return fail(403, "not_supervisor_membership");
    }
    if (!membershipIsActive(membership)) {
      safeLog("membership_not_active", { role, status });
      return fail(403, "membership_not_active");
    }

    const email = normEmail(membership.email);
    if (!isValidInviteEmail(email)) {
      safeLog("membership_email_missing", { role, status });
      return fail(400, "membership_email_missing");
    }

    const linkedAuthUserId = String(membership.auth_user_id || "").trim();
    if (linkedAuthUserId) {
      safeLog("already_linked", { role, status });
      return success("already_linked");
    }

    const authLookup = await resolveAuthUserIdByEmailDetailed(email);
    if (authLookup.status === "resolve_failed") {
      safeLog("auth_lookup_failed", { role, status });
      return fail(502, "auth_lookup_failed");
    }
    if (authLookup.status === "found") {
      safeLog("auth_user_exists_link_pending", { role, status });
      return success(
        "auth_user_exists_link_pending",
        "A login account exists for this supervisor. They must sign in once to complete linking."
      );
    }

    const inviteResult = await inviteAuthUserByEmail(email);
    if (!inviteResult.ok) {
      safeLog("invite_failed", { role, status });
      return fail(502, inviteResult.code || "invite_failed");
    }

    safeLog("invite_sent", { role, status });
    return success("invite_sent");
  } catch (err) {
    if (err.isGuardError) {
      const code = String(err.code || "unauthorized").trim() || "unauthorized";
      safeLog("guard_rejected", { code });
      return fail(err.statusCode || 403, code);
    }
    safeLog("unexpected_error", { code: "invite_failed" });
    return fail(500, "invite_failed");
  }
};
