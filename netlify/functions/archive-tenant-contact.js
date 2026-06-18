/**
 * Step 3E-C17-C — archive or restore tenant contact (owner/admin, session-scoped).
 */

const { supabaseRequest } = require("./_lib/supabase-admin");
const { readSessionFromEvent } = require("./_lib/session");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");
const {
  resolveMembershipByEmail,
  membershipRole,
  membershipIsActive,
} = require("./_lib/membership-resolve");
const { throwGuard } = require("./_lib/tenant-device-guard");
const { UUID_RE, trimStr, serializeContact } = require("./_lib/tenant-contact-normalize");

const OWNER_ADMIN_ROLES = new Set(["owner", "admin"]);

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function parseBody(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return null;
  }
}

async function requireOwnerOrAdmin(event) {
  const session = readSessionFromEvent(event);
  if (!session?.e || !session?.c) {
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
  return { tenant, membership };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { error: "Method Not Allowed" });
    }

    const { tenant, membership } = await requireOwnerOrAdmin(event);
    const tenantId = String(tenant.id);
    const body = parseBody(event.body);
    if (body == null) {
      return json(400, { ok: false, error: "Invalid JSON" });
    }

    if (body.tenant_id != null) {
      return json(400, { ok: false, error: "tenant_id must not be sent by client", code: "tenant_id_forbidden" });
    }

    const contactId = trimStr(body.id, 64);
    if (!UUID_RE.test(contactId)) {
      return json(400, { ok: false, error: "Valid contact id is required" });
    }

    const restore = body.restore === true || String(body.restore || "").toLowerCase() === "true";
    const nextStatus = restore ? "active" : "archived";
    const nowIso = new Date().toISOString();
    const tid = encodeURIComponent(tenantId);
    const cid = encodeURIComponent(contactId);

    const rows = await supabaseRequest(`tenant_contacts?id=eq.${cid}&tenant_id=eq.${tid}`, {
      method: "PATCH",
      body: {
        status: nextStatus,
        updated_by_membership_id: membership?.id || null,
        updated_at: nowIso,
      },
    });

    const saved = Array.isArray(rows) && rows[0] ? rows[0] : null;
    if (!saved) {
      return json(404, { ok: false, error: "Contact not found for this tenant" });
    }

    return json(200, {
      ok: true,
      restored: restore,
      contact: serializeContact(saved),
    });
  } catch (err) {
    if (err?.isGuardError) {
      return json(err.statusCode || 403, { ok: false, error: err.message, code: err.code });
    }
    console.error("[archive-tenant-contact]", err);
    return json(500, { ok: false, error: err.message || "Server error" });
  }
};
