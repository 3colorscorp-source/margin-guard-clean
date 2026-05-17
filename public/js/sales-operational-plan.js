/**
 * Sales operational execution plan (browser) — schedule only, no financial fields.
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

  function normWorkerType(raw) {
    const key = str(raw, 64).toLowerCase();
    return WORKER_TYPE_ALIASES[key] || "pro";
  }

  function normRoleLabel(raw, workerType) {
    const r = str(raw, 120);
    if (r) return r;
    return workerType === "helper" ? "Assistant" : "Installer";
  }

  function normalizeWorker(row) {
    if (!row || typeof row !== "object") return null;
    const worker_type = normWorkerType(row.worker_type || row.type);
    const estimated_hours = Math.max(0, round2(row.estimated_hours ?? row.hours ?? 0));
    if (estimated_hours <= 0) return null;
    return {
      role: normRoleLabel(row.role, worker_type),
      worker_type,
      estimated_hours,
    };
  }

  function normalizeDay(row, fallbackDayNumber) {
    if (!row || typeof row !== "object") return null;
    const day_number = Math.max(1, Math.floor(num(row.day_number, fallbackDayNumber)));
    const phase = str(row.phase, 240) || "Day " + day_number;
    const workers = (Array.isArray(row.workers) ? row.workers : [])
      .map(normalizeWorker)
      .filter(Boolean);
    if (!workers.length) return null;
    return { day_number, phase, workers };
  }

  function normalizeOperationalPlan(input, estimatedDaysOverride) {
    let daysRaw = input;
    let override = estimatedDaysOverride;
    if (input && typeof input === "object" && !Array.isArray(input)) {
      daysRaw = input.days || input.operational_plan || [];
      if (input.estimated_days_override != null && input.estimated_days_override !== "") {
        override = num(input.estimated_days_override, NaN);
      }
    }
    const days = Array.isArray(daysRaw) ? daysRaw : [];
    const out = [];
    let i = 0;
    for (const row of days) {
      i += 1;
      const day = normalizeDay(row, i);
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

  function computeOperationalPlanMetrics(normalizedPlan, estimatedDaysOverride) {
    const days = Array.isArray(normalizedPlan) ? normalizedPlan : [];
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
    const override = Number.isFinite(estimatedDaysOverride) ? estimatedDaysOverride : NaN;
    const estimated_days =
      Number.isFinite(override) && override > 0 ? round2(override) : round2(maxDay);
    return {
      estimated_days: estimated_days,
      estimated_hours: round2(estimated_hours),
      worker_count: Object.keys(roleKeys).length,
      max_day_number: round2(maxDay),
    };
  }

  function createEmptyDay(dayNumber) {
    return {
      day_number: Math.max(1, Math.floor(num(dayNumber, 1))),
      phase: "",
      workers: [
        { role: "Installer", worker_type: "pro", estimated_hours: 8 },
        { role: "Assistant", worker_type: "helper", estimated_hours: 8 },
      ],
    };
  }

  function createEmptyWorker() {
    return { role: "Installer", worker_type: "pro", estimated_hours: 8 };
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
    normalizeOperationalPlan: normalizeOperationalPlan,
    computeOperationalPlanMetrics: computeOperationalPlanMetrics,
    planHasDays: planHasDays,
    createEmptyDay: createEmptyDay,
    createEmptyWorker: createEmptyWorker,
    OPERATIONAL_PLAN_TEMPLATES: OPERATIONAL_PLAN_TEMPLATES,
    applyTemplate: applyTemplate,
  };
})(typeof window !== "undefined" ? window : globalThis);
