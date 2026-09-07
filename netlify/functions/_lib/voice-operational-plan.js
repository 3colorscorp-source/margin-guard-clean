/**
 * Voice Operational Plan Builder — Phase 1 structured document.
 * Keyboard/preview only. No STT. No tenant rates inside the document.
 */

const {
  nextWorkdayOnOrAfter,
  addBusinessDays,
  projectFinishFromStart,
  normDate,
} = require("./sales-capacity-calendar");

const SCHEMA_VERSION = 1;
const DEFAULT_HOURS_PER_DAY = 8;
const RATE_KEYS = new Set([
  "hourly_rate",
  "daily_rate",
  "rate",
  "estimated_cost",
  "baseInstaller",
  "baseHelper",
  "sale_price",
  "labor_rate",
  "cost",
]);

const PUBLIC_FORBIDDEN_KEYS = [
  "internal_operational_plan",
  "internal_notes",
  "internal_tasks",
  "worker_assignments",
  "worker_count",
  "hours_per_worker",
  "materials_or_tools",
  "dependencies",
  "gc_client_responsibilities",
  "risks",
  "hourly_rate",
  "daily_rate",
];

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function round2(n) {
  return Math.round(num(n, 0) * 100) / 100;
}

function str(v, max = 4000) {
  return String(v == null ? "" : v)
    .trim()
    .slice(0, max);
}

function newStableId(prefix) {
  const p = String(prefix || "id").replace(/[^a-z0-9_]/gi, "") || "id";
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${p}_${crypto.randomUUID()}`;
  }
  return `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value == null ? {} : value));
}

function stripRateFields(value) {
  if (Array.isArray(value)) return value.map(stripRateFields);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (RATE_KEYS.has(k)) continue;
    out[k] = stripRateFields(v);
  }
  return out;
}

function normWorkerType(roleOrType) {
  const key = str(roleOrType, 64).toLowerCase();
  if (key === "helper" || key === "assistant" || key === "asst") return "helper";
  return "pro";
}

function normWorkerRole(raw, workerType) {
  const r = str(raw, 120);
  if (r) return r;
  return workerType === "helper" ? "Assistant" : "Installer";
}

function scheduleSettings(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    workdaysEnabled: src.workdaysEnabled !== false && src.workdays_enabled !== false,
  };
}

function snapStartDate(startYmd, settings) {
  const start = normDate(startYmd);
  if (!start) return null;
  return nextWorkdayOnOrAfter(start, scheduleSettings(settings));
}

function dateForDayNumber(snappedStart, dayNumber, settings) {
  const start = normDate(snappedStart);
  if (!start) return null;
  const n = Math.max(1, Math.floor(num(dayNumber, 1)));
  if (n === 1) return start;
  return addBusinessDays(start, n - 1, scheduleSettings(settings));
}

function estimatedDaysFromDays(days) {
  const list = Array.isArray(days) ? days : [];
  let max = 0;
  for (const day of list) {
    max = Math.max(max, Math.floor(num(day && day.day_number, 0)));
  }
  return max;
}

function finishFromStartAndDays(startYmd, estimatedDays, settings) {
  const days = Math.max(1, Math.ceil(num(estimatedDays, 1)));
  return projectFinishFromStart(startYmd, days, scheduleSettings(settings));
}

function normalizeTask(row, index) {
  if (typeof row === "string") {
    const label = str(row, 500);
    if (!label) return null;
    return { task_id: newStableId("task"), label };
  }
  if (!row || typeof row !== "object") return null;
  const label = str(row.label ?? row.text ?? row.task, 500);
  if (!label) return null;
  return {
    task_id: str(row.task_id, 80) || newStableId("task"),
    label,
    sort: Math.max(0, Math.floor(num(row.sort, index))),
  };
}

function normalizeAssignment(row) {
  if (!row || typeof row !== "object") return null;
  const worker_type = normWorkerType(row.worker_type ?? row.worker_role ?? row.role);
  const worker_role = normWorkerRole(row.worker_role ?? row.role, worker_type);
  const worker_count = Math.max(1, Math.floor(num(row.worker_count, 1)));
  const hours_per_worker = Math.max(0, round2(num(row.hours_per_worker ?? row.estimated_hours, 0)));
  if (hours_per_worker <= 0) return null;
  return {
    assignment_id: str(row.assignment_id, 80) || newStableId("asg"),
    worker_role,
    worker_type,
    worker_count,
    hours_per_worker,
  };
}

