/**
 * Quoted labor plan normalizer + estimate economics (Phase 1).
 * Accepts legacy { name, type, days } and rich rows; never throws on bad input.
 */

const { calculateQuotePublishFinancials } = require("./pricing-engine");

const DEFAULT_HOURS_PER_DAY = 8;
const MAX_PLAN_ROWS = 50;

function clampNum(v, fallback = 0) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return n < 0 ? 0 : n;
}

function round2(n) {
  return Math.round(clampNum(n, 0) * 100) / 100;
}

function str(v, max = 500) {
  return String(v == null ? "" : v)
    .trim()
    .slice(0, max);
}

function normWorkerType(raw) {
  const t = str(raw, 32).toLowerCase();
  return t === "helper" || t === "assistant" ? "helper" : "installer";
}

function roleLabelFromType(type) {
  return normWorkerType(type) === "helper" ? "Helper" : "Installer";
}

function readDays(w) {
  if (!w || typeof w !== "object") return 0;
  if (w.budget_days != null && w.budget_days !== "") return clampNum(w.budget_days, 0);
  if (w.days != null && w.days !== "") return clampNum(w.days, 0);
  return 0;
}

function readHours(w, hoursPerDay) {
  if (!w || typeof w !== "object") return 0;
  if (w.budget_hours != null && w.budget_hours !== "") return clampNum(w.budget_hours, 0);
  const days = readDays(w);
  if (days > 0) return round2(days * hoursPerDay);
  return 0;
}

function readHourlyRate(w, type, settings) {
  if (!w || typeof w !== "object") return 0;
  if (w.hourly_rate != null && w.hourly_rate !== "") return clampNum(w.hourly_rate, 0);
  const hr = w.rate;
  if (hr !== "" && hr != null) return clampNum(hr, 0);
  const s = settings && typeof settings === "object" ? settings : {};
  return normWorkerType(type) === "helper"
    ? clampNum(s.baseHelper, 45)
    : clampNum(s.baseInstaller, 75);
}

function readDailyRate(w, type, hourlyRate, hoursPerDay) {
  if (!w || typeof w !== "object") return 0;
  if (w.daily_rate != null && w.daily_rate !== "") return clampNum(w.daily_rate, 0);
  if (hourlyRate > 0 && hoursPerDay > 0) return round2(hourlyRate * hoursPerDay);
  return 0;
}

function readEstimatedCost(w, days, hours, dailyRate, hourlyRate) {
  if (!w || typeof w !== "object") return 0;
  if (w.estimated_cost != null && w.estimated_cost !== "") return clampNum(w.estimated_cost, 0);
  if (dailyRate > 0 && days > 0) return round2(dailyRate * days);
  if (hourlyRate > 0 && hours > 0) return round2(hourlyRate * hours);
  return 0;
}

/**
 * @param {unknown} raw
 * @param {{ hoursPerDay?: number, settings?: object }} [opts]
 * @returns {Array<object>}
 */
function normalizeQuotedLaborPlan(raw, opts) {
  if (!Array.isArray(raw)) return [];
  const hoursPerDay = Math.max(clampNum(opts?.hoursPerDay, DEFAULT_HOURS_PER_DAY), 0.25);
  const settings = opts?.settings && typeof opts.settings === "object" ? opts.settings : {};
  const out = [];

  for (let i = 0; i < raw.length && out.length < MAX_PLAN_ROWS; i++) {
    const w = raw[i];
    if (!w || typeof w !== "object") continue;

    const type = normWorkerType(w.type);
    const role = str(w.role, 64) || roleLabelFromType(type);
    const name = str(w.name, 200) || role;
    const days = readDays(w);
    let hours = readHours(w, hoursPerDay);
    if (hours <= 0 && days > 0) hours = round2(days * hoursPerDay);

    const hourlyRate = readHourlyRate(w, type, settings);
    let dailyRate = readDailyRate(w, type, hourlyRate, hoursPerDay);
    if (dailyRate <= 0 && hourlyRate > 0) dailyRate = round2(hourlyRate * hoursPerDay);

    const estimatedCost = readEstimatedCost(w, days, hours, dailyRate, hourlyRate);

    if (days <= 0 && hours <= 0 && estimatedCost <= 0) continue;

    const budgetDays = days > 0 ? days : hours > 0 ? round2(hours / hoursPerDay) : 0;
    const budgetHours = hours > 0 ? hours : budgetDays > 0 ? round2(budgetDays * hoursPerDay) : 0;

    out.push({
      role,
      name,
      type,
      budget_days: round2(budgetDays),
      budget_hours: round2(budgetHours),
      daily_rate: round2(dailyRate),
      hourly_rate: round2(hourlyRate),
      estimated_cost: round2(estimatedCost > 0 ? estimatedCost : dailyRate * budgetDays || hourlyRate * budgetHours),
      days: round2(budgetDays),
    });
  }

  return out;
}

