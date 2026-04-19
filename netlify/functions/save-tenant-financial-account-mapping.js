const { readSessionFromEvent } = require("./_lib/session");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");
const { supabaseRequest } = require("./_lib/supabase-admin");

const ALLOWED_BUCKETS = new Set(["operating", "savings", "profit", "tax_reserve"]);
const BUCKET_ORDER = ["operating", "savings", "profit", "tax_reserve"];

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { error: "Method not allowed" });
    }

    const session = readSessionFromEvent(event);
    if (!session?.e || !session?.c) {
      return json(401, { error: "Unauthorized" });
    }

    const tenant = await resolveTenantFromSession(session);
    if (!tenant?.id) {
      return json(404, { error: "Tenant not found" });
    }

    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { error: "Invalid JSON" });
    }

    const incoming = Array.isArray(body?.mappings) ? body.mappings : [];
    const byBucket = new Map();
    for (const row of incoming) {
      const bucket = String(row?.bucket || "").trim().toLowerCase();
      if (!ALLOWED_BUCKETS.has(bucket)) {
        continue;
      }
      const raw = row?.tenant_bank_account_id;
      const accountId =
        raw === null || raw === undefined ? "" : String(raw).trim();
      byBucket.set(bucket, accountId);
    }

    const tidEnc = encodeURIComponent(tenant.id);

    async function assertAccountOwned(accountUuid) {
      const rows = await supabaseRequest(
        `tenant_bank_accounts?id=eq.${encodeURIComponent(
          accountUuid
        )}&tenant_id=eq.${tidEnc}&status=eq.active&select=id`
      );
      const row = Array.isArray(rows) ? rows[0] : null;
      if (!row?.id) {
        throw new Error("Invalid or inactive bank account for this tenant");
      }
    }

    await supabaseRequest(`tenant_financial_account_mapping?tenant_id=eq.${tidEnc}`, {
      method: "DELETE",
    });

    const usedAccountIds = new Set();
    const rows = [];
    for (const bucket of BUCKET_ORDER) {
      const accountId = byBucket.get(bucket);
      if (!accountId) {
        continue;
      }
      if (usedAccountIds.has(accountId)) {
        continue;
      }
      await assertAccountOwned(accountId);
      usedAccountIds.add(accountId);
      rows.push({
        tenant_id: tenant.id,
        bucket,
        tenant_bank_account_id: accountId,
      });
    }

    if (!rows.length) {
      return json(200, { ok: true, saved: 0, rows: [] });
    }

    const inserted = await supabaseRequest("tenant_financial_account_mapping", {
      method: "POST",
      body: rows,
    });

    return json(200, {
      ok: true,
      saved: Array.isArray(inserted) ? inserted.length : 0,
      rows: inserted,
    });
  } catch (err) {
    return json(500, { error: err.message || "save_mapping_failed" });
  }
};
