/**
 * Shared filters for accepted / signed production projects (Supervisor + Project Control).
 */

const { supabaseRequest } = require("./supabase-admin");

/** Accepted production statuses on tenant_projects (excludes draft/cancelled/test paths). */
const PRODUCTION_PROJECT_STATUSES = [
  "signed",
  "deposit_paid",
  "assigned",
  "in_progress",
  "completed",
];

const PRODUCTION_STATUS_SET = new Set(
  PRODUCTION_PROJECT_STATUSES.map((s) => s.toLowerCase())
);

/** Quote must be accepted/approved before showing in production surfaces. */
const QUOTE_STATUSES_ALLOWED = new Set(["accepted", "approved"]);

const QUOTE_ID_IN_CHUNK = 25;

function normStatus(s) {
  return String(s || "")
    .trim()
    .toLowerCase();
}

function normQuoteIdKey(id) {
  return String(id || "")
    .trim()
    .toLowerCase();
}

function mapRowToProductionProject(row) {
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
    hiddenFromProjectControl: Boolean(row.hidden_from_project_control),
  };
}

function isCompleteProductionProject(row) {
  if (!row || typeof row !== "object") return false;
  const name = String(row.project_name || "").trim();
  return name.length > 0;
}

function isVisibleInProjectControl(row) {
  if (!row || typeof row !== "object") return false;
  if (row.hidden_from_project_control === true) return false;
  return true;
}

async function loadQuoteAcceptanceMap(tenantId, quoteIdsRaw) {
  const quoteOkById = Object.create(null);
  const quoteStatusByKey = Object.create(null);
  const tid = encodeURIComponent(tenantId);
  let quotesLoaded = 0;

  if (!quoteIdsRaw.length) {
    return { quoteOkById, quoteStatusByKey, quotesLoaded };
  }

  for (let i = 0; i < quoteIdsRaw.length; i += QUOTE_ID_IN_CHUNK) {
    const chunk = quoteIdsRaw.slice(i, i + QUOTE_ID_IN_CHUNK);
    const qIn = chunk.map(encodeURIComponent).join(",");
    const qRows = await supabaseRequest(
      `quotes?id=in.(${qIn})&tenant_id=eq.${tid}&select=id,status`
    );
    const qList = Array.isArray(qRows) ? qRows : [];
    quotesLoaded += qList.length;
    for (const q of qList) {
      if (!q || typeof q !== "object" || !q.id) continue;
      const key = normQuoteIdKey(q.id);
      const st = normStatus(q.status);
      quoteStatusByKey[key] = q.status == null ? "" : String(q.status);
      if (QUOTE_STATUSES_ALLOWED.has(st)) {
        quoteOkById[key] = true;
      }
    }
  }

  return { quoteOkById, quoteStatusByKey, quotesLoaded };
}

/**
 * @param {string} tenantId
 * @param {object} [options]
 * @param {boolean} [options.forProjectControl] - exclude hidden + incomplete rows
 */
async function loadProductionProjectsForTenant(tenantId, options) {
  const forProjectControl = Boolean(options && options.forProjectControl);
  const tid = encodeURIComponent(tenantId);
  const inList = PRODUCTION_PROJECT_STATUSES.map(encodeURIComponent).join(",");

  let rows;
  if (forProjectControl) {
    try {
      rows = await supabaseRequest(
        `tenant_projects?tenant_id=eq.${tid}&status=in.(${inList})&hidden_from_project_control=eq.false&select=*&order=signed_at.desc`
      );
    } catch (_e) {
      rows = await supabaseRequest(
        `tenant_projects?tenant_id=eq.${tid}&status=in.(${inList})&select=*&order=signed_at.desc`
      );
    }
  } else {
    rows = await supabaseRequest(
      `tenant_projects?tenant_id=eq.${tid}&status=in.(${inList})&select=*&order=signed_at.desc`
    );
  }

  let list = Array.isArray(rows) ? rows : [];
  list = list.filter((r) => r && PRODUCTION_STATUS_SET.has(normStatus(r.status)));

  if (forProjectControl) {
    list = list.filter(isVisibleInProjectControl).filter(isCompleteProductionProject);
  }

  const quoteIdsRaw = [
    ...new Set(
      list
        .map((r) => (r && r.quote_id != null ? String(r.quote_id).trim() : ""))
        .filter(Boolean)
    ),
  ];

  const { quoteOkById, quoteStatusByKey, quotesLoaded } = await loadQuoteAcceptanceMap(
    tenantId,
    quoteIdsRaw
  );

  const filtered = list.filter((row) => {
    const qid = row && row.quote_id != null ? normQuoteIdKey(row.quote_id) : "";
    if (!qid) return false;
    return quoteOkById[qid] === true;
  });

  const projects = filtered.map(mapRowToProductionProject).filter(Boolean);

  return {
    projects,
    counts: {
      after_status_filter: list.length,
      quote_ids_distinct: quoteIdsRaw.length,
      quotes_rows_loaded: quotesLoaded,
      after_quote_acceptance_filter: filtered.length,
      final_projects: projects.length,
    },
  };
}

module.exports = {
  PRODUCTION_PROJECT_STATUSES,
  PRODUCTION_STATUS_SET,
  QUOTE_STATUSES_ALLOWED,
  loadProductionProjectsForTenant,
  mapRowToProductionProject,
  isCompleteProductionProject,
  isVisibleInProjectControl,
};