function normalizeStringList(raw, maxItem = 400, maxItems = 24) {
  const list = Array.isArray(raw) ? raw : raw == null || raw === "" ? [] : [raw];
  const out = [];
  for (const item of list) {
    const s = str(item, maxItem);
    if (s) out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}

function normalizeDay(row, fallbackNumber) {
  if (!row || typeof row !== "object") return null;
  const day_number = Math.max(1, Math.floor(num(row.day_number, fallbackNumber)));
  const internal_tasks = (Array.isArray(row.internal_tasks) ? row.internal_tasks : [])
    .map((t, i) => normalizeTask(t, i))
    .filter(Boolean);
  const worker_assignments = (Array.isArray(row.worker_assignments) ? row.worker_assignments : [])
    .map(normalizeAssignment)
    .filter(Boolean);
  if (!worker_assignments.length && Array.isArray(row.workers) && row.workers.length) {
    for (const w of row.workers) {
      const asg = normalizeAssignment({
        worker_role: w.role,
        worker_type: w.worker_type,
        worker_count: 1,
        hours_per_worker: w.estimated_hours,
      });
      if (asg) worker_assignments.push(asg);
    }
  }
  if (!internal_tasks.length && !worker_assignments.length && !str(row.client_scope, 2000) && !str(row.phase, 240)) {
    return null;
  }
  if (!worker_assignments.length) {
    worker_assignments.push({
      assignment_id: newStableId("asg"),
      worker_role: "Installer",
      worker_type: "pro",
      worker_count: 1,
      hours_per_worker: DEFAULT_HOURS_PER_DAY,
    });
  }
  const client_scope =
    str(row.client_scope, 2000) ||
    str(row.phase, 240) ||
    (internal_tasks[0] ? `Complete ${internal_tasks[0].label}.` : `Complete planned work for day ${day_number}.`);
  return {
    day_id: str(row.day_id, 80) || newStableId("day"),
    day_number,
    date: normDate(row.date) || null,
    client_scope,
    internal_tasks,
    worker_assignments,
    materials_or_tools: normalizeStringList(row.materials_or_tools),
    dependencies: normalizeStringList(row.dependencies),
    gc_client_responsibilities: normalizeStringList(row.gc_client_responsibilities),
    risks: normalizeStringList(row.risks),
    internal_notes: str(row.internal_notes, 4000),
  };
}

function createEmptyDay(dayNumber, hoursPerDay) {
  const hpd = Math.max(0.25, num(hoursPerDay, DEFAULT_HOURS_PER_DAY));
  return {
    day_id: newStableId("day"),
    day_number: Math.max(1, Math.floor(num(dayNumber, 1))),
    date: null,
    client_scope: "",
    internal_tasks: [{ task_id: newStableId("task"), label: "" }],
    worker_assignments: [
      {
        assignment_id: newStableId("asg"),
        worker_role: "Installer",
        worker_type: "pro",
        worker_count: 1,
        hours_per_worker: hpd,
      },
    ],
    materials_or_tools: [],
    dependencies: [],
    gc_client_responsibilities: [],
    risks: [],
    internal_notes: "",
  };
}

function sortDaysByNumber(days) {
  return (Array.isArray(days) ? days.slice() : []).sort(
    (a, b) => num(a.day_number, 0) - num(b.day_number, 0)
  );
}

function renumberDays(days) {
  return (Array.isArray(days) ? days.slice() : []).map((day, i) => ({
    ...day,
    day_number: i + 1,
  }));
}

function insertDayAfter(days, afterDayId, hoursPerDay) {
  const list = Array.isArray(days) ? days.slice() : [];
  const idx = list.findIndex((d) => d && d.day_id === afterDayId);
  const at = idx >= 0 ? idx + 1 : list.length;
  list.splice(at, 0, createEmptyDay(at + 1, hoursPerDay));
  return renumberDays(list);
}

function moveDay(days, dayId, direction) {
  const list = Array.isArray(days) ? days.slice() : [];
  const idx = list.findIndex((d) => d && d.day_id === dayId);
  if (idx < 0) return list;
  const next = idx + (direction < 0 ? -1 : 1);
  if (next < 0 || next >= list.length) return list;
  const copy = list.slice();
  const [row] = copy.splice(idx, 1);
  copy.splice(next, 0, row);
  return renumberDays(copy);
}

function deleteDay(days, dayId) {
  return renumberDays((Array.isArray(days) ? days : []).filter((d) => d && d.day_id !== dayId));
}

function applyScheduleToDays(days, startYmd, settings) {
  const snapped = snapStartDate(startYmd, settings);
  return (Array.isArray(days) ? days : []).map((day) => ({
    ...day,
    date: snapped ? dateForDayNumber(snapped, day.day_number, settings) : null,
  }));
}

function totalBudgetHours(days) {
  let hours = 0;
  for (const day of Array.isArray(days) ? days : []) {
    for (const asg of day.worker_assignments || []) {
      hours += num(asg.worker_count, 0) * num(asg.hours_per_worker, 0);
    }
  }
  return round2(hours);
}

function previewLaborCost(days, settings) {
  const s = settings && typeof settings === "object" ? settings : {};
  const installer = Math.max(0, num(s.baseInstaller, 0));
  const helper = Math.max(0, num(s.baseHelper, 0));
  let total = 0;
  for (const day of Array.isArray(days) ? days : []) {
    for (const asg of day.worker_assignments || []) {
      const rate = asg.worker_type === "helper" ? helper : installer;
      total += num(asg.worker_count, 0) * num(asg.hours_per_worker, 0) * rate;
    }
  }
  return round2(total);
}

function deriveLegacyOperationalPlan(doc) {
  const days = Array.isArray(doc && doc.days) ? doc.days : [];
  const out = [];
  for (const day of days) {
    const workers = [];
    for (const asg of day.worker_assignments || []) {
      const count = Math.max(1, Math.floor(num(asg.worker_count, 1)));
      for (let i = 0; i < count; i += 1) {
        workers.push({
          role: asg.worker_role,
          worker_type: asg.worker_type,
          estimated_hours: round2(num(asg.hours_per_worker, 0)),
        });
      }
    }
    if (!workers.length) continue;
    out.push({
      day_number: day.day_number,
      phase: str(day.client_scope, 240) || `Day ${day.day_number}`,
      workers,
    });
  }
  return out;
}

function buildPublicClientScope(doc) {
  const days = Array.isArray(doc && doc.days) ? doc.days : [];
  const lines = [];
  for (const day of days) {
    const text = str(day.client_scope, 2000);
    if (!text) continue;
    lines.push(`Day ${day.day_number}: ${text}`);
  }
  return {
    kind: "client_scope",
    schema_version: SCHEMA_VERSION,
    proposed_start_date: doc && doc.start_date ? doc.start_date : null,
    proposed_finish_date: doc && doc.due_date ? doc.due_date : null,
    days: days.map((d) => ({
      day_number: d.day_number,
      date: d.date || null,
      client_scope: str(d.client_scope, 2000),
    })),
    narrative: lines.join("\n"),
  };
}

function publicPayloadContainsInternal(value, seen) {
  if (value == null) return false;
  if (typeof value === "string") {
    return /internal_notes|worker_assignments|hours_per_worker|internal_operational_plan/.test(value);
  }
  if (typeof value !== "object") return false;
  const bag = seen || new Set();
  if (bag.has(value)) return false;
  bag.add(value);
  if (Array.isArray(value)) return value.some((v) => publicPayloadContainsInternal(v, bag));
  for (const key of Object.keys(value)) {
    if (PUBLIC_FORBIDDEN_KEYS.includes(key)) return true;
    if (publicPayloadContainsInternal(value[key], bag)) return true;
  }
  return false;
}

function scrubPublicPayload(input) {
  if (input == null || typeof input !== "object") return input;
  if (Array.isArray(input)) return input.map(scrubPublicPayload);
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (PUBLIC_FORBIDDEN_KEYS.includes(k) || RATE_KEYS.has(k)) continue;
    out[k] = scrubPublicPayload(v);
  }
  return out;
}

