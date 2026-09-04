const { requireFcOwnerTenant, json } = require("./_lib/fc-owner-context");
const { supabaseRequest } = require("./_lib/supabase-admin");

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
        `tenant_financial_summary?tenant_id=eq.${tid}&currency=eq.USD&select=period_start,period_end,currency,total_inflow,total_outflow,net_change,source,computed_at,operating_balance,savings_balance,profit_balance,tax_reserve_balance,cash_on_hand&order=computed_at.desc&limit=1`
      );
      const row = Array.isArray(rows) ? rows[0] : null;

      if (!row) {
        return json(200, {
          ok: true,
          summary: null,
        });
      }

      return json(200, { ok: true, summary: row });
    } catch (err) {
      const msg = err.message || "";
      if (msg.includes("operating_balance") || msg.includes("column")) {
        return json(503, {
          error:
            "Summary columns missing in database. Run STEP 3 balance migration SQL.",
        });
      }
      return json(500, { error: err.message || "Unexpected error" });
    }
  };
}

exports.createHandler = createHandler;
exports.handler = createHandler();
