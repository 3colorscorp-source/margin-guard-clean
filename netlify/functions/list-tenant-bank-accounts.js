const { requireFcOwnerTenant, json } = require("./_lib/fc-owner-context");
const { supabaseRequest } = require("./_lib/supabase-admin");

function maskFca(fca) {
  const s = String(fca || "").trim();
  if (s.length < 10) {
    return "Account";
  }
  return `Account ${s.slice(0, 6)}…${s.slice(-4)}`;
}

function createHandler(deps = {}) {
  const requireOwner = deps.requireFcOwnerTenant || requireFcOwnerTenant;
  const requestFn = deps.supabaseRequest || supabaseRequest;

  return async function handler(event) {
    try {
      if (event.httpMethod !== "GET") {
        return json(405, { error: "Method not allowed" });
      }

      const gate = await requireOwner(event, deps);
      if (!gate.ok) {
        return gate.response;
      }
      const { tenant } = gate;

      const tid = encodeURIComponent(tenant.id);
      const rows = await requestFn(
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

      const mapRows = await requestFn(
        `tenant_financial_account_mapping?tenant_id=eq.${tid}&select=bucket,tenant_bank_account_id`
      );
      const mappings = Array.isArray(mapRows) ? mapRows : [];

      return json(200, { ok: true, accounts, mappings });
    } catch (err) {
      return json(500, { error: err.message || "Unexpected error" });
    }
  };
}

exports.createHandler = createHandler;
exports.handler = createHandler();
