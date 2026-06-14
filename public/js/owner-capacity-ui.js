/**
 * Owner-only capacity calendar UI (Seller uses MarginGuardSalesCapacity unchanged).
 */
(function (global) {
  "use strict";

  const TARGET_FINISH_HINT_DEFAULT =
    "Target finish will calculate after labor days and safe start date are set.";
  const ADVISORY_SUFFIX_QUOTE = " You may still send this quote.";
  const TENTATIVE_SCHEDULE_NOTE =
    " This schedule is not guaranteed — confirm with Supervisor before project start.";

  const OWNER_IDS = {
    guidanceId: "ownerCapacityGuidance",
    warningId: "ownerCapacityWarning",
    startId: "ownerStartDate",
    finishId: "ownerTargetFinishDate",
    hintId: "ownerTargetFinishHint",
    crewAvailId: "ownerOpCrewAvailability",
    advisorySuffix: ADVISORY_SUFFIX_QUOTE,
    renderCrewFn: "renderOwnerOpCrewAvailability",
    unverifiedKey: "__mgOwnerCapacityUnverified",
  };

  function capApi() {
    return global.MarginGuardSalesCapacity || null;
  }

  function normDate(value) {
    const cap = capApi();
    if (cap && typeof cap.normDate === "function") return cap.normDate(value);
    const s = String(value == null ? "" : value).trim().slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "";
  }

  function compareYmd(a, b) {
    const cap = capApi();
    if (cap && typeof cap.compareYmd === "function") return cap.compareYmd(a, b);
    const aa = normDate(a);
    const bb = normDate(b);
    if (!aa || !bb) return 0;
    if (aa < bb) return -1;
    if (aa > bb) return 1;
    return 0;
  }

  function formatDateUS(ymd) {
    const cap = capApi();
    if (cap && typeof cap.formatDateUS === "function") return cap.formatDateUS(ymd);
    return ymd || "";
  }

  function effectiveStartMin(calendar) {
    const cap = capApi();
    if (cap && typeof cap.effectiveStartMin === "function") return cap.effectiveStartMin(calendar);
    return "";
  }

  function isAdvisoryCapacityMode(calendar) {
    const cap = capApi();
    if (cap && typeof cap.isAdvisoryCapacityMode === "function") {
      return cap.isAdvisoryCapacityMode(calendar);
    }
    const mode =
      (calendar && calendar.crew_availability_mode) ||
      (calendar &&
        calendar.schedule_settings &&
        calendar.schedule_settings.crew_availability_mode) ||
      "advisory";
    return String(mode).toLowerCase() !== "strict";
  }

  function isStartBlocked(calendar, chosenStart) {
    const cap = capApi();
    if (cap && typeof cap.isStartBlocked === "function") {
      return cap.isStartBlocked(calendar, chosenStart);
    }
    return false;
  }

  function blockedStartMessage(calendar) {
    const cap = capApi();
    if (cap && typeof cap.blockedStartMessage === "function") {
      return cap.blockedStartMessage(calendar);
    }
    return "This start date is not available based on current crew capacity.";
  }

  function buildGuidanceReason(calendar) {
    const cap = capApi();
    if (cap && typeof cap.buildGuidanceReason === "function") {
      return cap.buildGuidanceReason(calendar);
    }
    return "";
  }

  function projectFinishFromStart(startYmd, estimatedDays, workdaysEnabled) {
    const cap = capApi();
    if (cap && typeof cap.projectFinishFromStart === "function") {
      return cap.projectFinishFromStart(startYmd, estimatedDays, {
        workdaysEnabled: workdaysEnabled !== false,
      });
    }
    return "";
  }

  function isStartBeforeSafeMin(calendar, chosenStart) {
    if (!calendar || !normDate(chosenStart)) return false;
    const min = effectiveStartMin(calendar);
    if (!min) return false;
    return compareYmd(chosenStart, min) < 0;
  }

  function hasActiveCrewConflict(calendar) {
    if (!calendar) return false;
    const status = String(calendar.capacity_status || "").toLowerCase();
    if (
      status === "conflict" ||
      status === "incomplete_reporting" ||
      status === "warning" ||
      status === "active_incomplete" ||
      status === "progress_unverified"
    ) {
      return true;
    }
    const detail = calendar.crew_availability_detail;
    const p = detail && detail.primary_project;
    return Boolean(p && !p.released && !p.is_completed_by_supervisor);
  }

  function isScheduleUnsafe(calendar, chosenStart) {
    if (!calendar || !normDate(chosenStart)) return false;
    return isStartBeforeSafeMin(calendar, chosenStart) || hasActiveCrewConflict(calendar);
  }

  function resolveScheduleWarningMessage(calendar, chosenStart) {
    const start = normDate(chosenStart);
    if (!calendar || !start) return "";
    const advisory = isAdvisoryCapacityMode(calendar);
    const suffix = advisory ? OWNER_IDS.advisorySuffix : "";
    if (isStartBlocked(calendar, start)) {
      return blockedStartMessage(calendar) + suffix;
    }
    if (advisory && isScheduleUnsafe(calendar, start)) {
      const reason = buildGuidanceReason(calendar);
      return (
        (reason || "Crew is not available for this start date.") + TENTATIVE_SCHEDULE_NOTE + suffix
      );
    }
    return "";
  }

  function buildTargetFinishHint(calendar, start, days, workdaysEnabled) {
    if (!normDate(start) || !(Number(days) > 0)) return TARGET_FINISH_HINT_DEFAULT;
    const dayLabel = workdaysEnabled !== false ? "workday" : "day";
    if (calendar && isStartBlocked(calendar, start)) {
      const nextLabel = formatDateUS(
        effectiveStartMin(calendar) || calendar.next_available_start_date
      );
      return `Start date blocked by crew capacity. Next safe date: ${nextLabel}. Target finish updates when a safe start is selected.`;
    }
    if (calendar && isScheduleUnsafe(calendar, start)) {
      return `Preview finish from tentative start (${formatDateUS(start)}) + ${Math.ceil(days)} ${dayLabel}(s). Not confirmed until crew is available.`;
    }
    return `System calculated from approved start (${formatDateUS(start)}) + ${Math.ceil(days)} ${dayLabel}(s) (Mon–Fri when enabled in Business Settings).`;
  }

  function showCapacityWarning(message, className) {
    const warning = document.getElementById(OWNER_IDS.warningId);
    if (!warning) return;
    const text = String(message || "").trim();
    if (!text) {
      warning.style.display = "none";
      warning.textContent = "";
      return;
    }
    warning.style.display = "block";
    warning.className = className || "notice";
    warning.textContent = text;
  }

  function updateTargetFinishDisplay(startYmd, estimatedDays, options) {
    const finishInput = document.getElementById(OWNER_IDS.finishId);
    const hint = document.getElementById(OWNER_IDS.hintId);
    const start = normDate(startYmd);
    const days = Number(estimatedDays);
    const hasDays = Number.isFinite(days) && days > 0;
    const workdaysEnabled = !options || options.workdaysEnabled !== false;
    const serverFinish = normDate(options && options.projectedFinishDate);
    const calendar = options && options.calendar;

    if (!start || !hasDays) {
      if (finishInput) finishInput.value = "";
      if (hint) hint.textContent = TARGET_FINISH_HINT_DEFAULT;
      return { start: "", finish: "", tentative: false, blocked: false };
    }

    const blocked = Boolean(calendar && isStartBlocked(calendar, start));
    const tentative = Boolean(calendar && isScheduleUnsafe(calendar, start));
    const finish =
      serverFinish && compareYmd(serverFinish, start) >= 0
        ? serverFinish
        : projectFinishFromStart(start, days, workdaysEnabled);

    if (finishInput) finishInput.value = finish;
    if (hint) {
      hint.textContent = buildTargetFinishHint(calendar, start, days, workdaysEnabled);
    }
    if (finishInput) {
      finishInput.setAttribute("data-schedule-tentative", tentative || blocked ? "true" : "false");
    }
    return { start, finish, tentative, blocked };
  }

  function applyCapacityGuidance(calendar) {
    const guidance = document.getElementById(OWNER_IDS.guidanceId);
    const warning = document.getElementById(OWNER_IDS.warningId);
    const startInput = document.getElementById(OWNER_IDS.startId);
    if (!calendar) return;

    const min = effectiveStartMin(calendar);
    const nextLabel = formatDateUS(min || calendar.next_available_start_date);
    const reasonText = buildGuidanceReason(calendar);
    const status = String(calendar.capacity_status || "").toLowerCase();
    const chosenStart = normDate(startInput && startInput.value);

    if (guidance) {
      if (status === "available" || !status) {
        guidance.innerHTML =
          `Next safe start date: <strong>${nextLabel}</strong><br>` +
          `Reason: ${reasonText}`;
      } else {
        guidance.innerHTML = reasonText || `Next safe start date: <strong>${nextLabel}</strong>`;
      }
      if (chosenStart && isAdvisoryCapacityMode(calendar) && isScheduleUnsafe(calendar, chosenStart)) {
        guidance.innerHTML +=
          '<br><span class="sales-op-capacity-tentative">Selected start is not crew-confirmed.</span>';
      }
    }
    if (startInput && min) {
      startInput.min = min;
      startInput.setAttribute("min", min);
    }
    if (warning) {
      const opAvail = document.getElementById(OWNER_IDS.crewAvailId);
      const scheduleWarn = resolveScheduleWarningMessage(calendar, chosenStart);
      if (opAvail) {
        const renderFn = global[OWNER_IDS.renderCrewFn];
        if (typeof renderFn === "function") {
          global[OWNER_IDS.unverifiedKey] = false;
          renderFn();
        }
        showCapacityWarning(scheduleWarn, scheduleWarn ? "notice" : null);
      } else if (scheduleWarn) {
        showCapacityWarning(scheduleWarn);
      } else {
        const msg =
          calendar.crew_availability_card_message ||
          calendar.availability_message ||
          (status === "conflict" || status === "incomplete_reporting" || status === "warning"
            ? reasonText + OWNER_IDS.advisorySuffix
            : "");
        if (msg && status !== "available") {
          showCapacityWarning(msg);
        } else {
          showCapacityWarning("");
        }
      }
    }
  }

  global.MarginGuardOwnerCapacity = {
    OWNER_IDS,
    TARGET_FINISH_HINT_DEFAULT,
    ADVISORY_SUFFIX_QUOTE,
    TENTATIVE_SCHEDULE_NOTE,
    updateTargetFinishDisplay,
    applyCapacityGuidance,
    showCapacityWarning,
    resolveScheduleWarningMessage,
    isScheduleUnsafe,
    isStartBeforeSafeMin,
    hasActiveCrewConflict,
    buildTargetFinishHint,
  };
})(typeof window !== "undefined" ? window : globalThis);
