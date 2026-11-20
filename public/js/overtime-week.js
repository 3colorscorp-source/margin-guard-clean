/**
 * Weekly overtime for a quote.
 * Weekday labor is the days already entered. Saturday and Sunday are added
 * only when the client asks for them. The first 40 hours of each person
 * each week stay at the regular rate. Hours after that are time and a half.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.MgOvertimeWeek = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var WEEKLY_REGULAR_CAP = 40;
  var WEEKDAYS = 5;
  var OVERTIME_MULTIPLIER = 1.5;

  function splitLaborHours(days, hoursPerDay, options) {
    var hpd = Number(hoursPerDay);
    if (!Number.isFinite(hpd) || hpd <= 0) hpd = 8;
    var weekdayDays = Math.max(0, Number(days) || 0);
    var src = options && typeof options === "object" ? options : {};
    var saturday = src.saturday === true || src.clientWantsSaturday === true || src.client_wants_saturday === true;
    var sunday = src.sunday === true || src.clientWantsSunday === true || src.client_wants_sunday === true;
    var fullWeeks = Math.floor(weekdayDays / WEEKDAYS);
    var remainder = weekdayDays - fullWeeks * WEEKDAYS;
    var includePartial = remainder > 0 || ((saturday || sunday) && weekdayDays === 0);
    var regularHours = 0;
    var overtimeHours = 0;

    function addWeek(weekDayCount) {
      var blocks = [weekDayCount * hpd];
      if (saturday) blocks.push(hpd);
      if (sunday) blocks.push(hpd);
      var room = WEEKLY_REGULAR_CAP;
      for (var i = 0; i < blocks.length; i += 1) {
        var block = blocks[i];
        if (!(block > 0)) continue;
        var regularPart = Math.min(block, Math.max(0, room));
        regularHours += regularPart;
        overtimeHours += block - regularPart;
        room -= regularPart;
      }
    }

    for (var week = 0; week < fullWeeks; week += 1) addWeek(WEEKDAYS);
    if (includePartial) addWeek(remainder);

    var weeks = fullWeeks + (includePartial ? 1 : 0);
    var weekendDays = 0;
    if (saturday) weekendDays += weeks;
    if (sunday) weekendDays += weeks;

    return {
      regularHours: regularHours,
      overtimeHours: overtimeHours,
      totalHours: regularHours + overtimeHours,
      weekendDays: weekendDays,
      overtimeMultiplier: OVERTIME_MULTIPLIER
    };
  }

  function pricedLabor(days, hoursPerDay, rate, options) {
    var split = splitLaborHours(days, hoursPerDay, options);
    var pay = Number(rate) || 0;
    var regularCost = split.regularHours * pay;
    var overtimeCost = split.overtimeHours * pay * OVERTIME_MULTIPLIER;
    return {
      regularHours: split.regularHours,
      overtimeHours: split.overtimeHours,
      totalHours: split.totalHours,
      weekendDays: split.weekendDays,
      regularCost: regularCost,
      overtimeCost: overtimeCost,
      cost: regularCost + overtimeCost
    };
  }

  return {
    WEEKLY_REGULAR_CAP: WEEKLY_REGULAR_CAP,
    WEEKDAYS: WEEKDAYS,
    OVERTIME_MULTIPLIER: OVERTIME_MULTIPLIER,
    splitLaborHours: splitLaborHours,
    pricedLabor: pricedLabor
  };
});
