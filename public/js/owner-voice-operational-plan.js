/**
 * Owner portal voice operational-plan — Phase 2.
 * Capture + interpret + preview, then Confirm and apply to the Owner draft only.
 * Does not publish, send, PDF, or write Seller state.
 */
(function (global) {
  "use strict";

  var MAX_TRANSCRIPT_CHARS = 6000;
  var ENDPOINT = "/.netlify/functions/voice-operational-plan-command";
  var CONFIRM_APPLY_ENABLED = true;
  var OWNER_STORE_KEY = "mg_owner_v2";
  var SETTINGS_STORE_KEY = "mg_settings_v2";
  var EMPTY_DOCUMENT = { schema_version: 1, source: "keyboard", days: [] };

  var NO_SPEECH_API_MESSAGE =
    "Este navegador no puede dictar por voz. Puedes escribir las instrucciones y pulsar Interpret and preview.";
  var PERMISSION_DENIED_MESSAGE =
    "El permiso del micrófono fue denegado. Actívalo en la configuración del navegador o escribe las instrucciones en el recuadro.";
  var MIC_START_FAILED_MESSAGE =
    "No se pudo iniciar el micrófono. Revisa el permiso del navegador o escribe las instrucciones.";
  var EMPTY_INTERPRET_MESSAGE = "Dictate or type instructions first.";
  var LISTENING_MESSAGE = "Listening… describe the plan or say which day to modify.";
  var STOPPED_MESSAGE = "Dictation stopped. Review the text, then choose Interpret and preview.";
  var READY_STATUS =
    "Voice changes are proposed only. Confirm and apply is required to update the Owner draft.";
  var PREVIEW_EMPTY_CLIENT = "No client-facing scope yet.";
  var PREVIEW_EMPTY_INTERNAL = "No internal plan yet.";
  var APPLY_SUCCESS_MESSAGE = "Operational plan applied to this Owner draft.";
  var APPLY_FAILED_MESSAGE = "Could not apply the plan. The Owner draft was left unchanged.";
  var NO_PREVIEW_MESSAGE = "Interpret a valid preview before Confirm and apply.";
  var OVERWRITE_BOTH_MESSAGE =
    "Scope of Work and the operational plan already have content. Confirm and apply will replace both with this preview. Cancel keeps everything unchanged.";
  var OVERWRITE_NOTES_MESSAGE =
    "Scope of Work already has text. Confirm and apply will replace it with this Client Scope. Cancel keeps everything unchanged.";
  var OVERWRITE_PLAN_MESSAGE =
    "The operational plan already has days. Confirm and apply will replace them with this preview. Cancel keeps everything unchanged.";

  function str(value) {
    return String(value == null ? "" : value);
  }

  function clampTranscript(value) {
    return str(value).slice(0, MAX_TRANSCRIPT_CHARS);
  }

  function canInterpretTranscript(value) {
    return clampTranscript(value).trim().length >= 3;
  }

  function transcriptAfterDictationStart(existing, appendExisting) {
    if (!appendExisting) return "";
    return clampTranscript(str(existing).trim());
  }

  function joinTranscriptParts(base, finalText, interim) {
    return clampTranscript([base, finalText, interim].filter(Boolean).join(" "));
  }

  function isPermissionDeniedCode(code) {
    var c = str(code).toLowerCase();
    return c === "not-allowed" || c === "service-not-allowed" || c === "permission-denied";
  }

  function shouldIgnoreSpeechError(code) {
    var c = str(code).toLowerCase();
    return c === "aborted" || c === "no-speech";
  }

  function permissionErrorMessage(code) {
    if (isPermissionDeniedCode(code)) return PERMISSION_DENIED_MESSAGE;
    if (str(code).toLowerCase() === "audio-capture") {
      return "No se encontró un micrófono. Conecta uno o escribe las instrucciones.";
    }
    return MIC_START_FAILED_MESSAGE;
  }

  function speechRecognitionCtor(win) {
    var w = win || global;
    if (!w) return null;
    return w.SpeechRecognition || w.webkitSpeechRecognition || null;
  }

  function isStaleInterpret(requestId, activeId, modalOpen) {
    return !modalOpen || requestId !== activeId;
  }

  function resolveClientLanguage(value) {
    return str(value).toLowerCase() === "es" ? "es" : "en";
  }

  function buildInterpretRequestBody(transcript, clientLanguage) {
    return {
      transcript: clampTranscript(transcript).trim(),
      current_document: EMPTY_DOCUMENT,
      start_date: "",
      client_language: resolveClientLanguage(clientLanguage)
    };
  }

  function formatClientPreview(proposed, publicScope) {
    if (publicScope && str(publicScope.narrative).trim()) return str(publicScope.narrative).trim();
    var days = proposed && Array.isArray(proposed.days) ? proposed.days : [];
    var lines = [];
    days.forEach(function (day) {
      var text = str(day && day.client_scope).trim();
      if (text) lines.push("Day " + (day.day_number || "") + ": " + text);
    });
    return lines.join("\n") || PREVIEW_EMPTY_CLIENT;
  }

  function formatInternalPreview(proposed) {
    var days = proposed && Array.isArray(proposed.days) ? proposed.days : [];
    var lines = [];
    days.forEach(function (day) {
      lines.push("Day " + (day.day_number || "") + (day.date ? " (" + day.date + ")" : ""));
      (day.internal_tasks || []).forEach(function (task) {
        if (task && task.label) lines.push("  • " + task.label);
      });
      (day.worker_assignments || []).forEach(function (asg) {
        lines.push(
          "  " +
            (asg.worker_count || 1) +
            "× " +
            (asg.worker_role || "Installer") +
            " @ " +
            (asg.hours_per_worker || 0) +
            "h"
        );
      });
      if (day.materials_or_tools && day.materials_or_tools.length) {
        lines.push("  Materials: " + day.materials_or_tools.join(", "));
      }
      if (day.internal_notes) lines.push("  Notes: " + day.internal_notes);
    });
    return lines.join("\n") || PREVIEW_EMPTY_INTERNAL;
  }

  function cloneJson(value) {
    return JSON.parse(JSON.stringify(value == null ? null : value));
  }

  function hasMeaningfulText(value) {
    return str(value).trim().length > 0;
  }

  function ownerPlanHasDays(plan) {
    return Array.isArray(plan) && plan.length > 0;
  }

  function needsOverwriteConfirm(existingNotes, existingPlan) {
    return hasMeaningfulText(existingNotes) || ownerPlanHasDays(existingPlan);
  }

  function overwriteWarningMessage(existingNotes, existingPlan) {
    var notes = hasMeaningfulText(existingNotes);
    var plan = ownerPlanHasDays(existingPlan);
    if (notes && plan) return OVERWRITE_BOTH_MESSAGE;
    if (notes) return OVERWRITE_NOTES_MESSAGE;
    return OVERWRITE_PLAN_MESSAGE;
  }

  function deriveOwnerOperationalPlan(proposed, hoursPerDay) {
    var hpd = Number(hoursPerDay);
    if (!Number.isFinite(hpd) || hpd <= 0) hpd = 8;
    var days = proposed && Array.isArray(proposed.days) ? proposed.days : [];
    var out = [];
    days.forEach(function (day) {
      if (!day) return;
      var workers = [];
      (Array.isArray(day.worker_assignments) ? day.worker_assignments : []).forEach(function (asg) {
        if (!asg) return;
        var count = Math.max(1, Math.floor(Number(asg.worker_count) || 1));
        var hours = Number(asg.hours_per_worker);
        if (!Number.isFinite(hours) || hours <= 0) hours = hpd;
        var type = str(asg.worker_type).toLowerCase() === "helper" ? "helper" : "pro";
        var role = str(asg.worker_role).trim() || (type === "helper" ? "Assistant" : "Installer");
        var i;
        for (i = 0; i < count; i += 1) {
          workers.push({ role: role, worker_type: type, estimated_hours: hours });
        }
      });
      var taskLabels = [];
      (Array.isArray(day.internal_tasks) ? day.internal_tasks : []).forEach(function (task) {
        var label = str(task && task.label).trim();
        if (label) taskLabels.push(label);
      });
      var phase =
        taskLabels.join("; ") ||
        str(day.client_scope).trim() ||
        ("Day " + (day.day_number || out.length + 1));
      if (!workers.length) {
        workers.push({ role: "Installer", worker_type: "pro", estimated_hours: hpd });
      }
      out.push({
        day_number: Math.max(1, Math.floor(Number(day.day_number) || out.length + 1)),
        phase: phase.slice(0, 240),
        workers: workers
      });
    });
    return out;
  }

  function buildApplyPayload(pending, hoursPerDay) {
    var proposed = pending && pending.proposed;
    return {
      quoteNotes: formatClientPreview(proposed, pending && pending.publicScope),
      operational_plan: deriveOwnerOperationalPlan(proposed, hoursPerDay)
    };
  }

  function isValidApplyPayload(payload) {
    return !!(
      payload &&
      hasMeaningfulText(payload.quoteNotes) &&
      payload.quoteNotes !== PREVIEW_EMPTY_CLIENT &&
      ownerPlanHasDays(payload.operational_plan)
    );
  }

  function parseJsonStore(raw, fallback) {
    try {
      var parsed = JSON.parse(str(raw) || "null");
      return parsed && typeof parsed === "object" ? parsed : fallback;
    } catch (_err) {
      return fallback;
    }
  }

  function readHoursPerDay(win) {
    var w = win || global;
    try {
      var settings = parseJsonStore(
        w.localStorage && w.localStorage.getItem(SETTINGS_STORE_KEY),
        {}
      );
      var n = Number(settings && settings.hoursPerDay);
      if (Number.isFinite(n) && n > 0) return n;
    } catch (_err) {}
    var api = w && w.MgSalesOperationalPlan;
    if (api && typeof api.getHoursPerDay === "function") {
      try {
        return api.getHoursPerDay({});
      } catch (_apiErr) {}
    }
    return 8;
  }

  function dispatchDomChange(el, doc) {
    if (!el) throw new Error("Owner operational plan refresh is unavailable.");
    if (typeof Event === "function") {
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
    if (doc && typeof doc.createEvent === "function") {
      var ev = doc.createEvent("HTMLEvents");
      ev.initEvent("change", true, false);
      el.dispatchEvent(ev);
      return;
    }
    throw new Error("Owner operational plan refresh is unavailable.");
  }

  function createDefaultOwnerApply(doc, win) {
    var w = win || global;
    function readState() {
      return parseJsonStore(w.localStorage && w.localStorage.getItem(OWNER_STORE_KEY), {});
    }
    function writeState(state) {
      if (!w.localStorage || typeof w.localStorage.setItem !== "function") {
        throw new Error("Owner draft storage is unavailable.");
      }
      w.localStorage.setItem(OWNER_STORE_KEY, JSON.stringify(state));
    }
    function notesEl() {
      return doc && typeof doc.getElementById === "function" ? doc.getElementById("quoteNotes") : null;
    }
    function daysOverrideEl() {
      return doc && typeof doc.getElementById === "function" ? doc.getElementById("ownerOperationalDaysOverride") : null;
    }
    function hoursOverrideEl() {
      return doc && typeof doc.getElementById === "function" ? doc.getElementById("ownerOperationalHoursOverride") : null;
    }
    function refreshOwnerView() {
      dispatchDomChange(hoursOverrideEl() || daysOverrideEl(), doc);
    }
    return {
      readNotes: function () {
        var el = notesEl();
        if (el && el.value != null) return str(el.value);
        return str(readState().quoteNotes);
      },
      readPlan: function () {
        var plan = readState().operational_plan;
        return Array.isArray(plan) ? cloneJson(plan) : [];
      },
      hoursPerDay: function () {
        return readHoursPerDay(w);
      },
      snapshot: function () {
        return {
          store: cloneJson(readState()),
          notes: this.readNotes()
        };
      },
      restore: function (snap) {
        if (!snap) return;
        writeState(snap.store && typeof snap.store === "object" ? snap.store : {});
        var el = notesEl();
        if (el) el.value = str(snap.notes);
        var restored = snap.store || {};
        var daysEl = daysOverrideEl();
        var hoursEl = hoursOverrideEl();
        if (daysEl) daysEl.value = str(restored.operational_estimated_days_override);
        if (hoursEl) hoursEl.value = str(restored.operational_estimated_hours_override);
        try {
          refreshOwnerView();
        } catch (_refreshErr) {}
      },
      applyAtomic: function (payload) {
        var state = readState();
        if (!state || typeof state !== "object") state = {};
        state.quoteNotes = str(payload && payload.quoteNotes);
        state.operational_plan = cloneJson(payload && payload.operational_plan);
        state.operational_estimated_days_override = "";
        state.operational_estimated_hours_override = "";
        writeState(state);
        var el = notesEl();
        if (el) el.value = state.quoteNotes;
        var daysEl = daysOverrideEl();
        var hoursEl = hoursOverrideEl();
        if (daysEl) daysEl.value = "";
        if (hoursEl) hoursEl.value = "";
        refreshOwnerView();
      },
      confirmOverwrite: function (message) {
        if (w && typeof w.confirm === "function") return !!w.confirm(message);
        return false;
      }
    };
  }

  function elClassList(el) {
    if (!el) return { add: function () {}, remove: function () {}, toggle: function () {} };
    if (el.classList) return el.classList;
    var names = str(el.className).split(/\s+/).filter(Boolean);
    function sync() {
      el.className = names.join(" ");
    }
    return {
      add: function (name) {
        if (names.indexOf(name) < 0) names.push(name);
        sync();
      },
      remove: function (name) {
        names = names.filter(function (n) { return n !== name; });
        sync();
      },
      toggle: function (name, on) {
        if (on) this.add(name);
        else this.remove(name);
      }
    };
  }

  function createOwnerVoiceSession(options) {
    var opts = options || {};
    var doc = opts.document || null;
    var win = opts.window || global;
    var fetchFn = opts.fetch || (global.fetch && global.fetch.bind(global));
    var RecognitionCtor =
      typeof opts.speechRecognitionCtor === "function"
        ? opts.speechRecognitionCtor
        : speechRecognitionCtor(opts.window || global);
    var ownerApply =
      opts.ownerApply && typeof opts.ownerApply === "object"
        ? opts.ownerApply
        : createDefaultOwnerApply(doc, win);

    var ids = {
      modal: "ownerVoicePlanPreviewModal",
      open: "btnOwnerReviewConfirmOperationalPlan",
      close: "ownerVoicePlanPreviewClose",
      cancel: "ownerVoicePlanPreviewCancel",
      confirm: "ownerVoicePlanPreviewConfirm",
      transcript: "ownerVoicePlanTranscript",
      language: "ownerVoicePlanLanguage",
      clientLanguage: "ownerVoicePlanClientLanguage",
      micNew: "ownerVoicePlanMicToggle",
      micContinue: "ownerVoicePlanMicContinue",
      interpret: "ownerVoicePlanInterpret",
      clear: "ownerVoicePlanTranscriptClear",
      status: "ownerVoicePlanCaptureStatus",
      clientPreview: "ownerVoicePlanClientPreview",
      internalPreview: "ownerVoicePlanInternalPreview",
      previewStatus: "ownerVoicePlanPreviewStatus",
      quoteNotes: "quoteNotes"
    };

    function $(id) {
      return doc && typeof doc.getElementById === "function" ? doc.getElementById(id) : null;
    }

    var state = {
      modalOpen: false,
      listening: false,
      listeningMode: null,
      aiBusy: false,
      applyBusy: false,
      interpretSeq: 0,
      recognition: null,
      abortController: null,
      recognitionBase: "",
      recognitionFinal: "",
      lastFocus: null,
      pendingApply: null
    };

    function hoursPerDay() {
      if (typeof ownerApply.hoursPerDay === "function") return ownerApply.hoursPerDay();
      return Number(ownerApply.hoursPerDay) || 8;
    }

    function setStatus(message, listening, isError) {
      var status = $(ids.status);
      if (!status) return;
      status.textContent = str(message);
      elClassList(status).toggle("is-listening", !!listening);
      elClassList(status).toggle("is-error", !!isError);
    }

    function setPreviewStatus(message, isError) {
      var el = $(ids.previewStatus);
      if (!el) return;
      var text = str(message).trim();
      el.textContent = text;
      el.hidden = !text;
      elClassList(el).toggle("is-error", !!isError);
    }

    function pendingPayload() {
      if (!state.pendingApply) return null;
      return buildApplyPayload(state.pendingApply, hoursPerDay());
    }

    function confirmIsReady() {
      return (
        CONFIRM_APPLY_ENABLED &&
        !state.applyBusy &&
        !state.aiBusy &&
        isValidApplyPayload(pendingPayload())
      );
    }

    function syncConfirmButton() {
      var confirmBtn = $(ids.confirm);
      if (!confirmBtn) return;
      var ready = confirmIsReady();
      confirmBtn.disabled = !ready;
      if (ready) {
        confirmBtn.removeAttribute("disabled");
        confirmBtn.setAttribute("aria-disabled", "false");
        confirmBtn.removeAttribute("title");
      } else {
        confirmBtn.setAttribute("disabled", "disabled");
        confirmBtn.setAttribute("aria-disabled", "true");
      }
      confirmBtn.textContent = state.applyBusy ? "Applying…" : "Confirm and apply";
    }

    function lockConfirmButton() {
      var confirmBtn = $(ids.confirm);
      if (!confirmBtn) return;
      confirmBtn.disabled = true;
      confirmBtn.setAttribute("disabled", "disabled");
      confirmBtn.setAttribute("aria-disabled", "true");
      confirmBtn.textContent = "Confirm and apply";
    }

    function syncButtons() {
      var speechOk = !!RecognitionCtor;
      var mic = $(ids.micNew);
      var continueMic = $(ids.micContinue);
      var interpret = $(ids.interpret);
      if (interpret) {
        interpret.disabled = !!state.aiBusy || !!state.applyBusy;
        interpret.textContent = state.aiBusy ? "Interpreting…" : "Interpret and preview";
      }
      if (mic) {
        mic.disabled =
          !!state.aiBusy ||
          !!state.applyBusy ||
          !speechOk ||
          (state.listening && state.listeningMode !== "new");
      }
      if (continueMic) {
        continueMic.disabled =
          !!state.aiBusy ||
          !!state.applyBusy ||
          !speechOk ||
          (state.listening && state.listeningMode !== "continue");
      }
      syncConfirmButton();
    }

    function resetMicLabels() {
      var mic = $(ids.micNew);
      var continueMic = $(ids.micContinue);
      if (mic) {
        elClassList(mic).remove("is-listening");
        mic.textContent = "New dictation";
        mic.setAttribute("aria-pressed", "false");
      }
      if (continueMic) {
        elClassList(continueMic).remove("is-listening");
        continueMic.textContent = "Continue dictation";
        continueMic.setAttribute("aria-pressed", "false");
      }
    }

    function clearPreviewColumns() {
      var clientEl = $(ids.clientPreview);
      var internalEl = $(ids.internalPreview);
      if (clientEl) clientEl.textContent = PREVIEW_EMPTY_CLIENT;
      if (internalEl) internalEl.textContent = PREVIEW_EMPTY_INTERNAL;
      setPreviewStatus("", false);
    }

    function invalidatePendingPreview(message) {
      state.pendingApply = null;
      clearPreviewColumns();
      lockConfirmButton();
      if (message) setStatus(message, false, false);
      syncButtons();
    }

    function renderPreview(proposed, publicScope, summary, warnings) {
      var clientEl = $(ids.clientPreview);
      var internalEl = $(ids.internalPreview);
      if (clientEl) clientEl.textContent = formatClientPreview(proposed, publicScope);
      if (internalEl) internalEl.textContent = formatInternalPreview(proposed);
      var extra = Array.isArray(warnings) && warnings.length ? " Warnings: " + warnings.join(" ") : "";
      setStatus(
        (summary || "Voice changes are ready for review.") +
          extra +
          " Review both columns, then Confirm and apply. Nothing is saved until you confirm.",
        false,
        false
      );
    }

    function stopRecognition() {
      if (!state.recognition) return;
      try {
        state.recognition.stop();
      } catch (_err) {}
    }

    function abortInterpret() {
      state.interpretSeq += 1;
      state.aiBusy = false;
      if (state.abortController) {
        try {
          state.abortController.abort();
        } catch (_err) {}
        state.abortController = null;
      }
    }

    function finishListeningUi() {
      state.listening = false;
      state.listeningMode = null;
      state.recognition = null;
      state.recognitionBase = "";
      state.recognitionFinal = "";
      resetMicLabels();
      syncButtons();
    }

    function startDictation(appendExisting) {
      var transcript = $(ids.transcript);
      var language = $(ids.language);
      var mic = $(ids.micNew);
      var continueMic = $(ids.micContinue);
      var activeMic = appendExisting ? continueMic : mic;
      if (state.listening) {
        stopRecognition();
        return "stop";
      }
      if (!RecognitionCtor || !transcript || state.aiBusy || state.applyBusy) {
        setStatus(NO_SPEECH_API_MESSAGE, false, true);
        syncButtons();
        return "unavailable";
      }
      if (!appendExisting) {
        transcript.value = "";
        invalidatePendingPreview(READY_STATUS);
      }
      state.recognitionBase = transcriptAfterDictationStart(transcript.value, true);
      state.recognitionFinal = "";
      var recognition = new RecognitionCtor();
      state.recognition = recognition;
      state.listening = true;
      state.listeningMode = appendExisting ? "continue" : "new";
      recognition.lang = str(language && language.value) || "es-US";
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.onstart = function () {
        if (activeMic) {
          elClassList(activeMic).add("is-listening");
          activeMic.textContent = "Stop dictation";
          activeMic.setAttribute("aria-pressed", "true");
        }
        syncButtons();
        setStatus(LISTENING_MESSAGE, true, false);
      };
      recognition.onresult = function (event) {
        var interim = "";
        var i;
        for (i = event.resultIndex; i < event.results.length; i += 1) {
          var words = str(event.results[i][0] && event.results[i][0].transcript).trim();
          if (!words) continue;
          if (event.results[i].isFinal) {
            state.recognitionFinal += (state.recognitionFinal ? " " : "") + words;
          } else {
            interim += (interim ? " " : "") + words;
          }
        }
        transcript.value = joinTranscriptParts(state.recognitionBase, state.recognitionFinal, interim);
        if (state.pendingApply) invalidatePendingPreview(READY_STATUS);
      };
      recognition.onerror = function (event) {
        var code = str(event && event.error || "unknown");
        if (shouldIgnoreSpeechError(code)) return;
        setStatus(permissionErrorMessage(code), false, true);
      };
      recognition.onend = function () {
        finishListeningUi();
        if (!state.aiBusy && state.modalOpen) setStatus(STOPPED_MESSAGE, false, false);
      };
      try {
        recognition.start();
        return appendExisting ? "continue" : "new";
      } catch (_err) {
        finishListeningUi();
        setStatus(MIC_START_FAILED_MESSAGE, false, true);
        return "failed";
      }
    }

    function clearCapture() {
      stopRecognition();
      abortInterpret();
      var transcript = $(ids.transcript);
      if (transcript) transcript.value = "";
      invalidatePendingPreview("Transcript cleared. No plan changes were made.");
    }

    function closeModal() {
      stopRecognition();
      abortInterpret();
      finishListeningUi();
      state.modalOpen = false;
      state.pendingApply = null;
      state.applyBusy = false;
      var modal = $(ids.modal);
      if (modal) {
        modal.setAttribute("aria-hidden", "true");
        modal.removeAttribute("aria-modal");
      }
      setPreviewStatus("", false);
      lockConfirmButton();
      syncButtons();
      if (state.lastFocus && typeof state.lastFocus.focus === "function") {
        try {
          state.lastFocus.focus();
        } catch (_err) {}
      }
      state.lastFocus = null;
    }

    function openModal() {
      var modal = $(ids.modal);
      if (!modal) return;
      state.lastFocus = doc && doc.activeElement ? doc.activeElement : $(ids.open);
      state.modalOpen = true;
      abortInterpret();
      state.pendingApply = null;
      state.applyBusy = false;
      var transcript = $(ids.transcript);
      if (transcript) transcript.value = "";
      clearPreviewColumns();
      lockConfirmButton();
      var speechOk = !!RecognitionCtor;
      setStatus(speechOk ? READY_STATUS : NO_SPEECH_API_MESSAGE, false, !speechOk);
      syncButtons();
      modal.setAttribute("aria-hidden", "false");
      modal.setAttribute("aria-modal", "true");
      if (transcript && typeof transcript.focus === "function") transcript.focus();
    }

    async function interpretTranscript() {
      if (!state.modalOpen || state.aiBusy || state.applyBusy) return { ok: false, reason: "busy" };
      var transcriptEl = $(ids.transcript);
      var transcript = clampTranscript(transcriptEl && transcriptEl.value).trim();
      if (!canInterpretTranscript(transcript)) {
        setStatus(EMPTY_INTERPRET_MESSAGE, false, true);
        return { ok: false, reason: "empty" };
      }
      stopRecognition();
      var requestId = state.interpretSeq + 1;
      state.interpretSeq = requestId;
      state.aiBusy = true;
      syncButtons();
      setStatus("Interpreting the instructions… no quote changes have been saved.", false, false);
      var clientLanguageEl = $(ids.clientLanguage);
      var body = buildInterpretRequestBody(transcript, clientLanguageEl && clientLanguageEl.value);
      var controller = typeof AbortController === "function" ? new AbortController() : null;
      state.abortController = controller;
      if (typeof fetchFn !== "function") {
        state.aiBusy = false;
        syncButtons();
        setStatus("Voice interpretation is unavailable right now. Type and try again later.", false, true);
        return { ok: false, reason: "no-fetch" };
      }
      try {
        var response = await fetchFn(ENDPOINT, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller ? controller.signal : undefined
        });
        if (isStaleInterpret(requestId, state.interpretSeq, state.modalOpen)) {
          return { ok: false, reason: "stale" };
        }
        var data = {};
        try {
          data = await response.json();
        } catch (_parseErr) {
          data = {};
        }
        if (isStaleInterpret(requestId, state.interpretSeq, state.modalOpen)) {
          return { ok: false, reason: "stale" };
        }
        if (!response.ok || !data || data.ok !== true || !data.proposed_document) {
          throw new Error((data && data.error) || "The instructions could not be interpreted.");
        }
        var nextPending = {
          proposed: data.proposed_document,
          publicScope: data.public_client_scope,
          transcript: transcript,
          summary: data.summary,
          warnings: data.warnings
        };
        if (!isValidApplyPayload(buildApplyPayload(nextPending, hoursPerDay()))) {
          throw new Error("The instructions could not be interpreted into a usable Owner plan.");
        }
        state.pendingApply = nextPending;
        renderPreview(data.proposed_document, data.public_client_scope, data.summary, data.warnings);
        return { ok: true, requestBody: body, applied: false };
      } catch (err) {
        if (err && err.name === "AbortError") return { ok: false, reason: "aborted" };
        if (isStaleInterpret(requestId, state.interpretSeq, state.modalOpen)) {
          return { ok: false, reason: "stale" };
        }
        setStatus(err && err.message ? err.message : "Voice interpretation failed. Please try again.", false, true);
        return { ok: false, reason: "error" };
      } finally {
        if (state.abortController === controller) state.abortController = null;
        if (requestId === state.interpretSeq) {
          state.aiBusy = false;
          syncButtons();
        }
      }
    }

    async function applyConfirmedPlan() {
      if (!CONFIRM_APPLY_ENABLED) return { ok: false, reason: "disabled" };
      if (!state.modalOpen) return { ok: false, reason: "closed" };
      if (state.applyBusy || state.aiBusy) return { ok: false, reason: "busy" };
      var payload = pendingPayload();
      if (!isValidApplyPayload(payload)) {
        setStatus(NO_PREVIEW_MESSAGE, false, true);
        lockConfirmButton();
        return { ok: false, reason: "no-preview" };
      }
      var existingNotes = typeof ownerApply.readNotes === "function" ? ownerApply.readNotes() : "";
      var existingPlan = typeof ownerApply.readPlan === "function" ? ownerApply.readPlan() : [];
      if (needsOverwriteConfirm(existingNotes, existingPlan)) {
        var proceed =
          typeof ownerApply.confirmOverwrite === "function"
            ? ownerApply.confirmOverwrite(overwriteWarningMessage(existingNotes, existingPlan))
            : false;
        if (!proceed) {
          setStatus("Confirmation cancelled. The Owner draft was not changed.", false, false);
          return { ok: false, reason: "overwrite-cancelled" };
        }
      }
      state.applyBusy = true;
      syncButtons();
      var snapshot = typeof ownerApply.snapshot === "function" ? ownerApply.snapshot() : null;
      try {
        if (typeof ownerApply.applyAtomic !== "function") {
          throw new Error("Owner apply hook is unavailable.");
        }
        await Promise.resolve(ownerApply.applyAtomic(payload));
        state.pendingApply = null;
        state.applyBusy = false;
        setPreviewStatus(APPLY_SUCCESS_MESSAGE, false);
        setStatus(APPLY_SUCCESS_MESSAGE, false, false);
        closeModal();
        return { ok: true, payload: payload };
      } catch (_err) {
        if (snapshot && typeof ownerApply.restore === "function") {
          try {
            ownerApply.restore(snapshot);
          } catch (_restoreErr) {}
        }
        state.applyBusy = false;
        syncButtons();
        setPreviewStatus(APPLY_FAILED_MESSAGE, true);
        setStatus(APPLY_FAILED_MESSAGE, false, true);
        return { ok: false, reason: "apply-failed" };
      }
    }

    function onTranscriptInput() {
      var transcript = $(ids.transcript);
      if (!transcript) return;
      if (str(transcript.value).length > MAX_TRANSCRIPT_CHARS) {
        transcript.value = clampTranscript(transcript.value);
      }
      if (state.pendingApply) {
        invalidatePendingPreview(
          "Transcript changed. Interpret again before Confirm and apply. The Owner draft was not changed."
        );
      }
    }

    function focusableInModal() {
      var modal = $(ids.modal);
      if (!modal || typeof modal.querySelectorAll !== "function") return [];
      var nodes = modal.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      var list = [];
      for (var i = 0; i < nodes.length; i += 1) {
        if (nodes[i].id === ids.confirm && nodes[i].disabled) continue;
        list.push(nodes[i]);
      }
      return list;
    }

    function onDocumentKeydown(event) {
      if (!state.modalOpen) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeModal();
        return;
      }
      if (event.key !== "Tab") return;
      var items = focusableInModal();
      if (!items.length) return;
      var first = items[0];
      var last = items[items.length - 1];
      var active = doc && doc.activeElement;
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    function bindOnce(el, handler) {
      if (!el || el.dataset && el.dataset.ownerVoiceBound === "1") return;
      if (el.dataset) el.dataset.ownerVoiceBound = "1";
      el.addEventListener("click", handler);
    }

    function bind() {
      if (!$(ids.modal) || !$(ids.open)) return false;
      bindOnce($(ids.open), function (event) {
        event.preventDefault();
        openModal();
      });
      bindOnce($(ids.close), function (event) {
        event.preventDefault();
        closeModal();
      });
      bindOnce($(ids.cancel), function (event) {
        event.preventDefault();
        closeModal();
      });
      bindOnce($(ids.confirm), function (event) {
        event.preventDefault();
        event.stopPropagation();
        applyConfirmedPlan();
      });
      bindOnce($(ids.micNew), function (event) {
        event.preventDefault();
        startDictation(false);
      });
      bindOnce($(ids.micContinue), function (event) {
        event.preventDefault();
        startDictation(true);
      });
      bindOnce($(ids.interpret), function (event) {
        event.preventDefault();
        interpretTranscript();
      });
      bindOnce($(ids.clear), function (event) {
        event.preventDefault();
        clearCapture();
      });
      var transcript = $(ids.transcript);
      if (transcript && !(transcript.dataset && transcript.dataset.ownerVoiceBound === "1")) {
        if (transcript.dataset) transcript.dataset.ownerVoiceBound = "1";
        transcript.addEventListener("input", onTranscriptInput);
      }
      if (doc && !doc.documentElement.dataset.ownerVoiceKeys) {
        doc.documentElement.dataset.ownerVoiceKeys = "1";
        doc.addEventListener("keydown", onDocumentKeydown);
      }
      lockConfirmButton();
      syncButtons();
      return true;
    }

    return {
      ids: ids,
      state: state,
      bind: bind,
      openModal: openModal,
      closeModal: closeModal,
      startDictation: startDictation,
      stopRecognition: stopRecognition,
      abortInterpret: abortInterpret,
      clearCapture: clearCapture,
      interpretTranscript: interpretTranscript,
      applyConfirmedPlan: applyConfirmedPlan,
      lockConfirmButton: lockConfirmButton,
      syncButtons: syncButtons,
      invalidatePendingPreview: invalidatePendingPreview
    };
  }

  function bindOwnerVoiceUi(doc) {
    var session = createOwnerVoiceSession({ document: doc || global.document, window: global });
    session.bind();
    return session;
  }

  var api = {
    MAX_TRANSCRIPT_CHARS: MAX_TRANSCRIPT_CHARS,
    ENDPOINT: ENDPOINT,
    CONFIRM_APPLY_ENABLED: CONFIRM_APPLY_ENABLED,
    OWNER_STORE_KEY: OWNER_STORE_KEY,
    EMPTY_DOCUMENT: EMPTY_DOCUMENT,
    NO_SPEECH_API_MESSAGE: NO_SPEECH_API_MESSAGE,
    PERMISSION_DENIED_MESSAGE: PERMISSION_DENIED_MESSAGE,
    EMPTY_INTERPRET_MESSAGE: EMPTY_INTERPRET_MESSAGE,
    APPLY_SUCCESS_MESSAGE: APPLY_SUCCESS_MESSAGE,
    OVERWRITE_BOTH_MESSAGE: OVERWRITE_BOTH_MESSAGE,
    OVERWRITE_NOTES_MESSAGE: OVERWRITE_NOTES_MESSAGE,
    OVERWRITE_PLAN_MESSAGE: OVERWRITE_PLAN_MESSAGE,
    clampTranscript: clampTranscript,
    canInterpretTranscript: canInterpretTranscript,
    transcriptAfterDictationStart: transcriptAfterDictationStart,
    joinTranscriptParts: joinTranscriptParts,
    isPermissionDeniedCode: isPermissionDeniedCode,
    shouldIgnoreSpeechError: shouldIgnoreSpeechError,
    permissionErrorMessage: permissionErrorMessage,
    speechRecognitionCtor: speechRecognitionCtor,
    isStaleInterpret: isStaleInterpret,
    buildInterpretRequestBody: buildInterpretRequestBody,
    formatClientPreview: formatClientPreview,
    formatInternalPreview: formatInternalPreview,
    hasMeaningfulText: hasMeaningfulText,
    ownerPlanHasDays: ownerPlanHasDays,
    needsOverwriteConfirm: needsOverwriteConfirm,
    overwriteWarningMessage: overwriteWarningMessage,
    deriveOwnerOperationalPlan: deriveOwnerOperationalPlan,
    buildApplyPayload: buildApplyPayload,
    isValidApplyPayload: isValidApplyPayload,
    createDefaultOwnerApply: createDefaultOwnerApply,
    createOwnerVoiceSession: createOwnerVoiceSession,
    bindOwnerVoiceUi: bindOwnerVoiceUi
  };

  global.MgOwnerVoiceOperationalPlan = api;
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  if (global.document && typeof global.document.getElementById === "function") {
    var boot = function () {
      bindOwnerVoiceUi(global.document);
    };
    if (global.document.readyState === "loading") {
      global.document.addEventListener("DOMContentLoaded", boot);
    } else {
      boot();
    }
  }
})(typeof window !== "undefined" ? window : globalThis);
