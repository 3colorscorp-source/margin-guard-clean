/**
 * GET — Owner-only project financial detail for Project Control modal.
 * Tenant + project resolved server-side from session cookie.
 */

const { readSessionFromEvent } = require("./_lib/session");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");
const { supabaseRequest } = require("./_lib/supabase-admin");
const {
  resolveProfileRoleForSession,
  roleMayAccessFinancialSnapshot,
} = require("./_lib/resolve-profile-role");
const { buildProjectFinancialDetail } = require("./_lib/project-financial-detail");
const { loadDayProgressForProject } = require("./_lib/project-day-progress");

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  };
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

async function loadLatestTenantSnapshotPayload(tenantId) {
  const tid = encodeURIComponent(tenantId);
  try {
    const rows = await supabaseRequest(
      `tenant_snapshots?tenant_id=eq.${tid}&select=payload&order=created_at.desc&limit=1`
    );
    const row = Array.isArray(rows) ? rows[0] : null;
    return row?.payload && typeof row.payload === "object" ? row.payload : null;
  } catch (_e) {
    return null;
  }
}

function extractSupervisorBonusPct(payload) {
  const storage =
    payload?.storage && typeof payload.storage === "object" ? payload.storage : {};
  const mg =
    storage.mg_settings_v2 && typeof storage.mg_settings_v2 === "object"
      ? storage.mg_settings_v2
      : {};
  return num(mg.supervisorBonusPct, 1);
}

function extractHoursPerDay(payload) {
  const storage =
    payload?.storage && typeof payload.storage === "object" ? payload.storage : {};
  const mg =
    storage.mg_settings_v2 && typeof storage.mg_settings_v2 === "object"
      ? storage.mg_settings_v2
      : {};
  const hpd = num(mg.hoursPerDay, 8);
  return hpd > 0 ? hpd : 8;
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

    const role = await resolveProfileRoleForSession(session, tenant.id);
    if (!roleMayAccessFinancialSnapshot(role)) {
      return json(403, {
        error: "Project financial detail is restricted to owner role.",
      });
    }

    const qs = event.queryStringParameters || {};
    const projectId = String(qs.project_id || "").trim();
    if (!projectId) {
      return json(400, { error: "project_id is required" });
    }

    const tid = encodeURIComponent(tenant.id);
    const pid = encodeURIComponent(projectId);

    const projRows = await supabaseRequest(
      `tenant_projects?id=eq.${pid}&tenant_id=eq.${tid}&select=*`
    );
    const project = Array.isArray(projRows) ? projRows[0] : null;
    if (!project?.id) {
      return json(403, { error: "Project not found for this tenant" });
    }

    const [
      reportRows,
      expenseRows,
      coRows,
      invoiceRows,
      snapshotPayload,
      dayProgress,
    ] = await Promise.all([
      supabaseRequest(
        `tenant_project_reports?tenant_id=eq.${tid}&project_id=eq.${pid}&select=*&order=entry_date.desc`
      ),
      supabaseRequest(
        `tenant_project_expenses?tenant_id=eq.${tid}&project_id=eq.${pid}&select=*&order=expense_date.desc,created_at.desc`
      ),
      supabaseRequest(
        `tenant_project_change_orders?tenant_id=eq.${tid}&project_id=eq.${pid}&select=client_price,status`
      ),
      supabaseRequest(
        `invoices?tenant_id=eq.${tid}&project_id=eq.${pid}&select=id,amount,paid_amount,balance_due,status,due_date,created_at&order=created_at.desc`
      ),
      loadLatestTenantSnapshotPayload(tenant.id),
      loadDayProgressForProject(tenant.id, projectId),
    ]);

    const reports = Array.isArray(reportRows) ? reportRows : [];
    const expenses = Array.isArray(expenseRows) ? expenseRows : [];
    const changeOrders = Array.isArray(coRows) ? coRows : [];
    const invoices = Array.isArray(invoiceRows) ? invoiceRows : [];

    let payments = [];
    const invoiceIds = invoices.map((i) => i.id).filter(Boolean);
    if (invoiceIds.length) {
      const chunk = invoiceIds.slice(0, 40).map((id) => encodeURIComponent(id)).join(",");
      try {
        const payRows = await supabaseRequest(
          `tenant_project_payments?tenant_id=eq.${tid}&invoice_id=in.(${chunk})&select=amount,paid_at,created_at&order=paid_at.desc`
        );
        payments = Array.isArray(payRows) ? payRows : [];
      } catch (_e) {
        payments = [];
      }
    }

    const detail = buildProjectFinancialDetail({
      project,
      reports,
      expenses,
      changeOrders,
      invoices,
      payments,
      dayProgressRows: dayProgress,
      tenantSnapshotPayload: snapshotPayload,
      supervisorBonusPct: extractSupervisorBonusPct(snapshotPayload),
      hoursPerDay: extractHoursPerDay(snapshotPayload),
      tableMetrics: null,
    });

    return json(200, { ok: true, detail });
  } catch (err) {
    return json(500, { error: err.message || "Unexpected error" });
  }
};
