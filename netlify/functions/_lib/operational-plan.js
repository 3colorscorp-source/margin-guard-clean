/**
 * Operational execution plan (field schedule) — no contract $, rates, or margin.
 */

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function round2(n) {
  return Math.round(num(n, 0) * 100) / 100;
}

function str(v, max = 500) {
  return String(v == null ? "" : v)
    .trim()
    .slice(0, max);
}

const DEFAULT_HOURS_PER_DAY = 8;

const WORKER_TYPE_ALIASES = {
  pro: "pro",
  installer: "pro",
  professional: "pro",
  helper: "helper",
  assistant: "helper",
  asst: "helper",
};

function normWorkerType(raw) {
  const key = str(raw, 64).toLowerCase();
  return WORKER_TYPE_ALIASES[key] || "pro";
}

function normRoleLabel(raw, workerType) {
  const r = str(raw, 120);
  if (r) return r;
  return workerType === "helper" ? "Assistant" : "Installer";
}

function normalizeWorker(row, hoursPerDay) {
  if (!row || typeof row !== "object") return null;
  const worker_type = normWorkerType(row.worker_type ?? row.type);
  const hpd = Math.max(num(hoursPerDay, DEFAULT_HOURS_PER_DAY), 0.25);
  let estimated_hours = num(row.estimated_hours ?? row.hours, NaN);
  if (!Number.isFinite(estimated_hours) || estimated_hours <= 0) {
    const days = num(row.estimated_days ?? row.days ?? row.crew_days, NaN);
    if (Number.isFinite(days) && days > 0) {
      estimated_hours = round2(days * hpd);
    } else {
      const units = num(row.planned_units, NaN);
      if (Number.isFinite(units) && units > 0) {
        estimated_hours = round2(units * hpd);
      }
    }
  }
  estimated_hours = Math.max(0, round2(estimated_hours));
  if (estimated_hours <= 0) return null;
  return {
    role: normRoleLabel(row.role, worker_type),
    worker_type,
    estimated_hours,
  };
}

function normalizeDay(row, fallbackDayNumber, hoursPerDay) {
  if (!row || typeof row !== "object") return null;
  const day_number = Math.max(
    1,
    Math.floor(num(row.day_number, fallbackDayNumber))
  );
  const phase = str(row.phase, 240) || `Day ${day_number}`;
  const workersIn = Array.isArray(row.workers)
    ? row.workers
    : Array.isArray(row.crew)
      ? row.crew
      : [];
  const workers = workersIn
    .map((w) => normalizeWorker(w, hoursPerDay))
    .filter(Boolean);
  if (!workers.length) return null;
  return { day_number, phase, workers };
}

/**
 * @param {Array|object} input - array of days or { days, estimated_days_override }
 * @param {number|null} estimatedDaysOverride
 * @param {number} [hoursPerDay]
 * @returns {Array<{day_number, phase, workers}>}
 */
function normalizeOperationalPlan(input, estimatedDaysOverride = null, hoursPerDay = DEFAULT_HOURS_PER_DAY) {
  let daysRaw = input;
  let override = estimatedDaysOverride;

  if (input && typeof input === "object" && !Array.isArray(input)) {
    daysRaw = input.days ?? input.operational_plan ?? input.plan ?? [];
    if (input.estimated_days_override != null && input.estimated_days_override !== "") {
      override = num(input.estimated_days_override, NaN);
    }
  }

  const hpd = Math.max(num(hoursPerDay, DEFAULT_HOURS_PER_DAY), 0.25);
  const days = Array.isArray(daysRaw) ? daysRaw : [];
  const out = [];
  let i = 0;
  for (const row of days) {
    i += 1;
    const day = normalizeDay(row, i, hpd);
    if (day) out.push(day);
  }
  out.sort((a, b) => a.day_number - b.day_number);
  return out;
}

function planHasDays(plan) {
  return Array.isArray(plan) && plan.length > 0;
}

/** Parse operational_plan from PostgREST jsonb (array or JSON string). */
function parseOperationalPlanJsonb(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object" && Array.isArray(raw.days)) return raw.days;
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      return parseOperationalPlanJsonb(parsed);
    } catch (_e) {
      return [];
    }
  }
  return [];
}

