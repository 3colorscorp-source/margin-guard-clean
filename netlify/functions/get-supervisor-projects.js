const { readSessionFromEvent } = require("./_lib/session");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");
const { supabaseRequest } = require("./_lib/supabase-admin");

const STATUSES = ["signed", "deposit_paid", "assigned", "in_progress"];

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  };
}

function mapRowToProject(row) {
  if (!row || typeof row !== "object") return null;
  const due =
    row.due_date == null || row.due_date === ""
      ? ""
      : String(row.due_date).slice(0, 10);
  return {
    id: row.id,
    quoteId: row.quote_id ?? null,
    projectName: row.project_name ?? "",
    clientName: row.client_name ?? "",
    clientEmail: row.client_email ?? "",
    status: row.status ?? "signed",
    signedAt: row.signed_at ?? null,
    depositPaid: Boolean(row.deposit_paid),
    supervisorUserId: row.supervisor_user_id ?? null,
    estimatedDays: Number(row.estimated_days) || 0,
    laborBudget: Number(row.labor_budget) || 0,
    salePrice: Number(row.sale_price) || 0,
    recommendedPrice: Number(row.recommended_price) || 0,
    minimumPrice: Number(row.minimum_price) || 0,
    dueDate: due,
    notes: row.notes ?? "",
    appliedChangeOrderTotal: Number(row.applied_change_order_total) || 0,
    projectedRevenueTotal:
      row.projected_revenue_total == null || row.projected_revenue_total === ""
        ? null
        : Number(row.projected_revenue_total),
    laborConsumedTotal: Number(row.labor_consumed_total) || 0,
    unexpectedExpenseTotal: Number(row.unexpected_expense_total) || 0,
    realProfitTotal: Number(row.real_profit_total) || 0,
    realMarginPct: Number(row.real_margin_pct) || 0,
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

    const tid = encodeURIComponent(tenant.id);
    const inList = STATUSES.map(encodeURIComponent).join(",");
    const rows = await supabaseRequest(
      `tenant_projects?tenant_id=eq.${tid}&status=in.(${inList})&select=*&order=signed_at.desc`
    );
    const list = Array.isArray(rows) ? rows : [];
    const projects = list.map(mapRowToProject).filter(Boolean);

    return json(200, { ok: true, projects });
  } catch (err) {
    return json(500, { error: err.message || "Unexpected error" });
  }
};