function hydrateFromLegacyOperationalPlan(legacyDays, startYmd, settings, hoursPerDay) {
  const hpd = Math.max(0.25, num(hoursPerDay, DEFAULT_HOURS_PER_DAY));
  const days = [];
  const src = Array.isArray(legacyDays) ? legacyDays : [];
  src.forEach((row, i) => {
    const day_number = Math.max(1, Math.floor(num(row && row.day_number, i + 1)));
    const workers = Array.isArray(row && row.workers) ? row.workers : [];
    const grouped = {};
    for (const w of workers) {
      const worker_type = normWorkerType(w.worker_type || w.role);
      const worker_role = normWorkerRole(w.role, worker_type);
      const hours = Math.max(0, round2(num(w.estimated_hours, hpd)));
      const key = `${worker_type}::${worker_role}::${hours}`;
      if (!grouped[key]) {
        grouped[key] = {
          assignment_id: newStableId("asg"),
          worker_role,
          worker_type,
          worker_count: 0,
          hours_per_worker: hours || hpd,
        };
      }
      grouped[key].worker_count += 1;
    }
    const phase = str(row && row.phase, 240);
    days.push({
      day_id: newStableId("day"),
      day_number,
      date: null,
      client_scope: phase,
      internal_tasks: phase ? [{ task_id: newStableId("task"), label: phase }] : [],
      worker_assignments: Object.values(grouped),
      materials_or_tools: [],
      dependencies: [],
      gc_client_responsibilities: [],
      risks: [],
      internal_notes: "",
    });
  });
  return normalizeDocument(
    {
      schema_version: SCHEMA_VERSION,
      source: "keyboard",
      days,
    },
    { startDate: startYmd, settings, hoursPerDay: hpd }
  );
}

