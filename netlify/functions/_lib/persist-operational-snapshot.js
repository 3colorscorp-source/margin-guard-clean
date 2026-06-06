/**
 * Persist immutable operational execution plan on sign / accept.
 */

const { supabaseRequest } = require("./supabase-admin");
const {
  normalizeOperationalPlan,
  computeOperationalPlanMetrics,
  planHasDays,
  parseOperationalPlanJsonb,
} = require("./operational-plan");

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function normDate(d) {
  const t = String(d == null ? "" : d).trim();
  if (!t) return null;
  const datePrefix = t.match(/^(\d{4}-\d{2}-\d{2})/);
  if (datePrefix) return datePrefix[1];
  const parsed = new Date(t);
  if (Number.isNaN(parsed.getTime())) return null;
  const y = parsed.getFullYear();
  const mo = String(parsed.getMonth() + 1).padStart(2, "0");
  const day = String(parsed.getDate()).padStart(2, "0");
  return `${y}-${mo}-${day}`;
}

/**
 * @param {object} params
 * @param {string} params.tenantId
 * @param {string} params.projectId
 * @param {string} [params.quoteId]
 * @param {Array|object} params.operationalPlan
 * @param {number|null} [params.estimatedDaysOverride]
 * @param {string} [params.source] - mark_sold | quote_accept | ...
 * @param {string} [params.commitment_date] - project due / committed date (YYYY-MM-DD)
 * @param {string} [params.due_date] - alias for commitment_date
 * @returns {Promise<{ ok: boolean, skipped?: boolean, id?: string }>}
 */
async function persistOperationalSnapshot(params) {
  const tenantId = String(params?.tenantId || "").trim();
  const projectId = String(params?.projectId || "").trim();
  if (!tenantId || !projectId) {
    return { ok: false, skipped: true };
  }

  const overrideRaw = params?.estimatedDaysOverride;
  const override =
    overrideRaw == null || overrideRaw === ""
      ? null
      : num(overrideRaw, NaN);

  const hoursOverrideRaw = params?.estimatedHoursOverride ?? params?.operational_estimated_hours_override;
  const hoursOverride =
    hoursOverrideRaw == null || hoursOverrideRaw === ""
      ? null
      : num(hoursOverrideRaw, NaN);
  const hoursPerDay = Math.max(
    num(params?.hoursPerDay ?? params?.hours_per_day, 8),
    0.25
  );

  const normalized = normalizeOperationalPlan(
    params?.operationalPlan,
    Number.isFinite(override) && override > 0 ? override : null,
    hoursPerDay
  );

  if (!planHasDays(normalized)) {
    return { ok: false, skipped: true };
  }

  const metrics = computeOperationalPlanMetrics(
    normalized,
    Number.isFinite(override) && override > 0 ? override : null,
    Number.isFinite(hoursOverride) && hoursOverride > 0 ? hoursOverride : null,
    hoursPerDay
  );

  const tid = encodeURIComponent(tenantId);
  const pid = encodeURIComponent(projectId);
  const nowIso = new Date().toISOString();

  const existingRows = await supabaseRequest(
    `tenant_project_operational_snapshots?tenant_id=eq.${tid}&project_id=eq.${pid}&select=id,locked_at,operational_plan&limit=1`
  );
  const existing = Array.isArray(existingRows) ? existingRows[0] : null;
  const existingPlan = parseOperationalPlanJsonb(existing?.operational_plan);
  if (existing?.locked_at && planHasDays(existingPlan)) {
    return { ok: true, skipped: true, id: existing.id };
  }

  const commitmentDate = normDate(
    params?.commitment_date ?? params?.due_date ?? params?.commitmentDate
  );

  const row = {
    tenant_id: tenantId,
    project_id: projectId,
    quote_id: params?.quoteId ? String(params.quoteId).trim() : null,
    operational_plan: normalized,
    estimated_days: metrics.estimated_days,
    estimated_hours: metrics.estimated_hours,
    worker_count: Math.max(0, Math.floor(metrics.worker_count)),
    commitment_date: commitmentDate,
    locked_at: nowIso,
    source: String(params?.source || "signed").slice(0, 64),
    updated_at: nowIso,
  };

  if (existing?.id) {
    await supabaseRequest(
      `tenant_project_operational_snapshots?id=eq.${encodeURIComponent(existing.id)}&tenant_id=eq.${tid}`,
      { method: "PATCH", body: row }
    );
    return { ok: true, id: existing.id };
  }

  row.created_at = nowIso;
  const inserted = await supabaseRequest("tenant_project_operational_snapshots", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: row,
  });
  const ins = Array.isArray(inserted) ? inserted[0] : inserted;
  return { ok: true, id: ins?.id };
}

module.exports = { persistOperationalSnapshot };
