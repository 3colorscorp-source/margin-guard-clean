/**
 * Step 3E-C17-I — preview owner CSV contact import (owner/admin, session-scoped).
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
const { CONTACT_TYPES, trimStr } = require("./_lib/tenant-contact-normalize");
const { parseAndClassifyContactImport } = require("./_lib/csv-contact-import");

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

async function loadActiveContactsForDuplicateCheck(tenantId) {
  const tid = encodeURIComponent(tenantId);
  const rows = await supabaseRequest(
    `tenant_contacts?tenant_id=eq.${tid}&status=eq.active&select=id,display_name,email,phone,phone_normalized&limit=5000`,
    { method: "GET" }
  );
  return Array.isArray(rows) ? rows : [];
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
      return json(400, {
        ok: false,
        error: "tenant_id must not be sent by client",
        code: "tenant_id_forbidden",
      });
    }

    const { tenant, membership } = await requireOwnerOrAdmin(event);
    const tenantId = String(tenant.id);

    const csvText = String(body.csv_text ?? "");
    if (!csvText.trim()) {
      return json(400, { ok: false, error: "csv_text is required", code: "csv_text_required" });
    }

    const defaultContactType = trimStr(body.default_contact_type, 64).toLowerCase() || "homeowner";
    if (!CONTACT_TYPES.has(defaultContactType)) {
      return json(400, {
        ok: false,
        error: "Invalid default_contact_type",
        code: "invalid_contact_type",
      });
    }

    const activeContacts = await loadActiveContactsForDuplicateCheck(tenantId);
    const parsed = parseAndClassifyContactImport(csvText, {
      filename: body.filename,
      defaultContactType,
      activeContacts,
    });

    if (!parsed.ok) {
      return json(400, { ok: false, error: parsed.error, code: parsed.code, total_rows: parsed.total_rows || null });
    }

    const nowIso = new Date().toISOString();
    const summary = {
      filename: parsed.filename,
      default_contact_type: parsed.default_contact_type,
      header_map: parsed.header_map,
      counts: parsed.counts,
      preview_rows: parsed.preview_rows,
      import_rows: parsed.import_rows,
      warnings: parsed.warnings,
    };

    const batchRows = await supabaseRequest("tenant_contact_import_batches", {
      method: "POST",
      body: {
        tenant_id: tenantId,
        filename: parsed.filename,
        source: "import",
        status: "previewed",
        total_rows: parsed.total_rows,
        created_count: 0,
        updated_count: 0,
        skipped_count: parsed.counts.skip_duplicate + parsed.counts.skip_invalid,
        error_count: parsed.counts.skip_invalid,
        summary,
        created_by_membership_id: membership?.id || null,
        created_at: nowIso,
      },
    });

    const batch = Array.isArray(batchRows) && batchRows[0] ? batchRows[0] : null;
    if (!batch?.id) {
      return json(500, { ok: false, error: "Failed to create import batch" });
    }

    return json(200, {
      ok: true,
      batch_id: batch.id,
      filename: parsed.filename,
      default_contact_type: parsed.default_contact_type,
      total_rows: parsed.total_rows,
      counts: parsed.counts,
      preview_rows: parsed.preview_rows,
      warnings: parsed.warnings,
      errors: parsed.counts.skip_invalid
        ? [{ message: `${parsed.counts.skip_invalid} row(s) skipped due to missing identity` }]
        : [],
    });
  } catch (err) {
    if (err?.isGuardError) {
      return json(err.statusCode || 403, { ok: false, error: err.message, code: err.code });
    }
    console.error("[preview-tenant-contact-import]", err);
    return json(500, { ok: false, error: err.message || "Server error" });
  }
};
