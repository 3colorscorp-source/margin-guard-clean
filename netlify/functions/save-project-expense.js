const { supabaseRequest } = require("./_lib/supabase-admin");
const { resolveAuthUserIdByEmail } = require("./_lib/auth-resolve-user-id");
const { mapDeviceExpenseRow } = require("./_lib/supervisor-device-field-dto");
const {
  appendCrewTrailer,
  crewFromStoredRow,
  sanitizeSupervisorCrew,
} = require("./_lib/supervisor-day-crew");
const {
  isOwnerContext,
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
  const stored = crewFromStoredRow(row);
  const out = {
    id: row.id,
    tenant_id: row.tenant_id,
    project_id: row.project_id,
    expense_date: row.expense_date == null ? null : String(row.expense_date).slice(0, 10),
    amount: Number(row.amount) || 0,
    note: stored.note,
    created_by: row.created_by ?? null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
  };
  if (stored.crew.length) out.crew = stored.crew;
  return out;
}

async function insertExpenseRow(row) {
  return supabaseRequest("tenant_project_expenses", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: row,
  });
}

async function insertExpenseWithFallback(row, crew) {
  try {
    return await insertExpenseRow(row);
  } catch (insertErr) {
    const msg = String(insertErr?.message || insertErr || "");
    if (!/column/i.test(msg)) throw insertErr;
    const next = { ...row };
    if (/crew/i.test(msg)) {
      delete next.crew;
      if (crew.length) next.note = appendCrewTrailer(row.note, crew);
    }
    if (/day_number|phase/i.test(msg)) {
      delete next.day_number;
      delete next.phase;
    }
    try {
      return await insertExpenseRow(next);
    } catch (retryErr) {
      const retryMsg = String(retryErr?.message || retryErr || "");
      if (!/column/i.test(retryMsg)) throw retryErr;
      const bare = { ...next };
      delete bare.day_number;
      delete bare.phase;
      delete bare.crew;
      if (crew.length) bare.note = appendCrewTrailer(row.note, crew);
      return insertExpenseRow(bare);
    }
  }
}

async function resolveOwnerActorUserId(session) {
  let supervisorUserId = session?.u ? String(session.u).trim() : "";
  if (!supervisorUserId) {
    supervisorUserId = (await resolveAuthUserIdByEmail(session.e)) || "";
  }
  return supervisorUserId;
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
    const isDevice = ctx.auth_mode === "device";
    const tenant = ctx.tenant;
    if (!tenant?.id) {
      return json(404, { error: "Tenant not found" });
    }

    const projectId = str(body.project_id, 128);
    const expenseDate = normExpenseDate(body.expense_date);
    if (!projectId) {
      return json(400, { error: "project_id is required" });
    }
    if (!expenseDate) {
      return json(400, { error: "expense_date must be YYYY-MM-DD" });
    }

    const amount = num(body.amount, 0);
    const crew = sanitizeSupervisorCrew(body.crew);
    if (amount <= 0) {
      return json(400, { error: "amount must be greater than zero" });
    }
    if (!crew.length) {
      return json(400, { error: "Add at least one Pro or Assistant who worked this day.", code: "crew_required" });
    }

    await loadTenantProjectForSupervisorAction(ctx, projectId);

    let supervisorUserId = "";
    if (isDevice) {
      supervisorUserId = String(ctx.membership?.auth_user_id || "").trim();
      if (!supervisorUserId) {
        return json(403, {
          error: "Supervisor must sign in once before saving expenses",
          code: "supervisor_auth_user_id_missing",
        });
      }
    } else if (isOwnerContext(ctx)) {
      supervisorUserId = await resolveOwnerActorUserId(ctx.session);
      if (!supervisorUserId) {
        return json(400, { error: "Could not resolve user id for created_by" });
      }
    } else {
      return json(403, { error: "Forbidden", code: "forbidden" });
    }

    const now = new Date().toISOString();
    const baseRow = {
      tenant_id: tenant.id,
      project_id: projectId,
      expense_date: expenseDate,
      amount,
      note: str(body.note, 8000),
      crew,
      created_by: supervisorUserId,
      created_at: now,
      updated_at: now,
    };
    const dayNumberRaw = Number(body.day_number);
    const phase = str(body.phase, 500);
    if (Number.isFinite(dayNumberRaw) && dayNumberRaw >= 1) {
      baseRow.day_number = Math.floor(dayNumberRaw);
      if (phase) baseRow.phase = phase;
    }

    let inserted;
    try {
      inserted = await insertExpenseWithFallback(baseRow, crew);
    } catch (_insertErr) {
      return json(500, { error: "Save failed", code: "save_failed" });
    }

    const row = Array.isArray(inserted) ? inserted[0] : inserted;
    if (!row?.id) {
      return json(500, { error: "Save failed", code: "save_failed" });
    }

    if (isDevice) {
      const expense = mapDeviceExpenseRow(row);
      if (!expense) {
        return json(500, { error: "Save failed", code: "save_failed" });
      }
      return json(200, { ok: true, expense });
    }

    const expense = mapRow(row);
    if (!expense?.id) {
      return json(500, { error: "Insert did not return a row" });
    }

    return json(200, { ok: true, expense });
  } catch (err) {
    if (err.isGuardError) {
      return json(err.statusCode || 403, {
        error: err.message,
        code: err.code || "guard_error",
      });
    }
    return json(500, { error: "Save failed", code: "save_failed" });
  }
};
