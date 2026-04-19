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
  return String(v == null ? "" : v).slice(0, max);
}

const ALLOWED_STATUS = new Set(["draft", "applied", "cancelled"]);

function normStatus(s) {
  const x = String(s || "")
    .trim()
    .toLowerCase();
  if (ALLOWED_STATUS.has(x)) return x;
  return "draft";
}

function mapRow(row) {
  if (!row || typeof row !== "object") return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    project_id: row.project_id,
    title: row.title == null ? "" : String(row.title),
    notes: row.notes == null ? "" : String(row.notes),
    worker_days: Number(row.worker_days) || 0,
    recommended_price: Number(row.recommended_price) || 0,
    client_price: Number(row.client_price) || 0,
    status: row.status == null ? "draft" : String(row.status),
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
    const projectId = str(body.project_id, 128).trim();
    const title = str(body.title, 2000).trim();
    if (!projectId) {
      return json(400, { error: "project_id is required" });
    }
    if (!title) {
      return json(400, { error: "title is required" });
    }

    const workerDays = num(body.worker_days, 0);
    const recommendedPrice = num(body.recommended_price, 0);
    const clientPrice = num(body.client_price, 0);
    if (workerDays < 0 || recommendedPrice < 0 || clientPrice < 0) {
      return json(400, { error: "worker_days, recommended_price, and client_price must be >= 0" });
    }

    const status = normStatus(body.status);
    const tid = encodeURIComponent(tenant.id);
    const projRows = await supabaseRequest(
      `tenant_projects?id=eq.${encodeURIComponent(projectId)}&tenant_id=eq.${tid}&select=id`
    );
    const proj = Array.isArray(projRows) ? projRows[0] : null;
    if (!proj?.id) {
      return json(403, { error: "Project not found for this tenant" });
    }

    const now = new Date().toISOString();
    const inserted = await supabaseRequest("tenant_project_change_orders", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: {
        tenant_id: tenant.id,
        project_id: projectId,
        title,
        notes: body.notes == null || body.notes === "" ? null : str(body.notes, 16000),
        worker_days: workerDays,
        recommended_price: recommendedPrice,
        client_price: clientPrice,
        status,
        created_by: supervisorUserId,
        created_at: now,
        updated_at: now,
      },
    });

    const row = Array.isArray(inserted) ? inserted[0] : inserted;
    const changeOrder = mapRow(row);
    if (!changeOrder?.id) {
      return json(500, { error: "Insert did not return a row" });
    }

    return json(200, { ok: true, changeOrder });
  } catch (err) {
    return json(500, { error: err.message || "Unexpected error" });
  }
};
