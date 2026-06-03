/**
 * Supervisor day-level execution progress (no financial fields).
 */

const { supabaseRequest } = require("./supabase-admin");

const ALLOWED_STATUS = new Set(["pending", "completed", "skipped", "delayed"]);

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function str(v, max = 8000) {
  return String(v == null ? "" : v)
    .trim()
    .slice(0, max);
}

function mapDayProgressRow(row) {
  if (!row || typeof row !== "object") return null;
  return {
    id: row.id,
    day_number: Math.max(1, Math.floor(num(row.day_number, 0))),
    status: ALLOWED_STATUS.has(str(row.status, 32).toLowerCase())
      ? str(row.status, 32).toLowerCase()
      : "pending",
    completed_at: row.completed_at ?? null,
    completion_note: row.completion_note == null ? "" : String(row.completion_note),
  };
}

async function loadDayProgressForProject(tenantId, projectId) {
  const tid = encodeURIComponent(tenantId);
  const pid = encodeURIComponent(projectId);
  try {
    const rows = await supabaseRequest(
      `tenant_project_day_progress?tenant_id=eq.${tid}&project_id=eq.${pid}&select=id,day_number,status,completed_at,completion_note&order=day_number.asc`
    );
    return (Array.isArray(rows) ? rows : [])
      .map(mapDayProgressRow)
      .filter(Boolean);
  } catch (_e) {
    return [];
  }
}

async function upsertDayProgressCompleted(params) {
  const tenantId = str(params?.tenantId, 128);
  const projectId = str(params?.projectId, 128);
  const dayNumber = Math.max(1, Math.floor(num(params?.dayNumber, 0)));
  const completedBy = params?.completedBy ? str(params.completedBy, 128) : null;
  const phase = str(params?.phase, 500);
  const note =
    str(params?.completionNote, 8000) ||
    (phase ? `Day ${dayNumber} completed — phase: ${phase}` : `Day ${dayNumber} completed`);

  const tid = encodeURIComponent(tenantId);
  const pid = encodeURIComponent(projectId);
  const nowIso = new Date().toISOString();

  const existingRows = await supabaseRequest(
    `tenant_project_day_progress?tenant_id=eq.${tid}&project_id=eq.${pid}&day_number=eq.${dayNumber}&select=id,status&limit=1`
  );
  const existing = Array.isArray(existingRows) ? existingRows[0] : null;

  const row = {
    tenant_id: tenantId,
    project_id: projectId,
    day_number: dayNumber,
    status: "completed",
    completed_at: nowIso,
    completed_by: completedBy,
    completion_note: note,
    updated_at: nowIso,
  };

  if (existing?.id) {
    if (str(existing.status, 32).toLowerCase() === "completed") {
      return { ok: true, id: existing.id, already_completed: true, day_number: dayNumber };
    }
    await supabaseRequest(
      `tenant_project_day_progress?id=eq.${encodeURIComponent(existing.id)}&tenant_id=eq.${tid}`,
      { method: "PATCH", body: row }
    );
    return { ok: true, id: existing.id, already_completed: false, day_number: dayNumber };
  }

  row.created_at = nowIso;
  const inserted = await supabaseRequest("tenant_project_day_progress", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: row,
  });
  const ins = Array.isArray(inserted) ? inserted[0] : inserted;
  return {
    ok: true,
    id: ins?.id,
    already_completed: false,
    day_number: dayNumber,
  };
}

function dayProgressMap(rows) {
  const map = Object.create(null);
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || row.day_number == null) continue;
    map[String(row.day_number)] = row;
  }
  return map;
}

function countCompletedDays(rows) {
  return (Array.isArray(rows) ? rows : []).filter(
    (r) => r && str(r.status, 32).toLowerCase() === "completed"
  ).length;
}

async function reopenDayProgress(params) {
  const tenantId = str(params?.tenantId, 128);
  const projectId = str(params?.projectId, 128);
  const dayNumber = Math.max(1, Math.floor(num(params?.dayNumber, 0)));
  const tid = encodeURIComponent(tenantId);
  const pid = encodeURIComponent(projectId);
  const nowIso = new Date().toISOString();

  const existingRows = await supabaseRequest(
    `tenant_project_day_progress?tenant_id=eq.${tid}&project_id=eq.${pid}&day_number=eq.${dayNumber}&select=id&limit=1`
  );
  const existing = Array.isArray(existingRows) ? existingRows[0] : null;
  if (!existing?.id) {
    return { ok: true, id: null, reopened: false, day_number: dayNumber };
  }

  await supabaseRequest(
    `tenant_project_day_progress?id=eq.${encodeURIComponent(existing.id)}&tenant_id=eq.${tid}`,
    {
      method: "PATCH",
      body: {
        status: "pending",
        completed_at: null,
        completed_by: null,
        updated_at: nowIso,
      },
    }
  );
  return { ok: true, id: existing.id, reopened: true, day_number: dayNumber };
}

module.exports = {
  loadDayProgressForProject,
  upsertDayProgressCompleted,
  reopenDayProgress,
  dayProgressMap,
  countCompletedDays,
  mapDayProgressRow,
};
