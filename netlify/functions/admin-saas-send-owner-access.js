/**
 * Platform-admin: send owner Auth invite/recovery after Square activation.
 * Webhook still never invites. Browser cannot activate the tenant.
 */
"use strict";

const { assertPlatformAdminSession } = require("./_lib/mg-support/require-platform-admin");
const { readSessionFromEvent } = require("./_lib/session");
const { supabaseRequest } = require("./_lib/supabase-admin");
const db = require("./_lib/saas-square-db");
const { resolveMembershipByEmail, membershipIsActive, membershipRole } = require("./_lib/membership-resolve");
const { loadPlatformAdminFlag } = require("./_lib/mg-support/require-owner-session");
const { resolveAuthUserIdByEmailDetailed } = require("./_lib/auth-resolve-user-id");
const {
  inviteAuthUserByEmail,
  recoverAuthUserByEmail,
  isValidInviteEmail,
  normEmail,
} = require("./_lib/supervisor-auth-invite");
const { planStatusNorm } = require("./_lib/square-saas-policy");

const OWNER_INVITE_REDIRECT = "https://marginguardsystem.netlify.app/index.html?login=1";

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify(body),
  };
}

function parseBody(event) {
  if (!event || event.body == null || event.body === "") return {};
  const raw = typeof event.body === "string" ? event.body : JSON.stringify(event.body);
  try {
    return JSON.parse(raw);
  } catch (_err) {
    return null;
  }
}

function createHandler(deps = {}) {
  const assertAdmin = deps.assertPlatformAdminSession || assertPlatformAdminSession;
  const readSession = deps.readSessionFromEvent || readSessionFromEvent;
  const req = deps.supabaseRequest || supabaseRequest;
  const invite = deps.inviteAuthUserByEmail || inviteAuthUserByEmail;
  const recover = deps.recoverAuthUserByEmail || recoverAuthUserByEmail;
  const resolveAuth = deps.resolveAuthUserIdByEmailDetailed || resolveAuthUserIdByEmailDetailed;
  const adminFlag = deps.loadPlatformAdminFlag || loadPlatformAdminFlag;

  return async function handler(event) {
    try {
      if (String(event?.httpMethod || "").toUpperCase() !== "POST") {
        return json(405, { ok: false, error: "method_not_allowed" });
      }
      const session = readSession(event);
      if (!session) return json(401, { ok: false, error: "not_authorized" });
      const gate = await assertAdmin(event, deps);
      if (!gate?.ok) return json(403, { ok: false, error: "not_authorized" });

      const body = parseBody(event);
      if (!body) return json(400, { ok: false, error: "invalid_json" });
      const extra = Object.keys(body).filter((key) => key !== "tenant_id");
      if (extra.length) return json(400, { ok: false, error: "invalid_request" });

      const tenantId = String(body.tenant_id || "").trim();
      if (!tenantId) return json(400, { ok: false, error: "invalid_request" });

      const tenant = await db.getTenantById(tenantId, req);
      if (!tenant?.id) return json(404, { ok: false, error: "tenant_not_found" });
      if (planStatusNorm(tenant) !== "active") {
        return json(409, { ok: false, status: "blocked", error: "tenant_not_active" });
      }

      const onboarding = await db.getLatestOnboardingForTenant(tenantId, req);
      if (!onboarding || onboarding.status !== "activated" || !onboarding.paid_at || !onboarding.activated_at) {
        return json(409, { ok: false, status: "blocked", error: "onboarding_not_activated" });
      }

      const ownerEmail = normEmail(tenant.owner_email);
      if (!isValidInviteEmail(ownerEmail)) {
        return json(409, { ok: false, status: "blocked", error: "owner_email_invalid" });
      }

      const profile = await resolveMembershipByEmail(req, tenantId, ownerEmail);
      if (!profile?.id || membershipRole(profile) !== "owner" || !membershipIsActive(profile)) {
        return json(409, { ok: false, status: "blocked", error: "owner_membership_missing" });
      }
      if (normEmail(profile.email) !== ownerEmail) {
        return json(409, { ok: false, status: "blocked", error: "ambiguous_owner" });
      }

      const ownerIsAdmin = await adminFlag({ e: ownerEmail, u: String(profile.auth_user_id || "").trim() });
      if (ownerIsAdmin) {
        return json(409, { ok: false, status: "blocked", error: "owner_is_platform_admin" });
      }

      if (String(profile.auth_user_id || "").trim()) {
        return json(200, { ok: true, status: "already_has_access" });
      }

      if (profile.invited_at) {
        return json(200, { ok: true, status: "already_invited" });
      }

      const lookup = await resolveAuth(ownerEmail);
      if (lookup.status === "resolve_failed") {
        return json(502, { ok: false, status: "error", error: "auth_lookup_failed" });
      }

      if (lookup.status === "found") {
        const recovered = await recover(ownerEmail, OWNER_INVITE_REDIRECT);
        if (!recovered.ok) return json(502, { ok: false, status: "error", error: "recovery_failed" });
      } else {
        const invited = await invite(ownerEmail, OWNER_INVITE_REDIRECT);
        if (!invited.ok) return json(502, { ok: false, status: "error", error: "invite_failed" });
      }

      await req(`profiles?id=eq.${encodeURIComponent(profile.id)}&tenant_id=eq.${encodeURIComponent(tenantId)}`, {
        method: "PATCH",
        body: { invited_at: new Date().toISOString() },
      });

      return json(200, { ok: true, status: "invite_sent" });
    } catch (_err) {
      return json(500, { ok: false, status: "error", error: "send_failed" });
    }
  };
}

exports.handler = createHandler();
exports.createHandler = createHandler;
