/**
 * Contract Builder Article 8 — estimated schedule presentation and confirm.
 *
 * Owns date display, CTA plan, busy lock, persist/no-persist, and readiness captions.
 * Does not invent dates, use today, auto-confirm, freeze, or change Article 7.
 */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.MarginGuardContractScheduleConfirm = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var QUOTE_UPDATE_API = "/.netlify/functions/update-tenant-quote-edit";
  var SETUP_API = "/.netlify/functions/project-contract-setup";
  var NOTICE =
    "Project dates may change due to site conditions, material availability, approved changes, or events outside either party's reasonable control.";
  var INVALID_ORDER = "Completion date must be on or after the start date.";
  var NOT_SCHEDULED = "Not scheduled";
  var START_MISSING_MESSAGE = "Add the project start date to continue.";
  var COMPLETION_MISSING_MESSAGE = "Add the target completion date to continue.";
  var STORAGE_PREFIX = "mg.art8.scheduleConfirmed.";
  var confirmLock = false;

  function trimField(value) {
    return String(value == null ? "" : value).trim();
  }

  function normIsoDate(raw) {
    if (raw === null || raw === undefined) return "";
    var t = trimField(raw);
    if (!t) return "";
    var slice = t.slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(slice) ? slice : "";
  }

  function formatDisplayDate(raw) {
    var ymd = normIsoDate(raw);
    if (!ymd) return "";
    try {
      var d = new Date(ymd + "T12:00:00");
      if (Number.isNaN(d.getTime())) return ymd;
      return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(d);
    } catch (_err) {
      return ymd;
    }
  }

  function datesFromSource(source, edits) {
    var e = edits || {};
    var s = source || {};
    return {
      startDate: normIsoDate(
        e.startDate != null && e.startDate !== "" ? e.startDate : s.startDate
      ),
      dueDate: normIsoDate(e.dueDate != null && e.dueDate !== "" ? e.dueDate : s.dueDate),
    };
  }

  function validateScheduleDates(startRaw, dueRaw) {
    var startDate = normIsoDate(startRaw);
    var dueDate = normIsoDate(dueRaw);
    var errors = [];
    if (!startDate) errors.push(START_MISSING_MESSAGE);
    if (!dueDate) errors.push(COMPLETION_MISSING_MESSAGE);
    var orderInvalid = Boolean(startDate && dueDate && dueDate < startDate);
    if (orderInvalid) errors.push(INVALID_ORDER);
    return {
      ok: errors.length === 0,
      complete: Boolean(startDate && dueDate && dueDate >= startDate),
      startDate: startDate,
      dueDate: dueDate,
      orderInvalid: orderInvalid,
      errors: errors,
    };
  }

  function confirmationKey(projectId, quoteId) {
    return STORAGE_PREFIX + trimField(projectId) + "." + trimField(quoteId);
  }

  function readStoredConfirmation(projectId, quoteId, storage) {
    var store = storage || (typeof localStorage !== "undefined" ? localStorage : null);
    if (!store || typeof store.getItem !== "function") return null;
    try {
      var raw = store.getItem(confirmationKey(projectId, quoteId));
      if (!raw) return null;
      var data = JSON.parse(raw);
      var startDate = normIsoDate(data && data.startDate);
      var dueDate = normIsoDate(data && data.dueDate);
      if (!startDate || !dueDate) return null;
      return { startDate: startDate, dueDate: dueDate, confirmed: true };
    } catch (_err) {
      return null;
    }
  }

  function writeStoredConfirmation(projectId, quoteId, startDate, dueDate, storage) {
    var store = storage || (typeof localStorage !== "undefined" ? localStorage : null);
    if (!store || typeof store.setItem !== "function") return;
    store.setItem(
      confirmationKey(projectId, quoteId),
      JSON.stringify({
        startDate: normIsoDate(startDate),
        dueDate: normIsoDate(dueDate),
      })
    );
  }

  function clearStoredConfirmation(projectId, quoteId, storage) {
    var store = storage || (typeof localStorage !== "undefined" ? localStorage : null);
    if (!store || typeof store.removeItem !== "function") return;
    store.removeItem(confirmationKey(projectId, quoteId));
  }

  function storedConfirmationMatches(stored, startDate, dueDate) {
    if (!stored || stored.confirmed !== true) return false;
    return (
      stored.startDate === normIsoDate(startDate) && stored.dueDate === normIsoDate(dueDate)
    );
  }

  function serverConfirmationFromSource(source) {
    var src = source || {};
    var setup = (src.contractSetup && src.contractSetup.setup) || src.setup || {};
    var confirmedAt = trimField(
      src.scheduleConfirmedAt || setup.schedule_confirmed_at || ""
    );
    var startDate = normIsoDate(
      src.scheduleConfirmedStart || setup.schedule_confirmed_start_date
    );
    var dueDate = normIsoDate(
      src.scheduleConfirmedDue || setup.schedule_confirmed_due_date
    );
    var setupProject = trimField(setup.project_id || src.projectId);
    var setupQuote = trimField(setup.quote_id || src.quoteId);
    var idsMatch =
      (!setup.project_id || setupProject === trimField(src.projectId)) &&
      (!setup.quote_id || setupQuote === trimField(src.quoteId));
    return {
      confirmedAt: confirmedAt || "",
      startDate: startDate,
      dueDate: dueDate,
      idsMatch: idsMatch,
    };
  }

  function scheduleConfirmed(source, edits) {
    var dates = datesFromSource(source, edits);
    var check = validateScheduleDates(dates.startDate, dates.dueDate);
    if (!check.complete) return false;
    var server = serverConfirmationFromSource(source);
    if (!server.confirmedAt || server.idsMatch !== true) return false;
    return server.startDate === check.startDate && server.dueDate === check.dueDate;
  }

  function scheduleKind(input) {
    var src = input || {};
    var check = validateScheduleDates(src.startDate, src.dueDate);
    if (check.orderInvalid) return "invalid";
    if (!check.startDate) return "missing_start";
    if (!check.dueDate) return "missing_completion";
    if (src.confirmed === true) return "confirmed";
    return "unconfirmed";
  }

  function presentScheduleArticle(input) {
    var src = input || {};
    var check = validateScheduleDates(src.startDate, src.dueDate);
    var confirmed = src.confirmed === true && check.complete;
    var frozen = src.frozen === true;
    var kind = scheduleKind({
      startDate: check.startDate,
      dueDate: check.dueDate,
      confirmed: confirmed,
    });
    var dueValid = Boolean(check.dueDate) && !check.orderInvalid;
    var showCompletion = Boolean(check.startDate) || dueValid;
    var message = "";
    if (kind === "invalid") message = INVALID_ORDER;
    else if (kind === "missing_start") message = START_MISSING_MESSAGE;
    else if (kind === "missing_completion") message = COMPLETION_MISSING_MESSAGE;
    var showNotice = kind === "unconfirmed" || kind === "confirmed";
    var readinessStatus = kind === "confirmed" ? "available" : "needs_confirmation";
    return {
      kind: kind,
      startLabel: "Estimated Start Date",
      startValue: check.startDate ? formatDisplayDate(check.startDate) : NOT_SCHEDULED,
      startDate: check.startDate,
      completionLabel: "Target Completion",
      completionValue: check.dueDate ? formatDisplayDate(check.dueDate) : NOT_SCHEDULED,
      dueDate: check.dueDate,
      showCompletion: showCompletion,
      notice: showNotice ? NOTICE : "",
      message: message,
      readinessCaption:
        kind === "confirmed"
          ? "COMPLETE — ESTIMATED SCHEDULE"
          : "NEEDS CONFIRMATION — ESTIMATED SCHEDULE",
      readinessStatus: readinessStatus,
      readinessLabel: "ESTIMATED SCHEDULE",
      orderInvalid: check.orderInvalid === true,
      confirmBlocked: check.complete !== true,
      persistBlocked: check.orderInvalid === true,
      footerPrimaryVisible: true,
      footerPrimaryLabel:
        kind === "confirmed"
          ? "Continue"
          : kind === "unconfirmed"
            ? "Confirm Schedule"
            : "Set Project Dates",
      editVisible: frozen ? false : kind === "unconfirmed" || kind === "confirmed",
      editLabel: "Edit Project Dates",
      continueVisible: kind === "confirmed",
      continueEnabled: kind === "confirmed" && src.busy !== true,
      confirmVisible: kind === "unconfirmed",
      setDatesVisible: kind === "missing_start" || kind === "missing_completion" || kind === "invalid",
    };
  }

  function scheduleFooterPlan(input) {
    var view = presentScheduleArticle(input);
    var busy = Boolean(input && input.busy);
    var buttons = [];
    if (view.setDatesVisible) {
      buttons.push({
        id: "set",
        label: "Set Project Dates",
        style: "primary",
        enabled: !busy,
      });
    }
    if (view.editVisible) {
      buttons.push({
        id: "edit",
        label: "Edit Project Dates",
        style: "ghost",
        enabled: !busy,
      });
    }
    if (view.confirmVisible) {
      buttons.push({
        id: "confirm",
        label: "Confirm Schedule",
        style: "primary",
        enabled: !busy,
      });
    }
    if (view.continueVisible) {
      buttons.push({
        id: "continue",
        label: "Continue",
        style: "primary",
        enabled: view.continueEnabled,
      });
    }
    var primaries = buttons.filter(function (btn) {
      return btn.style === "primary" && btn.enabled;
    });
    return {
      kind: view.kind,
      buttons: buttons,
      continueVisible: view.continueVisible,
      continueEnabled: view.continueEnabled,
      confirmVisible: view.confirmVisible,
      setDatesVisible: view.setDatesVisible,
      editVisible: view.editVisible,
      primaryEnabledCount: primaries.length,
      primaryLabel: primaries[0] ? primaries[0].label : "",
      message: view.message,
    };
  }

  function scheduleTermsReadiness(input) {
    var view = presentScheduleArticle(input);
    return {
      status: view.readinessStatus,
      caption: view.readinessCaption,
      label: view.readinessLabel,
    };
  }

  function quoteAllowsScheduleWrite(quote) {
    var row = quote || {};
    var status = trimField(row.status).toLowerCase();
    var start = normIsoDate(row.start_date || row.startDate);
    var due = normIsoDate(row.due_date || row.dueDate);
    if (!start && !due && (status === "accepted" || status === "approved")) return true;
    if (status && status !== "accepted" && status !== "approved") return true;
    return false;
  }

  function buildScheduleDatePayload(quoteId, startDate, dueDate) {
    return {
      quote_id: quoteId,
      start_date: normIsoDate(startDate),
      due_date: normIsoDate(dueDate),
      confirm_sent_update: true,
    };
  }

  function buildScheduleConfirmPayload(projectId, quoteId) {
    return {
      project_id: projectId,
      quote_id: quoteId,
      confirm_estimated_schedule: true,
    };
  }

  function createScheduleConfirmRunner(hooks) {
    var h = hooks || {};

    function tryLock() {
      if (confirmLock) return false;
      if (typeof h.getBusy === "function" && h.getBusy()) return false;
      confirmLock = true;
      if (typeof h.setBusy === "function") h.setBusy(true);
      return true;
    }

    function unlock() {
      confirmLock = false;
      if (typeof h.setBusy === "function") h.setBusy(false);
    }

    async function confirm() {
      if (!tryLock()) {
        return { ok: false, reason: "busy", posted: false };
      }
      try {
        var ids = typeof h.getIds === "function" ? h.getIds() || {} : {};
        var requestProjectId = trimField(ids.projectId);
        var requestQuoteId = trimField(ids.quoteId);
        var dates = typeof h.getDates === "function" ? h.getDates() || {} : {};
        var check = validateScheduleDates(dates.startDate, dates.dueDate);
        if (check.orderInvalid) {
          return {
            ok: false,
            reason: "invalid",
            posted: false,
            openEdit: true,
            error: INVALID_ORDER,
            persistBlocked: true,
            readinessUnchanged: true,
          };
        }
        if (!check.complete) {
          return {
            ok: false,
            reason: check.startDate ? "missing_completion" : "missing_start",
            posted: false,
            openEdit: true,
            error: check.errors[0] || START_MISSING_MESSAGE,
          };
        }
        if (typeof h.isConfirmed === "function" && h.isConfirmed()) {
          return { ok: true, reason: "already_confirmed", posted: false };
        }
        var payload = buildScheduleConfirmPayload(requestProjectId, requestQuoteId);
        if (typeof h.postJson !== "function") {
          throw new Error("postJson is required to confirm the estimated schedule.");
        }
        var res = await h.postJson(h.apiUrl || SETUP_API, payload);
        var current = typeof h.getIds === "function" ? h.getIds() || {} : {};
        if (
          trimField(current.projectId) !== requestProjectId ||
          trimField(current.quoteId) !== requestQuoteId
        ) {
          return {
            ok: false,
            reason: "stale_project",
            posted: true,
            payload: payload,
          };
        }
        if (!res || res.ok !== true || !res.data || res.data.ok !== true) {
          return {
            ok: false,
            reason: "http",
            posted: true,
            payload: payload,
            error:
              trimField(res && res.data && res.data.error) ||
              "Estimated schedule could not be confirmed.",
            status: res && res.status,
          };
        }
        var setup = res.data.setup || null;
        var serverStart = normIsoDate(setup && setup.schedule_confirmed_start_date);
        var serverDue = normIsoDate(setup && setup.schedule_confirmed_due_date);
        if (!setup || !setup.schedule_confirmed_at) {
          return {
            ok: false,
            reason: "http",
            posted: true,
            payload: payload,
            error: "Estimated schedule confirmation was not persisted.",
          };
        }
        if (typeof h.applySuccess === "function") {
          h.applySuccess(res.data, payload, {
            startDate: serverStart,
            dueDate: serverDue,
            setup: setup,
            readiness: res.data.readiness || null,
          });
        }
        return {
          ok: true,
          reason: "confirmed",
          posted: true,
          payload: payload,
          setup: setup,
        };
      } finally {
        unlock();
      }
    }

    return {
      confirm: confirm,
      isLocked: function () {
        return confirmLock;
      },
    };
  }

  function applyConfirmationToEdits(edits, startDate, dueDate) {
    var next = edits || {};
    next.startDate = normIsoDate(startDate);
    next.dueDate = normIsoDate(dueDate);
    next.scheduleConfirmed = true;
    next.scheduleConfirmedStart = next.startDate;
    next.scheduleConfirmedDue = next.dueDate;
    return next;
  }

  function applyServerSetupToSource(source, setup) {
    var next = source || {};
    var row = setup || {};
    next.scheduleConfirmedAt = row.schedule_confirmed_at || "";
    next.scheduleConfirmedStart = normIsoDate(row.schedule_confirmed_start_date);
    next.scheduleConfirmedDue = normIsoDate(row.schedule_confirmed_due_date);
    next.scheduleConfirmed = Boolean(row.schedule_confirmed_at);
    if (row.schedule_confirmed_start_date) {
      next.startDate = normIsoDate(row.schedule_confirmed_start_date);
    }
    if (Object.prototype.hasOwnProperty.call(row, "schedule_confirmed_due_date")) {
      next.dueDate = normIsoDate(row.schedule_confirmed_due_date);
    }
    return next;
  }

  function clearConfirmationOnDateChange(edits) {
    var next = edits || {};
    if (next.scheduleConfirmed !== true) return next;
    if (
      normIsoDate(next.startDate) === normIsoDate(next.scheduleConfirmedStart) &&
      normIsoDate(next.dueDate) === normIsoDate(next.scheduleConfirmedDue)
    ) {
      return next;
    }
    next.scheduleConfirmed = false;
    next.scheduleConfirmedStart = "";
    next.scheduleConfirmedDue = "";
    return next;
  }

  return {
    QUOTE_UPDATE_API: QUOTE_UPDATE_API,
    SETUP_API: SETUP_API,
    NOTICE: NOTICE,
    INVALID_ORDER: INVALID_ORDER,
    NOT_SCHEDULED: NOT_SCHEDULED,
    START_MISSING_MESSAGE: START_MISSING_MESSAGE,
    COMPLETION_MISSING_MESSAGE: COMPLETION_MISSING_MESSAGE,
    normIsoDate: normIsoDate,
    formatDisplayDate: formatDisplayDate,
    validateScheduleDates: validateScheduleDates,
    datesFromSource: datesFromSource,
    scheduleKind: scheduleKind,
    presentScheduleArticle: presentScheduleArticle,
    scheduleFooterPlan: scheduleFooterPlan,
    scheduleTermsReadiness: scheduleTermsReadiness,
    scheduleConfirmed: scheduleConfirmed,
    quoteAllowsScheduleWrite: quoteAllowsScheduleWrite,
    buildScheduleDatePayload: buildScheduleDatePayload,
    buildScheduleConfirmPayload: buildScheduleConfirmPayload,
    createScheduleConfirmRunner: createScheduleConfirmRunner,
    readStoredConfirmation: readStoredConfirmation,
    writeStoredConfirmation: writeStoredConfirmation,
    clearStoredConfirmation: clearStoredConfirmation,
    storedConfirmationMatches: storedConfirmationMatches,
    applyConfirmationToEdits: applyConfirmationToEdits,
    applyServerSetupToSource: applyServerSetupToSource,
    serverConfirmationFromSource: serverConfirmationFromSource,
    clearConfirmationOnDateChange: clearConfirmationOnDateChange,
    confirmationKey: confirmationKey,
  };
});
