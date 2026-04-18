const { readSessionFromEvent } = require("./_lib/session");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");
const { supabaseRequest } = require("./_lib/supabase-admin");

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function maskFca(fca) {
  const s = String(fca || "").trim();
  if (s.length < 10) {
    return "Account";
  }
  return `Account ${s.slice(0, 6)}…${s.slice(-4)}`;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "GET") {
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

    const tid = encodeURIComponent(tenant.id);
    const rows = await supabaseRequest(
      `tenant_bank_accounts?tenant_id=eq.${tid}&status=eq.active&select=id,stripe_fc_account_id,tenant_label&order=created_at.asc`
    );
    const list = Array.isArray(rows) ? rows : [];

    const accounts = list.map((r) => {
      const label = String(r.tenant_label || "").trim();
      return {
        id: r.id,
        label: label || maskFca(r.stripe_fc_account_id),
      };
    });

    const mapRows = await supabaseRequest(
      `tenant_financial_account_mapping?tenant_id=eq.${tid}&select=bucket,tenant_bank_account_id`
    );
    const mappings = Array.isArray(mapRows) ? mapRows : [];

    return json(200, { ok: true, accounts, mappings });
  } catch (err) {
    return json(500, { error: err.message || "Unexpected error" });
  }
};
