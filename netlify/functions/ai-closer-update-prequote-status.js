/**
 * AI Closer Step 4 — update starter pre-quote status only (owner/admin).
 * Does not create official quotes or modify quote data.
 */

const { supabaseRequest } = require("./_lib/supabase-admin");
const { readSessionFromEvent } = require("./_lib/session");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");
const {
  membershipIsActive,
  membershipRole,
  resolveMembershipByEmail,
  PROFILE_SELECT,
} = require("./_lib/membership-resolve");
const { throwGuard } = require("./_lib/tenant-device-guard");

const OWNER_ADMIN_ROLES = new Set(["owner", "admin"]);

const ALLOWED_STATUSES = new Set([
  "new",
  "reviewed",
  "good_lead",
  "needs_site_visit",
  "bad_budget",
  "archived",
]);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function trimStr(value, maxLen) {
  const s = String(value ?? "").trim();
  if (!s) return "";
  return maxLen && s.length > maxLen ? s.slice(0, maxLen) : s;
}

async function resolveOwnerAdminContext(event) {
  const session = readSessionFromEvent(event);
  if (!session?.e && !session?.u) {
    throwGuard(401, "Unauthorized", "no_session");
  }

  let membership = null;

  const authUserId = String(session?.u || "").trim();
  if (authUserId) {
    const rows = await supabaseRequest(
      `profiles?auth_user_id=eq.${encodeURIComponent(authUserId)}&select=${PROFILE_SELECT}&limit=10`
    );
    const list = Array.isArray(rows) ? rows : [];
    membership =
      list.find(
        (row) => membershipIsActive(row) && OWNER_ADMIN_ROLES.has(membershipRole(row))
      ) || null;
  }

  if (!membership && session?.e && session?.c) {
    const tenant = await resolveTenantFromSession(session);
    if (tenant?.id) {
      const byEmail = await resolveMembershipByEmail(supabaseRequest, tenant.id, session.e);
      if (
        byEmail?.id &&
        membershipIsActive(byEmail) &&
        OWNER_ADMIN_ROLES.has(membershipRole(byEmail))
      ) {
        membership = byEmail;
      }
    }
  }

  if (!membership?.tenant_id) {
    throwGuard(403, "Owner or admin access required", "owner_required");
  }

  return {
    tenantId: String(membership.tenant_id),
    membership,
  };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "Method not allowed" });
    }

    const { tenantId } = await resolveOwnerAdminContext(event);

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch (_err) {
      return json(400, { ok: false, error: "Invalid JSON body" });
    }

    const prequoteId = trimStr(body.prequoteId ?? body.prequote_id ?? body.id, 80);
    const status = trimStr(body.status, 40).toLowerCase();

    if (!prequoteId || !UUID_RE.test(prequoteId)) {
      return json(400, { ok: false, error: "Valid prequoteId is required" });
    }
    if (!status || !ALLOWED_STATUSES.has(status)) {
      return json(400, { ok: false, error: "Invalid status" });
    }

    const path =
      `ai_closer_prequotes?id=eq.${encodeURIComponent(prequoteId)}` +
      `&tenant_id=eq.${encodeURIComponent(tenantId)}`;

    let rows;
    try {
      rows = await supabaseRequest(path, {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: { status },
      });
    } catch (err) {
      if (err?.status === 404 || err?.statusCode === 404) {
        return json(404, { ok: false, error: "Pre-quote not found" });
      }
      return json(502, { ok: false, error: "Unable to update pre-quote status" });
    }

    const updated = Array.isArray(rows) && rows[0] ? rows[0] : null;
    if (!updated?.id) {
      return json(404, { ok: false, error: "Pre-quote not found" });
    }

    return json(200, {
      ok: true,
      id: String(updated.id),
      status: String(updated.status || status),
    });
  } catch (err) {
    if (err?.isGuardError) {
      return json(err.statusCode || 403, { ok: false, error: err.message || "Forbidden" });
    }
    return json(500, { ok: false, error: "Server error" });
  }
};
