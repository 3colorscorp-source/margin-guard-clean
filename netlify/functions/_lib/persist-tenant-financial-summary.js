/**
 * Persist one financial-summary snapshot per tenant.
 *
 * Production PK is tenant_id (one row per tenant). Inserting a second row
 * for a new period raises PostgreSQL 23505 tenant_financial_summary_pkey.
 * Always UPDATE the existing tenant row when present; INSERT only if none.
 * Do not delete or merge extra historical rows.
 */
"use strict";

function isSummaryUniqueViolation(err) {
  const msg = String((err && err.message) || err || "");
  const code = String((err && (err.code || err.status)) || "");
  return (
    code === "23505" ||
    code === "409" ||
    /23505/.test(msg) ||
    /duplicate key/i.test(msg) ||
    /tenant_financial_summary_pkey/i.test(msg)
  );
}

function asRows(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") return [data];
  return [];
}

async function persistTenantFinancialSummary({ tenantId, payload, supabaseRequest }) {
  const id = String(tenantId || "").trim();
  if (!id) {
    throw new Error("tenant_required");
  }
  const requestFn = supabaseRequest;
  if (typeof requestFn !== "function") {
    throw new Error("supabase_request_required");
  }

  const nowIso = payload.computed_at || new Date().toISOString();
  const body = {
    ...payload,
    last_sync_at: payload.last_sync_at || nowIso,
    computed_at: nowIso,
    updated_at: payload.updated_at || nowIso,
  };

  const tid = encodeURIComponent(id);
  const existingRows = asRows(
    await requestFn(
      `tenant_financial_summary?tenant_id=eq.${tid}&select=tenant_id&limit=5`
    )
  );
  const existing = existingRows[0];

  async function patchByTenant() {
    const patched = await requestFn(`tenant_financial_summary?tenant_id=eq.${tid}`, {
      method: "PATCH",
      body,
    });
    return asRows(patched);
  }

  if (existing && (existing.id || existing.tenant_id)) {
    const rows = await patchByTenant();
    if (rows.length) {
      return { persisted: true, method: "update", row: rows[0] };
    }
  }

  try {
    const inserted = await requestFn("tenant_financial_summary", {
      method: "POST",
      body: { tenant_id: id, ...body },
    });
    const rows = asRows(inserted);
    if (!rows.length) {
      throw new Error("summary_persist_failed");
    }
    return { persisted: true, method: "insert", row: rows[0] };
  } catch (err) {
    if (!isSummaryUniqueViolation(err)) {
      throw err;
    }
    const rows = await patchByTenant();
    if (!rows.length) {
      throw err;
    }
    return { persisted: true, method: "update_after_conflict", row: rows[0] };
  }
}

module.exports = {
  isSummaryUniqueViolation,
  persistTenantFinancialSummary,
};
