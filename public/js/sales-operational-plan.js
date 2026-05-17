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
  };
})(typeof window !== "undefined" ? window : globalThis);