/** Field-facing crew label for Supervisor (no financial data). */
function crewSummaryFromOperationalPlan(plan) {
  const roles = new Set();
  for (const day of Array.isArray(plan) ? plan : []) {
    for (const w of day?.workers || day?.crew || []) {
      const r = str(w?.role || w?.worker_type, 120);
      if (r) roles.add(r);
    }
  }
  if (!roles.size) return "";
  return [...roles].join(" + ");
}

/**
 * @param {Array} normalizedPlan - output of normalizeOperationalPlan (array only)
 * @param {number|null} estimatedDaysOverride
 * @param {number|null} [estimatedHoursOverride]
 * @param {number} [hoursPerDay]
 */
function scheduledDayNumbersSet(normalizedPlan) {
  const set = new Set();
  for (const day of Array.isArray(normalizedPlan) ? normalizedPlan : []) {
    const dn = Math.max(1, Math.floor(num(day?.day_number, 0)));
    if (dn > 0) set.add(dn);
  }
  return set;
}

/**
 * Execution progress from operational_plan + day_progress (Financial Detail / owner read model).
 * scheduledDays follows computeOperationalPlanMetrics (max day_number convention, same as Supervisor).
 * @returns {object|null}
 */
function computeOperationalPlanExecutionState(
  normalizedPlan,
  dayProgressRows,
  hoursPerDay = DEFAULT_HOURS_PER_DAY,
  estimatedDaysOverride = null
) {
  if (!planHasDays(normalizedPlan)) return null;

  const hpd = Math.max(num(hoursPerDay, DEFAULT_HOURS_PER_DAY), 0.25);
  const metrics = computeOperationalPlanMetrics(
    normalizedPlan,
    estimatedDaysOverride,
    null,
    hpd
  );
  const scheduledDays = metrics.estimated_days;
  const scheduledSet = scheduledDayNumbersSet(normalizedPlan);

  let totalCompletedRows = 0;
  const completedUnique = new Set();
  const completedScheduledUnique = new Set();

  for (const row of Array.isArray(dayProgressRows) ? dayProgressRows : []) {
    if (!row || typeof row !== "object") continue;
    const status = str(row.status, 32).toLowerCase();
    if (status !== "completed") continue;
    const dn = Math.max(1, Math.floor(num(row.day_number, 0)));
    if (dn <= 0) continue;
    totalCompletedRows += 1;
    completedUnique.add(dn);
    if (scheduledSet.has(dn)) completedScheduledUnique.add(dn);
  }

  const completedScheduledDays = completedScheduledUnique.size;
  const progressPct =
    scheduledDays > 0
      ? Math.round((completedScheduledDays / scheduledDays) * 100)
      : null;

  let overScheduled = false;
  if (scheduledDays > 0 && totalCompletedRows > scheduledDays) {
    overScheduled = true;
  }
  if (!overScheduled) {
    for (const dn of completedUnique) {
      if (!scheduledSet.has(dn)) {
        overScheduled = true;
        break;
      }
    }
  }

  return {
    estimated_days: scheduledDays,
    estimated_hours: metrics.estimated_hours,
    completed_days: totalCompletedRows,
    completed_scheduled_days: completedScheduledDays,
    days_remaining: round2(Math.max(0, scheduledDays - completedScheduledDays)),
    completion_pace_pct: progressPct,
    over_scheduled_days: overScheduled,
    progress_source: "operational_plan",
  };
}

