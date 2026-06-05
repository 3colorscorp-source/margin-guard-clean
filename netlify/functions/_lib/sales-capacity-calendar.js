/**
 * Sales capacity calendar — crew availability from active projects, reports, and baselines.
 */

const { supabaseRequest } = require("./supabase-admin");
const {
  loadMigrationBaseline,
  sumReportDaysAfterBaseline,
} = require("./migration-baseline");
const { extractSettingsFromSnapshotPayload } = require("./project-labor-plan");
const { countCompletedDays } = require("./project-day-progress");

const ACTIVE_STATUSES = ["signed", "deposit_paid", "assigned", "in_progress"];

const DEFAULT_SCHEDULE = {
  workdaysEnabled: true,
  crewCapacity: 1,
  scheduleBufferDays: 2,
  allowSellerScheduleOverride: false,
  crewAvailabilityMode: "advisory",
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
  const crewAvailabilityModeRaw = String(
    src.crewAvailabilityMode != null
      ? src.crewAvailabilityMode
      : src.crew_availability_mode != null
        ? src.crew_availability_mode
        : DEFAULT_SCHEDULE.crewAvailabilityMode
  )
    .trim()
    .toLowerCase();
  const crewAvailabilityMode =
    crewAvailabilityModeRaw === "strict" ? "strict" : "advisory";
  return {
    workdaysEnabled,
    crewCapacity,
    scheduleBufferDays,
    allowSellerScheduleOverride,
    crewAvailabilityMode,
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

function resolveEstimatedDays(project, opRow, baseline) {
  let estimated =
    num(opRow?.estimated_days, NaN) ||
    num(project?.estimated_days, NaN) ||
    num(baseline?.estimated_total_days, NaN);
  if (!Number.isFinite(estimated) || estimated <= 0) return 0;
  return round2(estimated);
}

function resolveCompletedDays(dayProgressRows, reports, baseline) {
  const rows = Array.isArray(dayProgressRows) ? dayProgressRows : [];
  const fromProgress = countCompletedDays(rows);
  if (fromProgress > 0) return fromProgress;
  if (rows.length > 0) return fromProgress;
  if (baseline) {
    return round2(
      num(baseline.days_completed_to_date, 0) + sumReportDaysAfterBaseline(reports, baseline)
    );
  }
  return sumReportDays(reports);
}

function isCompletedBySupervisor(estimatedDays, completedDays) {
  return estimatedDays > 0 && num(completedDays, 0) >= estimatedDays;
}

function hasDelayedStatus(project, dayProgressRows) {
  const st = String(project?.status || "")
    .trim()
    .toLowerCase();
  if (st.includes("delay") || st === "delayed") return true;
  return rowsSomeDelayed(dayProgressRows);
}

function rowsSomeDelayed(dayProgressRows) {
  return (Array.isArray(dayProgressRows) ? dayProgressRows : []).some(
    (r) =>
      String(r?.status || "")
        .trim()
        .toLowerCase() === "delayed"
  );
}

function resolveTargetFinish(project, opRow, baseline) {
  return (
    normDate(baseline?.target_finish_date) ||
    normDate(project?.due_date) ||
    normDate(opRow?.commitment_date) ||
    null
  );
}

function resolveProjectStart(project, baseline) {
  const signed = project?.signed_at;
  const signedYmd =
    typeof signed === "string" && signed.length >= 10 ? signed.slice(0, 10) : signed;
  return normDate(baseline?.actual_start_date) || normDate(signedYmd) || null;
}

function formatDateUS(ymd) {
  const dt = parseYmd(ymd);
  if (!dt) return String(ymd || "");
  return dt.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Per-project crew blocking analysis — day_progress first, then target finish.
 */
function analyzeProjectForCrewAvailability(
  project,
  ctx,
  settings,
  todayYmd,
  desiredStartDate
) {
  const { opRow, baseline, reports, dayProgressRows } = ctx;
  const status = String(project?.status || "")
    .trim()
    .toLowerCase();
  const projectName = String(project?.project_name || project?.id || "Active project").trim();
  const projectId = String(project?.id || "").trim();

  if (status === "completed" || status === "cancelled") {
    return {
      project_id: projectId,
      project_name: projectName,
      blocks_capacity: false,
      completed_by_supervisor: true,
      released: true,
    };
  }

  const estimatedDays = resolveEstimatedDays(project, opRow, baseline);
  const completedDays = resolveCompletedDays(dayProgressRows, reports, baseline);
  const remainingDays = round2(Math.max(0, estimatedDays - completedDays));
  const completedBySupervisor = isCompletedBySupervisor(estimatedDays, completedDays);
  const progressPct =
    estimatedDays > 0 ? Math.round((completedDays / estimatedDays) * 100) : 0;
  const isDelayed = hasDelayedStatus(project, dayProgressRows);

  const base = {
    project_id: projectId,
    project_name: projectName,
    estimated_days: estimatedDays,
    completed_days: round2(completedDays),
    remaining_days: remainingDays,
    progress_pct: progressPct,
    is_delayed: isDelayed,
    completed_by_supervisor: completedBySupervisor,
  };

  if (completedBySupervisor || (progressPct >= 100 && remainingDays <= 0.01)) {
    return {
      ...base,
      blocks_capacity: false,
      released: true,
      release_reason: "supervisor_complete",
    };
  }

  const startDate = resolveProjectStart(project, baseline);
  let targetFinish = resolveTargetFinish(project, opRow, baseline);
  if (!targetFinish && startDate && estimatedDays > 0) {
    targetFinish = projectFinishFromStart(startDate, estimatedDays, settings);
  }

  if (targetFinish && compareYmd(todayYmd, targetFinish) > 0) {
    if (isDelayed) {
      const occupationEnd = addBusinessDays(
        todayYmd,
        Math.max(1, Math.ceil(remainingDays)) + settings.scheduleBufferDays,
        settings
      );
      return {
        ...base,
        blocks_capacity: true,
        target_finish_date: targetFinish,
        start_date: startDate,
        occupation_end: occupationEnd,
        past_target_incomplete: true,
        advisory_only: false,
        conflict_with_desired: overlapsDesiredStart(
          desiredStartDate,
          startDate,
          targetFinish
        ),
      };
    }
    return {
      ...base,
      blocks_capacity: false,
      target_finish_date: targetFinish,
      start_date: startDate,
      past_target_incomplete: true,
      incomplete_supervisor_reporting: true,
      advisory_only: true,
      released: true,
      release_reason: "target_finish_passed",
    };
  }

  const occupationEnd =
    targetFinish ||
    addBusinessDays(
      todayYmd,
      Math.max(0, Math.ceil(remainingDays)) + settings.scheduleBufferDays,
      settings
    );

  const conflictWithDesired = overlapsDesiredStart(
    desiredStartDate,
    startDate,
    targetFinish || occupationEnd
  );

  return {
    ...base,
    blocks_capacity: true,
    target_finish_date: targetFinish,
    start_date: startDate,
    occupation_end: occupationEnd,
    advisory_only: false,
    conflict_with_desired: conflictWithDesired,
  };
}

function overlapsDesiredStart(desiredStartDate, projectStart, windowEnd) {
  const desired = normDate(desiredStartDate);
  const end = normDate(windowEnd);
  if (!desired || !end) return false;
  const start = normDate(projectStart);
  if (compareYmd(desired, end) > 0) return false;
  if (start && compareYmd(desired, start) < 0) return false;
  return true;
}

function buildAvailabilitySummary({
  blockingProjects,
  incompleteReportingProjects,
  desiredStartDate,
  nextAvailableStartDate,
  settings,
}) {
  const suffix = " You may still send this estimate.";
  const conflict = blockingProjects.find((p) => p.conflict_with_desired);
  if (conflict) {
    const until = formatDateUS(conflict.target_finish_date || conflict.occupation_end);
    return {
      capacity_status: "conflict",
      availability_message: `Crew may be booked until ${until} on ${conflict.project_name}.${suffix}`,
      guidance_message: `Crew may be booked until ${until} on ${conflict.project_name}.`,
    };
  }

  if (incompleteReportingProjects.length) {
    const names = incompleteReportingProjects.map((p) => p.project_name).join(", ");
    return {
      capacity_status: "incomplete_reporting",
      availability_message:
        `Supervisor has not marked the current project complete (${names}). Availability is based on target finish and should be confirmed.${suffix}`,
      guidance_message:
        "Supervisor has not marked the current project complete. Availability is based on target finish and should be confirmed.",
    };
  }

  if (blockingProjects.length && desiredStartDate) {
    const top = blockingProjects[0];
    const until = formatDateUS(top.target_finish_date || top.occupation_end);
    return {
      capacity_status: "warning",
      availability_message: `Crew may be booked until ${until} on ${top.project_name}.${suffix}`,
      guidance_message: `Active project ${top.project_name} may hold crew until ${until}.`,
    };
  }

  const nextLabel = formatDateUS(nextAvailableStartDate);
  return {
    capacity_status: "available",
    availability_message: nextLabel
      ? `Crew appears available starting ${nextLabel}.${suffix}`
      : `Crew appears available.${suffix}`,
    guidance_message: nextLabel
      ? `Crew appears available starting ${nextLabel}.`
      : "No active crew commitments blocking new starts.",
  };
}

/** @deprecated kept for tests — prefer analyzeProjectForCrewAvailability */
function computeRemainingDays(project, reports, opRow, baseline, dayProgressRows) {
  const estimated = resolveEstimatedDays(project, opRow, baseline) || 1;
  const actualDays = resolveCompletedDays(dayProgressRows || [], reports, baseline);
  return {
    estimated: round2(estimated),
    actualDays: round2(actualDays),
    remaining: round2(Math.max(0, estimated - actualDays)),
  };
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

  const [projectRows, snapshotRows, baselineRows, reportRows, dayProgressRows] =
    await Promise.all([
    supabaseRequest(
      `tenant_projects?tenant_id=eq.${tid}&status=in.(${statusList})&select=id,status,signed_at,due_date,estimated_days,quote_id,project_name`
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
    supabaseRequest(
      `tenant_project_day_progress?tenant_id=eq.${tid}&select=project_id,day_number,status`
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
  const dayProgressByProject = new Map();
  for (const row of Array.isArray(dayProgressRows) ? dayProgressRows : []) {
    if (!row?.project_id) continue;
    const key = String(row.project_id);
    if (!dayProgressByProject.has(key)) dayProgressByProject.set(key, []);
    dayProgressByProject.get(key).push(row);
  }

  let maxOccupationEnd = null;
  let maxRemaining = 0;
  const blockingProjects = [];
  const incompleteReportingProjects = [];
  const projectAnalyses = [];

  for (const project of projects) {
    const pid = String(project.id);
    const opRow = snapshotsByProject.get(pid) || null;
    const baseline = baselinesByProject.get(pid) || null;
    const reports = reportsByProject.get(pid) || [];
    const progressRows = dayProgressByProject.get(pid) || [];

    const analysis = analyzeProjectForCrewAvailability(
      project,
      { opRow, baseline, reports, dayProgressRows: progressRows },
      settings,
      todayYmd,
      desiredStartDate
    );
    projectAnalyses.push(analysis);

    const rem = num(analysis.remaining_days, 0);
    if (rem > maxRemaining) maxRemaining = rem;

    if (analysis.incomplete_supervisor_reporting) {
      incompleteReportingProjects.push(analysis);
      continue;
    }

    if (analysis.released || !analysis.blocks_capacity) {
      continue;
    }

    blockingProjects.push(analysis);
    const occEnd = normDate(analysis.occupation_end);
    if (occEnd && (!maxOccupationEnd || compareYmd(occEnd, maxOccupationEnd) > 0)) {
      maxOccupationEnd = occEnd;
    }
  }

  blockingProjects.sort((a, b) =>
    compareYmd(b.target_finish_date || b.occupation_end, a.target_finish_date || a.occupation_end)
  );

  let nextAvailableStartDate;
  if (maxOccupationEnd) {
    nextAvailableStartDate = addBusinessDays(maxOccupationEnd, 1, settings);
    nextAvailableStartDate = nextWorkdayOnOrAfter(nextAvailableStartDate, settings);
  } else {
    nextAvailableStartDate = nextWorkdayOnOrAfter(todayYmd, settings);
  }
  nextAvailableStartDate = effectiveStartMinYmd(nextAvailableStartDate, todayYmd, settings);

  const blockedDates = buildBlockedDates(todayYmd, nextAvailableStartDate);

  const summary = buildAvailabilitySummary({
    blockingProjects,
    incompleteReportingProjects,
    desiredStartDate,
    nextAvailableStartDate,
    settings,
  });

  let capacityStatus = summary.capacity_status;
  if (
    settings.crewAvailabilityMode === "strict" &&
    desiredStartDate &&
    compareYmd(desiredStartDate, nextAvailableStartDate) < 0 &&
    !settings.allowSellerScheduleOverride
  ) {
    capacityStatus = "blocked";
  }

  const projectedFinishDate =
    desiredStartDate && estimatedDays > 0
      ? projectFinishFromStart(desiredStartDate, estimatedDays, settings)
      : estimatedDays > 0 && nextAvailableStartDate
        ? projectFinishFromStart(nextAvailableStartDate, estimatedDays, settings)
        : null;

  const bufferDays = settings.scheduleBufferDays;
  const reason = summary.guidance_message || buildCapacityReason(projects.length, maxRemaining, bufferDays);

  return {
    ok: true,
    next_available_start_date: nextAvailableStartDate,
    blocked_dates: blockedDates,
    reason,
    availability_message: summary.availability_message,
    guidance_message: summary.guidance_message,
    remaining_days: round2(Math.max(0, maxRemaining)),
    buffer_days: bufferDays,
    capacity_status: capacityStatus,
    crew_availability_mode: settings.crewAvailabilityMode,
    projected_finish_date: projectedFinishDate,
    schedule_settings: {
      workdays_enabled: settings.workdaysEnabled,
      crew_capacity: settings.crewCapacity,
      schedule_buffer_days: settings.scheduleBufferDays,
      allow_seller_schedule_override: settings.allowSellerScheduleOverride,
      crew_availability_mode: settings.crewAvailabilityMode,
    },
    active_project_count: projects.length,
    blocking_projects: blockingProjects.map((p) => ({
      project_id: p.project_id,
      project_name: p.project_name,
      target_finish_date: p.target_finish_date || null,
      occupation_end: p.occupation_end || null,
      completed_days: p.completed_days,
      estimated_days: p.estimated_days,
      progress_pct: p.progress_pct,
      completed_by_supervisor: Boolean(p.completed_by_supervisor),
      is_delayed: Boolean(p.is_delayed),
      conflict_with_desired: Boolean(p.conflict_with_desired),
    })),
    incomplete_reporting_projects: incompleteReportingProjects.map((p) => ({
      project_id: p.project_id,
      project_name: p.project_name,
      target_finish_date: p.target_finish_date || null,
      completed_days: p.completed_days,
      estimated_days: p.estimated_days,
      progress_pct: p.progress_pct,
    })),
    project_analyses: projectAnalyses,
  };
}

module.exports = {
  DEFAULT_SCHEDULE,
  resolveScheduleSettings,
  loadScheduleSettingsForTenant,
  computeSalesCapacityCalendar,
  analyzeProjectForCrewAvailability,
  resolveCompletedDays,
  isCompletedBySupervisor,
  addBusinessDays,
  projectFinishFromStart,
  nextWorkdayOnOrAfter,
  normDate,
  todayYmdLocal,
};
