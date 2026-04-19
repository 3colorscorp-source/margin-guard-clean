const { readSessionFromEvent } = require("./_lib/session");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");
const { supabaseRequest } = require("./_lib/supabase-admin");

const BUCKETS = new Set(["operating", "savings", "profit", "tax_reserve"]);

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
    return {};
  }
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

    const customerId = String(tenant.stripe_customer_id || "").trim();
    if (!customerId || String(customerId) !== String(session.c)) {
      return json(403, { error: "Session does not match tenant billing profile" });
    }

    const body = parseBody(event.body);
    const mappings = body.mappings;
    if (!Array.isArray(mappings)) {
      return json(400, { error: "mappings array required" });
    }

    const tid = encodeURIComponent(tenant.id);

    async function assertAccountOwned(accountUuid) {
      const rows = await supabaseRequest(
        `tenant_bank_accounts?id=eq.${encodeURIComponent(
          accountUuid
        )}&tenant_id=eq.${tid}&status=eq.active&select=id`
      );
      const row = Array.isArray(rows) ? rows[0] : null;
      if (!row?.id) {
        throw new Error("Invalid or inactive bank account for this tenant");
      }
    }

    const upsertPath = `tenant_financial_account_mapping?on_conflict=${encodeURIComponent(
      "tenant_id,bucket"
    )}`;

    for (const m of mappings) {
      const bucket = m?.bucket;
      if (!BUCKETS.has(bucket)) {
        return json(400, { error: "Invalid bucket" });
      }

      const rawId = m?.tenant_bank_account_id;
      const accountId =
        rawId === null || rawId === undefined || rawId === ""
          ? ""
          : String(rawId).trim();

      if (!accountId) {
        await supabaseRequest(
          `tenant_financial_account_mapping?tenant_id=eq.${tid}&bucket=eq.${encodeURIComponent(
            bucket
          )}`,
          { method: "DELETE" }
        );
        continue;
      }

      await assertAccountOwned(accountId);

      await supabaseRequest(
        `tenant_financial_account_mapping?tenant_id=eq.${tid}&tenant_bank_account_id=eq.${encodeURIComponent(
          accountId
        )}`,
        { method: "DELETE" }
      );

      await supabaseRequest(upsertPath, {
        method: "POST",
        headers: {
          Prefer: "return=representation,resolution=merge-duplicates",
        },
        body: {
          tenant_id: tenant.id,
          tenant_bank_account_id: accountId,
          bucket,
        },
      });
    }

    return json(200, { ok: true });
  } catch (err) {
    return json(500, { error: err.message || "Unexpected error" });
  }
};
