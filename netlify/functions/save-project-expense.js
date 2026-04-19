const { readSessionFromEvent } = require("./_lib/session");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");
const { supabaseRequest } = require("./_lib/supabase-admin");
const { resolveAuthUserIdByEmail } = require("./_lib/auth-resolve-user-id");

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

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function str(v, max = 8000) {
  return String(v == null ? "" : v)
    .trim()
    .slice(0, max);
}

function normExpenseDate(d) {
  const t = str(d, 32);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
  return t;
}

function mapRow(row) {
  if (!row || typeof row !== "object") return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    project_id: row.project_id,
    expense_date: row.expense_date == null ? null : String(row.expense_date).slice(0, 10),
    amount: Number(row.amount) || 0,
    note: row.note == null ? "" : String(row.note),
    created_by: row.created_by ?? null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
  };
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

    let supervisorUserId = session.u ? String(session.u).trim() : "";
    if (!supervisorUserId) {
      supervisorUserId = (await resolveAuthUserIdByEmail(session.e)) || "";
    }
    if (!supervisorUserId) {
      return json(400, { error: "Could not resolve user id for created_by" });
    }

    const body = parseBody(event.body);
    const projectId = str(body.project_id, 128);
    const expenseDate = normExpenseDate(body.expense_date);
    if (!projectId) {
      return json(400, { error: "project_id is required" });
    }
    if (!expenseDate) {
      return json(400, { error: "expense_date must be YYYY-MM-DD" });
    }

    const amount = num(body.amount, 0);
    if (amount <= 0) {
      return json(400, { error: "amount must be greater than zero" });
    }

    const tid = encodeURIComponent(tenant.id);
    const projRows = await supabaseRequest(
      `tenant_projects?id=eq.${encodeURIComponent(projectId)}&tenant_id=eq.${tid}&select=id`
    );
    const proj = Array.isArray(projRows) ? projRows[0] : null;
    if (!proj?.id) {
      return json(403, { error: "Project not found for this tenant" });
    }

    const now = new Date().toISOString();
    const inserted = await supabaseRequest("tenant_project_expenses", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: {
        tenant_id: tenant.id,
        project_id: projectId,
        expense_date: expenseDate,
        amount,
        note: str(body.note, 8000),
        created_by: supervisorUserId,
        created_at: now,
        updated_at: now,
      },
    });

    const row = Array.isArray(inserted) ? inserted[0] : inserted;
    const expense = mapRow(row);
    if (!expense?.id) {
      return json(500, { error: "Insert did not return a row" });
    }

    return json(200, { ok: true, expense });
  } catch (err) {
    return json(500, { error: err.message || "Unexpected error" });
  }
};
