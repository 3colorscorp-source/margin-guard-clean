const { resolveOwnerOrSupervisorContext } = require("./_lib/tenant-device-guard");
const { supabaseRequest, getSupabaseConfig } = require("./_lib/supabase-admin");

/** tenant_projects.status — active work only (excludes draft/sent/cancelled paths). */
const PROJECT_STATUSES = ["signed", "deposit_paid", "assigned", "in_progress", "completed"];

/** quotes.status — estimate must be accepted/approved before Supervisor sees the job. */
const QUOTE_STATUSES_ALLOWED = new Set(["accepted", "approved"]);

const PROJECT_SET = new Set(PROJECT_STATUSES.map((s) => s.toLowerCase()));

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

function parseContentRangeTotal(contentRange) {
  const parts = String(contentRange || "").split("/");
  if (parts.length < 2) return null;
  const n = parseInt(parts[1], 10);
  return Number.isFinite(n) ? n : null;
}

/** Total tenant_projects rows for tenant (all statuses), for debug only. */
async function countAllTenantProjectsForTenant(tenantEncodedId) {
  const { url, key } = getSupabaseConfig();
  const res = await fetch(`${url}/rest/v1/tenant_projects?tenant_id=eq.${tenantEncodedId}&select=id`, {
    method: "GET",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
      Prefer: "count=exact",
      Range: "0-0",
    },
  });
  return parseContentRangeTotal(res.headers.get("content-range"));
}

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

/** Supervisor device read-only DTO — no owner financial or quote linkage fields. */
function mapRowToDeviceProject(row) {
  if (!row || typeof row !== "object") return null;
  const due =
    row.due_date == null || row.due_date === ""
      ? ""
      : String(row.due_date).slice(0, 10);
  return {
    id: row.id,
    projectName: row.project_name ?? "",
    clientName: row.client_name ?? "",
    status: row.status ?? "signed",
    signedAt: row.signed_at ?? null,
    dueDate: due,
    estimatedDays: Number(row.estimated_days) || 0,
    laborBudget: Number(row.labor_budget) || 0,
    laborConsumedTotal: Number(row.labor_consumed_total) || 0,
    unexpectedExpenseTotal: Number(row.unexpected_expense_total) || 0,
    workers: Array.isArray(row.quoted_labor_plan) ? row.quoted_labor_plan : [],
  };
}

function filterRowsAssignedToSupervisor(rows, authUserId) {
  const uid = String(authUserId || "").trim();
  if (!uid) return [];
  return rows.filter(
    (row) => row && String(row.supervisor_user_id || "").trim() === uid
  );
}

async function loadSupervisorProjectList(tenantId) {
  const tid = encodeURIComponent(tenantId);
  const inList = PROJECT_STATUSES.map(encodeURIComponent).join(",");
  const rows = await supabaseRequest(
    `tenant_projects?tenant_id=eq.${tid}&status=in.(${inList})&select=*&order=signed_at.desc`
  );
  let list = Array.isArray(rows) ? rows : [];
  const countAfterUrlStatusFilter = list.length;

  list = list.filter((r) => r && PROJECT_SET.has(normStatus(r.status)));
  const countAfterProjectStatusNorm = list.length;

  const quoteIdsRaw = [
    ...new Set(
      list
        .map((r) => (r && r.quote_id != null ? String(r.quote_id).trim() : ""))
        .filter(Boolean)
    ),
  ];

  const quoteOkById = Object.create(null);
  const quoteStatusByKey = Object.create(null);
  let qListTotal = 0;
  if (quoteIdsRaw.length) {
    for (let i = 0; i < quoteIdsRaw.length; i += QUOTE_ID_IN_CHUNK) {
      const chunk = quoteIdsRaw.slice(i, i + QUOTE_ID_IN_CHUNK);
      const qIn = chunk.map(encodeURIComponent).join(",");
      const qRows = await supabaseRequest(
        `quotes?id=in.(${qIn})&tenant_id=eq.${tid}&select=id,status`
      );
      const qList = Array.isArray(qRows) ? qRows : [];
      qListTotal += qList.length;
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
  }

  const filtered = list.filter((row) => {
    const qid = row && row.quote_id != null ? normQuoteIdKey(row.quote_id) : "";
    if (!qid) return false;
    return quoteOkById[qid] === true;
  });
  const countAfterQuoteAllowedFilter = filtered.length;

  return {
    list,
    filtered,
    quoteStatusByKey,
    quoteOkById,
    counts: {
      after_url_status_in_filter: countAfterUrlStatusFilter,
      after_project_status_normalized: countAfterProjectStatusNorm,
      quote_ids_distinct: quoteIdsRaw.length,
      quotes_rows_loaded: qListTotal,
      after_quote_status_allowed_filter: countAfterQuoteAllowedFilter,
    },
  };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "GET") {
      return json(405, { error: "Method not allowed" });
    }

    const ctx = await resolveOwnerOrSupervisorContext(event);
    const tenant = ctx.tenant;
    if (!tenant?.id) {
      return json(404, { error: "Tenant not found" });
    }

    const isDevice = ctx.auth_mode === "device";
    const useDebug =
      !isDevice && event.queryStringParameters && event.queryStringParameters.debug === "1";

    const { list, filtered, quoteStatusByKey, quoteOkById, counts } =
      await loadSupervisorProjectList(tenant.id);

    let rowsForMap = filtered;
    if (isDevice) {
      rowsForMap = filterRowsAssignedToSupervisor(
        filtered,
        ctx.membership?.auth_user_id
      );
    }

    const projects = isDevice
      ? rowsForMap.map(mapRowToDeviceProject).filter(Boolean)
      : rowsForMap.map(mapRowToProject).filter(Boolean);
    const countFinal = projects.length;

    if (useDebug) {
      const tid = encodeURIComponent(tenant.id);
      let countAllTenantProjects = null;
      try {
        countAllTenantProjects = await countAllTenantProjectsForTenant(tid);
      } catch (_e) {
        countAllTenantProjects = null;
      }

      const diagCounts = {
        tenant_projects_total_for_tenant: countAllTenantProjects,
        ...counts,
        final_mapped_projects: countFinal,
      };

      console.log("[get-supervisor-projects] diag counts", diagCounts);

      const sampleSource = list.slice(0, 25);
      const sample = sampleSource.map((row) => {
        const qid = row && row.quote_id != null ? normQuoteIdKey(row.quote_id) : "";
        const qs = qid ? quoteStatusByKey[qid] : "";
        const qsn = normStatus(qs);
        const gate = Boolean(qid) && quoteOkById[qid] === true;
        return {
          project_id: row.id,
          project_status: row.status,
          quote_id: row.quote_id,
          quote_status: qs === "" && qid ? "(not in quotes response)" : qs,
          quote_status_normalized: qsn || null,
          quote_gate_pass: gate,
        };
      });

      return json(200, { ok: true, projects, counts: diagCounts, sample });
    }

    return json(200, { ok: true, projects });
  } catch (err) {
    if (err.isGuardError) {
      return json(err.statusCode || 403, {
        ok: false,
        error: err.message,
        code: err.code || "guard_error",
      });
    }
    return json(500, { error: err.message || "Unexpected error" });
  }
};
