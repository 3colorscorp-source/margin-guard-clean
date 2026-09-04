/**
 * Reuse one tenant_bank_connections row across Connect Bank attempts.
 * Stripe session ids (fcs_) change per collect; bank accounts are upserted by fca_.
 * Does not delete or merge extra historical rows.
 */
"use strict";

const REUSABLE_STATUSES = new Set(["pending", "active", "requires_action"]);

function asRows(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") return [data];
  return [];
}

async function upsertTenantBankConnection({
  tenantId,
  stripeFcSessionId,
  stripeCustomerId,
  supabaseRequest,
}) {
  const id = String(tenantId || "").trim();
  const sessionId = String(stripeFcSessionId || "").trim();
  if (!id || !sessionId) {
    throw new Error("connection_upsert_required");
  }
  const requestFn = supabaseRequest;
  if (typeof requestFn !== "function") {
    throw new Error("supabase_request_required");
  }

  const nowIso = new Date().toISOString();
  const patchBody = {
    stripe_fc_session_id: sessionId,
    stripe_customer_id: String(stripeCustomerId || "").trim(),
    status: "pending",
    updated_at: nowIso,
  };

  const existing = asRows(
    await requestFn(
      `tenant_bank_connections?tenant_id=eq.${encodeURIComponent(
        id
      )}&select=id,status,stripe_fc_session_id&order=updated_at.desc&limit=50`
    )
  );
  const reusable = existing.find((row) => REUSABLE_STATUSES.has(String(row?.status || "")));

  if (reusable?.id) {
    const patched = asRows(
      await requestFn(`tenant_bank_connections?id=eq.${encodeURIComponent(reusable.id)}`, {
        method: "PATCH",
        body: patchBody,
      })
    );
    const row = patched[0] || { id: reusable.id, tenant_id: id, ...patchBody };
    return { connection: row, reused: true };
  }

  const inserted = asRows(
    await requestFn("tenant_bank_connections", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: {
        tenant_id: id,
        ...patchBody,
      },
    })
  );
  const row = inserted[0];
  if (!row?.id) {
    throw new Error("Failed to record bank connection");
  }
  return { connection: row, reused: false };
}

module.exports = {
  REUSABLE_STATUSES,
  upsertTenantBankConnection,
};
