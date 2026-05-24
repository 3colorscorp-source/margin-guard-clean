/**
 * Migrated project baseline — field schedule only (no invoice / owner financials).
 */

const { supabaseRequest } = require("./supabase-admin");

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function round2(n) {
  return Math.round(num(n, 0) * 100) / 100;
}

function str(v, max = 8000) {
  return String(v == null ? "" : v)
    .trim()
    .slice(0, max);
}

function normDate(d) {
  const t = str(d, 32);
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const parsed = new Date(t);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function clampPct(v) {
  const n = num(v, NaN);
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, round2(n)));
}

function mapBaselineRow(row) {
  if (!row || typeof row !== "object") return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    project_id: row.project_id,
    external_source: str(row.external_source, 64) || "Square",
    actual_start_date: normDate(row.actual_start_date),
    target_finish_date: normDate(row.target_finish_date),
    estimated_total_days: round2(num(row.estimated_total_days, 0)),
    days_completed_to_date: round2(num(row.days_completed_to_date, 0)),
    progress_pct: clampPct(row.progress_pct),
    current_phase: str(row.current_phase, 500),
    remaining_scope_notes: str(row.remaining_scope_notes, 8000),
    original_contract_reference: str(row.original_contract_reference, 500) || null,
    baseline_set_at: row.baseline_set_at ?? row.updated_at ?? null,
    updated_at: row.updated_at ?? null,
  };
}

/** Supervisor-safe subset (no financial fields). */
function migrationBaselineForSupervisor(row) {
  const b = mapBaselineRow(row);
  if (!b) return null;
  return {
    external_source: b.external_source,
    actual_start_date: b.actual_start_date,
    target_finish_date: b.target_finish_date,
    estimated_total_days: b.estimated_total_days,
    days_completed_to_date: b.days_completed_to_date,
    progress_pct: b.progress_pct,
    current_phase: b.current_phase,
    remaining_scope_notes: b.remaining_scope_notes,
    original_contract_reference: b.original_contract_reference,
    is_migrated: true,
  };
}

async function loadMigrationBaseline(tenantId, projectId) {
  const tid = encodeURIComponent(tenantId);
  const pid = encodeURIComponent(projectId);
  try {
    const rows = await supabaseRequest(
      `tenant_project_migration_baselines?tenant_id=eq.${tid}&project_id=eq.${pid}&select=*&limit=1`
    );
    return mapBaselineRow(Array.isArray(rows) ? rows[0] : null);
  } catch (_e) {
    return null;
  }
}

function sumReportDaysAfterBaseline(reports, baseline) {
  if (!Array.isArray(reports) || !baseline) return 0;
  const cutoffRaw = baseline.baseline_set_at || baseline.updated_at;
  const cutoffMs = cutoffRaw ? new Date(cutoffRaw).getTime() : NaN;
  const hasCutoff = Number.isFinite(cutoffMs);
  return round2(
    reports.reduce((sum, r) => {
      if (!r || typeof r !== "object") return sum;
      if (hasCutoff) {
        const createdMs = new Date(r.created_at || 0).getTime();
        if (!Number.isFinite(createdMs) || createdMs < cutoffMs) return sum;
      }
      return sum + num(r.days, 0);
    }, 0)
  );
}

/**
 * Merge migrated baseline into supervisor operational metrics.
 * @param {object} metrics - allowlisted operational snapshot
 * @param {object|null} baseline - mapped baseline row
 * @param {Array} reports - report rows with days, created_at
 */
function applyMigrationBaselineToMetrics(metrics, baseline, reports) {
  if (!baseline || !metrics || typeof metrics !== "object") return metrics;
  const out = { ...metrics };
  const est = round2(Math.max(0, num(baseline.estimated_total_days, 0)));
  const baselineDays = round2(Math.max(0, num(baseline.days_completed_to_date, 0)));
  const newReportDays = sumReportDaysAfterBaseline(reports, baseline);
  const actualDays = round2(baselineDays + newReportDays);
  const daysRemaining = round2(Math.max(0, est - actualDays));
  const baselinePct = clampPct(baseline.progress_pct);
  let completionPacePct = 0;
  if (est > 0) {
    const paceFromRatio = Math.round((actualDays / est) * 100);
    completionPacePct =
      baselinePct > 0 ? Math.max(baselinePct, paceFromRatio) : paceFromRatio;
  } else if (baselinePct > 0) {
    completionPacePct = Math.round(baselinePct);
  }

  out.estimated_days = est;
  out.actual_days = actualDays;
  out.days_remaining = daysRemaining;
  out.completion_pace_pct = completionPacePct;

  const dev = round2(actualDays - est);
  out.labor_deviation_days = dev;
  if (Math.abs(dev) < 0.01) out.labor_deviation_label = "On budget";
  else if (dev > 0) out.labor_deviation_label = `${dev.toFixed(2)} day(s) over budget`;
  else out.labor_deviation_label = `${Math.abs(dev).toFixed(2)} day(s) under budget`;

  return out;
}