function computeOperationalPlanMetrics(
  normalizedPlan,
  estimatedDaysOverride = null,
  estimatedHoursOverride = null,
  hoursPerDay = DEFAULT_HOURS_PER_DAY
) {
  const days = Array.isArray(normalizedPlan) ? normalizedPlan : [];
  const hpd = Math.max(num(hoursPerDay, DEFAULT_HOURS_PER_DAY), 0.25);
  const maxDay = days.reduce((mx, d) => Math.max(mx, num(d?.day_number, 0)), 0);

  let estimated_hours = 0;
  const roleKeys = new Set();

  for (const day of days) {
    const workers = Array.isArray(day?.workers)
      ? day.workers
      : Array.isArray(day?.crew)
        ? day.crew
        : [];
    for (const w of workers) {
      estimated_hours += num(w?.estimated_hours, 0);
      const key = `${normWorkerType(w?.worker_type)}::${normRoleLabel(w?.role, w?.worker_type)}`;
      roleKeys.add(key);
    }
  }
  estimated_hours = round2(estimated_hours);

  const daysOv = Number.isFinite(estimatedDaysOverride) ? estimatedDaysOverride : NaN;
  const hoursOv = Number.isFinite(estimatedHoursOverride) ? estimatedHoursOverride : NaN;

  let estimated_days =
    Number.isFinite(daysOv) && daysOv > 0 ? round2(daysOv) : round2(maxDay);

  if (Number.isFinite(hoursOv) && hoursOv > 0) {
    estimated_hours = round2(hoursOv);
  }

  if ((!Number.isFinite(daysOv) || daysOv <= 0) && estimated_hours > 0 && maxDay <= 0) {
    estimated_days = round2(estimated_hours / hpd);
  }

  return {
    estimated_days,
    estimated_hours,
    worker_count: roleKeys.size,
    max_day_number: round2(maxDay),
  };
}

/**
 * Supervisor-safe view: schedule only (no costs).
 */
function operationalPlanForSupervisorVisibility(plan) {
  const daysRaw = Array.isArray(plan) ? plan : [];
  const normalized = normalizeOperationalPlan(plan);
  return normalized.map((day, idx) => {
    const raw =
      daysRaw.find((d) => Math.floor(num(d?.day_number, 0)) === day.day_number) ||
      daysRaw[idx] ||
      null;
    const tasks = Array.isArray(raw?.tasks)
      ? raw.tasks.map((t) => str(t, 500)).filter(Boolean)
      : [];
    const out = {
      day_number: day.day_number,
      phase: day.phase,
      workers: (day.workers || []).map((w) => ({
        role: w.role,
        worker_type: w.worker_type,
        estimated_hours: w.estimated_hours,
      })),
    };
    if (tasks.length) out.tasks = tasks;
    return out;
  });
}

function extractOperationalPlanFromUnknown(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    if (Array.isArray(value.operational_plan)) return value.operational_plan;
    if (Array.isArray(value.days)) return value.days;
  }
  return null;
}

function extractOperationalPlanFromQuoteRow(quoteRow) {
  if (!quoteRow || typeof quoteRow !== "object") return null;
  const keys = [
    "operational_plan",
    "operationalPlan",
    "estimate_payload",
    "pricing_payload",
    "payload",
  ];
  for (const key of keys) {
    let raw = quoteRow[key];
    if (typeof raw === "string" && raw.trim()) {
      try {
        raw = JSON.parse(raw);
      } catch (_e) {
        continue;
      }
    }
    const plan = extractOperationalPlanFromUnknown(raw);
    if (plan && plan.length) return plan;
    if (raw && typeof raw === "object" && raw.operational_plan) {
      const nested = extractOperationalPlanFromUnknown(raw);
      if (nested && nested.length) return nested;
    }
  }
  return null;
}

function extractOperationalPlanFromSnapshotPayload(payload, quoteId) {
  if (!payload || typeof payload !== "object") return null;
  const qid = str(quoteId, 128).toLowerCase();
  const storage =
    payload.storage && typeof payload.storage === "object" ? payload.storage : {};
  const stateKeys = ["mg_sales_v2", "mg_owner_v2"];

  for (const key of stateKeys) {
    const state = storage[key];
    if (!state || typeof state !== "object") continue;
    const stateQuote = str(state.quoteId ?? state.quote_id, 128).toLowerCase();
    if (stateQuote && qid && stateQuote !== qid) continue;
    const plan = extractOperationalPlanFromUnknown(state.operational_plan);
    if (plan && plan.length) {
      return {
        plan,
        override: state.operational_estimated_days_override ?? null,
      };
    }
  }
  return null;
}

