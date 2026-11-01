/**
 * Supervisor project hold.
 * Calendar target finish moves forward. Labor-day index stays on days worked.
 * Browser and Node. Does not write production data.
 */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.MgSupervisorProjectHold = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var DEFAULT_HOLD_REASON = "Other trade on site";
  var MAX_HOLD_DAYS = 366;

  function normDate(value) {
    var text = String(value == null ? "" : value).trim();
    var match = text.match(/^(\d{4}-\d{2}-\d{2})/);
    return match ? match[1] : "";
  }

  function pad(n) {
    return String(n).padStart(2, "0");
  }

  function utcDate(ymd) {
    var iso = normDate(ymd);
    if (!iso) return null;
    var parts = iso.split("-");
    return new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])));
  }

  function formatUtc(date) {
    return (
      date.getUTCFullYear() +
      "-" +
      pad(date.getUTCMonth() + 1) +
      "-" +
      pad(date.getUTCDate())
    );
  }

  function addCalendarDays(ymd, days) {
    var date = utcDate(ymd);
    if (!date) return "";
    var n = Math.trunc(Number(days) || 0);
    date.setUTCDate(date.getUTCDate() + n);
    return formatUtc(date);
  }

  function diffCalendarDays(startYmd, endYmd) {
    var start = utcDate(startYmd);
    var end = utcDate(endYmd);
    if (!start || !end) return 0;
    return Math.round((end.getTime() - start.getTime()) / 86400000);
  }

  function normalizeHoldList(raw) {
    var rows = Array.isArray(raw) ? raw : [];
    var out = [];
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i];
      if (!row || typeof row !== "object") continue;
      var id = String(row.id || "").trim().slice(0, 80);
      var reason = String(row.reason || "").trim().slice(0, 200);
      var days = Math.floor(Number(row.days));
      if (!id || !reason || !Number.isFinite(days) || days < 1 || days > MAX_HOLD_DAYS) continue;
      var unit = row.unit === "weeks" || row.unit === "range" ? row.unit : "days";
      out.push({
        id: id,
        reason: reason,
        days: days,
        unit: unit,
        range_start: normDate(row.range_start) || null,
        range_end: normDate(row.range_end) || null,
        created_at: String(row.created_at || "").slice(0, 40),
      });
    }
    return out;
  }

  function rawPlanObject(raw) {
    if (typeof raw === "string" && raw.trim()) {
      try {
        return rawPlanObject(JSON.parse(raw));
      } catch (_err) {
        return null;
      }
    }
    if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
    return null;
  }

  function extractProjectHolds(raw) {
    var obj = rawPlanObject(raw);
    if (!obj) return [];
    return normalizeHoldList(obj.project_holds);
  }

  function planDaysFromRaw(raw) {
    if (Array.isArray(raw)) return raw.slice();
    if (typeof raw === "string" && raw.trim()) {
      try {
        return planDaysFromRaw(JSON.parse(raw));
      } catch (_err) {
        return [];
      }
    }
    var obj = rawPlanObject(raw);
    if (obj && Array.isArray(obj.days)) return obj.days.slice();
    return [];
  }

  function planValueWithHolds(days, holds) {
    var dayList = Array.isArray(days) ? days.slice() : [];
    var list = normalizeHoldList(holds);
    if (!list.length) return dayList;
    return { days: dayList, project_holds: list };
  }

  function summarizeTarget(originalTarget, holds) {
    var original = normDate(originalTarget);
    var list = normalizeHoldList(holds);
    var holdDays = 0;
    for (var i = 0; i < list.length; i += 1) holdDays += list[i].days;
    return {
      originalTarget: original,
      holdDays: holdDays,
      adjustedTarget: original ? addCalendarDays(original, holdDays) : "",
      holds: list,
    };
  }

  function makeHoldId(seed) {
    var base = String(seed || "").trim();
    if (base) return base.slice(0, 80);
    return "hold-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }

  function createHoldFromInput(input, nowIso) {
    var body = input && typeof input === "object" ? input : {};
    var reason = String(body.reason == null ? "" : body.reason).trim().slice(0, 200);
    if (!reason) {
      return { ok: false, error: "A reason is required.", code: "reason_required" };
    }
    var mode = body.mode === "range" ? "range" : "count";
    var days = 0;
    var unit = "days";
    var rangeStart = null;
    var rangeEnd = null;
    if (mode === "range") {
      rangeStart = normDate(body.range_start);
      rangeEnd = normDate(body.range_end);
      if (!rangeStart || !rangeEnd || rangeEnd < rangeStart) {
        return { ok: false, error: "Enter a valid date range.", code: "invalid_range" };
      }
      days = diffCalendarDays(rangeStart, rangeEnd) + 1;
      unit = "range";
    } else {
      var amount = Math.floor(Number(body.amount != null ? body.amount : body.days));
      unit = body.unit === "weeks" ? "weeks" : "days";
      if (!Number.isFinite(amount) || amount < 1) {
        return { ok: false, error: "Enter a number of days or weeks.", code: "invalid_days" };
      }
      days = unit === "weeks" ? amount * 7 : amount;
    }
    if (days > MAX_HOLD_DAYS) {
      return { ok: false, error: "A hold can be at most 366 days.", code: "hold_too_long" };
    }
    var createdAt = String(nowIso || body.created_at || "").slice(0, 40);
    return {
      ok: true,
      hold: {
        id: makeHoldId(body.id),
        reason: reason,
        days: days,
        unit: unit,
        range_start: rangeStart,
        range_end: rangeEnd,
        created_at: createdAt,
      },
    };
  }

  function addProjectHold(holds, input, nowIso) {
    var created = createHoldFromInput(input, nowIso);
    if (!created.ok) return created;
    var list = normalizeHoldList(holds);
    var id = created.hold.id;
    var taken = false;
    for (var i = 0; i < list.length; i += 1) {
      if (list[i].id === id) taken = true;
    }
    if (taken) created.hold.id = makeHoldId("");
    list.push(created.hold);
    return { ok: true, hold: created.hold, holds: list };
  }

  function removeProjectHold(holds, holdId) {
    var id = String(holdId || "").trim();
    var list = normalizeHoldList(holds);
    if (!id) {
      return { ok: false, error: "That hold was not found.", code: "hold_not_found", holds: list };
    }
    var next = [];
    for (var i = 0; i < list.length; i += 1) {
      if (list[i].id !== id) next.push(list[i]);
    }
    if (next.length === list.length) {
      return { ok: false, error: "That hold was not found.", code: "hold_not_found", holds: list };
    }
    return { ok: true, holds: next };
  }

  function laborDayIndex(input) {
    var body = input && typeof input === "object" ? input : {};
    var planLength = Math.max(0, Math.floor(Number(body.planLength) || 0));
    var worked = Math.max(0, Math.floor(Number(body.actualDays) || 0));
    var startIso = normDate(body.startIso);
    var todayIso = normDate(body.todayIso || body.today);
    if (startIso && todayIso && todayIso < startIso) return 1;
    var index = worked + 1;
    if (planLength > 0) index = Math.min(index, planLength);
    return Math.max(1, index);
  }

  function evaluateSchedule(input) {
    var body = input && typeof input === "object" ? input : {};
    var summary = summarizeTarget(body.originalTarget, body.holds);
    var estimatedDays = Number(body.estimatedDays);
    if (!Number.isFinite(estimatedDays) || estimatedDays < 0) estimatedDays = 0;
    var actualDays = Number(body.actualDays);
    if (!Number.isFinite(actualDays) || actualDays < 0) actualDays = 0;
    var planLength = Math.floor(Number(body.planLength) || 0);
    if (!Number.isFinite(planLength) || planLength < 0) planLength = 0;
    var today = normDate(body.today);
    var index = laborDayIndex({
      planLength: planLength > 0 ? planLength : estimatedDays,
      actualDays: actualDays,
      startIso: body.startIso,
      todayIso: today,
    });
    var hasHold = summary.holds.length > 0;
    var laborLate = estimatedDays > 0 && actualDays > estimatedDays;
    var calendarBehindDays = 0;
    var calendarTarget = hasHold ? summary.adjustedTarget : summary.originalTarget;
    if (today && calendarTarget && today > calendarTarget) {
      calendarBehindDays = diffCalendarDays(calendarTarget, today);
    }
    // A saved pause excuses calendar slip, including days still past the adjusted finish.
    // The labor-day index stays on worked days and does not count hold days.
    // Labor is late only when worked days themselves run past the plan.
    var behind = hasHold ? laborLate : calendarBehindDays > 0 || laborLate;
    return {
      originalTarget: summary.originalTarget,
      holdDays: summary.holdDays,
      adjustedTarget: summary.adjustedTarget,
      holds: summary.holds,
      hasHold: hasHold,
      laborDayIndex: index,
      calendarBehindDays: calendarBehindDays,
      laborLate: laborLate,
      behind: behind,
    };
  }

  return {
    DEFAULT_HOLD_REASON: DEFAULT_HOLD_REASON,
    MAX_HOLD_DAYS: MAX_HOLD_DAYS,
    normDate: normDate,
    addCalendarDays: addCalendarDays,
    extractProjectHolds: extractProjectHolds,
    planDaysFromRaw: planDaysFromRaw,
    planValueWithHolds: planValueWithHolds,
    summarizeTarget: summarizeTarget,
    createHoldFromInput: createHoldFromInput,
    addProjectHold: addProjectHold,
    removeProjectHold: removeProjectHold,
    laborDayIndex: laborDayIndex,
    evaluateSchedule: evaluateSchedule,
  };
});
