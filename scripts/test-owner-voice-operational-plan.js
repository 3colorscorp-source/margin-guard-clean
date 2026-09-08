#!/usr/bin/env node
/**
 * Owner voice operational-plan Phase 1 tests.
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
  eq("14. confirm apply flag is false", voice.CONFIRM_APPLY_ENABLED, false);
  const docD = makeDoc();
  const sessionD = voice.createOwnerVoiceSession({
    document: docD,
    speechRecognitionCtor: FakeRecognition,
    fetch: async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        proposed_document: proposed,
        public_client_scope: { narrative: "Protect floors and walls." },
        summary: "Ready",
        warnings: [],
      }),
    }),
  });
  sessionD.openModal();
  docD.els.ownerVoicePlanTranscript.value = "Day 1 protect floors with one Assistant for 8 hours.";
  await sessionD.interpretTranscript();
  ok("14. confirm stays disabled after interpret", docD.els.ownerVoicePlanPreviewConfirm.disabled === true);
  eq("14. confirm aria-disabled", docD.els.ownerVoicePlanPreviewConfirm.getAttribute("aria-disabled"), "true");

  const writeHaystack = js;
  ok("15. no quoteNotes writer", !/quoteNotes/.test(writeHaystack));
  ok("15. no owner date writers", !/ownerStartDate|ownerTargetFinishDate|salesStartDate/.test(writeHaystack));
  ok("15. no labor writers", !/workersBody|btnAddWorker|labor_auto_sync/.test(writeHaystack));
  ok("15. no mg_owner_v2 or localStorage writes", !/mg_owner_v2|localStorage/.test(writeHaystack));
  ok("15. no persist endpoint", !/quote-internal-operational-plan|publish-public-quote|send-quote/.test(writeHaystack));
  ok("15. no apply/save owner helpers", !/saveOwner|applyConfirmedVoicePlanToState|refreshOwnerAfterOpChange/.test(writeHaystack));

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

  ok("syntax of owner voice script", spawnSync(process.execPath, ["--check", path.join(ROOT, "public/js/owner-voice-operational-plan.js")], { encoding: "utf8" }).status === 0);

  ok("mobile stacks preview columns", /@media \(max-width: 740px\)[\s\S]*owner-voice-plan-dual[\s\S]*grid-template-columns: 1fr/.test(html));
  ok("no new libraries added", !/cdn\.jsdelivr.*speech|webkitSpeechRecognition\.min/.test(html));

  console.log(`\nOwner Voice Operational Plan Phase 1: ${passed} passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