/** Quick templates (prefill for Sales UI). */
const OPERATIONAL_PLAN_TEMPLATES = {
  master_bathroom_5: {
    label: "Master Bathroom — 5 days",
    estimated_days_override: null,
    days: [
      { day_number: 1, phase: "Demo + prep", workers: [{ role: "Installer", worker_type: "pro", estimated_hours: 8 }, { role: "Assistant", worker_type: "helper", estimated_hours: 8 }] },
      { day_number: 2, phase: "Prep + waterproofing", workers: [{ role: "Installer", worker_type: "pro", estimated_hours: 8 }, { role: "Assistant", worker_type: "helper", estimated_hours: 8 }] },
      { day_number: 3, phase: "Wall tile installation", workers: [{ role: "Installer", worker_type: "pro", estimated_hours: 8 }, { role: "Assistant", worker_type: "helper", estimated_hours: 8 }] },
      { day_number: 4, phase: "Grout + details", workers: [{ role: "Installer", worker_type: "pro", estimated_hours: 8 }] },
      { day_number: 5, phase: "Cleanup + punch", workers: [{ role: "Assistant", worker_type: "helper", estimated_hours: 6 }] },
    ],
  },
  kitchen_backsplash_2: {
    label: "Kitchen Backsplash — 2 days",
    days: [
      { day_number: 1, phase: "Prep + layout", workers: [{ role: "Installer", worker_type: "pro", estimated_hours: 8 }] },
      { day_number: 2, phase: "Install + grout", workers: [{ role: "Installer", worker_type: "pro", estimated_hours: 8 }, { role: "Assistant", worker_type: "helper", estimated_hours: 4 }] },
    ],
  },
  commercial_restroom_7: {
    label: "Commercial Restroom — 7 days",
    days: [
      { day_number: 1, phase: "Mobilize + demo", workers: [{ role: "Installer", worker_type: "pro", estimated_hours: 8 }, { role: "Assistant", worker_type: "helper", estimated_hours: 8 }] },
      { day_number: 2, phase: "Rough prep", workers: [{ role: "Installer", worker_type: "pro", estimated_hours: 8 }, { role: "Assistant", worker_type: "helper", estimated_hours: 8 }] },
      { day_number: 3, phase: "Waterproof / substrate", workers: [{ role: "Installer", worker_type: "pro", estimated_hours: 8 }] },
      { day_number: 4, phase: "Wall tile", workers: [{ role: "Installer", worker_type: "pro", estimated_hours: 8 }, { role: "Assistant", worker_type: "helper", estimated_hours: 8 }] },
      { day_number: 5, phase: "Floor tile", workers: [{ role: "Installer", worker_type: "pro", estimated_hours: 8 }, { role: "Assistant", worker_type: "helper", estimated_hours: 8 }] },
      { day_number: 6, phase: "Grout + seal", workers: [{ role: "Installer", worker_type: "pro", estimated_hours: 8 }] },
      { day_number: 7, phase: "Punch + turnover", workers: [{ role: "Assistant", worker_type: "helper", estimated_hours: 8 }] },
    ],
  },
  shower_remodel_4: {
    label: "Shower Remodel — 4 days",
    days: [
      { day_number: 1, phase: "Demo + prep", workers: [{ role: "Installer", worker_type: "pro", estimated_hours: 8 }] },
      { day_number: 2, phase: "Waterproof + pan", workers: [{ role: "Installer", worker_type: "pro", estimated_hours: 8 }, { role: "Assistant", worker_type: "helper", estimated_hours: 6 }] },
      { day_number: 3, phase: "Tile install", workers: [{ role: "Installer", worker_type: "pro", estimated_hours: 8 }] },
      { day_number: 4, phase: "Grout + glass prep", workers: [{ role: "Installer", worker_type: "pro", estimated_hours: 6 }] },
    ],
  },
  large_format_tile_6: {
    label: "Large Format Tile — 6 days",
    days: [
      { day_number: 1, phase: "Layout + prep", workers: [{ role: "Installer", worker_type: "pro", estimated_hours: 8 }, { role: "Assistant", worker_type: "helper", estimated_hours: 8 }] },
      { day_number: 2, phase: "Floor prep", workers: [{ role: "Installer", worker_type: "pro", estimated_hours: 8 }] },
      { day_number: 3, phase: "Large format set — day 1", workers: [{ role: "Installer", worker_type: "pro", estimated_hours: 8 }, { role: "Assistant", worker_type: "helper", estimated_hours: 8 }] },
      { day_number: 4, phase: "Large format set — day 2", workers: [{ role: "Installer", worker_type: "pro", estimated_hours: 8 }] },
      { day_number: 5, phase: "Grout", workers: [{ role: "Installer", worker_type: "pro", estimated_hours: 8 }] },
      { day_number: 6, phase: "Detail + cleanup", workers: [{ role: "Assistant", worker_type: "helper", estimated_hours: 6 }] },
    ],
  },
};

