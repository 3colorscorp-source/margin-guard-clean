/**
 * Sales capacity calendar — crew availability from active projects, reports, and baselines.
 */

const { supabaseRequest } = require("./supabase-admin");
const {
  loadMigrationBaseline,
  sumReportDaysAfterBaseline,
} = require("./migration-baseline");
const { extractSettingsFromSnapshotPayload } = require("./project-labor-plan");

const ACTIVE_STATUSES = ["signed", "deposit_paid", "assigned", "in_progress"];

const DEFAULT_SCHEDULE = {
  workdaysEnabled: true,
  crewCapacity: 1,
  scheduleBufferDays: 2,
  allowSellerScheduleOverride: false,
};

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function round2(n) {
  return Math.round(num(n, 0) * 100) / 100;
}

function normDate(d) {
  const t = String(d == null ? "" : d).trim();
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const parsed = new Date(t);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function parseYmd(ymd) {
  const s = normDate(ymd);
  if (!s) return null;
  const [y, mo, d] = s.split("-").map(Number);
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return dt;
}

function formatYmd(dt) {
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const day = String(dt.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function todayYmdLocal() {
  return formatYmd(new Date());
}

function isWorkdayDate(dt, settings) {
  if (!settings?.workdaysEnabled) return true;
  const dow = dt.getDay();
  return dow !== 0 && dow !== 6;
}

function nextWorkdayOnOrAfter(ymd, settings) {
  let cur = parseYmd(ymd);
  if (!cur) return null;
  for (let guard = 0; guard < 14; guard += 1) {
    if (isWorkdayDate(cur, settings)) return formatYmd(cur);
    cur.setDate(cur.getDate() + 1);
  }
  return formatYmd(cur);
}

/** Advance `steps` business days forward from `fromYmd` (each step moves to next workday). */
function addBusinessDays(fromYmd, steps, settings) {
  const n = Math.max(0, Math.floor(num(steps, 0)));
  let cur = parseYmd(fromYmd);
  if (!cur) return null;
  if (n === 0) return formatYmd(cur);
  let counted = 0;
  for (let guard = 0; guard < 4000 && counted < n; guard += 1) {
    cur.setDate(cur.getDate() + 1);
    if (isWorkdayDate(cur, settings)) counted += 1;
  }
  return formatYmd(cur);
}

function compareYmd(a, b) {
  const aa = normDate(a);
  const bb = normDate(b);
  if (!aa || !bb) return 0;
  if (aa < bb) return -1;
  if (aa > bb) return 1;
  return 0;
}

function sumReportDays(reports) {
  if (!Array.isArray(reports)) return 0;
  return round2(
    reports.reduce((sum, row) => {
      if (!row || typeof row !== "object") return sum;
      return sum + num(row.days, 0);
    }, 0)
  );
}

function resolveScheduleSettings(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const workdaysEnabled =
    src.workdaysEnabled != null
      ? Boolean(src.workdaysEnabled)
      : src.workdays_enabled != null
        ? Boolean(src.workdays_enabled)
        : DEFAULT_SCHEDULE.workdaysEnabled;
  const crewCapacity = Math.max(
    1,
    Math.floor(
      num(src.crewCapacity, num(src.crew_capacity, DEFAULT_SCHEDULE.crewCapacity))
    )
  );
  const scheduleBufferDays = Math.max(
    0,
    Math.floor(
      num(
        src.scheduleBufferDays,
        num(src.schedule_buffer_days, DEFAULT_SCHEDULE.scheduleBufferDays)
      )
    )
  );
  const allowSellerScheduleOverride =
    src.allowSellerScheduleOverride != null
      ? Boolean(src.allowSellerScheduleOverride)
      : src.allow_seller_schedule_override != null
        ? Boolean(src.allow_seller_schedule_override)
        : DEFAULT_SCHEDULE.allowSellerScheduleOverride;
  return {
    workdaysEnabled,
    crewCapacity,
    scheduleBufferDays,
    allowSellerScheduleOverride,
  };
}

async function loadLatestTenantSnapshotPayload(tenantId) {
  const tidEnc = encodeURIComponent(tenantId);
  try {
    const rows = await supabaseRequest(
      `tenant_snapshots?tenant_id=eq.${tidEnc}&select=payload&order=created_at.desc&limit=1`,
      { method: "GET" }
    );
    const row = Array.isArray(rows) ? rows[0] : null;
    return row?.payload && typeof row.payload === "object" ? row.payload : null;
  } catch (_e) {
    return null;
  }
}

async function loadScheduleSettingsForTenant(tenantId) {
  const payload = await loadLatestTenantSnapshotPayload(tenantId);
  const mg = extractSettingsFromSnapshotPayload(payload);
  return resolveScheduleSettings(mg);
}

function computeRemainingDays(project, reports, opRow, baseline) {
  let estimated =
    num(opRow?.estimated_days, NaN) ||
    num(project?.estimated_days, NaN) ||
    num(baseline?.estimated_total_days, NaN);
  if (!Number.isFinite(estimated) || estimated <= 0) estimated = 1;

  let actualDays = 0;
  if (baseline) {
    actualDays = round2(
      num(baseline.days_completed_to_date, 0) +
        sumReportDaysAfterBaseline(reports, baseline)
    );
  } else {
    actualDays = sumReportDays(reports);
  }

  return {
    estimated: round2(estimated),
    actualDays: round2(actualDays),
    remaining: round2(Math.max(0, estimated - actualDays)),
  };
}

function computeProjectOccupationEnd(project, reports, opRow, baseline, settings, todayYmd) {
  const status = String(project?.status || "")
    .trim()
    .toLowerCase();
  if (status === "completed" || status === "cancelled") return null;

  const { remaining } = computeRemainingDays(project, reports, opRow, baseline);
  const buffer = settings.scheduleBufferDays;
  const startYmd =
    normDate(baseline?.actual_start_date) ||
    normDate(project?.signed_at) ||
    todayYmd;
  const anchor = compareYmd(todayYmd, startYmd) >= 0 ? todayYmd : startYmd;

  let occupationEnd = addBusinessDays(anchor, remaining + buffer, settings);

  const committedFinish =
    normDate(baseline?.target_finish_date) || normDate(project?.due_date);
  if (
    committedFinish &&
    compareYmd(committedFinish, occupationEnd) > 0 &&
    remaining <= 0.01
  ) {
    occupationEnd = committedFinish;
  } else if (
    committedFinish &&
    compareYmd(committedFinish, occupationEnd) > 0 &&
    compareYmd(committedFinish, todayYmd) >= 0
  ) {
    occupationEnd = committedFinish;
  }

  return occupationEnd;
}

function projectFinishFromStart(startYmd, estimatedDays, settings) {
  const days = Math.max(1, Math.ceil(num(estimatedDays, 1)));
  const snapped = nextWorkdayOnOrAfter(startYmd, settings);
  if (!snapped) return null;
  return addBusinessDays(snapped, days - 1, settings);
}

function buildBlockedDates(fromYmd, untilExclusiveYmd) {
  const out = [];
  let cur = parseYmd(fromYmd);
  const end = parseYmd(untilExclusiveYmd);
  if (!cur || !end) return out;
  for (let guard = 0; guard < 800 && cur < end; guard += 1) {
    out.push(formatYmd(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

function buildCapacityReason(activeCount, maxRemaining, buffer) {
  if (activeCount <= 0) {
    return "No active crew commitments. Production schedule is open for a new start date.";
  }
  const remaining = round2(Math.max(0, maxRemaining));
  const bufferDays = Math.max(0, Math.floor(num(buffer, 0)));
  if (remaining > 0) {
    return `Current active project has ${remaining} working day${remaining === 1 ? "" : "s"} remaining plus ${bufferDays} buffer day${bufferDays === 1 ? "" : "s"}.`;
  }
  return `Current active project is finishing plus ${bufferDays} buffer day${bufferDays === 1 ? "" : "s"}.`;
}

function effectiveStartMinYmd(nextAvailableStartDate, todayYmd, settings) {
  const next = normDate(nextAvailableStartDate);
  const today = normDate(todayYmd) || todayYmdLocal();
  if (!next) return nextWorkdayOnOrAfter(today, settings);
  if (compareYmd(next, today) >= 0) return next;
  return nextWorkdayOnOrAfter(today, settings);
}

/**
 * @param {object} params
 * @param {string} params.tenantId
 * @param {number} params.estimatedDays
 * @param {string} [params.desiredStartDate]
 * @param {string} [params.excludeProjectId] - omit when editing same signed project
 */
async function computeSalesCapacityCalendar(params) {
  const tenantId = String(params?.tenantId || "").trim();
  const estimatedDays = Math.max(0, num(params?.estimatedDays, 0));
  const desiredStartDate = normDate(params?.desiredStartDate);
  const excludeProjectId = String(params?.excludeProjectId || "").trim();
  const todayYmd = todayYmdLocal();

  const settings = params?.settings
    ? resolveScheduleSettings(params.settings)
    : await loadScheduleSettingsForTenant(tenantId);

  const tid = encodeURIComponent(tenantId);
  const statusList = ACTIVE_STATUSES.map(encodeURIComponent).join(",");

  const [projectRows, snapshotRows, baselineRows, reportRows] = await Promise.all([
    supabaseRequest(
      `tenant_projects?tenant_id=eq.${tid}&status=in.(${statusList})&select=id,status,signed_at,due_date,estimated_days,quote_id`
    ),
    supabaseRequest(
      `tenant_project_operational_snapshots?tenant_id=eq.${tid}&select=project_id,estimated_days,commitment_date`
    ),
    supabaseRequest(
      `tenant_project_migration_baselines?tenant_id=eq.${tid}&select=project_id,actual_start_date,target_finish_date,estimated_total_days,days_completed_to_date,baseline_set_at,updated_at`
    ),
    supabaseRequest(
      `tenant_project_reports?tenant_id=eq.${tid}&select=project_id,days,created_at`
    ),
  ]);

  const projects = (Array.isArray(projectRows) ? projectRows : []).filter(
    (p) => p?.id && String(p.id) !== excludeProjectId
  );
  const snapshotsByProject = new Map();
  for (const row of Array.isArray(snapshotRows) ? snapshotRows : []) {
    if (row?.project_id) snapshotsByProject.set(String(row.project_id), row);
  }
  const baselinesByProject = new Map();
  for (const row of Array.isArray(baselineRows) ? baselineRows : []) {
    if (row?.project_id) baselinesByProject.set(String(row.project_id), row);
  }
  const reportsByProject = new Map();
  for (const row of Array.isArray(reportRows) ? reportRows : []) {
    if (!row?.project_id) continue;
    const key = String(row.project_id);
    if (!reportsByProject.has(key)) reportsByProject.set(key, []);
    reportsByProject.get(key).push(row);
  }

  let maxOccupationEnd = null;
  let maxRemaining = 0;

  for (const project of projects) {
    const pid = String(project.id);
    const opRow = snapshotsByProject.get(pid) || null;
    const baseline = baselinesByProject.get(pid) || null;
    const reports = reportsByProject.get(pid) || [];
    const { remaining } = computeRemainingDays(project, reports, opRow, baseline);
    if (remaining > maxRemaining) maxRemaining = remaining;

    const occupationEnd = computeProjectOccupationEnd(
      project,
      reports,
      opRow,
      baseline,
      settings,
      todayYmd
    );
    if (!occupationEnd) continue;
    if (!maxOccupationEnd || compareYmd(occupationEnd, maxOccupationEnd) > 0) {
      maxOccupationEnd = occupationEnd;
    }
  }

  let nextAvailableStartDate;
  if (maxOccupationEnd) {
    nextAvailableStartDate = addBusinessDays(maxOccupationEnd, 1, settings);
    nextAvailableStartDate = nextWorkdayOnOrAfter(nextAvailableStartDate, settings);
  } else {
    nextAvailableStartDate = nextWorkdayOnOrAfter(todayYmd, settings);
  }
  nextAvailableStartDate = effectiveStartMinYmd(nextAvailableStartDate, todayYmd, settings);

  const blockedDates = buildBlockedDates(todayYmd, nextAvailableStartDate);

  let capacityStatus = "available";
  if (
    desiredStartDate &&
    compareYmd(desiredStartDate, nextAvailableStartDate) < 0 &&
    !settings.allowSellerScheduleOverride
  ) {
    capacityStatus = "blocked";
  } else if (projects.length > 0 && !desiredStartDate) {
    capacityStatus = "warning";
  }

  const projectedFinishDate =
    desiredStartDate && estimatedDays > 0
      ? projectFinishFromStart(desiredStartDate, estimatedDays, settings)
      : estimatedDays > 0 && nextAvailableStartDate
        ? projectFinishFromStart(nextAvailableStartDate, estimatedDays, settings)
        : null;

  const bufferDays = settings.scheduleBufferDays;
  const reason = buildCapacityReason(projects.length, maxRemaining, bufferDays);

  return {
    ok: true,
    next_available_start_date: nextAvailableStartDate,
    blocked_dates: blockedDates,
    reason,
    remaining_days: round2(Math.max(0, maxRemaining)),
    buffer_days: bufferDays,
    capacity_status: capacityStatus,
    projected_finish_date: projectedFinishDate,
    schedule_settings: {
      workdays_enabled: settings.workdaysEnabled,
      crew_capacity: settings.crewCapacity,
      schedule_buffer_days: settings.scheduleBufferDays,
      allow_seller_schedule_override: settings.allowSellerScheduleOverride,
    },
    active_project_count: projects.length,
  };
}

module.exports = {
  DEFAULT_SCHEDULE,
  resolveScheduleSettings,
  loadScheduleSettingsForTenant,
  computeSalesCapacityCalendar,
  addBusinessDays,
  projectFinishFromStart,
  nextWorkdayOnOrAfter,
  normDate,
  todayYmdLocal,
};