function normalizeDocument(raw, options = {}) {
  const stripped = stripRateFields(raw && typeof raw === "object" ? raw : {});
  const settings = options.settings || {};
  const hpd = Math.max(0.25, num(options.hoursPerDay ?? stripped.hours_per_day_used, DEFAULT_HOURS_PER_DAY));
  const startIn = options.startDate || stripped.start_date;
  let days = (Array.isArray(stripped.days) ? stripped.days : [])
    .map((d, i) => normalizeDay(d, i + 1))
    .filter(Boolean);
  days = renumberDays(sortDaysByNumber(days));
  days = applyScheduleToDays(days, startIn, settings);
  const estimated_days = estimatedDaysFromDays(days);
  const snapped = snapStartDate(startIn, settings);
  const due_date =
    snapped && estimated_days > 0 ? finishFromStartAndDays(snapped, estimated_days, settings) : null;
  const sourceRaw = str(stripped.source, 32).toLowerCase();
  const source = sourceRaw === "voice" || sourceRaw === "mixed" ? sourceRaw : "keyboard";
  return {
    schema_version: SCHEMA_VERSION,
    source,
    hours_per_day_used: hpd,
    start_date: snapped,
    due_date,
    estimated_days,
    estimated_hours: totalBudgetHours(days),
    days,
  };
}

function createPreviewSession(confirmedDoc, draftDoc, options) {
  const confirmed = normalizeDocument(confirmedDoc || { days: [] }, options);
  const draft = normalizeDocument(draftDoc || confirmed, options);
  return { confirmed, draft };
}

function cancelPreview(session) {
  const confirmed = session && session.confirmed ? cloneJson(session.confirmed) : normalizeDocument({ days: [] });
  return { applied: confirmed, changed: false };
}

function confirmPreview(session, options) {
  const applied = normalizeDocument(session && session.draft ? session.draft : { days: [] }, options);
  return { applied, changed: true };
}

module.exports = {
  SCHEMA_VERSION,
  PUBLIC_FORBIDDEN_KEYS,
  newStableId,
  cloneJson,
  stripRateFields,
  snapStartDate,
  dateForDayNumber,
  estimatedDaysFromDays,
  finishFromStartAndDays,
  sortDaysByNumber,
  createEmptyDay,
  insertDayAfter,
  moveDay,
  deleteDay,
  renumberDays,
  applyScheduleToDays,
  totalBudgetHours,
  previewLaborCost,
  deriveLegacyOperationalPlan,
  buildPublicClientScope,
  publicPayloadContainsInternal,
  scrubPublicPayload,
  hydrateFromLegacyOperationalPlan,
  normalizeDocument,
  createPreviewSession,
  cancelPreview,
  confirmPreview,
};
