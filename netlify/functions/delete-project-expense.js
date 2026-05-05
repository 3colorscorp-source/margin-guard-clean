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
    const expenseId = str(body.expense_id, 128);
    if (!expenseId) {
      return json(400, { error: "expense_id is required" });
    }

    const tid = encodeURIComponent(tenant.id);
    const rows = await supabaseRequest(
      `tenant_project_expenses?id=eq.${encodeURIComponent(expenseId)}&tenant_id=eq.${tid}&select=id`
    );
    const hit = Array.isArray(rows) ? rows[0] : null;
    if (!hit?.id) {
      return json(404, { error: "Expense not found" });
    }

    await supabaseRequest(`tenant_project_expenses?id=eq.${encodeURIComponent(expenseId)}&tenant_id=eq.${tid}`, {
      method: "DELETE",
    });

    return json(200, { ok: true, deleted: true });
  } catch (err) {
    return json(500, { error: err.message || "Unexpected error" });
  }
};
