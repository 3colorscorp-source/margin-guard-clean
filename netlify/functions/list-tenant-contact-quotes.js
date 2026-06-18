/**
 * Step 3E-C17-G — read-only quote history for a tenant contact (owner/admin).
 */

const { supabaseRequest } = require("./_lib/supabase-admin");
const { readSessionFromEvent } = require("./_lib/session");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");
const {
  membershipRole,
  membershipIsActive,
  resolveMembershipByEmail,
} = require("./_lib/membership-resolve");
const { throwGuard } = require("./_lib/tenant-device-guard");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const OWNER_ADMIN_ROLES = new Set(["owner", "admin"]);

const QUOTE_SELECT = [
  "id",
  "quote_number_display",
  "project_name",
  "title",
  "client_name",
  "client_email",
  "client_phone",
  "project_address",
  "job_site",
  "status",
  "total",
  "deposit_required",
  "currency",
  "created_at",
  "updated_at",
  "accepted_at",
  "public_token",
].join(",");

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function pickFirst(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  return "";
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function roundMoney(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 100) / 100;
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

function buildPublicUrl(publicToken) {
  const token = String(publicToken || "").trim();
  if (!token) return null;
  const siteUrl = String(
    process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.SITE_URL || ""
  ).replace(/\/+$/, "");
  if (siteUrl) {
    return `${siteUrl}/estimate-public.html?token=${encodeURIComponent(token)}`;
  }
  return `/estimate-public.html?token=${encodeURIComponent(token)}`;
}

function serializeQuoteRow(row) {
  if (!row || !row.id) return null;
  return {
    id: row.id,
    quote_number_display: row.quote_number_display ?? null,
    project_name: pickFirst(row.project_name, row.title) || null,
    client_name: row.client_name ?? null,
    client_email: row.client_email ?? null,
    client_phone: row.client_phone ?? null,
    project_address: pickFirst(row.project_address, row.job_site) || null,
    status: row.status ?? null,
    total: row.total ?? null,
    deposit_required: row.deposit_required ?? null,
    currency: row.currency ?? "USD",
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
    accepted_at: row.accepted_at ?? null,
    public_url: buildPublicUrl(row.public_token),
  };
}

async function loadContactForTenant(tenantId, contactId) {
  const tid = encodeURIComponent(tenantId);
  const cid = encodeURIComponent(contactId);
  const rows = await supabaseRequest(
    `tenant_contacts?id=eq.${cid}&tenant_id=eq.${tid}&select=id,display_name,status&limit=1`,
    { method: "GET" }
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "GET") {
      return json(405, { error: "Method Not Allowed" });
    }

    const { tenant } = await requireOwnerOrAdmin(event);
    const tenantId = String(tenant.id);
    const qs = event.queryStringParameters || {};

    const contactId = pickFirst(qs.contact_id, qs.contactId);
    if (!contactId) {
      return json(400, { ok: false, error: "contact_id is required", code: "contact_id_required" });
    }
    if (!UUID_RE.test(contactId)) {
      return json(400, { ok: false, error: "Invalid contact_id", code: "invalid_contact_id" });
    }

    const limit = clampInt(qs.limit, 1, 100, 25);

    const contact = await loadContactForTenant(tenantId, contactId);
    if (!contact) {
      return json(404, { ok: false, error: "Contact not found", code: "contact_not_found" });
    }

    const quoteRows = await supabaseRequest(
      `quotes?tenant_id=eq.${encodeURIComponent(tenantId)}&contact_id=eq.${encodeURIComponent(contactId)}&select=${QUOTE_SELECT}&order=created_at.desc&limit=${limit}`,
      { method: "GET" }
    );

    const quotes = Array.isArray(quoteRows)
      ? quoteRows.map(serializeQuoteRow).filter(Boolean)
      : [];

    const totalQuoted = quotes.reduce((sum, row) => sum + roundMoney(row.total), 0);

    return json(200, {
      ok: true,
      contact: {
        id: contact.id,
        display_name: contact.display_name || "",
      },
      quotes,
      summary: {
        count: quotes.length,
        total_quoted: roundMoney(totalQuoted),
      },
      count: quotes.length,
    });
  } catch (err) {
    if (err?.isGuardError) {
      return json(err.statusCode || 403, { ok: false, error: err.message, code: err.code });
    }
    console.error("[list-tenant-contact-quotes]", err);
    return json(500, { ok: false, error: err.message || "Server error" });
  }
};
