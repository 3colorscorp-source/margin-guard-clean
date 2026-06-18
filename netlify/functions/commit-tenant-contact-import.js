/**
 * Step 3E-C17-I — commit owner CSV contact import batch (owner/admin, session-scoped).
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
const { UUID_RE, trimStr } = require("./_lib/tenant-contact-normalize");
const {
  buildDuplicateIndex,
  findDuplicateMatch,
  hasUsefulIdentity,
  hasStoredContactIdentity,
} = require("./_lib/csv-contact-import");

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

async function loadBatchForTenant(batchId, tenantId) {
  const bid = encodeURIComponent(batchId);
  const tid = encodeURIComponent(tenantId);
  const rows = await supabaseRequest(
    `tenant_contact_import_batches?id=eq.${bid}&tenant_id=eq.${tid}&select=*&limit=1`,
    { method: "GET" }
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
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

    const confirm =
      body.confirm === true || String(body.confirm || "").trim().toLowerCase() === "true";
    if (!confirm) {
      return json(400, {
        ok: false,
        error: "confirm=true is required to commit import",
        code: "confirm_required",
      });
    }

    const batchId = trimStr(body.batch_id, 64);
    if (!UUID_RE.test(batchId)) {
      return json(400, { ok: false, error: "Valid batch_id is required", code: "invalid_batch_id" });
    }

    const { tenant, membership } = await requireOwnerOrAdmin(event);
    const tenantId = String(tenant.id);
    const membershipId = membership?.id || null;
    const nowIso = new Date().toISOString();

    const batch = await loadBatchForTenant(batchId, tenantId);
    if (!batch) {
      return json(404, { ok: false, error: "Import batch not found", code: "batch_not_found" });
    }

    if (String(batch.status || "").toLowerCase() !== "previewed") {
      return json(409, {
        ok: false,
        error: "Import batch is not in previewed status",
        code: "batch_not_previewed",
        status: batch.status || null,
      });
    }

    const summary = batch.summary && typeof batch.summary === "object" ? batch.summary : {};
    const importRows = Array.isArray(summary.import_rows) ? summary.import_rows : [];

    const activeContacts = await loadActiveContactsForDuplicateCheck(tenantId);
    const duplicateIndex = buildDuplicateIndex(activeContacts);
    const seenInCsv = { emails: new Set(), phones: new Set() };

    const results = {
      created_count: 0,
      updated_count: 0,
      skipped_count: 0,
      error_count: 0,
      created_contact_ids: [],
      skipped: [],
    };

    for (const row of importRows) {
      const contact = row?.contact;
      if (!contact || row.action !== "create") {
        results.skipped_count += 1;
        results.error_count += 1;
        results.skipped.push({
          row_index: row?.row_index || null,
          reason: "invalid_import_row",
        });
        continue;
      }

      if (!hasStoredContactIdentity(contact)) {
        results.skipped_count += 1;
        results.error_count += 1;
        results.skipped.push({ row_index: row.row_index, reason: "no_identity" });
        continue;
      }

      const duplicate = findDuplicateMatch(contact, duplicateIndex, seenInCsv);
      if (duplicate) {
        results.skipped_count += 1;
        results.skipped.push({
          row_index: row.row_index,
          reason: duplicate.type,
          message: duplicate.message,
        });
        continue;
      }

      const insertBody = {
        ...contact,
        tenant_id: tenantId,
        source: "import",
        status: "active",
        imported_batch_id: batchId,
        duplicate_key: row.duplicate_key || contact.email || contact.phone_normalized || null,
        created_by_membership_id: membershipId,
        updated_by_membership_id: membershipId,
        created_at: nowIso,
        updated_at: nowIso,
      };

      try {
        const inserted = await supabaseRequest("tenant_contacts", {
          method: "POST",
          body: insertBody,
        });
        const saved = Array.isArray(inserted) && inserted[0] ? inserted[0] : null;
        if (!saved?.id) {
          results.skipped_count += 1;
          results.error_count += 1;
          results.skipped.push({ row_index: row.row_index, reason: "insert_failed" });
          continue;
        }

        results.created_count += 1;
        results.created_contact_ids.push(saved.id);

        if (saved.email) {
          duplicateIndex.byEmail.set(String(saved.email).toLowerCase(), saved);
          seenInCsv.emails.add(String(saved.email).toLowerCase());
        }
        if (saved.phone_normalized) {
          duplicateIndex.byPhone.set(saved.phone_normalized, saved);
          seenInCsv.phones.add(saved.phone_normalized);
        }
      } catch (insertErr) {
        results.skipped_count += 1;
        results.error_count += 1;
        results.skipped.push({
          row_index: row.row_index,
          reason: "insert_error",
          message: insertErr.message || "Insert failed",
        });
      }
    }

    const finalSummary = {
      ...summary,
      final_counts: {
        created_count: results.created_count,
        updated_count: 0,
        skipped_count: results.skipped_count,
        error_count: results.error_count,
      },
      skipped: results.skipped.slice(0, 200),
      committed_at: nowIso,
    };

    const bid = encodeURIComponent(batchId);
    const tid = encodeURIComponent(tenantId);
    await supabaseRequest(`tenant_contact_import_batches?id=eq.${bid}&tenant_id=eq.${tid}`, {
      method: "PATCH",
      body: {
        status: "committed",
        created_count: results.created_count,
        updated_count: 0,
        skipped_count: results.skipped_count,
        error_count: results.error_count,
        summary: finalSummary,
        committed_at: nowIso,
      },
    });

    return json(200, {
      ok: true,
      batch_id: batchId,
      created_count: results.created_count,
      updated_count: 0,
      skipped_count: results.skipped_count,
      error_count: results.error_count,
      created_contact_ids: results.created_contact_ids,
      skipped: results.skipped.slice(0, 50),
    });
  } catch (err) {
    if (err?.isGuardError) {
      return json(err.statusCode || 403, { ok: false, error: err.message, code: err.code });
    }
    console.error("[commit-tenant-contact-import]", err);
    return json(500, { ok: false, error: err.message || "Server error" });
  }
};
