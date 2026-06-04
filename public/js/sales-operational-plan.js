/**
 * Sales operational execution plan (browser) — schedule only, no financial fields.
 * UI unit mode follows Business Settings pricingMode (day | hour).
 */
(function (global) {
  function num(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  function round2(n) {
    return Math.round(num(n, 0) * 100) / 100;
  }

  function str(v, max) {
    return String(v == null ? "" : v)
      .trim()
      .slice(0, max || 500);
  }

  const WORKER_TYPE_ALIASES = {
    pro: "pro",
    installer: "pro",
    helper: "helper",
    assistant: "helper",
  };

  function getOperationalPlanUnitMode(settings) {
    const pm = str(settings && settings.pricingMode, 16).toLowerCase();
    return pm === "day" ? "day" : "hour";
  }

  function getHoursPerDay(settings) {
    return Math.max(num(settings && settings.hoursPerDay, 8), 0.25);
  }

  function normWorkerType(raw) {
    const key = str(raw, 64).toLowerCase();
    return WORKER_TYPE_ALIASES[key] || "pro";
  }

  function normRoleLabel(raw, workerType) {
    const r = str(raw, 120);
    if (r) return r;
    return workerType === "helper" ? "Assistant" : "Installer";
  }

  function workerHoursToDisplayUnits(worker, mode, hoursPerDay) {
    const hours = num(worker && worker.estimated_hours, 0);
    const hpd = Math.max(num(hoursPerDay, 8), 0.25);
    if (mode === "day") return round2(hours / hpd);
    return round2(hours);
  }

  function setWorkerDisplayUnits(worker, displayValue, mode, hoursPerDay) {
    if (!worker || typeof worker !== "object") return;
    const hpd = Math.max(num(hoursPerDay, 8), 0.25);
    const v = Math.max(0, num(displayValue, 0));
    worker.estimated_hours = mode === "day" ? round2(v * hpd) : round2(v);
  }

  function normalizeWorker(row, hoursPerDay) {
    if (!row || typeof row !== "object") return null;
    const worker_type = normWorkerType(row.worker_type || row.type);
    const hpd = Math.max(num(hoursPerDay, 8), 0.25);
    let estimated_hours = num(row.estimated_hours, NaN);
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
    const day_number = Math.max(1, Math.floor(num(row.day_number, fallbackDayNumber)));
    const phase = str(row.phase, 240) || "Day " + day_number;
    const workers = (Array.isArray(row.workers) ? row.workers : [])
      .map(function (w) {
        return normalizeWorker(w, hoursPerDay);
      })
      .filter(Boolean);
    if (!workers.length) return null;
    return { day_number, phase, workers };
  }

  function normalizeOperationalPlan(input, estimatedDaysOverride, hoursPerDay) {
    let daysRaw = input;
    let override = estimatedDaysOverride;
    if (input && typeof input === "object" && !Array.isArray(input)) {
      daysRaw = input.days || input.operational_plan || [];
      if (input.estimated_days_override != null && input.estimated_days_override !== "") {
        override = num(input.estimated_days_override, NaN);
      }
    }
    const hpd = Math.max(num(hoursPerDay, 8), 0.25);
    const days = Array.isArray(daysRaw) ? daysRaw : [];
    const out = [];
    let i = 0;
    for (const row of days) {
      i += 1;
      const day = normalizeDay(row, i, hpd);
      if (day) out.push(day);
    }
    out.sort(function (a, b) {
      return a.day_number - b.day_number;
    });
    return out;
  }

  function planHasDays(plan) {
    return Array.isArray(plan) && plan.length > 0;
  }

  function computeOperationalPlanMetrics(
    normalizedPlan,
    estimatedDaysOverride,
    estimatedHoursOverride,
    hoursPerDay
  ) {
    const days = Array.isArray(normalizedPlan) ? normalizedPlan : [];
    const hpd = Math.max(num(hoursPerDay, 8), 0.25);
    const maxDay = days.reduce(function (mx, d) {
      return Math.max(mx, num(d && d.day_number, 0));
    }, 0);
    let estimated_hours = 0;
    const roleKeys = {};
    days.forEach(function (day) {
      (day.workers || []).forEach(function (w) {
        estimated_hours += num(w && w.estimated_hours, 0);
        const key =
          normWorkerType(w && w.worker_type) +
          "::" +
          normRoleLabel(w && w.role, w && w.worker_type);
        roleKeys[key] = true;
      });
    });
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
      estimated_days: estimated_days,
      estimated_hours: estimated_hours,
      worker_count: Object.keys(roleKeys).length,
      max_day_number: round2(maxDay),
    };
  }

  function formatOperationalSummary(metrics, mode) {
    if (!metrics) return "No schedule yet";
    if (mode === "day") {
      return metrics.estimated_days + " days · " + metrics.worker_count + " roles";
    }
    return metrics.estimated_hours + " hours · " + metrics.worker_count + " roles";
  }

  function formatMetricsHtml(metrics, mode) {
    if (!metrics) {
      return '<p class="small" style="margin:0;">Add schedule days or apply a template.</p>';
    }
    if (mode === "day") {
      return (
        '<div class="sales-operational-metrics__grid sales-operational-metrics__grid--day">' +
        '<div><strong>Estimated project days</strong><br>' +
        metrics.estimated_days +
        "</div>" +
        '<div><strong>Crew roles</strong><br>' +
        metrics.worker_count +
        "</div>" +
        "</div>"
      );
    }
    return (
      '<div class="sales-operational-metrics__grid sales-operational-metrics__grid--hour">' +
      '<div><strong>Estimated project hours</strong><br>' +
      metrics.estimated_hours +
      "</div>" +
      '<div><strong>Crew roles</strong><br>' +
      metrics.worker_count +
      "</div>" +
      "</div>"
    );
  }

  function createEmptyDay(dayNumber, mode, hoursPerDay) {
    const hpd = Math.max(num(hoursPerDay, 8), 0.25);
    const unitHours = mode === "day" ? hpd : 8;
    return {
      day_number: Math.max(1, Math.floor(num(dayNumber, 1))),
      phase: "",
      workers: [
        { role: "Installer", worker_type: "pro", estimated_hours: unitHours },
        { role: "Assistant", worker_type: "helper", estimated_hours: unitHours },
      ],
    };
  }

  function createEmptyWorker(mode, hoursPerDay) {
    const hpd = Math.max(num(hoursPerDay, 8), 0.25);
    const unitHours = mode === "day" ? hpd : 8;
    return { role: "Installer", worker_type: "pro", estimated_hours: unitHours };
  }

  const OPERATIONAL_PLAN_TEMPLATES = {
    master_bathroom_5: {
      label: "Master Bathroom — 5 days",
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

  function applyTemplate(templateKey) {
    const tpl = OPERATIONAL_PLAN_TEMPLATES[templateKey];
    if (!tpl || !Array.isArray(tpl.days)) return [];
    return tpl.days.map(function (day) {
      return {
        day_number: day.day_number,
        phase: day.phase,
        workers: (day.workers || []).map(function (w) {
          return {
            role: w.role,
            worker_type: w.worker_type,
            estimated_hours: w.estimated_hours,
          };
        }),
      };
    });
  }

  const DISPLAY_PHASE_COLORS = [
    "sales-op-phase-tone--a",
    "sales-op-phase-tone--b",
    "sales-op-phase-tone--c",
    "sales-op-phase-tone--d",
  ];

  /** Presentation-only phase grouping from task/phase text. */
  function deriveDisplayPhaseGroup(phaseText, fallbackIndex) {
    const p = str(phaseText, 240).toLowerCase();
    if (/downstairs|lower bath|guest bath|powder/.test(p)) {
      return { key: "downstairs", label: "Downstairs Bathroom", tone: 0 };
    }
    if (/master|primary bath|owner bath| ensuite/.test(p)) {
      return { key: "master", label: "Master Bathroom", tone: 1 };
    }
    if (/grout|cleanup|clean up|clean-up|final|punch|turnover|finish|detail/.test(p)) {
      return { key: "final", label: "Final / Cleanup", tone: 2 };
    }
    const trimmed = str(phaseText, 240);
    if (trimmed) {
      return { key: "custom:" + trimmed.slice(0, 40), label: trimmed, tone: 3 };
    }
    const idx = Math.max(0, Math.floor(num(fallbackIndex, 0)));
    return {
      key: "execution",
      label: "Phase " + (idx + 1) + " — Project Execution",
      tone: idx % DISPLAY_PHASE_COLORS.length,
    };
  }

  function groupPlanByDisplayPhase(plan) {
    const days = Array.isArray(plan) ? plan : [];
    const groups = [];
    const map = new Map();
    days.forEach(function (day, index) {
      const meta = deriveDisplayPhaseGroup(day && day.phase, index);
      let group = map.get(meta.key);
      if (!group) {
        group = {
          key: meta.key,
          label: meta.label,
          tone: meta.tone,
          toneClass: DISPLAY_PHASE_COLORS[meta.tone % DISPLAY_PHASE_COLORS.length],
          days: [],
        };
        map.set(meta.key, group);
        groups.push(group);
      }
      group.days.push({ day: day, dayIndex: index });
    });
    groups.forEach(function (g) {
      g.days.sort(function (a, b) {
        return num(a.day && a.day.day_number, 0) - num(b.day && b.day.day_number, 0);
      });
    });
    return groups;
  }

  function formatCrewShortLabel(workers) {
    let hasPro = false;
    let hasHelper = false;
    (Array.isArray(workers) ? workers : []).forEach(function (w) {
      const t = normWorkerType(w && w.worker_type);
      if (t === "helper") hasHelper = true;
      else hasPro = true;
    });
    const parts = [];
    if (hasPro) parts.push("Pro");
    if (hasHelper) parts.push("Helper");
    return parts.length ? parts.join(" + ") : "—";
  }

  function sumDayDisplayUnits(workers, mode, hoursPerDay) {
    let sum = 0;
    (Array.isArray(workers) ? workers : []).forEach(function (w) {
      sum += workerHoursToDisplayUnits(w, mode, hoursPerDay);
    });
    return round2(sum);
  }

  function parseYmdLocal(ymd) {
    const s = str(ymd, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const parts = s.split("-").map(Number);
    const dt = new Date(parts[0], parts[1] - 1, parts[2]);
    if (
      dt.getFullYear() !== parts[0] ||
      dt.getMonth() !== parts[1] - 1 ||
      dt.getDate() !== parts[2]
    ) {
      return null;
    }
    return dt;
  }

  function formatYmdLocal(dt) {
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, "0");
    const d = String(dt.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + d;
  }

  function isWorkdayLocal(dt) {
    const dow = dt.getDay();
    return dow !== 0 && dow !== 6;
  }

  function addCalendarDaysLocal(fromYmd, days) {
    const dt = parseYmdLocal(fromYmd);
    if (!dt) return "";
    dt.setDate(dt.getDate() + Number(days || 0));
    return formatYmdLocal(dt);
  }

  function buildWorkdaySequence(startYmd, count, workdaysOnly) {
    const n = Math.max(0, Math.ceil(Number(count) || 0));
    const start = str(startYmd, 10);
    if (!start || n <= 0) return [];
    const out = [];
    let cur = start;
    let guard = 0;
    while (out.length < n && guard < 4000) {
      const dt = parseYmdLocal(cur);
      if (!dt) break;
      if (!workdaysOnly || isWorkdayLocal(dt)) out.push(cur);
      cur = addCalendarDaysLocal(cur, 1);
      guard += 1;
    }
    return out;
  }

  /**
   * Weekly-style calendar preview cells for Sales planning (presentation only).
   */
  function buildSalesPlanCalendarPreview(input) {
    const plan = Array.isArray(input && input.plan) ? input.plan : [];
    const startYmd = str(input && input.startDate, 10);
    const hasStart = /^\d{4}-\d{2}-\d{2}$/.test(startYmd);
    const estimatedDays = Math.max(
      plan.length,
      Math.ceil(Number(input && input.estimatedDays) || plan.length || 1)
    );
    const workdaysOnly = !input || input.workdaysEnabled !== false;
    const sorted = plan.slice().sort(function (a, b) {
      return num(a.day_number, 0) - num(b.day_number, 0);
    });
    const dates = hasStart ? buildWorkdaySequence(startYmd, estimatedDays, workdaysOnly) : [];
    const cells = [];
    for (let i = 0; i < estimatedDays; i += 1) {
      const day = sorted[i] || null;
      const meta = day ? deriveDisplayPhaseGroup(day.phase, i) : null;
      cells.push({
        index: i,
        day_number: day ? day.day_number : i + 1,
        date: dates[i] || "",
        phase: day ? str(day.phase, 120) : "",
        crew: day ? formatCrewShortLabel(day.workers) : "",
        toneClass: meta
          ? DISPLAY_PHASE_COLORS[meta.tone % DISPLAY_PHASE_COLORS.length]
          : "sales-op-phase-tone--muted",
        hasPlan: Boolean(day),
        previewMode: hasStart ? "dated" : "plan_day",
      });
    }
    return {
      cells: cells,
      startDate: hasStart ? startYmd : "",
      estimatedDays: estimatedDays,
      hasStart: hasStart,
      planDayCount: sorted.length,
    };
  }

  function formatDayUnitsLabel(units, mode) {
    const v = round2(units);
    if (mode === "day") return v + (v === 1 ? " day" : " days");
    return v + (v === 1 ? " hr" : " hrs");
  }

  /**
   * Worker-days contributed by one operational-plan crew row (default 1 day if blank).
   */
  function crewRowWorkerDays(worker, mode, hoursPerDay) {
    const hpd = Math.max(num(hoursPerDay, 8), 0.25);
    const hours = num(worker && worker.estimated_hours, 0);
    if (hours <= 0) return 1;
    if (mode === "hour") return round2(hours / hpd);
    const units = workerHoursToDisplayUnits(worker, mode, hpd);
    return round2(units > 0 ? units : 1);
  }

  /**
   * Sum operational plan crew rows into Sales labor table workers (Pro / Assistant buckets).
   * Presentation + labor sync only — does not mutate operational_plan.
   */
  function aggregateLaborWorkersFromOperationalPlan(plan, settings) {
    const mode = getOperationalPlanUnitMode(settings);
    const hpd = getHoursPerDay(settings);
    const days = Array.isArray(plan) ? plan : [];
    const totals = { pro: 0, helper: 0 };

    days.forEach(function (day) {
      (day && day.workers ? day.workers : []).forEach(function (w) {
        const wt = normWorkerType(w && w.worker_type);
        const bucket = wt === "helper" ? "helper" : "pro";
        totals[bucket] += crewRowWorkerDays(w, mode, hpd);
      });
    });

    const out = [];
    if (totals.pro > 0) {
      out.push({
        name: "Worker " + (out.length + 1),
        type: "installer",
        days: round2(totals.pro),
        rate: "",
      });
    }
    if (totals.helper > 0) {
      out.push({
        name: "Worker " + (out.length + 1),
        type: "helper",
        days: round2(totals.helper),
        rate: "",
      });
    }
    return out;
  }

  global.MgSalesOperationalPlan = {
    getOperationalPlanUnitMode: getOperationalPlanUnitMode,
    getHoursPerDay: getHoursPerDay,
    workerHoursToDisplayUnits: workerHoursToDisplayUnits,
    setWorkerDisplayUnits: setWorkerDisplayUnits,
    normalizeOperationalPlan: normalizeOperationalPlan,
    computeOperationalPlanMetrics: computeOperationalPlanMetrics,
    formatOperationalSummary: formatOperationalSummary,
    formatMetricsHtml: formatMetricsHtml,
    planHasDays: planHasDays,
    createEmptyDay: createEmptyDay,
    createEmptyWorker: createEmptyWorker,
    OPERATIONAL_PLAN_TEMPLATES: OPERATIONAL_PLAN_TEMPLATES,
    applyTemplate: applyTemplate,
    deriveDisplayPhaseGroup: deriveDisplayPhaseGroup,
    groupPlanByDisplayPhase: groupPlanByDisplayPhase,
    formatCrewShortLabel: formatCrewShortLabel,
    sumDayDisplayUnits: sumDayDisplayUnits,
    buildSalesPlanCalendarPreview: buildSalesPlanCalendarPreview,
    formatDayUnitsLabel: formatDayUnitsLabel,
    crewRowWorkerDays: crewRowWorkerDays,
    aggregateLaborWorkersFromOperationalPlan: aggregateLaborWorkersFromOperationalPlan,
    DISPLAY_PHASE_COLORS: DISPLAY_PHASE_COLORS,
  };
})(typeof window !== "undefined" ? window : globalThis);
