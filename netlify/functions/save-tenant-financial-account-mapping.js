const { requireFcOwnerTenant, json } = require("./_lib/fc-owner-context");
const { supabaseRequest } = require("./_lib/supabase-admin");

const ALLOWED_BUCKETS = new Set(["operating", "savings", "profit", "tax_reserve"]);
const BUCKET_ORDER = ["operating", "savings", "profit", "tax_reserve"];

function createHandler(deps = {}) {
  const requireOwner = deps.requireFcOwnerTenant || requireFcOwnerTenant;
  const requestFn = deps.supabaseRequest || supabaseRequest;

  return async function handler(event) {
    try {
      if (event.httpMethod !== "POST") {
        return json(405, { error: "Method not allowed" });
      }

      const gate = await requireOwner(event, deps);
      if (!gate.ok) {
        return gate.response;
      }
      const { tenant } = gate;

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
        const rows = await requestFn(
          `tenant_bank_accounts?id=eq.${encodeURIComponent(
            accountUuid
          )}&tenant_id=eq.${tidEnc}&status=eq.active&select=id`
        );
        const row = Array.isArray(rows) ? rows[0] : null;
        if (!row?.id) {
          throw new Error("Invalid or inactive bank account for this tenant");
        }
      }

      await requestFn(`tenant_financial_account_mapping?tenant_id=eq.${tidEnc}`, {
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

      const inserted = await requestFn("tenant_financial_account_mapping", {
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
}

exports.createHandler = createHandler;
exports.handler = createHandler();
