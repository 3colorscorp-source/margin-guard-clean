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

    const customerId = String(tenant.stripe_customer_id || "").trim();
    if (!customerId || String(customerId) !== String(session.c)) {
      return json(403, { error: "Session does not match tenant billing profile" });
    }

    const tid = encodeURIComponent(tenant.id);
    const rows = await supabaseRequest(
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
