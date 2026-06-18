/**
 * Step 3E-C17-C — list tenant contacts (owner/admin, session-scoped).
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
const {
  CONTACT_TYPES,
  CONTACT_STATUSES,
  serializeContact,
  trimStr,
} = require("./_lib/tenant-contact-normalize");

const OWNER_ADMIN_ROLES = new Set(["owner", "admin"]);

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
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
  return { session, tenant, membership };
}

function matchesSearch(contact, q) {
  if (!q) return true;
  const hay = [
    contact.display_name,
    contact.email,
    contact.phone,
    contact.company_name,
    contact.city,
    contact.first_name,
    contact.last_name,
  ]
    .map((v) => String(v || "").toLowerCase())
    .join(" ");
  return hay.includes(q);
}

function buildStats(rows) {
  const stats = {
    total_active: 0,
    homeowners: 0,
    general_contractors: 0,
    suppliers: 0,
    archived: 0,
  };
  for (const row of rows) {
    const status = String(row?.status || "").toLowerCase();
    const type = String(row?.contact_type || "").toLowerCase();
    if (status === "archived") {
      stats.archived += 1;
      continue;
    }
    if (status !== "active") continue;
    stats.total_active += 1;
    if (type === "homeowner") stats.homeowners += 1;
    if (type === "general_contractor") stats.general_contractors += 1;
    if (type === "supplier") stats.suppliers += 1;
  }
  return stats;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "GET") {
      return json(405, { error: "Method Not Allowed" });
    }

    const { tenant } = await requireOwnerOrAdmin(event);
    const tenantId = String(tenant.id);
    const tid = encodeURIComponent(tenantId);
    const qs = event.queryStringParameters || {};

    let status = trimStr(qs.status, 32).toLowerCase() || "active";
    if (!CONTACT_STATUSES.has(status)) status = "active";

    const typeFilter = trimStr(qs.contact_type, 64).toLowerCase();
    const q = trimStr(qs.q, 120).toLowerCase();
    const limit = clampInt(qs.limit, 1, 200, 100);

    const params = new URLSearchParams();
    params.set("tenant_id", `eq.${tenantId}`);
    params.set("status", `eq.${status}`);
    params.set("select", "*");
    params.set("order", "updated_at.desc,created_at.desc");
    params.set("limit", String(Math.min(limit, q ? 200 : limit)));

    if (typeFilter && CONTACT_TYPES.has(typeFilter)) {
      params.set("contact_type", `eq.${typeFilter}`);
    }

    const rows = await supabaseRequest(`tenant_contacts?${params.toString()}`, { method: "GET" });
    let contacts = Array.isArray(rows) ? rows.map(serializeContact).filter(Boolean) : [];
    if (q) {
      contacts = contacts.filter((c) => matchesSearch(c, q)).slice(0, limit);
    }

    const statsRows = await supabaseRequest(
      `tenant_contacts?tenant_id=eq.${tid}&select=status,contact_type&limit=1000`,
      { method: "GET" }
    );
    const stats = buildStats(Array.isArray(statsRows) ? statsRows : []);

    return json(200, { ok: true, contacts, stats, count: contacts.length });
  } catch (err) {
    if (err?.isGuardError) {
      return json(err.statusCode || 403, { ok: false, error: err.message, code: err.code });
    }
    console.error("[list-tenant-contacts]", err);
    return json(500, { ok: false, error: err.message || "Server error" });
  }
};
