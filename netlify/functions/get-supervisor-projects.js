const { readSessionFromEvent } = require("./_lib/session");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");
const { supabaseRequest } = require("./_lib/supabase-admin");

/** tenant_projects.status — active work only (excludes draft/sent/cancelled paths). */
const PROJECT_STATUSES = ["signed", "deposit_paid", "assigned", "in_progress", "completed"];

/** quotes.status — estimate must be accepted/approved before Supervisor sees the job. */
const QUOTE_STATUSES_ALLOWED = new Set(["accepted", "approved", "signed"]);

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
    workers: Array.isArray(row.quoted_labor_plan) ? row.quoted_labor_plan : [],
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
    const inList = PROJECT_STATUSES.map(encodeURIComponent).join(",");
    const rows = await supabaseRequest(
      `tenant_projects?tenant_id=eq.${tid}&status=in.(${inList})&select=*&order=signed_at.desc`
    );
    const list = Array.isArray(rows) ? rows : [];

    const quoteIds = [...new Set(list.map((r) => (r && r.quote_id ? String(r.quote_id).trim() : "")).filter(Boolean))];
    const quoteOkById = Object.create(null);
    if (quoteIds.length) {
      const qIn = quoteIds.map(encodeURIComponent).join(",");
      const qRows = await supabaseRequest(`quotes?id=in.(${qIn})&tenant_id=eq.${tid}&select=id,status`);
      const qList = Array.isArray(qRows) ? qRows : [];
      for (const q of qList) {
        if (!q || typeof q !== "object" || !q.id) continue;
        const st = String(q.status || "")
          .trim()
          .toLowerCase();
        if (QUOTE_STATUSES_ALLOWED.has(st)) {
          quoteOkById[String(q.id)] = true;
        }
      }
    }

    const filtered = list.filter((row) => {
      const qid = row && row.quote_id != null ? String(row.quote_id).trim() : "";
      if (!qid) return false;
      return quoteOkById[qid] === true;
    });

    const projects = filtered.map(mapRowToProject).filter(Boolean);

    return json(200, { ok: true, projects });
  } catch (err) {
    return json(500, { error: err.message || "Unexpected error" });
  }
};
