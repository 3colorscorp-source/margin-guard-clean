/**
 * Step 3E-C17-C — create/update tenant contact (owner/admin, session-scoped).
 * Step 3E-C17-D2 — seller create-only from quote form (device session + source_context).
 */

const { supabaseRequest } = require("./_lib/supabase-admin");
const { readSessionFromEvent } = require("./_lib/session");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");
const {
  resolveMembershipByEmail,
  membershipRole,
  membershipIsActive,
} = require("./_lib/membership-resolve");
const {
  throwGuard,
  resolveOwnerOrSellerContext,
} = require("./_lib/tenant-device-guard");
const {
  UUID_RE,
  trimStr,
  normalizeContactInput,
  serializeContact,
} = require("./_lib/tenant-contact-normalize");

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

function isSellerQuoteCreateRequest(body) {
  const ctx = trimStr(body?.source_context, 64).toLowerCase();
  if (ctx === "seller_quote_form") return true;
  if (body?.from_sales_quote === true) return true;
  return String(body?.from_sales_quote || "").trim().toLowerCase() === "true";
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
  return { session, tenant, membership, accessMode: "owner_admin" };
}

async function resolveUpsertAccess(event, body) {
  try {
    return await requireOwnerOrAdmin(event);
  } catch (ownerErr) {
    if (!ownerErr?.isGuardError) throw ownerErr;

    const ctx = await resolveOwnerOrSellerContext(event);
    if (ctx.auth_mode !== "device") {
      throw ownerErr;
    }

    if (!isSellerQuoteCreateRequest(body)) {
      throwGuard(
        403,
        "Seller contact create requires source_context seller_quote_form",
        "seller_create_context_required"
      );
    }

    const contactId = trimStr(body?.id, 64);
    if (UUID_RE.test(contactId)) {
      throwGuard(403, "Seller cannot update contacts", "seller_update_forbidden");
    }

    return {
      tenant: ctx.tenant,
      membership: ctx.membership,
      accessMode: "seller_create",
    };
  }
}

async function findDuplicateWarnings(tenantId, normalized, excludeId) {
  const warnings = [];
  const tid = encodeURIComponent(tenantId);
  const activeFilter = `tenant_id=eq.${tid}&status=eq.active`;

  if (normalized.email) {
    const em = encodeURIComponent(normalized.email);
    const rows = await supabaseRequest(
      `tenant_contacts?${activeFilter}&email=eq.${em}&select=id,display_name,email&limit=5`,
      { method: "GET" }
    );
    for (const row of Array.isArray(rows) ? rows : []) {
      if (excludeId && String(row.id) === String(excludeId)) continue;
      warnings.push({
        type: "email",
        message: `Active contact with same email: ${row.display_name || row.email}`,
        contact_id: row.id,
      });
    }
  }

  if (normalized.phone_normalized) {
    const ph = encodeURIComponent(normalized.phone_normalized);
    const rows = await supabaseRequest(
      `tenant_contacts?${activeFilter}&phone_normalized=eq.${ph}&select=id,display_name,phone&limit=5`,
      { method: "GET" }
    );
    for (const row of Array.isArray(rows) ? rows : []) {
      if (excludeId && String(row.id) === String(excludeId)) continue;
      warnings.push({
        type: "phone",
        message: `Active contact with same phone: ${row.display_name || row.phone}`,
        contact_id: row.id,
      });
    }
  }

  return warnings;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { error: "Method Not Allowed" });
    }

    const body = parseBody(event.body);
    if (body == null) {
      return json(400, { ok: false, error: "Invalid JSON" });
    }

    if (body.tenant_id != null) {
      return json(400, { ok: false, error: "tenant_id must not be sent by client", code: "tenant_id_forbidden" });
    }

    const { tenant, membership, accessMode } = await resolveUpsertAccess(event, body);
    const tenantId = String(tenant.id);

    const contactId = trimStr(body.id, 64);
    const isEdit = accessMode === "owner_admin" && UUID_RE.test(contactId);
    const isSellerCreate = accessMode === "seller_create";

    const normalized = normalizeContactInput(body, {
      isInsert: !isEdit,
      sourceOverride: isSellerCreate ? "quote" : undefined,
    });

    if (isSellerCreate) {
      normalized.status = "active";
    }

    if (!normalized.display_name) {
      return json(400, { ok: false, error: "display_name could not be derived" });
    }

    const warnings = await findDuplicateWarnings(tenantId, normalized, isEdit ? contactId : null);
    const membershipId = membership?.id || null;
    const nowIso = new Date().toISOString();

    let saved = null;

    if (isEdit) {
      const patch = {
        ...normalized,
        updated_by_membership_id: membershipId,
        updated_at: nowIso,
      };
      const tid = encodeURIComponent(tenantId);
      const cid = encodeURIComponent(contactId);
      const rows = await supabaseRequest(`tenant_contacts?id=eq.${cid}&tenant_id=eq.${tid}`, {
        method: "PATCH",
        body: patch,
      });
      saved = Array.isArray(rows) && rows[0] ? rows[0] : null;
      if (!saved) {
        return json(404, { ok: false, error: "Contact not found for this tenant" });
      }
    } else {
      const insert = {
        ...normalized,
        tenant_id: tenantId,
        source: isSellerCreate ? "quote" : normalized.source || "manual",
        status: "active",
        created_by_membership_id: membershipId,
        updated_by_membership_id: membershipId,
        created_at: nowIso,
        updated_at: nowIso,
      };
      const rows = await supabaseRequest("tenant_contacts", {
        method: "POST",
        body: insert,
      });
      saved = Array.isArray(rows) && rows[0] ? rows[0] : null;
      if (!saved) {
        return json(500, { ok: false, error: "Contact insert failed" });
      }
    }

    return json(200, {
      ok: true,
      contact: serializeContact(saved),
      duplicate_warnings: warnings,
    });
  } catch (err) {
    if (err?.isGuardError) {
      return json(err.statusCode || 403, { ok: false, error: err.message, code: err.code });
    }
    console.error("[upsert-tenant-contact]", err);
    return json(500, { ok: false, error: err.message || "Server error" });
  }
};
