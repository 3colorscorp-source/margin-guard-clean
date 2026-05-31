/**
 * Client helper for Sales capacity calendar API and date UI.
 */
(function (global) {
  "use strict";

  const CAPACITY_API = "/.netlify/functions/get-sales-capacity-calendar";

  function normDate(value) {
    const s = String(value == null ? "" : value).trim().slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "";
  }

  function parseYmd(ymd) {
    if (!normDate(ymd)) return null;
    const [y, mo, d] = ymd.split("-").map(Number);
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

  function todayYmd() {
    return formatYmd(new Date());
  }

  function compareYmd(a, b) {
    const aa = normDate(a);
    const bb = normDate(b);
    if (!aa || !bb) return 0;
    if (aa < bb) return -1;
    if (aa > bb) return 1;
    return 0;
  }

  function addCalendarDays(fromYmd, days) {
    const dt = parseYmd(fromYmd);
    if (!dt) return "";
    dt.setDate(dt.getDate() + Number(days || 0));
    return formatYmd(dt);
  }

  function isWorkday(dt) {
    const dow = dt.getDay();
    return dow !== 0 && dow !== 6;
  }

  function addBusinessDaysLocal(fromYmd, steps) {
    const n = Math.max(0, Math.floor(Number(steps) || 0));
    let cur = parseYmd(fromYmd);
    if (!cur) return "";
    if (n === 0) return formatYmd(cur);
    let counted = 0;
    for (let guard = 0; guard < 4000 && counted < n; guard += 1) {
      cur.setDate(cur.getDate() + 1);
      if (isWorkday(cur)) counted += 1;
    }
    return formatYmd(cur);
  }

  function projectFinishFromStart(startYmd, estimatedDays, options) {
    const days = Math.max(1, Math.ceil(Number(estimatedDays) || 0));
    if (!normDate(startYmd)) return "";
    const workdaysOnly = !options || options.workdaysEnabled !== false;
    if (!workdaysOnly) return addCalendarDays(startYmd, days - 1);
    return addBusinessDaysLocal(startYmd, days - 1);
  }

  const TARGET_FINISH_HINT_DEFAULT =
    "Target finish will calculate after labor days and safe start date are set.";

  /**
   * System-controlled target finish from approved capacity start + estimated project days.
   * Never uses issue date.
   */
  function updateTargetFinishDisplay(startYmd, estimatedDays, options) {
    const finishInput = document.getElementById("salesTargetFinishDate");
    const dueHidden = document.getElementById("salesDueDate");
    const hint = document.getElementById("salesTargetFinishHint");
    const start = normDate(startYmd);
    const days = Number(estimatedDays);
    const hasDays = Number.isFinite(days) && days > 0;
    const workdaysEnabled = !options || options.workdaysEnabled !== false;
    const serverFinish = normDate(options && options.projectedFinishDate);

    if (!start || !hasDays) {
      if (finishInput) finishInput.value = "";
      if (dueHidden) dueHidden.value = "";
      if (hint) hint.textContent = TARGET_FINISH_HINT_DEFAULT;
      return { start: "", finish: "" };
    }

    const finish =
      serverFinish && compareYmd(serverFinish, start) >= 0
        ? serverFinish
        : projectFinishFromStart(start, days, { workdaysEnabled });

    if (finishInput) finishInput.value = finish;
    if (dueHidden) dueHidden.value = finish;
    if (hint) {
      const dayLabel = workdaysEnabled ? "workday" : "day";
      hint.textContent = `System calculated from approved start (${formatDateUS(start)}) + ${Math.ceil(days)} ${dayLabel}(s) (Mon–Fri when enabled in Business Settings).`;
    }
    return { start, finish };
  }

  function projectFinishFromStartLocal(startYmd, estimatedDays, options) {
    return projectFinishFromStart(startYmd, estimatedDays, options);
  }

  function formatDateUS(ymd) {
    const dt = parseYmd(ymd);
    if (!dt) return ymd || "";
    return dt.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }

  /** min selectable start = max(today, next_available_start_date from capacity engine). */
  function effectiveStartMin(calendar) {
    const today = todayYmd();
    const next = normDate(calendar && calendar.next_available_start_date);
    if (!next) return today;
    return compareYmd(next, today) >= 0 ? next : today;
  }

  function isStartBlocked(calendar, chosenStart) {
    if (!calendar || !normDate(chosenStart)) return false;
    if (calendar.schedule_settings && calendar.schedule_settings.allow_seller_schedule_override) {
      return false;
    }
    const min = effectiveStartMin(calendar);
    if (!min) return false;
    return compareYmd(chosenStart, min) < 0;
  }

  function buildGuidanceReason(calendar) {
    if (!calendar) return "";
    if (calendar.reason) return String(calendar.reason);
    const remaining = Number(calendar.remaining_days);
    const buffer = Number(calendar.buffer_days);
    if (Number.isFinite(remaining) && remaining > 0 && Number.isFinite(buffer)) {
      return `Current active project has ${remaining} working day${remaining === 1 ? "" : "s"} remaining plus ${buffer} buffer day${buffer === 1 ? "" : "s"}.`;
    }
    return "Production schedule is based on active crew workload.";
  }

  async function fetchCapacityCalendar(estimatedDays, desiredStartDate, projectId) {
    const params = new URLSearchParams();
    params.set("estimated_days", String(Math.max(0, Number(estimatedDays) || 0)));
    const desired = normDate(desiredStartDate);
    if (desired) params.set("desired_start_date", desired);
    if (projectId) params.set("project_id", String(projectId).trim());
    const res = await fetch(`${CAPACITY_API}?${params.toString()}`, {
      method: "GET",
      credentials: "include",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data || data.ok !== true) {
      throw new Error((data && data.error) || "Capacity calendar unavailable");
    }
    return data;
  }

  /**
   * Apply picker min, guidance, and clear stale start dates before next safe date.
   * @returns {{ cleared: boolean, value: string, min: string }}
   */
  function reconcileStartDateWithCapacity(calendar, startInput, state) {
    const min = effectiveStartMin(calendar);
    const result = { cleared: false, value: "", min: min || todayYmd() };
    if (startInput && min) {
      startInput.min = min;
      startInput.setAttribute("min", min);
    }
    const chosen = normDate(startInput && startInput.value);
    if (chosen && min && compareYmd(chosen, min) < 0) {
      if (startInput) startInput.value = "";
      if (state && typeof state === "object") {
        state.startDate = "";
        state.targetFinishDate = "";
        state.dueDate = "";
      }
      result.cleared = true;
      return result;
    }
    result.value = chosen || "";
    return result;
  }

  function applyCapacityGuidance(calendar) {
    const guidance = document.getElementById("salesCapacityGuidance");
    const warning = document.getElementById("salesCapacityWarning");
    const startInput = document.getElementById("salesStartDate");
    if (!calendar) return;

    const min = effectiveStartMin(calendar);
    const nextLabel = formatDateUS(min || calendar.next_available_start_date);
    const reasonText = buildGuidanceReason(calendar);
    if (guidance) {
      guidance.innerHTML =
        `Next safe start date: <strong>${nextLabel}</strong><br>` +
        `Reason: ${reasonText}`;
    }
    if (startInput && min) {
      startInput.min = min;
      startInput.setAttribute("min", min);
    }
    if (warning && startInput) {
      const chosen = normDate(startInput.value);
      if (chosen && isStartBlocked(calendar, chosen)) {
        warning.style.display = "block";
        warning.className = "notice error";
        warning.textContent = blockedStartMessage(calendar);
      } else {
        warning.style.display = "none";
        warning.textContent = "";
      }
    }
  }

  function syncTargetFinishFromStart(startYmd, estimatedDays, options) {
    return updateTargetFinishDisplay(startYmd, estimatedDays, options);
  }

  function blockedStartMessage(calendar) {
    const min = effectiveStartMin(calendar);
    const nextLabel = formatDateUS(min || (calendar && calendar.next_available_start_date));
    return `This start date is not available based on current crew capacity. Next available date is ${nextLabel}.`;
  }

  global.MarginGuardSalesCapacity = {
    normDate,
    todayYmd,
    compareYmd,
    effectiveStartMin,
    addCalendarDays,
    addBusinessDaysLocal,
    projectFinishFromStart,
    projectFinishFromStartLocal,
    updateTargetFinishDisplay,
    formatDateUS,
    fetchCapacityCalendar,
    applyCapacityGuidance,
    reconcileStartDateWithCapacity,
    syncTargetFinishFromStart,
    isStartBlocked,
    blockedStartMessage,
    buildGuidanceReason,
    QUOTE_EXPIRATION_DAYS: 15,
  };
})(typeof window !== "undefined" ? window : globalThis);