function planHasRows(plan) {
  return Array.isArray(plan) && plan.length > 0;
}

function isPlanEffectivelyEmpty(plan) {
  if (!Array.isArray(plan) || !plan.length) return true;
  return plan.every((row) => {
    if (!row || typeof row !== "object") return true;
    const days = clampNum(row.budget_days ?? row.days, 0);
    const cost = clampNum(row.estimated_cost, 0);
    return days <= 0 && cost <= 0;
  });
}

function laborCostFromPlan(plan) {
  if (!Array.isArray(plan)) return 0;
  return round2(plan.reduce((s, row) => s + clampNum(row?.estimated_cost, 0), 0));
}

/**
 * @param {object} params
 * @param {Array} params.workers
 * @param {object} [params.settings]
 * @param {number} [params.salePrice]
 * @param {number} [params.hoursPerDay]
 * @param {number} [params.estimatedLaborCost]
 * @param {number} [params.estimatedMaterialCost]
 * @param {number} [params.estimatedProfit]
 * @param {number} [params.estimatedProfitMargin]
 */
function buildEstimateEconomics(params) {
  const p = params && typeof params === "object" ? params : {};
  const hoursPerDay = Math.max(clampNum(p.hoursPerDay, DEFAULT_HOURS_PER_DAY), 0.25);
  const settings = p.settings && typeof p.settings === "object" ? p.settings : {};
  const workers = Array.isArray(p.workers) ? p.workers : [];
  const salePrice = clampNum(p.salePrice, 0);

  const quotedLaborPlan = normalizeQuotedLaborPlan(workers, { hoursPerDay, settings });
  const planLabor = laborCostFromPlan(quotedLaborPlan);

  let financials = null;
  if (workers.length) {
    try {
      financials = calculateQuotePublishFinancials(
        {
          workers,
          price: salePrice > 0 ? salePrice : undefined,
          _manualPriceTouched: salePrice > 0,
        },
        settings
      );
    } catch (_e) {
      financials = null;
    }
  }

  let estimatedLaborCost = clampNum(p.estimatedLaborCost, NaN);
  if (!Number.isFinite(estimatedLaborCost)) {
    estimatedLaborCost =
      financials && Number.isFinite(Number(financials.labor))
        ? clampNum(financials.labor, 0)
        : planLabor;
  }

  let estimatedMaterialCost = clampNum(p.estimatedMaterialCost, 0);

  let estimatedProfit = clampNum(p.estimatedProfit, NaN);
  let estimatedProfitMargin = clampNum(p.estimatedProfitMargin, NaN);

  if (!Number.isFinite(estimatedProfit) && financials && salePrice > 0) {
    const internalCost =
      clampNum(financials.before_profit, 0) + clampNum(financials.reserve, 0);
    estimatedProfit = round2(salePrice - internalCost - estimatedMaterialCost);
  } else if (!Number.isFinite(estimatedProfit) && salePrice > 0) {
    estimatedProfit = round2(salePrice - estimatedLaborCost - estimatedMaterialCost);
  } else if (!Number.isFinite(estimatedProfit)) {
    estimatedProfit = 0;
  }

  if (!Number.isFinite(estimatedProfitMargin) && salePrice > 0) {
    estimatedProfitMargin = round2(estimatedProfit / salePrice);
  } else if (!Number.isFinite(estimatedProfitMargin)) {
    estimatedProfitMargin = 0;
  }

  return {
    quotedLaborPlan,
    estimatedLaborCost: round2(estimatedLaborCost),
    estimatedMaterialCost: round2(estimatedMaterialCost),
    estimatedProfit: round2(estimatedProfit),
    estimatedProfitMargin: round2(estimatedProfitMargin),
    financials,
  };
}

