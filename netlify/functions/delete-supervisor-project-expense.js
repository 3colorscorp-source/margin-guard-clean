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

function expenseScopeFilter(tenantId, projectId, expenseId) {
  return (
    "tenant_project_expenses?id=eq." +
    encodeURIComponent(expenseId) +
    "&project_id=eq." +
    encodeURIComponent(projectId) +
    "&tenant_id=eq." +
    encodeURIComponent(tenantId)
  );
}

async function recalcSupervisorProjectExpenseTotals(tenantId, projectId) {
  const tid = encodeURIComponent(tenantId);
  const pid = encodeURIComponent(projectId);
  const projRows = await supabaseRequest(
    `tenant_projects?id=eq.${pid}&tenant_id=eq.${tid}&select=labor_consumed_total,sale_price,applied_change_order_total,projected_revenue_total&limit=1`
  );
  const proj = Array.isArray(projRows) ? projRows[0] : null;
  if (!proj) return;

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

  const laborConsumedTotal = num(proj.labor_consumed_total, 0);
  const realProfitTotal = projectedRevenueTotal - laborConsumedTotal - unexpectedExpenseTotal;
  const realMarginPct =
    projectedRevenueTotal > 0 ? realProfitTotal / projectedRevenueTotal : 0;

  await supabaseRequest(`tenant_projects?id=eq.${pid}&tenant_id=eq.${tid}`, {
    method: "PATCH",
    body: {
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
    const expenseId = str(body.expense_id, 128);
    if (!projectId) {
      return json(400, { error: "project_id is required" });
    }
    if (!expenseId) {
      return json(400, { error: "expense_id is required" });
    }

    await loadTenantProjectForSupervisorAction(ctx, projectId);

    const filter = expenseScopeFilter(tenant.id, projectId, expenseId);
    const rows = await supabaseRequest(`${filter}&select=id&limit=1`);
    const hit = Array.isArray(rows) ? rows[0] : null;
    if (!hit?.id) {
      return json(404, { error: "Expense not found" });
    }

    await supabaseRequest(filter, { method: "DELETE" });
    await recalcSupervisorProjectExpenseTotals(tenant.id, projectId);

    return json(200, {
      ok: true,
      deleted: true,
      expense_id: expenseId,
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