function scheduleFromMigrationBaseline(baseline) {
  if (!baseline) return {};
  return {
    start_date: baseline.actual_start_date,
    commitment_date: baseline.target_finish_date,
    target_finish_date: baseline.target_finish_date,
    crew_summary: "",
    migration_source: baseline.external_source,
    current_phase: baseline.current_phase,
    remaining_scope_notes: baseline.remaining_scope_notes,
  };
}

async function upsertMigrationBaseline(tenantId, projectId, body) {
  const tid = encodeURIComponent(tenantId);
  const pid = encodeURIComponent(projectId);
  const nowIso = new Date().toISOString();
  const row = {
    tenant_id: tenantId,
    project_id: projectId,
    external_source: str(body.external_source, 64) || "Square",
    actual_start_date: normDate(body.actual_start_date),
    target_finish_date: normDate(body.target_finish_date),
    estimated_total_days: round2(Math.max(0, num(body.estimated_total_days, 0))),
    days_completed_to_date: round2(Math.max(0, num(body.days_completed_to_date, 0))),
    progress_pct: clampPct(body.progress_pct),
    current_phase: str(body.current_phase, 500),
    remaining_scope_notes: str(body.remaining_scope_notes, 8000),
    original_contract_reference: str(body.original_contract_reference, 500) || null,
    baseline_set_at: nowIso,
    updated_at: nowIso,
  };

  const existingRows = await supabaseRequest(
    `tenant_project_migration_baselines?tenant_id=eq.${tid}&project_id=eq.${pid}&select=id&limit=1`
  );
  const existing = Array.isArray(existingRows) ? existingRows[0] : null;

  if (existing?.id) {
    const { tenant_id: _t, project_id: _p, ...patch } = row;
    await supabaseRequest(
      `tenant_project_migration_baselines?id=eq.${encodeURIComponent(existing.id)}&tenant_id=eq.${tid}`,
      { method: "PATCH", body: patch }
    );
    return { ok: true, id: existing.id, updated: true };
  }

  row.created_at = nowIso;
  const inserted = await supabaseRequest("tenant_project_migration_baselines", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: row,
  });
  const ins = Array.isArray(inserted) ? inserted[0] : inserted;
  return { ok: true, id: ins?.id, updated: false };
}

/** Align operational snapshot estimated_days / commitment_date with baseline (plan unchanged). */
async function syncOperationalSnapshotDatesFromBaseline(tenantId, projectId, baseline) {
  if (!baseline) return;
  const tid = encodeURIComponent(tenantId);
  const pid = encodeURIComponent(projectId);
  const est = round2(Math.max(0, num(baseline.estimated_total_days, 0)));
  const due = normDate(baseline.target_finish_date);
  const nowIso = new Date().toISOString();
  try {
    const rows = await supabaseRequest(
      `tenant_project_operational_snapshots?tenant_id=eq.${tid}&project_id=eq.${pid}&select=id&limit=1`
    );
    const existing = Array.isArray(rows) ? rows[0] : null;
    const patch = {
      estimated_days: est,
      commitment_date: due,
      updated_at: nowIso,
      source: "migration_baseline",
    };
    if (existing?.id) {
      await supabaseRequest(
        `tenant_project_operational_snapshots?id=eq.${encodeURIComponent(existing.id)}&tenant_id=eq.${tid}`,
        { method: "PATCH", body: patch }
      );
      return;
    }
    await supabaseRequest("tenant_project_operational_snapshots", {
      method: "POST",
      body: {
        tenant_id: tenantId,
        project_id: projectId,
        operational_plan: [],
        estimated_days: est,
        estimated_hours: 0,
        worker_count: 0,
        commitment_date: due,
        locked_at: nowIso,
        source: "migration_baseline",
        created_at: nowIso,
        updated_at: nowIso,
      },
    });
  } catch (_e) {
    /* table may not exist in some envs */
  }
}

module.exports = {
  mapBaselineRow,
  migrationBaselineForSupervisor,
  loadMigrationBaseline,
  upsertMigrationBaseline,
  applyMigrationBaselineToMetrics,
  scheduleFromMigrationBaseline,
  sumReportDaysAfterBaseline,
  syncOperationalSnapshotDatesFromBaseline,
  normDate,
  clampPct,
};