function normIsoDate(raw) {
  const t = str(raw, 32).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null;
}

function readQuoteOperationalDaysOverride(quoteRow) {
  const raw =
    quoteRow?.operational_estimated_days_override ??
    quoteRow?.estimated_days_override ??
    quoteRow?.operationalEstimatedDaysOverride;
  if (raw == null || raw === "") return null;
  const n = num(raw, NaN);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function readQuoteOperationalHoursOverride(quoteRow) {
  const raw =
    quoteRow?.operational_estimated_hours_override ??
    quoteRow?.estimated_hours_override ??
    quoteRow?.operationalEstimatedHoursOverride;
  if (raw == null || raw === "") return null;
  const n = num(raw, NaN);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function scheduleFieldsFromQuoteRow(quoteRow) {
  if (!quoteRow || typeof quoteRow !== "object") {
    return { start_date: null, due_date: null };
  }
  return {
    start_date: normIsoDate(quoteRow.start_date ?? quoteRow.startDate),
    due_date: normIsoDate(
      quoteRow.due_date ?? quoteRow.target_finish_date ?? quoteRow.dueDate
    ),
  };
}

/** Hourly rate from Business Settings — installer/pro vs assistant/helper only. */
function hourlyRateForPlanWorker(worker, settings) {
  const settingsObj = settings && typeof settings === "object" ? settings : {};
  if (worker?.hourly_rate != null && worker?.hourly_rate !== "") {
    return Math.max(0, round2(num(worker.hourly_rate, 0)));
  }
  const wt = normWorkerType(worker?.worker_type ?? worker?.type);
  return wt === "helper"
    ? Math.max(0, round2(num(settingsObj.baseHelper, 45)))
    : Math.max(0, round2(num(settingsObj.baseInstaller, 75)));
}

/**
 * Sum labor cost across every worker on every operational plan day.
 * hours × Business Settings rate (no contract revenue).
 */
function laborCostFromOperationalPlan(normalizedPlan, settings) {
  const days = Array.isArray(normalizedPlan) ? normalizedPlan : [];
  let total = 0;
  for (const day of days) {
    for (const w of day?.workers || []) {
      const hours = num(w?.estimated_hours, 0);
      if (hours <= 0) continue;
      total += hours * hourlyRateForPlanWorker(w, settings);
    }
  }
  return round2(total);
}

/**
 * Labor metrics for completed scheduled days only (Supervisor day progress).
 * @param {Array} normalizedPlan
 * @param {Set<number>|Array<number>} completedDayNumbers
 * @param {object} settings - mg_settings_v2
 * @param {number} [hoursPerDay]
 * @returns {{ labor_cost: number, hours: number, days: number, pro_hours: number, assistant_hours: number }}
 */
function laborMetricsForCompletedOperationalDays(
  normalizedPlan,
  completedDayNumbers,
  settings,
  hoursPerDay = DEFAULT_HOURS_PER_DAY
) {
  const completed =
    completedDayNumbers instanceof Set
      ? completedDayNumbers
      : new Set(
          (Array.isArray(completedDayNumbers) ? completedDayNumbers : [])
            .map((d) => Math.max(1, Math.floor(num(d, 0))))
            .filter((d) => d > 0)
        );
  const days = Array.isArray(normalizedPlan) ? normalizedPlan : [];
  let laborCost = 0;
  let totalHours = 0;
  let proHours = 0;
  let assistantHours = 0;

  for (const day of days) {
    const dn = Math.max(1, Math.floor(num(day?.day_number, 0)));
    if (!completed.has(dn)) continue;
    for (const w of day?.workers || []) {
      const hours = num(w?.estimated_hours, 0);
      if (hours <= 0) continue;
      const rate = hourlyRateForPlanWorker(w, settings);
      laborCost += hours * rate;
      totalHours += hours;
      const wt = normWorkerType(w?.worker_type ?? w?.type);
      if (wt === "helper") assistantHours += hours;
      else proHours += hours;
    }
  }

  return {
    labor_cost: round2(laborCost),
    hours: round2(totalHours),
    days: completed.size,
    pro_hours: round2(proHours),
    assistant_hours: round2(assistantHours),
  };
}

/**
 * Flat quoted_labor_plan rows — one row per worker per day with estimated_cost.
 */
function quotedLaborPlanRowsFromOperationalPlan(
  normalizedPlan,
  settings,
  hoursPerDay = DEFAULT_HOURS_PER_DAY
) {
  const hpd = Math.max(num(hoursPerDay, DEFAULT_HOURS_PER_DAY), 0.25);
  const days = Array.isArray(normalizedPlan) ? normalizedPlan : [];
  const out = [];
  for (const day of days) {
    for (const w of day?.workers || []) {
      const hours = num(w?.estimated_hours, 0);
      if (hours <= 0) continue;
      const wt = normWorkerType(w.worker_type);
      const rate = hourlyRateForPlanWorker(w, settings);
      const budgetDays = round2(hours / hpd);
      const cost = round2(hours * rate);
      out.push({
        role: w.role,
        name: w.role,
        type: wt === "helper" ? "helper" : "installer",
        worker_type: wt,
        day_number: day.day_number,
        budget_days: budgetDays,
        budget_hours: round2(hours),
        hourly_rate: round2(rate),
        daily_rate: round2(rate * hpd),
        estimated_cost: cost,
        days: budgetDays,
      });
    }
  }
  return out;
}

async function resolveOperationalPlanForQuote(quoteRow, loadSnapshotPayload) {
  if (!quoteRow || typeof quoteRow !== "object") return null;

  let plan = extractOperationalPlanFromQuoteRow(quoteRow);
  let override = readQuoteOperationalDaysOverride(quoteRow);
  let hoursOverride = readQuoteOperationalHoursOverride(quoteRow);
  const schedule = scheduleFieldsFromQuoteRow(quoteRow);

  if (!plan || !plan.length) {
    const tenantId = String(quoteRow.tenant_id || "").trim();
    const quoteId = String(quoteRow.id || "").trim();
    if (tenantId && typeof loadSnapshotPayload === "function") {
      const payload = await loadSnapshotPayload(tenantId);
      const hit = extractOperationalPlanFromSnapshotPayload(payload, quoteId);
      if (hit?.plan?.length) {
        plan = hit.plan;
        override =
          hit.override == null || hit.override === ""
            ? null
            : num(hit.override, NaN);
      }
    }
  }

  if (!plan || !plan.length) return null;
  return {
    plan,
    override: Number.isFinite(override) && override > 0 ? override : null,
    hoursOverride:
      Number.isFinite(hoursOverride) && hoursOverride > 0 ? hoursOverride : null,
    start_date: schedule.start_date,
    due_date: schedule.due_date,
  };
}

module.exports = {
  normalizeOperationalPlan,
  computeOperationalPlanMetrics,
  computeOperationalPlanExecutionState,
  scheduledDayNumbersSet,
  operationalPlanForSupervisorVisibility,
  parseOperationalPlanJsonb,
  crewSummaryFromOperationalPlan,
  planHasDays,
  hourlyRateForPlanWorker,
  laborCostFromOperationalPlan,
  laborMetricsForCompletedOperationalDays,
  quotedLaborPlanRowsFromOperationalPlan,
  extractOperationalPlanFromQuoteRow,
  extractOperationalPlanFromSnapshotPayload,
  resolveOperationalPlanForQuote,
  readQuoteOperationalDaysOverride,
  readQuoteOperationalHoursOverride,
  scheduleFieldsFromQuoteRow,
  normIsoDate,
  OPERATIONAL_PLAN_TEMPLATES,
};
