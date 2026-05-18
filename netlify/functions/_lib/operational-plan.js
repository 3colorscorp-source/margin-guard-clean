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
  const workersIn = Array.isArray(row.workers) ? row.workers : [];
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
    for (const w of day?.workers || []) {
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
    const workers = Array.isArray(day?.workers) ? day.workers : [];
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
  const normalized = normalizeOperationalPlan(plan);
  return normalized.map((day) => ({
    day_number: day.day_number,
    phase: day.phase,
    workers: (day.workers || []).map((w) => ({
      role: w.role,
      worker_type: w.worker_type,
      estimated_hours: w.estimated_hours,
    })),
  }));
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

/**
 * Resolve operational plan from quote row and tenant snapshot (accept / bridge).
 */
async function resolveOperationalPlanForQuote(quoteRow, loadSnapshotPayload) {
  if (!quoteRow || typeof quoteRow !== "object") return null;

  let plan = extractOperationalPlanFromQuoteRow(quoteRow);
  let override = null;

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
  };
}

module.exports = {
  normalizeOperationalPlan,
  computeOperationalPlanMetrics,
  operationalPlanForSupervisorVisibility,
  parseOperationalPlanJsonb,
  crewSummaryFromOperationalPlan,
  planHasDays,
  extractOperationalPlanFromQuoteRow,
  extractOperationalPlanFromSnapshotPayload,
  resolveOperationalPlanForQuote,
  OPERATIONAL_PLAN_TEMPLATES,
};