function extractWorkersFromUnknown(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && Array.isArray(value.workers)) return value.workers;
  return null;
}

/**
 * Pull worker lines from a quote row (best-effort; quotes schema varies).
 * @param {object} quoteRow
 * @returns {Array|null}
 */
function extractWorkersFromQuoteRow(quoteRow) {
  if (!quoteRow || typeof quoteRow !== "object") return null;
  const keys = [
    "workers",
    "sales_workers",
    "quoted_labor_plan",
    "labor_plan",
    "pricing_payload",
    "estimate_payload",
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
    const workers = extractWorkersFromUnknown(raw);
    if (workers && workers.length) return workers;
  }
  return null;
}

function extractSettingsFromSnapshotPayload(payload) {
  if (!payload || typeof payload !== "object") return {};
  const storage =
    payload.storage && typeof payload.storage === "object" ? payload.storage : {};
  const mg =
    storage.mg_settings_v2 && typeof storage.mg_settings_v2 === "object"
      ? storage.mg_settings_v2
      : {};
  return mg;
}

/**
 * Find workers in tenant snapshot storage for a quote id (sales/owner drafts).
 * @param {object} payload - tenant_snapshots.payload
 * @param {string} quoteId
 * @returns {{ workers: Array, settings: object }|null}
 */
function extractWorkersFromSnapshotPayload(payload, quoteId) {
  if (!payload || typeof payload !== "object") return null;
  const qid = str(quoteId, 128).toLowerCase();
  if (!qid) return null;

  const storage =
    payload.storage && typeof payload.storage === "object" ? payload.storage : {};
  const settings = extractSettingsFromSnapshotPayload(payload);
  const stateKeys = ["mg_sales_v2", "mg_owner_v2"];

  for (const key of stateKeys) {
    const state = storage[key];
    if (!state || typeof state !== "object") continue;
    const stateQuote = str(state.quoteId ?? state.quote_id, 128).toLowerCase();
    if (stateQuote && stateQuote === qid && Array.isArray(state.workers) && state.workers.length) {
      return { workers: state.workers, settings, source: key };
    }
  }

  for (const key of stateKeys) {
    const state = storage[key];
    if (!state || typeof state !== "object") continue;
    if (Array.isArray(state.workers) && state.workers.length) {
      return { workers: state.workers, settings, source: key };
    }
  }

  return null;
}

/**
 * @param {object} existingProject - tenant_projects row subset
 * @param {Array} incomingPlan - normalized plan
 * @returns {boolean}
 */
function shouldLockLaborPlan(existingProject, incomingPlan) {
  if (existingProject?.quoted_labor_plan_locked_at) return false;
  return planHasRows(incomingPlan) && !isPlanEffectivelyEmpty(incomingPlan);
}

/**
 * @param {object} existingProject
 * @param {Array} incomingPlan
 * @returns {boolean} true if incoming plan may replace stored plan
 */
function mayWriteLaborPlan(existingProject, incomingPlan) {
  if (existingProject?.quoted_labor_plan_locked_at) return false;
  if (!planHasRows(incomingPlan) || isPlanEffectivelyEmpty(incomingPlan)) return false;
  const current = existingProject?.quoted_labor_plan;
  if (isPlanEffectivelyEmpty(current)) return true;
  return !existingProject?.quoted_labor_plan_locked_at;
}

module.exports = {
  DEFAULT_HOURS_PER_DAY,
  clampNum,
  round2,
  normalizeQuotedLaborPlan,
  planHasRows,
  isPlanEffectivelyEmpty,
  laborCostFromPlan,
  buildEstimateEconomics,
  extractWorkersFromQuoteRow,
  extractSettingsFromSnapshotPayload,
  extractWorkersFromSnapshotPayload,
  shouldLockLaborPlan,
  mayWriteLaborPlan,
  roleLabelFromType,
};
