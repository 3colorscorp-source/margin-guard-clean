/**
 * Voice Operational Plan Builder — Phase 1 (browser).
 * Keyboard/preview only. Dates come from MarginGuardSalesCapacity (canonical snap).
 */
(function (global) {
  "use strict";

  const SCHEMA_VERSION = 1;
  const DEFAULT_HOURS_PER_DAY = 8;
  const RATE_KEYS = {
    hourly_rate: true,
    daily_rate: true,
    rate: true,
    estimated_cost: true,
    baseInstaller: true,
    baseHelper: true,
    sale_price: true,
    labor_rate: true,
    cost: true,
  };
  const DOCUMENT_LIMITS = {
    MAX_DAYS: 45,
    MAX_TASKS_PER_DAY: 20,
    MAX_ASSIGNMENTS_PER_DAY: 8,
    MAX_WORKER_COUNT: 12,
    MAX_HOURS_PER_WORKER: 24,
    MAX_JSON_BYTES: 100000,
    MAX_CLIENT_SCOPE: 2000,
    MAX_INTERNAL_NOTES: 4000,
    MAX_TASK_LABEL: 500,
    MAX_LIST_ITEMS: 24,
    MAX_LIST_ITEM: 400,
  };
  const PUBLIC_FORBIDDEN_KEYS = [
    "internal_operational_plan",
    "quote_internal_operational_plans",
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

  function cap() {
    return global.MarginGuardSalesCapacity || {};
  }

  function num(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback || 0;
  }

  function round2(n) {
    return Math.round(num(n, 0) * 100) / 100;
  }

  function str(v, max) {
    return String(v == null ? "" : v)
      .trim()
      .slice(0, max || 4000);
  }

  function newStableId(prefix) {
    const p = String(prefix || "id").replace(/[^a-z0-9_]/gi, "") || "id";
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return p + "_" + crypto.randomUUID();
    }
    return p + "_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
  }

  function cloneJson(value) {
    return JSON.parse(JSON.stringify(value == null ? {} : value));
  }

  function stripRateFields(value) {
    if (Array.isArray(value)) return value.map(stripRateFields);
    if (!value || typeof value !== "object") return value;
    const out = {};
    for (const k of Object.keys(value)) {
      if (RATE_KEYS[k]) continue;
      out[k] = stripRateFields(value[k]);
    }
    return out;
  }

  function jsonByteLength(value) {
    try {
      return JSON.stringify(value == null ? {} : value).length;
    } catch (_e) {
      return Number.POSITIVE_INFINITY;
    }
  }

  function resolveHoursPerDayFromSettings(settings) {
    const src = settings && typeof settings === "object" ? settings : {};
    const n = Number(src.hoursPerDay != null ? src.hoursPerDay : src.hours_per_day);
    if (Number.isFinite(n) && n >= 1) return n;
    return DEFAULT_HOURS_PER_DAY;
  }

  function validateIncomingDocument(raw) {
    const errors = [];
    const bytes = jsonByteLength(raw);
    if (bytes > DOCUMENT_LIMITS.MAX_JSON_BYTES) {
      errors.push({
        code: "document_too_large",
        message: "Document exceeds " + DOCUMENT_LIMITS.MAX_JSON_BYTES + " bytes.",
      });
      return { ok: false, errors: errors };
    }
    if (raw != null && (typeof raw !== "object" || Array.isArray(raw))) {
      errors.push({
        code: "document_not_object",
        message: "Operational plan document must be a JSON object.",
      });
      return { ok: false, errors: errors };
    }
    const days = raw && Array.isArray(raw.days) ? raw.days : [];
    if (!Array.isArray(raw && raw.days) && raw && raw.days != null) {
      errors.push({ code: "days_not_array", message: "days must be an array." });
      return { ok: false, errors: errors };
    }
    if (days.length > DOCUMENT_LIMITS.MAX_DAYS) {
      errors.push({
        code: "too_many_days",
        message: "A plan cannot have more than " + DOCUMENT_LIMITS.MAX_DAYS + " days.",
      });
    }
    const dayIds = {};
    const taskIds = {};
    const asgIds = {};
    days.forEach(function (day, dayIndex) {
      if (!day || typeof day !== "object") {
        errors.push({ code: "day_not_object", message: "Day " + (dayIndex + 1) + " must be an object." });
        return;
      }
      const dayId = str(day.day_id, 80);
      if (dayId) {
        if (dayIds[dayId]) {
          errors.push({ code: "duplicate_day_id", message: 'Duplicate day_id "' + dayId + '".' });
        }
        dayIds[dayId] = true;
      }
      const scope = String(day.client_scope == null ? "" : day.client_scope);
      if (scope.length > DOCUMENT_LIMITS.MAX_CLIENT_SCOPE) {
        errors.push({
          code: "client_scope_too_long",
          message: "Day " + (dayIndex + 1) + " client scope exceeds " + DOCUMENT_LIMITS.MAX_CLIENT_SCOPE + " characters.",
        });
      }
      const notes = String(day.internal_notes == null ? "" : day.internal_notes);
      if (notes.length > DOCUMENT_LIMITS.MAX_INTERNAL_NOTES) {
        errors.push({
          code: "internal_notes_too_long",
          message: "Day " + (dayIndex + 1) + " internal notes exceed " + DOCUMENT_LIMITS.MAX_INTERNAL_NOTES + " characters.",
        });
      }
      const tasks = Array.isArray(day.internal_tasks) ? day.internal_tasks : [];
      if (tasks.length > DOCUMENT_LIMITS.MAX_TASKS_PER_DAY) {
        errors.push({
          code: "too_many_tasks",
          message: "Day " + (dayIndex + 1) + " cannot have more than " + DOCUMENT_LIMITS.MAX_TASKS_PER_DAY + " internal tasks.",
        });
      }
      tasks.forEach(function (task) {
        const tid = task && typeof task === "object" ? str(task.task_id, 80) : "";
        if (tid) {
          if (taskIds[tid]) {
            errors.push({ code: "duplicate_task_id", message: 'Duplicate task_id "' + tid + '".' });
          }
          taskIds[tid] = true;
        }
        const label = task && typeof task === "object" ? String(task.label == null ? "" : task.label) : String(task || "");
        if (label.length > DOCUMENT_LIMITS.MAX_TASK_LABEL) {
          errors.push({
            code: "task_label_too_long",
            message: "A task label exceeds " + DOCUMENT_LIMITS.MAX_TASK_LABEL + " characters.",
          });
        }
      });
      const assignments = Array.isArray(day.worker_assignments) ? day.worker_assignments : [];
      if (assignments.length > DOCUMENT_LIMITS.MAX_ASSIGNMENTS_PER_DAY) {
        errors.push({
          code: "too_many_assignments",
          message: "Day " + (dayIndex + 1) + " cannot have more than " + DOCUMENT_LIMITS.MAX_ASSIGNMENTS_PER_DAY + " worker assignments.",
        });
      }
      assignments.forEach(function (asg) {
        if (!asg || typeof asg !== "object") return;
        const aid = str(asg.assignment_id, 80);
        if (aid) {
          if (asgIds[aid]) {
            errors.push({ code: "duplicate_assignment_id", message: 'Duplicate assignment_id "' + aid + '".' });
          }
          asgIds[aid] = true;
        }
        const count = Math.floor(num(asg.worker_count, 1));
        if (count < 1 || count > DOCUMENT_LIMITS.MAX_WORKER_COUNT) {
          errors.push({
            code: "invalid_worker_count",
            message: "worker_count must be between 1 and " + DOCUMENT_LIMITS.MAX_WORKER_COUNT + ".",
          });
        }
        const hours = num(asg.hours_per_worker != null ? asg.hours_per_worker : asg.estimated_hours, 0);
        if (!(hours > 0) || hours > DOCUMENT_LIMITS.MAX_HOURS_PER_WORKER) {
          errors.push({
            code: "invalid_hours_per_worker",
            message: "hours_per_worker must be greater than 0 and at most " + DOCUMENT_LIMITS.MAX_HOURS_PER_WORKER + ".",
          });
        }
      });
      ["materials_or_tools", "dependencies", "gc_client_responsibilities", "risks"].forEach(function (key) {
        const list = Array.isArray(day[key]) ? day[key] : day[key] == null || day[key] === "" ? [] : [day[key]];
        if (list.length > DOCUMENT_LIMITS.MAX_LIST_ITEMS) {
          errors.push({
            code: "too_many_list_items",
            message: "Day " + (dayIndex + 1) + " " + key + " cannot have more than " + DOCUMENT_LIMITS.MAX_LIST_ITEMS + " items.",
          });
        }
      });
    });
    return { ok: errors.length === 0, errors: errors };
  }

  function scheduleSettings(raw) {
    const src = raw && typeof raw === "object" ? raw : {};
    return {
      workdaysEnabled: src.workdaysEnabled !== false && src.workdays_enabled !== false,
    };
  }

  function snapStartDate(startYmd, settings) {
    const helper = cap();
    const start = helper.normDate ? helper.normDate(startYmd) : String(startYmd || "").slice(0, 10);
    if (!start) return null;
    if (typeof helper.nextWorkdayOnOrAfter === "function") {
      return helper.nextWorkdayOnOrAfter(start, scheduleSettings(settings)) || null;
    }
    return start;
  }

  function dateForDayNumber(snappedStart, dayNumber, settings) {
    const helper = cap();
    const start = helper.normDate ? helper.normDate(snappedStart) : snappedStart;
    if (!start) return null;
    const n = Math.max(1, Math.floor(num(dayNumber, 1)));
    if (n === 1) return start;
    const opts = scheduleSettings(settings);
    if (!opts.workdaysEnabled && typeof helper.addCalendarDays === "function") {
      return helper.addCalendarDays(start, n - 1);
    }
    if (typeof helper.addBusinessDaysLocal === "function") {
      return helper.addBusinessDaysLocal(start, n - 1);
    }
    return start;
  }

  function estimatedDaysFromDays(days) {
    let max = 0;
    (Array.isArray(days) ? days : []).forEach(function (day) {
      max = Math.max(max, Math.floor(num(day && day.day_number, 0)));
    });
    return max;
  }

  function finishFromStartAndDays(startYmd, estimatedDays, settings) {
    const helper = cap();
    const days = Math.max(1, Math.ceil(num(estimatedDays, 1)));
    if (typeof helper.projectFinishFromStart === "function") {
      return helper.projectFinishFromStart(startYmd, days, scheduleSettings(settings)) || null;
    }
    return null;
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

  function normalizeTask(row, index) {
    if (typeof row === "string") {
      const label = str(row, 500);
      if (!label) return null;
      return { task_id: newStableId("task"), label: label };
    }
    if (!row || typeof row !== "object") return null;
    const label = str(row.label != null ? row.label : row.text != null ? row.text : row.task, 500);
    if (!label) return null;
    return {
      task_id: str(row.task_id, 80) || newStableId("task"),
      label: label,
      sort: Math.max(0, Math.floor(num(row.sort, index))),
    };
  }

  function normalizeAssignment(row) {
    if (!row || typeof row !== "object") return null;
    const worker_type = normWorkerType(row.worker_type != null ? row.worker_type : row.worker_role != null ? row.worker_role : row.role);
    const worker_role = normWorkerRole(row.worker_role != null ? row.worker_role : row.role, worker_type);
    const worker_count = Math.max(1, Math.floor(num(row.worker_count, 1)));
    const hours_per_worker = Math.max(
      0,
      round2(num(row.hours_per_worker != null ? row.hours_per_worker : row.estimated_hours, 0))
    );
    if (hours_per_worker <= 0) return null;
    return {
      assignment_id: str(row.assignment_id, 80) || newStableId("asg"),
      worker_role: worker_role,
      worker_type: worker_type,
      worker_count: worker_count,
      hours_per_worker: hours_per_worker,
    };
  }

  function normalizeStringList(raw, maxItem, maxItems) {
    const list = Array.isArray(raw) ? raw : raw == null || raw === "" ? [] : [raw];
    const out = [];
    for (let i = 0; i < list.length && out.length < (maxItems || 24); i += 1) {
      const s = str(list[i], maxItem || 400);
      if (s) out.push(s);
    }
    return out;
  }

  function normalizeDay(row, fallbackNumber) {
    if (!row || typeof row !== "object") return null;
    const day_number = Math.max(1, Math.floor(num(row.day_number, fallbackNumber)));
    const internal_tasks = (Array.isArray(row.internal_tasks) ? row.internal_tasks : [])
      .map(function (t, i) {
        return normalizeTask(t, i);
      })
      .filter(Boolean);
    const worker_assignments = (Array.isArray(row.worker_assignments) ? row.worker_assignments : [])
      .map(normalizeAssignment)
      .filter(Boolean);
    if (!worker_assignments.length && Array.isArray(row.workers) && row.workers.length) {
      row.workers.forEach(function (w) {
        const asg = normalizeAssignment({
          worker_role: w.role,
          worker_type: w.worker_type,
          worker_count: 1,
          hours_per_worker: w.estimated_hours,
        });
        if (asg) worker_assignments.push(asg);
      });
    }
    if (
      !internal_tasks.length &&
      !worker_assignments.length &&
      !str(row.client_scope, 2000) &&
      !str(row.phase, 240)
    ) {
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
      (internal_tasks[0] ? "Complete " + internal_tasks[0].label + "." : "Complete planned work for day " + day_number + ".");
    const helper = cap();
    return {
      day_id: str(row.day_id, 80) || newStableId("day"),
      day_number: day_number,
      date: (helper.normDate && helper.normDate(row.date)) || null,
      client_scope: client_scope,
      internal_tasks: internal_tasks,
      worker_assignments: worker_assignments,
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
    return (Array.isArray(days) ? days.slice() : []).sort(function (a, b) {
      return num(a.day_number, 0) - num(b.day_number, 0);
    });
  }

  function renumberDays(days) {
    return (Array.isArray(days) ? days.slice() : []).map(function (day, i) {
      const copy = Object.assign({}, day);
      copy.day_number = i + 1;
      return copy;
    });
  }

  function insertDayAfter(days, afterDayId, hoursPerDay) {
    const list = Array.isArray(days) ? days.slice() : [];
    const idx = list.findIndex(function (d) {
      return d && d.day_id === afterDayId;
    });
    const at = idx >= 0 ? idx + 1 : list.length;
    list.splice(at, 0, createEmptyDay(at + 1, hoursPerDay));
    return renumberDays(list);
  }

  function moveDay(days, dayId, direction) {
    const list = Array.isArray(days) ? days.slice() : [];
    const idx = list.findIndex(function (d) {
      return d && d.day_id === dayId;
    });
    if (idx < 0) return list;
    const next = idx + (direction < 0 ? -1 : 1);
    if (next < 0 || next >= list.length) return list;
    const copy = list.slice();
    const row = copy.splice(idx, 1)[0];
    copy.splice(next, 0, row);
    return renumberDays(copy);
  }

  function deleteDay(days, dayId) {
    return renumberDays(
      (Array.isArray(days) ? days : []).filter(function (d) {
        return d && d.day_id !== dayId;
      })
    );
  }

  function applyScheduleToDays(days, startYmd, settings) {
    const snapped = snapStartDate(startYmd, settings);
    return (Array.isArray(days) ? days : []).map(function (day) {
      const copy = Object.assign({}, day);
      copy.date = snapped ? dateForDayNumber(snapped, day.day_number, settings) : null;
      return copy;
    });
  }

  function totalBudgetHours(days) {
    let hours = 0;
    (Array.isArray(days) ? days : []).forEach(function (day) {
      (day.worker_assignments || []).forEach(function (asg) {
        hours += num(asg.worker_count, 0) * num(asg.hours_per_worker, 0);
      });
    });
    return round2(hours);
  }

  function previewLaborCost(days, settings) {
    const s = settings && typeof settings === "object" ? settings : {};
    const installer = Math.max(0, num(s.baseInstaller, 0));
    const helper = Math.max(0, num(s.baseHelper, 0));
    let total = 0;
    (Array.isArray(days) ? days : []).forEach(function (day) {
      (day.worker_assignments || []).forEach(function (asg) {
        const rate = asg.worker_type === "helper" ? helper : installer;
        total += num(asg.worker_count, 0) * num(asg.hours_per_worker, 0) * rate;
      });
    });
    return round2(total);
  }

  function deriveLegacyOperationalPlan(doc) {
    const days = Array.isArray(doc && doc.days) ? doc.days : [];
    const out = [];
    days.forEach(function (day) {
      const workers = [];
      (day.worker_assignments || []).forEach(function (asg) {
        const count = Math.max(1, Math.floor(num(asg.worker_count, 1)));
        for (let i = 0; i < count; i += 1) {
          workers.push({
            role: asg.worker_role,
            worker_type: asg.worker_type,
            estimated_hours: round2(num(asg.hours_per_worker, 0)),
          });
        }
      });
      if (!workers.length) return;
      out.push({
        day_number: day.day_number,
        phase: str(day.client_scope, 240) || "Day " + day.day_number,
        workers: workers,
      });
    });
    return out;
  }

  function buildPublicClientScope(doc) {
    const days = Array.isArray(doc && doc.days) ? doc.days : [];
    const lines = [];
    days.forEach(function (day) {
      const text = str(day.client_scope, 2000);
      if (text) lines.push("Day " + day.day_number + ": " + text);
    });
    return {
      kind: "client_scope",
      schema_version: SCHEMA_VERSION,
      proposed_start_date: doc && doc.start_date ? doc.start_date : null,
      proposed_finish_date: doc && doc.due_date ? doc.due_date : null,
      days: days.map(function (d) {
        return {
          day_number: d.day_number,
          date: d.date || null,
          client_scope: str(d.client_scope, 2000),
        };
      }),
      narrative: lines.join("\n"),
    };
  }

  function publicPayloadContainsInternal(value, seen) {
    if (value == null) return false;
    if (typeof value === "string") {
      return /internal_notes|worker_assignments|hours_per_worker|internal_operational_plan/.test(value);
    }
    if (typeof value !== "object") return false;
    const bag = seen || [];
    if (bag.indexOf(value) >= 0) return false;
    bag.push(value);
    if (Array.isArray(value)) {
      return value.some(function (v) {
        return publicPayloadContainsInternal(v, bag);
      });
    }
    const keys = Object.keys(value);
    for (let i = 0; i < keys.length; i += 1) {
      if (PUBLIC_FORBIDDEN_KEYS.indexOf(keys[i]) >= 0) return true;
      if (publicPayloadContainsInternal(value[keys[i]], bag)) return true;
    }
    return false;
  }

  function scrubPublicPayload(input) {
    if (input == null || typeof input !== "object") return input;
    if (Array.isArray(input)) return input.map(scrubPublicPayload);
    const out = {};
    Object.keys(input).forEach(function (k) {
      if (PUBLIC_FORBIDDEN_KEYS.indexOf(k) >= 0 || RATE_KEYS[k]) return;
      out[k] = scrubPublicPayload(input[k]);
    });
    return out;
  }

  function resolvePublicPdfScopeItems(data) {
    const src = data && typeof data === "object" ? data : {};
    let raw = src.scope_of_work || src.scopeOfWork || src.public_client_scope || src.client_scope_narrative || "";
    if (!raw) {
      const cand = src.scopeItems != null ? src.scopeItems : src.scopeSummary != null ? src.scopeSummary : src.scope_summary;
      const text = Array.isArray(cand) ? cand.join("\n") : String(cand == null ? "" : cand);
      if (text && !/internal_notes|worker_assignments|hours_per_worker|internal_operational_plan/.test(text)) {
        raw = cand;
      }
    }
    if (Array.isArray(raw)) {
      return raw.map(function (v) {
        return String(v || "").trim();
      }).filter(Boolean);
    }
    return String(raw || "")
      .split(/\r?\n+/)
      .map(function (v) {
        return v.replace(/^[\-\u2022\s]+/, "").trim();
      })
      .filter(Boolean);
  }

  function hydrateFromLegacyOperationalPlan(legacyDays, startYmd, settings, hoursPerDay) {
    const hpd = Math.max(0.25, num(hoursPerDay, DEFAULT_HOURS_PER_DAY));
    const days = [];
    (Array.isArray(legacyDays) ? legacyDays : []).forEach(function (row, i) {
      const day_number = Math.max(1, Math.floor(num(row && row.day_number, i + 1)));
      const workers = Array.isArray(row && row.workers) ? row.workers : [];
      const grouped = {};
      workers.forEach(function (w) {
        const worker_type = normWorkerType(w.worker_type || w.role);
        const worker_role = normWorkerRole(w.role, worker_type);
        const hours = Math.max(0, round2(num(w.estimated_hours, hpd)));
        const key = worker_type + "::" + worker_role + "::" + hours;
        if (!grouped[key]) {
          grouped[key] = {
            assignment_id: newStableId("asg"),
            worker_role: worker_role,
            worker_type: worker_type,
            worker_count: 0,
            hours_per_worker: hours || hpd,
          };
        }
        grouped[key].worker_count += 1;
      });
      const phase = str(row && row.phase, 240);
      days.push({
        day_id: newStableId("day"),
        day_number: day_number,
        date: null,
        client_scope: phase,
        internal_tasks: phase ? [{ task_id: newStableId("task"), label: phase }] : [],
        worker_assignments: Object.keys(grouped).map(function (k) {
          return grouped[k];
        }),
        materials_or_tools: [],
        dependencies: [],
        gc_client_responsibilities: [],
        risks: [],
        internal_notes: "",
      });
    });
    return normalizeDocument(
      { schema_version: SCHEMA_VERSION, source: "keyboard", days: days },
      { startDate: startYmd, settings: settings, hoursPerDay: hpd }
    );
  }

  function normalizeDocument(raw, options) {
    const opts = options || {};
    const stripped = stripRateFields(raw && typeof raw === "object" ? raw : {});
    const settings = opts.settings || {};
    const hpd = Math.max(0.25, num(opts.hoursPerDay != null ? opts.hoursPerDay : stripped.hours_per_day_used, DEFAULT_HOURS_PER_DAY));
    const startIn = opts.startDate || stripped.start_date;
    let days = (Array.isArray(stripped.days) ? stripped.days : [])
      .map(function (d, i) {
        return normalizeDay(d, i + 1);
      })
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
      source: source,
      hours_per_day_used: hpd,
      start_date: snapped,
      due_date: due_date,
      estimated_days: estimated_days,
      estimated_hours: totalBudgetHours(days),
      days: days,
    };
  }

  function createPreviewSession(confirmedDoc, draftDoc, options) {
    const confirmed = normalizeDocument(confirmedDoc || { days: [] }, options);
    const draft = normalizeDocument(draftDoc || confirmed, options);
    return { confirmed: confirmed, draft: draft };
  }

  function cancelPreview(session) {
    const confirmed =
      session && session.confirmed ? cloneJson(session.confirmed) : normalizeDocument({ days: [] });
    return { applied: confirmed, changed: false };
  }

  function confirmPreview(session, options) {
    const applied = normalizeDocument(session && session.draft ? session.draft : { days: [] }, options);
    return { applied: applied, changed: true };
  }

  const api = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    DOCUMENT_LIMITS: DOCUMENT_LIMITS,
    PUBLIC_FORBIDDEN_KEYS: PUBLIC_FORBIDDEN_KEYS,
    resolveHoursPerDayFromSettings: resolveHoursPerDayFromSettings,
    validateIncomingDocument: validateIncomingDocument,
    newStableId: newStableId,
    cloneJson: cloneJson,
    stripRateFields: stripRateFields,
    snapStartDate: snapStartDate,
    dateForDayNumber: dateForDayNumber,
    estimatedDaysFromDays: estimatedDaysFromDays,
    finishFromStartAndDays: finishFromStartAndDays,
    createEmptyDay: createEmptyDay,
    insertDayAfter: insertDayAfter,
    moveDay: moveDay,
    deleteDay: deleteDay,
    renumberDays: renumberDays,
    applyScheduleToDays: applyScheduleToDays,
    totalBudgetHours: totalBudgetHours,
    previewLaborCost: previewLaborCost,
    deriveLegacyOperationalPlan: deriveLegacyOperationalPlan,
    buildPublicClientScope: buildPublicClientScope,
    publicPayloadContainsInternal: publicPayloadContainsInternal,
    scrubPublicPayload: scrubPublicPayload,
    resolvePublicPdfScopeItems: resolvePublicPdfScopeItems,
    hydrateFromLegacyOperationalPlan: hydrateFromLegacyOperationalPlan,
    normalizeDocument: normalizeDocument,
    createPreviewSession: createPreviewSession,
    cancelPreview: cancelPreview,
    confirmPreview: confirmPreview,
  };

  global.MgVoiceOperationalPlan = api;
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
