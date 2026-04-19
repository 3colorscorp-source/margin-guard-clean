const { readSessionFromEvent } = require("./_lib/session");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");
const { supabaseRequest } = require("./_lib/supabase-admin");

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  };
}

function parseBody(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

function str(v, max = 128) {
  return String(v == null ? "" : v)
    .trim()
    .slice(0, max);
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
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

    const body = parseBody(event.body);
    const projectId = str(body.project_id, 128);
    if (!projectId) {
      return json(400, { error: "project_id is required" });
    }

    const tid = encodeURIComponent(tenant.id);
    const projRows = await supabaseRequest(
      `tenant_projects?id=eq.${encodeURIComponent(projectId)}&tenant_id=eq.${tid}&select=*`
    );
    const proj = Array.isArray(projRows) ? projRows[0] : null;
    if (!proj?.id) {
      return json(403, { error: "Project not found for this tenant" });
    }

    const estDays = num(proj.estimated_days, 0);
    const laborBudget = num(proj.labor_budget, 0);
    let hourlyRate = 0;
    if (estDays > 0 && laborBudget > 0) {
      hourlyRate = laborBudget / (estDays * 8);
    }

    const reportRows = await supabaseRequest(
      `tenant_project_reports?tenant_id=eq.${tid}&project_id=eq.${encodeURIComponent(projectId)}&select=hours`
    );
    const hoursSum = Array.isArray(reportRows)
      ? reportRows.reduce((s, r) => s + num(r.hours, 0), 0)
      : 0;
    const laborConsumedTotal = hoursSum * hourlyRate;

    const expenseRows = await supabaseRequest(
      `tenant_project_expenses?tenant_id=eq.${tid}&project_id=eq.${encodeURIComponent(projectId)}&select=amount`
    );
    const unexpectedExpenseTotal = Array.isArray(expenseRows)
      ? expenseRows.reduce((s, r) => s + num(r.amount, 0), 0)
      : 0;

    const salePrice = num(proj.sale_price, 0);
    const appliedCo = num(proj.applied_change_order_total, 0);
    const storedProjRev = proj.projected_revenue_total;
    const storedProjRevNum = num(storedProjRev, 0);
    let projectedRevenueTotal = 0;
    if (storedProjRev != null && storedProjRev !== "" && storedProjRevNum > 0) {
      projectedRevenueTotal = storedProjRevNum;
    } else {
      projectedRevenueTotal = salePrice + appliedCo;
    }

    const realProfitTotal = projectedRevenueTotal - laborConsumedTotal - unexpectedExpenseTotal;
    const realMarginPct = projectedRevenueTotal > 0 ? realProfitTotal / projectedRevenueTotal : 0;

    const now = new Date().toISOString();
    await supabaseRequest(`tenant_projects?id=eq.${encodeURIComponent(projectId)}`, {
      method: "PATCH",
      body: {
        labor_consumed_total: laborConsumedTotal,
        unexpected_expense_total: unexpectedExpenseTotal,
        real_profit_total: realProfitTotal,
        real_margin_pct: realMarginPct,
        updated_at: now,
      },
    });

    return json(200, {
      ok: true,
      projectId,
      laborConsumedTotal,
      unexpectedExpenseTotal,
      projectedRevenueTotal,
      realProfitTotal,
      realMarginPct,
    });
  } catch (err) {
    return json(500, { error: err.message || "Unexpected error" });
  }
};
