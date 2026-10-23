const { supabaseRequest } = require("./_lib/supabase-admin");
const {
  loadTenantProjectForSupervisorAction,
  resolveOwnerOrSupervisorContext,
} = require("./_lib/tenant-device-guard");

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
    return null;
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

function reportScopeFilter(tenantId, projectId, reportId) {
  return (
    "tenant_project_reports?id=eq." +
    encodeURIComponent(reportId) +
    "&project_id=eq." +
    encodeURIComponent(projectId) +
    "&tenant_id=eq." +
    encodeURIComponent(tenantId)
  );
}

async function recalcSupervisorProjectLaborTotals(tenantId, projectId) {
  const tid = encodeURIComponent(tenantId);
  const pid = encodeURIComponent(projectId);
  const projRows = await supabaseRequest(
    `tenant_projects?id=eq.${pid}&tenant_id=eq.${tid}&select=estimated_days,labor_budget,sale_price,applied_change_order_total,projected_revenue_total&limit=1`
  );
  const proj = Array.isArray(projRows) ? projRows[0] : null;
  if (!proj) return;

  const estDays = num(proj.estimated_days, 0);
  const laborBudget = num(proj.labor_budget, 0);
  let hourlyRate = 0;
  if (estDays > 0 && laborBudget > 0) {
    hourlyRate = laborBudget / (estDays * 8);
  }

  const reportRows = await supabaseRequest(
    `tenant_project_reports?tenant_id=eq.${tid}&project_id=eq.${pid}&select=hours`
  );
  const hoursSum = Array.isArray(reportRows)
    ? reportRows.reduce((sum, row) => sum + num(row.hours, 0), 0)
    : 0;
  const laborConsumedTotal = hoursSum * hourlyRate;

  const expenseRows = await supabaseRequest(
    `tenant_project_expenses?tenant_id=eq.${tid}&project_id=eq.${pid}&select=amount`
  );
  const unexpectedExpenseTotal = Array.isArray(expenseRows)
    ? expenseRows.reduce((sum, row) => sum + num(row.amount, 0), 0)
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
  const realMarginPct =
    projectedRevenueTotal > 0 ? realProfitTotal / projectedRevenueTotal : 0;

  await supabaseRequest(`tenant_projects?id=eq.${pid}&tenant_id=eq.${tid}`, {
    method: "PATCH",
    body: {
      labor_consumed_total: laborConsumedTotal,
      unexpected_expense_total: unexpectedExpenseTotal,
      real_profit_total: realProfitTotal,
      real_margin_pct: realMarginPct,
      updated_at: new Date().toISOString(),
    },
  });
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { error: "Method not allowed" });
    }

    const body = parseBody(event.body);
    if (body == null) {
      return json(400, { error: "Invalid JSON", code: "invalid_json" });
    }

    const ctx = await resolveOwnerOrSupervisorContext(event);
    const tenant = ctx.tenant;
    if (!tenant?.id) {
      return json(404, { error: "Tenant not found" });
    }

    const projectId = str(body.project_id, 128);
    const reportId = str(body.report_id, 128);
    if (!projectId) {
      return json(400, { error: "project_id is required" });
    }
    if (!reportId) {
      return json(400, { error: "report_id is required" });
    }

    await loadTenantProjectForSupervisorAction(ctx, projectId);

    const filter = reportScopeFilter(tenant.id, projectId, reportId);
    const rows = await supabaseRequest(`${filter}&select=id&limit=1`);
    const hit = Array.isArray(rows) ? rows[0] : null;
    if (!hit?.id) {
      return json(404, { error: "Report not found" });
    }

    await supabaseRequest(filter, { method: "DELETE" });
    await recalcSupervisorProjectLaborTotals(tenant.id, projectId);

    return json(200, {
      ok: true,
      deleted: true,
      report_id: reportId,
      project_id: projectId,
    });
  } catch (err) {
    if (err && err.isGuardError) {
      return json(err.statusCode || 403, {
        error: err.message,
        code: err.code || "guard_error",
      });
    }
    return json(500, { error: "Delete failed", code: "delete_failed" });
  }
};
