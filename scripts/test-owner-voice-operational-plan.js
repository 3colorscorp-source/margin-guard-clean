#!/usr/bin/env node
/**
 * Owner voice operational-plan Phase 1 + Phase 2 tests.
 * No live AI, Supabase, quotes, email, or webhooks.
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const voice = require("../public/js/owner-voice-operational-plan.js");

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

let passed = 0;
function ok(label, value) {
  assert.ok(value, label);
  passed += 1;
  console.log("PASS " + label);
}
function eq(label, actual, expected) {
  assert.strictEqual(actual, expected, `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  passed += 1;
  console.log("PASS " + label);
}

function FakeEl(id, tag) {
  this.id = id;
  this.tagName = String(tag || "div").toUpperCase();
  this.value = "";
  this.textContent = "";
  this.disabled = false;
  this.hidden = false;
  this.className = "";
  this.dataset = {};
  this.attrs = {};
  this.listeners = {};
  this.classList = {
    _el: this,
    add: (name) => {
      const names = String(this.className).split(/\s+/).filter(Boolean);
      if (names.indexOf(name) < 0) names.push(name);
      this.className = names.join(" ");
    },
    remove: (name) => {
      this.className = String(this.className)
        .split(/\s+/)
        .filter((n) => n && n !== name)
        .join(" ");
    },
    toggle: (name, on) => {
      if (on) this.classList.add(name);
      else this.classList.remove(name);
    },
  };
}
FakeEl.prototype.setAttribute = function (name, value) {
  this.attrs[name] = String(value);
  if (name === "disabled") this.disabled = true;
};
FakeEl.prototype.getAttribute = function (name) {
  return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
};
FakeEl.prototype.removeAttribute = function (name) {
  delete this.attrs[name];
  if (name === "disabled") this.disabled = false;
};
FakeEl.prototype.addEventListener = function (type, fn) {
  this.listeners[type] = this.listeners[type] || [];
  this.listeners[type].push(fn);
};
FakeEl.prototype.focus = function () {
  this.focused = true;
};
FakeEl.prototype.dispatchEvent = function (event) {
  const type = event && event.type;
  (this.listeners[type] || []).forEach((fn) => fn(event));
  if (type === "input" && typeof this.oninput === "function") this.oninput(event);
  if (type === "change" && typeof this.onchange === "function") this.onchange(event);
};

function FakeRecognition() {
  FakeRecognition.instances.push(this);
  this.lang = "";
  this.continuous = false;
  this.interimResults = false;
  this.started = false;
  this.stopped = false;
}
FakeRecognition.instances = [];
FakeRecognition.prototype.start = function () {
  this.started = true;
  if (typeof this.onstart === "function") this.onstart();
};
FakeRecognition.prototype.stop = function () {
  this.stopped = true;
  this.started = false;
  if (typeof this.onend === "function") this.onend();
};

function makeDoc() {
  const els = {};
  function el(id, tag) {
    els[id] = new FakeEl(id, tag);
    return els[id];
  }
  el("btnOwnerReviewConfirmOperationalPlan", "button");
  el("ownerVoicePlanPreviewModal", "div");
  el("ownerVoicePlanPreviewClose", "button");
  el("ownerVoicePlanPreviewCancel", "button");
  const confirm = el("ownerVoicePlanPreviewConfirm", "button");
  confirm.disabled = true;
  confirm.setAttribute("disabled", "disabled");
  confirm.setAttribute("aria-disabled", "true");
  el("ownerVoicePlanTranscript", "textarea");
  el("ownerVoicePlanLanguage", "select").value = "es-US";
  el("ownerVoicePlanClientLanguage", "select").value = "en";
  el("ownerVoicePlanMicToggle", "button").textContent = "New dictation";
  el("ownerVoicePlanMicContinue", "button").textContent = "Continue dictation";
  el("ownerVoicePlanInterpret", "button").textContent = "Interpret and preview";
  el("ownerVoicePlanTranscriptClear", "button");
  el("ownerVoicePlanCaptureStatus", "span");
  el("ownerVoicePlanClientPreview", "div").textContent = "No client-facing scope yet.";
  el("ownerVoicePlanInternalPreview", "div").textContent = "No internal plan yet.";
  el("ownerVoicePlanPreviewStatus", "div").hidden = true;
  el("quoteNotes", "textarea").value = "";
  el("ownerOperationalHoursOverride", "input").value = "";
  el("ownerOperationalDaysOverride", "input").value = "";
  const documentElement = { dataset: {} };
  const doc = {
    documentElement,
    activeElement: els.btnOwnerReviewConfirmOperationalPlan,
    getElementById: (id) => els[id] || null,
    addEventListener: function () {},
    querySelectorAll: () => [],
    els,
  };
  return doc;
}

function sampleProposed() {
  return {
    schema_version: 1,
    source: "voice",
    days: [
      {
        day_number: 1,
        date: "2026-09-10",
        client_scope: "Protect floors and walls.",
        internal_tasks: [{ label: "Install floor protection" }],
        worker_assignments: [{ worker_count: 1, worker_role: "Assistant", hours_per_worker: 8 }],
        materials_or_tools: ["ram board"],
        internal_notes: "Keep hallway clear.",
      },
    ],
  };
}

function interpretOkFetch(proposedDoc) {
  const proposed = proposedDoc || sampleProposed();
  const narrative =
    (proposed.days && proposed.days[0] && proposed.days[0].client_scope) || "Protect floors and walls.";
  return async () => ({
    ok: true,
    json: async () => ({
      ok: true,
      proposed_document: proposed,
      public_client_scope: { narrative },
      summary: "Ready",
      warnings: [],
    }),
  });
}

function makeOwnerApply(initial, extras) {
  const start = initial || {};
  const bag = {
    state: {
      quoteNotes: start.quoteNotes || "",
      operational_plan: Array.isArray(start.operational_plan) ? JSON.parse(JSON.stringify(start.operational_plan)) : [],
      workers: Array.isArray(start.workers) ? JSON.parse(JSON.stringify(start.workers)) : [],
      startDate: start.startDate || "2026-09-10",
      targetFinishDate: start.targetFinishDate || "2026-09-12",
      operational_estimated_days_override: start.operational_estimated_days_override || "",
      operational_estimated_hours_override: start.operational_estimated_hours_override || "",
    },
    notes: start.quoteNotes || "",
    applies: 0,
    refreshes: 0,
    overwritePrompts: 0,
    lastOverwriteMessage: "",
    allowOverwrite: extras && extras.allowOverwrite === false ? false : true,
    failApply: !!(extras && extras.failApply),
    hangApply: !!(extras && extras.hangApply),
    resolveHang: null,
  };
  const ownerApply = {
    readNotes: () => bag.notes,
    readPlan: () => bag.state.operational_plan || [],
    hoursPerDay: () => 8,
    snapshot: () => ({
      store: JSON.parse(JSON.stringify(bag.state)),
      notes: bag.notes,
    }),
    restore: (snap) => {
      bag.state = JSON.parse(JSON.stringify(snap.store));
      bag.notes = snap.notes;
    },
    applyAtomic: async (payload) => {
      bag.applies += 1;
      if (bag.hangApply) {
        await new Promise((resolve) => {
          bag.resolveHang = resolve;
        });
      }
      if (bag.failApply) {
        bag.notes = "PARTIAL WRITE SHOULD NOT STICK";
        bag.state.quoteNotes = "PARTIAL WRITE SHOULD NOT STICK";
        throw new Error("apply boom");
      }
      bag.state.quoteNotes = payload.quoteNotes;
      bag.state.operational_plan = JSON.parse(JSON.stringify(payload.operational_plan));
      bag.state.operational_estimated_days_override = "";
      bag.state.operational_estimated_hours_override = "";
      bag.notes = payload.quoteNotes;
      bag.refreshes += 1;
    },
    confirmOverwrite: (message) => {
      bag.overwritePrompts += 1;
      bag.lastOverwriteMessage = String(message || "");
      return bag.allowOverwrite;
    },
  };
  return { bag, ownerApply };
}

async function main() {
  const html = read("public/owner.html");
  const js = read("public/js/owner-voice-operational-plan.js");
  const salesHtml = read("public/sales.html");
  const sellerVoiceJs = read("public/js/voice-operational-plan.js");
  const sellerCommand = read("netlify/functions/voice-operational-plan-command.mjs");
  const sellerLib = read("netlify/functions/_lib/voice-operational-plan.js");
  const sellerPhase1 = read("scripts/test-voice-operational-plan-phase1.js");
  const sellerPhase2 = read("scripts/test-voice-operational-plan-phase2.js");

  const genIdx = html.indexOf('id="btnOwnerGenerateScopeDraft"');
  const reviewIdx = html.indexOf('id="btnOwnerReviewConfirmOperationalPlan"');
  const laborIdx = html.indexOf('class="owner-op-dash__action-bar-labor"');
  ok("1. review button exists", reviewIdx > 0);
  ok("1. review button after Generate Scope Draft", genIdx > 0 && reviewIdx > genIdx);
  ok("1. review button before labor actions", laborIdx > reviewIdx);

  ok("2. modal exists", /id="ownerVoicePlanPreviewModal"/.test(html));
  ok("2. language selector es-US/en-US", /id="ownerVoicePlanLanguage"/.test(html) && /value="es-US"/.test(html) && /value="en-US"/.test(html));
  ok("2. new dictation control", /id="ownerVoicePlanMicToggle"/.test(html) && /New dictation/.test(html));
  ok("2. continue dictation control", /id="ownerVoicePlanMicContinue"/.test(html) && /Continue dictation/.test(html));
  ok("2. clear control", /id="ownerVoicePlanTranscriptClear"/.test(html));
  ok("2. cancel control", /id="ownerVoicePlanPreviewCancel"/.test(html));
  ok("2. interpret control", /id="ownerVoicePlanInterpret"/.test(html));
  ok("2. transcript editor", /id="ownerVoicePlanTranscript"/.test(html));
  ok("2. dialog accessibility", /role="dialog"/.test(html) && /aria-labelledby="ownerVoicePlanPreviewTitle"/.test(html));

  ok("3. includes owner voice script", /src="\/js\/owner-voice-operational-plan\.js"/.test(html));
  ok("3. includes shared voice library before owner script", html.indexOf("/js/voice-operational-plan.js") < html.indexOf("/js/owner-voice-operational-plan.js"));

  eq("4. new dictation replaces transcript", voice.transcriptAfterDictationStart("existing plan text", false), "");
  eq("5. continue dictation keeps transcript", voice.transcriptAfterDictationStart("existing plan text", true), "existing plan text");

  FakeRecognition.instances = [];
  const docA = makeDoc();
  const sessionA = voice.createOwnerVoiceSession({
    document: docA,
    speechRecognitionCtor: FakeRecognition,
    fetch: async () => ({ ok: false }),
  });
  sessionA.bind();
  sessionA.openModal();
  docA.els.ownerVoicePlanTranscript.value = "keep me";
  eq("4. new dictation clears live transcript", sessionA.startDictation(false), "new");
  eq("4. transcript empty after new", docA.els.ownerVoicePlanTranscript.value, "");
  ok("6. recognition started", FakeRecognition.instances[0] && FakeRecognition.instances[0].started);
  eq("6. second click stops dictation", sessionA.startDictation(false), "stop");
  ok("6. recognition stopped", FakeRecognition.instances[0].stopped);

  FakeRecognition.instances = [];
  const docB = makeDoc();
  const sessionB = voice.createOwnerVoiceSession({
    document: docB,
    speechRecognitionCtor: FakeRecognition,
    fetch: async () => ({ ok: false }),
  });
  sessionB.openModal();
  docB.els.ownerVoicePlanTranscript.value = "Day 1 protection";
  eq("5. continue starts in append mode", sessionB.startDictation(true), "continue");
  eq("5. continue preserves transcript", docB.els.ownerVoicePlanTranscript.value, "Day 1 protection");
  ok("5. other mic disabled while listening", docB.els.ownerVoicePlanMicToggle.disabled === true);

  const proposed = sampleProposed();
  docB.els.ownerVoicePlanClientPreview.textContent = voice.formatClientPreview(proposed, { narrative: "Protect floors and walls." });
  docB.els.ownerVoicePlanInternalPreview.textContent = voice.formatInternalPreview(proposed);
  sessionB.clearCapture();
  eq("7. clear empties transcript", docB.els.ownerVoicePlanTranscript.value, "");
  eq("7. clear resets client preview", docB.els.ownerVoicePlanClientPreview.textContent, "No client-facing scope yet.");
  eq("7. clear resets internal preview", docB.els.ownerVoicePlanInternalPreview.textContent, "No internal plan yet.");
  ok("7. clear status does not apply plan", /No plan changes were made/.test(docB.els.ownerVoicePlanCaptureStatus.textContent));

  FakeRecognition.instances = [];
  let fetchCalls = 0;
  let resolveFetch;
  const hangingFetch = () => {
    fetchCalls += 1;
    return new Promise((resolve) => {
      resolveFetch = resolve;
    });
  };
  const docC = makeDoc();
  const sessionC = voice.createOwnerVoiceSession({
    document: docC,
    speechRecognitionCtor: FakeRecognition,
    fetch: hangingFetch,
  });
  sessionC.openModal();
  sessionC.startDictation(false);
  ok("8. cancel will stop recognition", FakeRecognition.instances[0].started);
  docC.els.ownerVoicePlanTranscript.value = "Day 1 protect the work area with one Assistant for 8 hours.";
  const interpretPromise = sessionC.interpretTranscript();
  sessionC.closeModal();
  ok("8. cancel stopped recognition", FakeRecognition.instances[0].stopped);
  eq("8. cancel closed modal", docC.els.ownerVoicePlanPreviewModal.getAttribute("aria-hidden"), "true");
  if (resolveFetch) {
    resolveFetch({
      ok: true,
      json: async () => ({
        ok: true,
        proposed_document: proposed,
        public_client_scope: { narrative: "STALE SHOULD NOT RENDER" },
      }),
    });
  }
  const interpretResult = await interpretPromise;
  ok("8. cancel aborted or ignored interpret", interpretResult.reason === "aborted" || interpretResult.reason === "stale");
  ok("20. stale interpret did not write preview", docC.els.ownerVoicePlanClientPreview.textContent !== "STALE SHOULD NOT RENDER");

  ok("9. maxlength 6000 in markup", /id="ownerVoicePlanTranscript"[^>]*maxlength="6000"/.test(html.replace(/\s+/g, " ")));
  eq("9. clamp enforces 6000", voice.clampTranscript("x".repeat(6005)).length, 6000);
  ok("9. dictation join clamps", voice.joinTranscriptParts("a".repeat(5990), "b".repeat(30), "").length === 6000);

  const docEmpty = makeDoc();
  const sessionEmpty = voice.createOwnerVoiceSession({
    document: docEmpty,
    speechRecognitionCtor: FakeRecognition,
    fetch: async () => {
      throw new Error("fetch must not run for empty transcript");
    },
  });
  sessionEmpty.openModal();
  const empty = await sessionEmpty.interpretTranscript();
  eq("10. interpret rejects empty before fetch", empty.reason, "empty");
  ok("10. helper rejects blank transcript", voice.canInterpretTranscript("  ") === false);
  ok("10. helper accepts typed instructions", voice.canInterpretTranscript("Day 1 protect floors"));

  const body = voice.buildInterpretRequestBody("Day 1 protect floors with one Installer for 8 hours.", "en");
  eq("11. endpoint path", voice.ENDPOINT, "/.netlify/functions/voice-operational-plan-command");
  ok("11. request body is text transcript only", typeof body.transcript === "string" && !body.audio && !body.blob);
  eq("11. current_document is empty preview seed", JSON.stringify(body.current_document), JSON.stringify(voice.EMPTY_DOCUMENT));
  ok("11. JSON fetch only", /JSON\.stringify\(body\)/.test(js) && /"Content-Type": "application\/json"/.test(js));

  ok("12. no getUserMedia", !/getUserMedia/.test(js + html));
  ok("12. no MediaRecorder/Blob/FormData/audio upload", !/MediaRecorder|FormData|audio\/webm|audio\/ogg/.test(js + html));
  ok("12. no blob upload", !/\bBlob\b/.test(js));

  ok("13. client scope preview column", /id="ownerVoicePlanClientTitle"/.test(html) && /Client Scope of Work/.test(html));
  ok("13. internal plan preview column", /id="ownerVoicePlanInternalTitle"/.test(html) && /Internal Operational Plan/.test(html));
  ok("13. formatters keep columns separate", voice.formatClientPreview(proposed).indexOf("Assistant") < 0 && /Assistant/.test(voice.formatInternalPreview(proposed)));

  ok("14. confirm disabled in markup", /id="ownerVoicePlanPreviewConfirm"[\s\S]*?disabled/.test(html));
  eq("14. confirm apply flag is true", voice.CONFIRM_APPLY_ENABLED, true);
  const blocked = makeOwnerApply();
  const docBlocked = makeDoc();
  const sessionBlocked = voice.createOwnerVoiceSession({
    document: docBlocked,
    speechRecognitionCtor: FakeRecognition,
    fetch: interpretOkFetch(),
    ownerApply: blocked.ownerApply,
  });
  sessionBlocked.openModal();
  ok("14. confirm blocked before Interpret", docBlocked.els.ownerVoicePlanPreviewConfirm.disabled === true);
  eq("14. confirm aria-disabled before Interpret", docBlocked.els.ownerVoicePlanPreviewConfirm.getAttribute("aria-disabled"), "true");
  const applyBefore = await sessionBlocked.applyConfirmedPlan();
  eq("14. apply without preview is rejected", applyBefore.reason, "no-preview");
  eq("14. apply without preview did not write", blocked.bag.applies, 0);

  const writeHaystack = js;
  ok("15. no owner date writers", !/ownerStartDate|ownerTargetFinishDate|salesStartDate/.test(writeHaystack));
  ok("15. no labor table writers", !/workersBody|btnAddWorker|labor_auto_sync/.test(writeHaystack));
  ok("15. no persist/publish/send endpoints", !/quote-internal-operational-plan|publish-public-quote|send-quote|estimate-accepted-webhook/.test(writeHaystack));
  ok("15. no sales apply writers", !/applyConfirmedVoicePlanToState|saveSalesState|openSendModal|exportOwnerPdf|btnExportPdf/.test(writeHaystack));
  ok("15. no direct saveOwner/refreshOwnerAfterOpChange", !/saveOwner|refreshOwnerAfterOpChange/.test(writeHaystack));

  ok("16. owner voice ids not added to sales.html", !/ownerVoicePlan|btnOwnerReviewConfirmOperationalPlan/.test(salesHtml));

  ok("17. seller html still owns original voice ids", /id="voicePlanMicToggle"/.test(salesHtml));
  ok("17. seller voice library unchanged in this file set", /MgVoiceOperationalPlan/.test(sellerVoiceJs));
  ok("17. seller command still owner-or-seller", /resolveOwnerOrSellerContext/.test(sellerCommand));
  ok("17. seller lib still exports normalizeDocument", /function normalizeDocument/.test(sellerLib));
  ok("17. seller phase tests still target sales.html", /public\/sales\.html/.test(sellerPhase2) && /voice-operational-plan/.test(sellerPhase1));

  const docE = makeDoc();
  const sessionE = voice.createOwnerVoiceSession({
    document: docE,
    speechRecognitionCtor: null,
    fetch: async () => ({ ok: false }),
  });
  sessionE.openModal();
  eq("18. missing Speech API disables new mic", docE.els.ownerVoicePlanMicToggle.disabled, true);
  eq("18. missing Speech API disables continue mic", docE.els.ownerVoicePlanMicContinue.disabled, true);
  eq("18. interpret remains enabled", docE.els.ownerVoicePlanInterpret.disabled, false);
  ok("18. fallback message shown", docE.els.ownerVoicePlanCaptureStatus.textContent.indexOf("escribir") >= 0);
  eq("18. startDictation reports unavailable", sessionE.startDictation(false), "unavailable");

  ok("19. permission denied is not raw not-allowed", voice.permissionErrorMessage("not-allowed").indexOf("not-allowed") < 0);
  ok("19. permission denied is understandable", /micrófono|microfono|permiso/i.test(voice.permissionErrorMessage("not-allowed")));
  ok("19. service-not-allowed mapped", /permiso/i.test(voice.permissionErrorMessage("service-not-allowed")));
  ok("19. aborted speech errors ignored", voice.shouldIgnoreSpeechError("aborted") && voice.shouldIgnoreSpeechError("no-speech"));

  ok("20. stale helper detects closed modal", voice.isStaleInterpret(1, 1, false) === true);
  ok("20. stale helper detects newer request", voice.isStaleInterpret(1, 2, true) === true);
  ok("20. current request is not stale", voice.isStaleInterpret(3, 3, true) === false);

  const derived = voice.deriveOwnerOperationalPlan(proposed, 8);
  eq("21. internal plan creates one owner day", derived.length, 1);
  eq("21. internal task becomes owner phase/task", derived[0].phase, "Install floor protection");
  eq("21. assignment becomes owner workers", derived[0].workers.length, 1);
  eq("21. worker role preserved", derived[0].workers[0].role, "Assistant");
  eq("21. worker hours preserved", derived[0].workers[0].estimated_hours, 8);
  ok("21. payload is valid", voice.isValidApplyPayload(voice.buildApplyPayload({ proposed, publicScope: { narrative: "Protect floors and walls." } }, 8)));

  const applyStore = makeOwnerApply();
  const docApply = makeDoc();
  const sessionApply = voice.createOwnerVoiceSession({
    document: docApply,
    speechRecognitionCtor: FakeRecognition,
    fetch: interpretOkFetch(),
    ownerApply: applyStore.ownerApply,
  });
  sessionApply.bind();
  sessionApply.openModal();
  ok("22. confirm blocked before Interpret", docApply.els.ownerVoicePlanPreviewConfirm.disabled === true);
  docApply.els.ownerVoicePlanTranscript.value = "Day 1 protect floors with one Assistant for 8 hours.";
  const interpreted = await sessionApply.interpretTranscript();
  ok("22. interpret succeeds without applying", interpreted.ok === true && interpreted.applied === false);
  eq("22. interpret did not apply", applyStore.bag.applies, 0);
  ok("22. confirm enabled only after valid response", docApply.els.ownerVoicePlanPreviewConfirm.disabled === false);
  eq("22. confirm aria enabled after interpret", docApply.els.ownerVoicePlanPreviewConfirm.getAttribute("aria-disabled"), "false");

  docApply.els.ownerVoicePlanTranscript.value = "Day 1 protect floors with one Assistant for 8 hours. Add cleanup.";
  docApply.els.ownerVoicePlanTranscript.dispatchEvent({ type: "input" });
  ok("23. transcript edit disables confirm", docApply.els.ownerVoicePlanPreviewConfirm.disabled === true);
  eq("23. transcript edit clears client preview", docApply.els.ownerVoicePlanClientPreview.textContent, "No client-facing scope yet.");
  eq("23. transcript edit did not apply", applyStore.bag.applies, 0);

  const secondProposed = sampleProposed();
  secondProposed.days[0].client_scope = "Protect floors and complete cleanup.";
  secondProposed.days[0].internal_tasks = [{ label: "Protect floors" }, { label: "Final cleanup" }];
  const sessionApply2 = voice.createOwnerVoiceSession({
    document: docApply,
    speechRecognitionCtor: FakeRecognition,
    fetch: interpretOkFetch(secondProposed),
    ownerApply: applyStore.ownerApply,
  });
  sessionApply2.state.modalOpen = true;
  const reinterpreted = await sessionApply2.interpretTranscript();
  ok("24. new interpretation replaces preview", reinterpreted.ok === true);
  ok("24. new client preview rendered", /complete cleanup/i.test(docApply.els.ownerVoicePlanClientPreview.textContent));
  eq("24. still not applied until confirm", applyStore.bag.applies, 0);
  ok("24. confirm enabled after replacement interpret", docApply.els.ownerVoicePlanPreviewConfirm.disabled === false);

  const applied = await sessionApply2.applyConfirmedPlan();
  ok("25. apply requires explicit click result ok", applied.ok === true);
  eq("25. apply ran once", applyStore.bag.applies, 1);
  eq("25. client scope reached quoteNotes", applyStore.bag.notes, "Protect floors and complete cleanup.");
  ok("25. internal plan created owner days", applyStore.bag.state.operational_plan.length === 1);
  eq("25. owner day task from internal plan", applyStore.bag.state.operational_plan[0].phase, "Protect floors; Final cleanup");
  eq("25. owner day has workers/tasks", applyStore.bag.state.operational_plan[0].workers.length, 1);
  eq("25. labor not written by voice script", JSON.stringify(applyStore.bag.state.workers), "[]");
  eq("25. finish date left to Owner refresh", applyStore.bag.state.targetFinishDate, "2026-09-12");
  eq("25. start date left to Owner rules", applyStore.bag.state.startDate, "2026-09-10");
  eq("25. Owner refresh invoked", applyStore.bag.refreshes, 1);
  eq("25. modal closed after apply", docApply.els.ownerVoicePlanPreviewModal.getAttribute("aria-hidden"), "true");

  const existing = makeOwnerApply({
    quoteNotes: "Existing scope text",
    operational_plan: [{ day_number: 1, phase: "Old day", workers: [{ role: "Installer", worker_type: "pro", estimated_hours: 8 }] }],
  }, { allowOverwrite: false });
  const docWarn = makeDoc();
  docWarn.els.quoteNotes.value = "Existing scope text";
  const sessionWarn = voice.createOwnerVoiceSession({
    document: docWarn,
    speechRecognitionCtor: FakeRecognition,
    fetch: interpretOkFetch(),
    ownerApply: existing.ownerApply,
  });
  sessionWarn.openModal();
  docWarn.els.ownerVoicePlanTranscript.value = "Day 1 protect floors with one Assistant for 8 hours.";
  await sessionWarn.interpretTranscript();
  const cancelled = await sessionWarn.applyConfirmedPlan();
  eq("26. existing content prompts warning", existing.bag.overwritePrompts, 1);
  ok("26. warning is not silent", /replace|Cancel keeps everything unchanged/i.test(existing.bag.lastOverwriteMessage));
  eq("26. cancel overwrite reason", cancelled.reason, "overwrite-cancelled");
  eq("26. cancel did not apply", existing.bag.applies, 0);
  eq("26. cancel kept previous notes", existing.bag.notes, "Existing scope text");
  eq("26. cancel kept previous plan", existing.bag.state.operational_plan[0].phase, "Old day");

  const failing = makeOwnerApply({ quoteNotes: "Keep me", operational_plan: [] }, { failApply: true });
  const docFail = makeDoc();
  const sessionFail = voice.createOwnerVoiceSession({
    document: docFail,
    speechRecognitionCtor: FakeRecognition,
    fetch: interpretOkFetch(),
    ownerApply: failing.ownerApply,
  });
  sessionFail.openModal();
  docFail.els.ownerVoicePlanTranscript.value = "Day 1 protect floors with one Assistant for 8 hours.";
  await sessionFail.interpretTranscript();
  const failed = await sessionFail.applyConfirmedPlan();
  eq("27. apply failure reason", failed.reason, "apply-failed");
  eq("27. failure restored previous notes", failing.bag.notes, "Keep me");
  ok("27. failure did not keep partial write", failing.bag.notes !== "PARTIAL WRITE SHOULD NOT STICK");
  ok("27. modal stayed open after failure", docFail.els.ownerVoicePlanPreviewModal.getAttribute("aria-hidden") !== "true");

  const double = makeOwnerApply({}, { hangApply: true });
  const docDouble = makeDoc();
  const sessionDouble = voice.createOwnerVoiceSession({
    document: docDouble,
    speechRecognitionCtor: FakeRecognition,
    fetch: interpretOkFetch(),
    ownerApply: double.ownerApply,
  });
  sessionDouble.openModal();
  docDouble.els.ownerVoicePlanTranscript.value = "Day 1 protect floors with one Assistant for 8 hours.";
  await sessionDouble.interpretTranscript();
  const firstClick = sessionDouble.applyConfirmedPlan();
  const secondClick = await sessionDouble.applyConfirmedPlan();
  eq("28. double click second is busy", secondClick.reason, "busy");
  if (typeof double.bag.resolveHang === "function") double.bag.resolveHang();
  const firstResult = await firstClick;
  ok("28. first click applied", firstResult.ok === true);
  eq("28. apply ran once", double.bag.applies, 1);

  ok("29. confirm label is Confirm and apply", /id="ownerVoicePlanPreviewConfirm"[\s\S]*?>Confirm and apply</.test(html));
  ok("29. no later-phase label", !/Confirm and apply \(later phase\)/.test(html));
  ok("29. no publish/send/pdf in owner voice script", !/publish-public-quote|openSendModal|jspdf|quote-send|btnSendQuote/.test(js));
  ok("29. seller html still free of owner voice ids", !/ownerVoicePlan|btnOwnerReviewConfirmOperationalPlan/.test(salesHtml));
  ok("29. seller voice library still unchanged", /function deriveLegacyOperationalPlan/.test(sellerVoiceJs));

  ok("syntax of owner voice script", spawnSync(process.execPath, ["--check", path.join(ROOT, "public/js/owner-voice-operational-plan.js")], { encoding: "utf8" }).status === 0);

  ok("mobile stacks preview columns", /@media \(max-width: 740px\)[\s\S]*owner-voice-plan-dual[\s\S]*grid-template-columns: 1fr/.test(html));
  ok("no new libraries added", !/cdn\.jsdelivr.*speech|webkitSpeechRecognition\.min/.test(html));

  console.log(`\nOwner Voice Operational Plan Phase 1+2: ${passed} passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
