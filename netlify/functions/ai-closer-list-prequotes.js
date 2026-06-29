/**
 * AI Closer Step 3 — read-only owner/admin inbox for starter pre-quotes.
 * Isolated from official quotes, invoices, and payments.
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

const SAFE_PREQUOTE_SELECT = [
  "id",
  "tenant_slug",
  "source",
  "status",
  "project_name",
  "work_type",
  "unit_type",
  "scope_size",
  "estimated_crew_days",
  "range_low",
  "range_high",
  "client_budget",
  "budget_signal",
  "zoom_slot",
  "target_date",
  "scope_notes",
  "plan_file_name",
  "current_photo_name",
  "inspiration_photo_name",
  "client_name",
  "client_email",
  "client_phone",
  "preferred_contact",
  "client_notes",
  "created_at",
].join(",");

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function clampLimit(raw) {
  const n = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n)) return 25;
  return Math.min(Math.max(n, 1), 50);
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
    if (event.httpMethod !== "GET") {
      return json(405, { ok: false, error: "Method not allowed" });
    }

    const { tenantId } = await resolveOwnerAdminContext(event);
    const limit = clampLimit(event.queryStringParameters?.limit);

    const path =
      `ai_closer_prequotes?tenant_id=eq.${encodeURIComponent(tenantId)}` +
      `&select=${SAFE_PREQUOTE_SELECT}` +
      `&order=created_at.desc` +
      `&limit=${limit}`;

    let rows;
    try {
      rows = await supabaseRequest(path, { method: "GET" });
    } catch (_err) {
      return json(502, { ok: false, error: "Unable to load AI Closer pre-quotes" });
    }

    const prequotes = Array.isArray(rows) ? rows : [];

    return json(200, { ok: true, prequotes, count: prequotes.length });
  } catch (err) {
    if (err?.isGuardError) {
      return json(err.statusCode || 403, { ok: false, error: err.message || "Forbidden" });
    }
    return json(500, { ok: false, error: "Server error" });
  }
};
