/**
 * Owner portal voice operational-plan capture — Phase 1.
 * Dictation + interpret + preview only. Never applies, persists, or sends a quote.
 */
(function (global) {
  "use strict";

  var MAX_TRANSCRIPT_CHARS = 6000;
  var ENDPOINT = "/.netlify/functions/voice-operational-plan-command";
  var CONFIRM_APPLY_ENABLED = false;
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
  var PHASE1_STATUS =
    "Voice changes are proposed only. Confirm and apply is not available in this phase.";
  var PREVIEW_EMPTY_CLIENT = "No client-facing scope yet.";
  var PREVIEW_EMPTY_INTERNAL = "No internal plan yet.";

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
    var fetchFn = opts.fetch || (global.fetch && global.fetch.bind(global));
    var RecognitionCtor =
      typeof opts.speechRecognitionCtor === "function"
        ? opts.speechRecognitionCtor
        : speechRecognitionCtor(opts.window || global);

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
      previewStatus: "ownerVoicePlanPreviewStatus"
    };

    function $(id) {
      return doc && typeof doc.getElementById === "function" ? doc.getElementById(id) : null;
    }

    var state = {
      modalOpen: false,
      listening: false,
      listeningMode: null,
      aiBusy: false,
      interpretSeq: 0,
      recognition: null,
      abortController: null,
      recognitionBase: "",
      recognitionFinal: "",
      lastFocus: null
    };

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

    function lockConfirmButton() {
      var confirmBtn = $(ids.confirm);
      if (!confirmBtn) return;
      confirmBtn.disabled = true;
      confirmBtn.setAttribute("disabled", "disabled");
      confirmBtn.setAttribute("aria-disabled", "true");
    }

    function syncButtons() {
      var speechOk = !!RecognitionCtor;
      var mic = $(ids.micNew);
      var continueMic = $(ids.micContinue);
      var interpret = $(ids.interpret);
      if (interpret) {
        interpret.disabled = !!state.aiBusy;
        interpret.textContent = state.aiBusy ? "Interpreting…" : "Interpret and preview";
      }
      if (mic) {
        mic.disabled = !!state.aiBusy || !speechOk || (state.listening && state.listeningMode !== "new");
      }
      if (continueMic) {
        continueMic.disabled =
          !!state.aiBusy || !speechOk || (state.listening && state.listeningMode !== "continue");
      }
      lockConfirmButton();
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

    function renderPreview(proposed, publicScope, summary, warnings) {
      var clientEl = $(ids.clientPreview);
      var internalEl = $(ids.internalPreview);
      if (clientEl) clientEl.textContent = formatClientPreview(proposed, publicScope);
      if (internalEl) internalEl.textContent = formatInternalPreview(proposed);
      var extra = Array.isArray(warnings) && warnings.length ? " Warnings: " + warnings.join(" ") : "";
      setStatus(
        (summary || "Voice changes are ready for review.") + extra + " Preview only — Confirm and apply is not available yet.",
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
      if (!RecognitionCtor || !transcript || state.aiBusy) {
        setStatus(NO_SPEECH_API_MESSAGE, false, true);
        syncButtons();
        return "unavailable";
      }
      if (!appendExisting) transcript.value = "";
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
      clearPreviewColumns();
      setStatus("Transcript cleared. No plan changes were made.", false, false);
      syncButtons();
    }

    function closeModal() {
      stopRecognition();
      abortInterpret();
      finishListeningUi();
      state.modalOpen = false;
      var modal = $(ids.modal);
      if (modal) {
        modal.setAttribute("aria-hidden", "true");
        modal.removeAttribute("aria-modal");
      }
      setPreviewStatus("", false);
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
      var transcript = $(ids.transcript);
      if (transcript) transcript.value = "";
      clearPreviewColumns();
      lockConfirmButton();
      var speechOk = !!RecognitionCtor;
      setStatus(speechOk ? PHASE1_STATUS : NO_SPEECH_API_MESSAGE, false, !speechOk);
      syncButtons();
      modal.setAttribute("aria-hidden", "false");
      modal.setAttribute("aria-modal", "true");
      if (transcript && typeof transcript.focus === "function") transcript.focus();
    }

    async function interpretTranscript() {
      if (!state.modalOpen || state.aiBusy) return { ok: false, reason: "busy" };
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
        renderPreview(data.proposed_document, data.public_client_scope, data.summary, data.warnings);
        return { ok: true, requestBody: body };
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

    function onTranscriptInput() {
      var transcript = $(ids.transcript);
      if (!transcript) return;
      if (str(transcript.value).length > MAX_TRANSCRIPT_CHARS) {
        transcript.value = clampTranscript(transcript.value);
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
        if (nodes[i].id === ids.confirm) continue;
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
      lockConfirmButton: lockConfirmButton,
      syncButtons: syncButtons
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
    EMPTY_DOCUMENT: EMPTY_DOCUMENT,
    NO_SPEECH_API_MESSAGE: NO_SPEECH_API_MESSAGE,
    PERMISSION_DENIED_MESSAGE: PERMISSION_DENIED_MESSAGE,
    EMPTY_INTERPRET_MESSAGE: EMPTY_INTERPRET_MESSAGE,
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
