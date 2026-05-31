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

  function projectFinishFromStartLocal(startYmd, estimatedDays) {
    const days = Math.max(1, Math.ceil(Number(estimatedDays) || 0));
    if (!normDate(startYmd)) return "";
    return addBusinessDaysLocal(startYmd, days - 1);
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

  function isStartBlocked(calendar, chosenStart) {
    if (!calendar || !normDate(chosenStart)) return false;
    if (calendar.schedule_settings && calendar.schedule_settings.allow_seller_schedule_override) {
      return false;
    }
    const next = normDate(calendar.next_available_start_date);
    if (!next) return false;
    return chosenStart < next;
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

  function applyCapacityGuidance(calendar) {
    const guidance = document.getElementById("salesCapacityGuidance");
    const warning = document.getElementById("salesCapacityWarning");
    const startInput = document.getElementById("salesStartDate");
    if (!calendar) return;

    const nextLabel = formatDateUS(calendar.next_available_start_date);
    if (guidance) {
      guidance.textContent = `Next safe start date: ${nextLabel}. Reason: ${calendar.reason || ""}`;
    }
    if (startInput && calendar.next_available_start_date) {
      startInput.min = calendar.next_available_start_date;
    }
    if (warning && startInput) {
      const chosen = normDate(startInput.value);
      if (chosen && isStartBlocked(calendar, chosen)) {
        warning.style.display = "block";
        warning.className = "notice error";
        warning.textContent = `This start date is not available based on current crew capacity. Next available date is ${nextLabel}.`;
      } else {
        warning.style.display = "none";
        warning.textContent = "";
      }
    }
  }

  function syncTargetFinishFromStart(startYmd, estimatedDays) {
    const finishInput = document.getElementById("salesTargetFinishDate");
    const dueHidden = document.getElementById("salesDueDate");
    const finish = projectFinishFromStartLocal(startYmd, estimatedDays);
    if (finishInput) finishInput.value = finish;
    if (dueHidden) dueHidden.value = finish;
    return finish;
  }

  function blockedStartMessage(calendar) {
    const nextLabel = formatDateUS(calendar && calendar.next_available_start_date);
    return `This start date is not available based on current crew capacity. Next available date is ${nextLabel}.`;
  }

  global.MarginGuardSalesCapacity = {
    normDate,
    todayYmd,
    addCalendarDays,
    addBusinessDaysLocal,
    projectFinishFromStartLocal,
    formatDateUS,
    fetchCapacityCalendar,
    applyCapacityGuidance,
    syncTargetFinishFromStart,
    isStartBlocked,
    blockedStartMessage,
    QUOTE_EXPIRATION_DAYS: 15,
  };
})(typeof window !== "undefined" ? window : globalThis);
