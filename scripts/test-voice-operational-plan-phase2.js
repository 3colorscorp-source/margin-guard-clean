#!/usr/bin/env node
/** Phase 2 voice dictation tests. No live AI, Supabase, quotes, email, or webhooks. */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const clientVoice = require("../public/js/voice-operational-plan.js");

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

function sampleCurrent() {
  return {
    schema_version: 1,
    source: "keyboard",
    days: [
      {
        day_id: "day_existing_1",
        day_number: 1,
        client_scope: "Protect the work area.",
        internal_tasks: [{ task_id: "task_existing_1", label: "Install protection" }],
        worker_assignments: [
          {
            assignment_id: "asg_existing_1",
            worker_role: "Assistant",
            worker_type: "helper",
            worker_count: 1,
            hours_per_worker: 8,
          },
        ],
        materials_or_tools: [],
        dependencies: [],
        gc_client_responsibilities: [],
        risks: [],
        internal_notes: "",
      },
      {
        day_id: "day_existing_2",
        day_number: 2,
        client_scope: "Complete demolition.",
        internal_tasks: [{ task_id: "task_existing_2", label: "Demolition" }],
        worker_assignments: [
          {
            assignment_id: "asg_existing_2",
            worker_role: "Installer",
            worker_type: "pro",
            worker_count: 1,
            hours_per_worker: 8,
          },
        ],
        materials_or_tools: [],
        dependencies: [],
        gc_client_responsibilities: [],
        risks: [],
        internal_notes: "",
      },
    ],
  };
}

function modelResult(days) {
  return { summary: "Updated from dictation.", warnings: [], document: { schema_version: 1, source: "mixed", days } };
}

async function responseJson(response) {
  return JSON.parse(await response.text());
}

async function main() {
  const check = spawnSync(process.execPath, ["--check", path.join(ROOT, "netlify/functions/voice-operational-plan-command.mjs")], { encoding: "utf8" });
  eq("function syntax", check.status, 0);

  const mod = await import("../netlify/functions/voice-operational-plan-command.mjs");
  ok("modern default handler exported", typeof mod.default === "function");
  ok("testable handler factory exported", typeof mod.createHandler === "function");

  eq("parse plain JSON", mod.parseModelJson('{"ok":true}').ok, true);
  eq("parse fenced JSON", mod.parseModelJson('```json\n{"ok":true}\n```').ok, true);
  eq("reject non-JSON", mod.parseModelJson("not json"), null);

  const current = sampleCurrent();
  const stabilized = mod.stabilizeProposedDocument(
    {
      days: [
        {
          ...current.days[0],
          day_id: "day_existing_1",
          internal_tasks: [{ task_id: "invented_task", label: "Changed" }],
          worker_assignments: [{ ...current.days[0].worker_assignments[0], assignment_id: "invented_asg" }],
        },
        { ...current.days[1], day_id: "invented_day" },
      ],
      hourly_rate: 999,
    },
    current
  );
  eq("existing day id preserved", stabilized.days[0].day_id, "day_existing_1");
  eq("invented day id cleared", stabilized.days[1].day_id, "");
  eq("invented task id cleared", stabilized.days[0].internal_tasks[0].task_id, "");
  eq("invented assignment id cleared", stabilized.days[0].worker_assignments[0].assignment_id, "");
  ok("rate fields stripped", !JSON.stringify(stabilized).includes("hourly_rate"));

  const duplicatedKnownIds = mod.stabilizeProposedDocument(
    {
      days: [
        current.days[0],
        {
          ...current.days[1],
          internal_tasks: [
            current.days[1].internal_tasks[0],
            { ...current.days[1].internal_tasks[0], label: "Second task created by voice" },
          ],
          worker_assignments: [
            current.days[1].worker_assignments[0],
            { ...current.days[1].worker_assignments[0], hours_per_worker: 6 },
          ],
        },
        {
          ...current.days[1],
          day_number: 3,
          client_scope: "New cleanup day.",
        },
      ],
    },
    current
  );
  eq("first existing task id remains stable", duplicatedKnownIds.days[1].internal_tasks[0].task_id, "task_existing_2");
  eq("duplicate task id is cleared", duplicatedKnownIds.days[1].internal_tasks[1].task_id, "");
  eq("first existing assignment id remains stable", duplicatedKnownIds.days[1].worker_assignments[0].assignment_id, "asg_existing_2");
  eq("duplicate assignment id is cleared", duplicatedKnownIds.days[1].worker_assignments[1].assignment_id, "");
  eq("duplicate day id is cleared", duplicatedKnownIds.days[2].day_id, "");
  eq("known task id cannot move into a new day", duplicatedKnownIds.days[2].internal_tasks[0].task_id, "");
  eq("known assignment id cannot move into a new day", duplicatedKnownIds.days[2].worker_assignments[0].assignment_id, "");

  const staleScopeProposal = {
    ...current,
    days: [
      {
        ...current.days[0],
        client_scope: "Protect the work area.",
        internal_tasks: [
          {
            task_id: "task_existing_1",
            label: "Proteger pisos, pasillos y paredes (protection of floors, hallways, and walls)",
          },
        ],
      },
      current.days[1],
    ],
  };
  const synchronizedScope = mod.synchronizeChangedClientScopes(staleScopeProposal, current);
  eq(
    "changed task replaces stale client scope",
    synchronizedScope.days[0].client_scope,
    "Proteger pisos, pasillos y paredes."
  );
  eq("unchanged day keeps its client scope", synchronizedScope.days[1].client_scope, "Complete demolition.");
  eq(
    "worker-only change does not rewrite client scope",
    mod.synchronizeChangedClientScopes({
      ...current,
      days: [{
        ...current.days[0],
        worker_assignments: [{ ...current.days[0].worker_assignments[0], hours_per_worker: 6 }],
      }, current.days[1]],
    }, current).days[0].client_scope,
    "Protect the work area."
  );
  eq(
    "crew details never enter derived client scope",
    mod.clientSafeTaskNarrative({ internal_tasks: [{ label: "Protection with one Assistant for 6 hours" }] }),
    "Complete the updated planned work for this day."
  );
  eq(
    "English crew suffix is removed from internal task",
    mod.cleanInternalTaskLabel("Protect floors and hallways, assign an Assistant for 6 hours for better efficiency"),
    "Protect floors and hallways"
  );
  eq(
    "Spanish crew suffix is removed from internal task",
    mod.cleanInternalTaskLabel("Demolición y preparación con un instalador y un ayudante durante 8 horas cada uno."),
    "Demolición y preparación"
  );

  eq("ordinary edit is not destructive authorization", mod.transcriptAllowsDestructiveChange("modify day one"), false);
  eq("Spanish delete is explicit", mod.transcriptAllowsDestructiveChange("elimina el día dos"), true);
  eq("English delete is explicit", mod.transcriptAllowsDestructiveChange("delete day two"), true);
  eq("missing current day detected", mod.missingCurrentDayIds(current, { days: [current.days[0]] })[0], "day_existing_2");
  eq("Netlify base receives v1 Responses path", mod.openAiResponsesUrl("https://gateway.example"), "https://gateway.example/v1/responses");
  eq("versioned OpenAI base is not doubled", mod.openAiResponsesUrl("https://api.openai.com/v1"), "https://api.openai.com/v1/responses");

  let authCalls = 0;
  let interpretArgs = null;
  const proposedDays = [
    { ...current.days[0], client_scope: "Protect floors, walls, and hallways." },
    current.days[1],
    {
      day_id: "",
      day_number: 3,
      client_scope: "Install wall tile.",
      internal_tasks: [{ task_id: "", label: "Set wall tile" }],
      worker_assignments: [
        { assignment_id: "", worker_role: "Installer", worker_type: "pro", worker_count: 1, hours_per_worker: 6 },
      ],
      materials_or_tools: [],
      dependencies: [],
      gc_client_responsibilities: [],
      risks: [],
      internal_notes: "Keep layout centered.",
    },
  ];
  const handler = mod.createHandler({
    resolveContext: async () => {
      authCalls += 1;
      return { auth_mode: "owner", tenant: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } };
    },
    loadSettings: async () => ({ hoursPerDay: 8, workdaysEnabled: true, baseInstaller: 40, baseHelper: 30 }),
    interpret: async (args) => {
      interpretArgs = args;
      return modelResult(proposedDays);
    },
  });
  const success = await handler(new Request("https://example.com/.netlify/functions/voice-operational-plan-command", {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: "mg_session=test" },
    body: JSON.stringify({ transcript: "Agrega día tres, instalación de tile, un instalador por seis horas.", current_document: current, start_date: "2026-09-10", client_language: "en" }),
  }));
  const successBody = await responseJson(success);
  eq("success status", success.status, 200);
  eq("auth checked once", authCalls, 1);
  eq("response is proposal only", successBody.persisted, false);
  eq("proposal has three days", successBody.proposed_document.days.length, 3);
  eq("new day keeps six hours", successBody.proposed_document.days[2].worker_assignments[0].hours_per_worker, 6);
  eq("proposal source mixed", successBody.proposed_document.source, "mixed");
  eq("model receives tenant hours per day", interpretArgs.hoursPerDay, 8);
  eq("model receives client document language", interpretArgs.clientLanguage, "en");
  eq("response confirms client document language", successBody.client_language, "en");
  ok("public scope omits worker assignments", !JSON.stringify(successBody.public_client_scope).includes("worker_assignments"));
  ok("response omits rates", !JSON.stringify(successBody).includes("baseInstaller") && !JSON.stringify(successBody).includes("hourly_rate"));

  let invalidAuthCalled = false;
  const invalidTranscript = await mod.createHandler({
    resolveContext: async () => { invalidAuthCalled = true; },
  })(new Request("https://example.com/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transcript: "x" }),
  }));
  eq("short transcript rejected", invalidTranscript.status, 400);
  eq("short transcript does not call auth", invalidAuthCalled, false);

  const unauthorized = await mod.createHandler({
    resolveContext: async () => {
      const err = new Error("Device session required");
      err.statusCode = 401;
      err.code = "no_device_session";
      err.isGuardError = true;
      throw err;
    },
  })(new Request("https://example.com/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transcript: "Create day one" }),
  }));
  eq("unauthorized rejected", unauthorized.status, 401);

  const reducedHandler = mod.createHandler({
    resolveContext: async () => ({ auth_mode: "device", tenant: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } }),
    loadSettings: async () => ({ hoursPerDay: 8 }),
    interpret: async () => modelResult([current.days[0]]),
  });
  const protectedDelete = await reducedHandler(new Request("https://example.com/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transcript: "Modify day one protection", current_document: current }),
  }));
  eq("implicit deletion blocked", protectedDelete.status, 422);
  eq("implicit deletion code", (await responseJson(protectedDelete)).code, "destructive_change_requires_explicit_command");

  const explicitDelete = await reducedHandler(new Request("https://example.com/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transcript: "Delete day two", current_document: current }),
  }));
  eq("explicit deletion proposed", explicitDelete.status, 200);
  eq("explicit deletion leaves one day", (await responseJson(explicitDelete)).proposed_document.days.length, 1);

  let aiRequest = null;
  const aiParsed = await mod.callOpenAi({
    transcript: "Create day one",
    current: { schema_version: 1, source: "voice", days: [] },
    hoursPerDay: 8,
    getEnv: (name) => ({ OPENAI_BASE_URL: "https://gateway.example", MG_VOICE_PLAN_OPENAI_MODEL: "gpt-4o-mini" }[name] || ""),
    fetchImpl: async (url, options) => {
      aiRequest = { url, options, body: JSON.parse(options.body) };
      return { ok: true, status: 200, text: async () => JSON.stringify({ output_text: JSON.stringify(modelResult([proposedDays[2]])) }) };
    },
  });
  eq("AI gateway base used", aiRequest.url, "https://gateway.example/v1/responses");
  eq("configured supported model used", aiRequest.body.model, "gpt-4o-mini");
  eq("structured JSON schema requested", aiRequest.body.text.format.type, "json_schema");
  eq("AI request does not store response", aiRequest.body.store, false);
  ok("AI prompt includes bilingual field dictation boundary", /FIELD_DICTATION/.test(aiRequest.body.input));
  eq("AI output parsed", aiParsed.summary, "Updated from dictation.");
  eq(
    "Spanish numeric insertion command is detected despite unrelated speech errors",
    mod.explicitInsertedDayNumbers("Plaza completamente el día uno. Inserta un nuevo día número 2 antes.")[0],
    2
  );
  eq("English word insertion command is detected", mod.explicitInsertedDayNumbers("Insert a new day two.")[0], 2);

  let preservationAttempts = 0;
  let preservationCorrection = "";
  const insertedDay = {
    ...proposedDays[2],
    day_id: "",
    day_number: 2,
    client_scope: "Complete demolition and preparation.",
  };
  const preservationHandler = mod.createHandler({
    resolveContext: async () => ({ auth_mode: "owner", tenant: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } }),
    loadSettings: async () => ({ hoursPerDay: 8 }),
    interpret: async (args) => {
      preservationAttempts += 1;
      preservationCorrection = args.correction || "";
      if (preservationAttempts === 1) {
        return modelResult([{ ...current.days[0], client_scope: "Protect floors." }, insertedDay]);
      }
      return modelResult([
        { ...current.days[0], client_scope: "Protect floors." },
        insertedDay,
        { ...current.days[1], day_number: 3 },
      ]);
    },
  });
  const preservationResponse = await preservationHandler(new Request("https://example.com/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      transcript: "Reemplaza el día uno e inserta un nuevo día número dos.",
      current_document: current,
      client_language: "en",
    }),
  }));
  const preservationBody = await responseJson(preservationResponse);
  eq("missing unchanged day triggers one controlled retry", preservationAttempts, 2);
  ok("retry names the missing stable day id", preservationCorrection.includes("day_existing_2"));
  eq("corrected insertion succeeds", preservationResponse.status, 200);
  eq("corrected insertion preserves all existing days", preservationBody.proposed_document.days.length, 3);

  let deterministicAttempts = 0;
  const deterministicHandler = mod.createHandler({
    resolveContext: async () => ({ auth_mode: "owner", tenant: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } }),
    loadSettings: async () => ({ hoursPerDay: 8 }),
    interpret: async () => {
      deterministicAttempts += 1;
      return modelResult([
        { ...current.days[0], client_scope: "Protect floors." },
        insertedDay,
      ]);
    },
  });
  const deterministicResponse = await deterministicHandler(new Request("https://example.com/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      transcript: "Plaza completamente el día uno. Inserta un nuevo día número 2 antes. Recorre los días existentes.",
      current_document: current,
      client_language: "en",
    }),
  }));
  const deterministicBody = await responseJson(deterministicResponse);
  eq("deterministic preservation runs after one failed retry", deterministicAttempts, 2);
  eq("deterministic insertion succeeds", deterministicResponse.status, 200);
  eq("deterministic insertion returns inserted plus all current days", deterministicBody.proposed_document.days.length, 3);
  eq("inserted day alone receives a new stable id", deterministicBody.proposed_document.days[1].day_number, 2);
  ok("inserted day does not steal an existing stable id", !["day_existing_1", "day_existing_2"].includes(deterministicBody.proposed_document.days[1].day_id));
  eq("later existing day is shifted forward", deterministicBody.proposed_document.days[2].day_number, 3);
  ok("later existing day keeps stable identity", deterministicBody.proposed_document.days.some((day) => day.day_id === "day_existing_2"));

  let failedPreservationAttempts = 0;
  const failedPreservationHandler = mod.createHandler({
    resolveContext: async () => ({ auth_mode: "owner", tenant: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } }),
    loadSettings: async () => ({ hoursPerDay: 8 }),
    interpret: async () => {
      failedPreservationAttempts += 1;
      return modelResult([current.days[0]]);
    },
  });
  const failedPreservation = await failedPreservationHandler(new Request("https://example.com/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transcript: "Modify day one protection.", current_document: current }),
  }));
  eq("failed preservation retries only once", failedPreservationAttempts, 2);
  eq("failed preservation remains fail closed", failedPreservation.status, 422);
  eq("failed preservation applies no proposal", (await responseJson(failedPreservation)).ok, false);

  const html = read("public/sales.html");
  const fnSrc = read("netlify/functions/voice-operational-plan-command.mjs");
  ok("UI includes microphone and transcript controls", /voicePlanMicToggle/.test(html) && /voicePlanTranscript/.test(html));
  ok("UI supports Spanish and English", /value="es-US"/.test(html) && /value="en-US"/.test(html));
  ok("UI separates dictation and client document language", /voicePlanClientLanguage/.test(html) && /Client document/.test(html));
  ok("new dictation clears prior transcript", /if \(!appendExisting\) transcript\.value = ''/.test(html));
  ok("continue dictation preserves prior transcript", /voicePlanMicContinue/.test(html) && /startVoicePlanRecognition\(true\)/.test(html));
  ok("UI uses browser speech recognition", /webkitSpeechRecognition/.test(html) && /interimResults = true/.test(html));
  ok("UI has typed fallback", /type the instructions/i.test(html));
  ok("UI calls authenticated interpreter", /voice-operational-plan-command/.test(html) && /credentials: 'include'/.test(html));
  ok("interpreted document only updates preview draft", /voicePlanPreviewSession\.draft = proposed/.test(html));
  ok("existing Confirm and apply remains required", /Confirm and apply/.test(html) && /applyVoicePlanConfirm/.test(html));
  ok("close aborts interpretation", /voicePlanInterpretController\.abort/.test(html));
  ok("close cancels dictation capture", /voicePlanDictationCapture\.cancel/.test(html));
  ok("seller Stop requests stop without invalidating capture", /if \(voicePlanRecognition\) \{[\s\S]*requestStop\(\);[\s\S]*stopVoicePlanRecognition\(\);[\s\S]*return;/.test(html));
  ok("seller Cancel nulls recognition before late results", /voicePlanRecognition = null;[\s\S]*rec\.stop\(\)/.test(html));
  ok("seller onend ignores a replaced instance", /if \(voicePlanRecognition !== recognition\) return;/.test(html));
  ok("seller onend closes capture generation", /voicePlanDictationCapture\.end\(/.test(html));
  ok("seller locks transcript during capture", /lockVoicePlanTranscriptForCapture\(true\)/.test(html));
  ok("seller onresult assigns reconstructed text", /transcript\.value = folded\.text/.test(html) && !/transcript\.value \+=/.test(html));
  ok("seller folds SpeechRecognition from resultIndex", /createVoiceDictationCapture/.test(html) && /applyEvent\(event, voicePlanDictationGeneration\)/.test(html));
  ok("seller does not append SpeechRecognition finals", !/voicePlanRecognitionFinal\s*\+=/.test(html));
  ok("seller keeps a single recognition instance", /if \(voicePlanRecognition\) \{[\s\S]*stopVoicePlanRecognition\(\);[\s\S]*return;/.test(html));
  ok("seller still uses es-US default language", /language && language\.value\) \|\| 'es-US'/.test(html));
  ok("no audio blob is uploaded or stored", !/MediaRecorder|audio\/webm|FormData/.test(html + fnSrc));
  ok("endpoint never writes quote or project tables", !/quotes\?|tenant_projects|quote_internal_operational_plans/.test(fnSrc));
  ok("endpoint authenticates owner or seller", /resolveOwnerOrSellerContext/.test(fnSrc));
  ok("endpoint strips rate fields", /stripRateFields/.test(fnSrc));
  ok("AI input receives explicit client scope language", /CLIENT_SCOPE_LANGUAGE/.test(fnSrc));
  ok("AI prompt keeps crew details out of task labels", /physical work activity/.test(fnSrc) && /worker_assignments/.test(fnSrc));
  ok("Netlify timeout configured", /\[functions\."voice-operational-plan-command"\][\s\S]*timeout = 30/.test(read("netlify.toml")));

  function srEvent(resultIndex, items) {
    return clientVoice.makeSpeechRecognitionEvent(resultIndex, items);
  }
  function phrase(text, isFinal) {
    return { transcript: text, isFinal: !!isFinal };
  }

  const capture = clientVoice.createVoiceDictationCapture({ maxChars: 6000 });
  const genNew = capture.start("");
  let folded = capture.applyEvent(srEvent(0, [phrase("Agrega", false)]), genNew);
  eq("seller 1. interim first draft", folded.text, "Agrega");
  folded = capture.applyEvent(srEvent(0, [phrase("Agrega día", false)]), genNew);
  eq("seller 1. interim replacement is not stacked", folded.text, "Agrega día");
  folded = capture.applyEvent(srEvent(0, [phrase("Agrega día 1", false)]), genNew);
  eq("seller 1. later interim still one copy", folded.text, "Agrega día 1");
  folded = capture.applyEvent(srEvent(0, [phrase("Agrega día 1", true)]), genNew);
  eq("seller 1. final after interims is one copy", folded.text, "Agrega día 1");
  folded = capture.applyEvent(srEvent(0, [phrase("Agrega día 1", true)]), genNew);
  folded = capture.applyEvent(srEvent(0, [phrase("Agrega día 1", true)]), genNew);
  eq("seller 3. later events repeating the same final do not duplicate", folded.text, "Agrega día 1");
  eq("seller 4. new dictation phrase appears once", folded.text, "Agrega día 1");

  folded = capture.applyEvent(
    srEvent(1, [phrase("Agrega día 1", true), phrase("Agrega día 2", false)]),
    genNew
  );
  eq("seller 2. advancing resultIndex keeps prior final", folded.text, "Agrega día 1 Agrega día 2");
  folded = capture.applyEvent(
    srEvent(1, [phrase("Agrega día 1", true), phrase("Agrega día 2", true)]),
    genNew
  );
  eq("seller 2. cumulative list with advancing resultIndex stays unique", folded.text, "Agrega día 1 Agrega día 2");
  folded = capture.applyEvent(
    srEvent(0, [phrase("Agrega día 1", true), phrase("Agrega día 2", true)]),
    genNew
  );
  eq("seller 3. replaying the full cumulative list does not duplicate", folded.text, "Agrega día 1 Agrega día 2");

  folded = capture.applyEvent(
    srEvent(2, [
      phrase("Agrega día 1", true),
      phrase("Agrega día 2", true),
      phrase("Agrega día 1", true),
    ]),
    genNew
  );
  eq(
    "seller 6. legitimate repeated phrase in a later final index is kept twice",
    folded.text,
    "Agrega día 1 Agrega día 2 Agrega día 1"
  );

  const beforeStop = folded.text;
  capture.requestStop();
  eq("seller A. requestStop keeps generation", capture.currentGeneration(), genNew);
  ok("seller A. requestStop stays listening", capture.isListening() === true);
  folded = capture.applyEvent(
    srEvent(0, [
      phrase("Agrega día 1", true),
      phrase("Agrega día 2", true),
      phrase("Agrega día 1", true),
    ]),
    genNew
  );
  eq("seller A. last final after requestStop is kept once", folded.text, "Agrega día 1 Agrega día 2 Agrega día 1");
  capture.end();
  const afterEnd = capture.applyEvent(srEvent(0, [phrase(beforeStop + " extra", true)]), genNew);
  ok("seller 7. onend ignores further events", afterEnd.ignored === true);
  eq("seller 7. stop does not clear prior transcript", beforeStop, "Agrega día 1 Agrega día 2 Agrega día 1");

  const raceA = clientVoice.createVoiceDictationCapture({ maxChars: 6000 });
  const genRaceA = raceA.start("");
  raceA.applyEvent(srEvent(0, [phrase("Agrega día", false)]), genRaceA);
  raceA.requestStop();
  eq("seller A. Stop does not bump generation", raceA.currentGeneration(), genRaceA);
  folded = raceA.applyEvent(srEvent(0, [phrase("Agrega día 1", true)]), genRaceA);
  eq("seller A. interim then Stop then final is one copy", folded.text, "Agrega día 1");
  raceA.end();
  ok("seller A. onend then ignores the same generation", raceA.applyEvent(srEvent(0, [phrase("Agrega día 1", true)]), genRaceA).ignored === true);

  const raceB = clientVoice.createVoiceDictationCapture({ maxChars: 6000 });
  const genRaceB = raceB.start("");
  const interimB = raceB.applyEvent(srEvent(0, [phrase("Agrega día", false)]), genRaceB);
  raceB.cancel();
  const lateB = raceB.applyEvent(srEvent(0, [phrase("Agrega día 1", true)]), genRaceB);
  ok("seller B. Cancel ignores the late final", lateB.ignored === true);
  eq("seller B. Cancel leaves the last accepted transcript unchanged", interimB.text, "Agrega día");
  ok("seller B. Cancel is no longer listening", raceB.isListening() === false);

  const raceC = clientVoice.createVoiceDictationCapture({ maxChars: 6000 });
  const genRaceC = raceC.start("");
  folded = raceC.applyEvent(srEvent(0, [phrase("Agrega día 1", true)]), genRaceC);
  raceC.requestStop();
  raceC.end();
  const lateC = raceC.applyEvent(srEvent(0, [phrase("Agrega día 1 extra", true)]), genRaceC);
  ok("seller C. result after onend is ignored", lateC.ignored === true);
  eq("seller C. transcript from before onend is unchanged", folded.text, "Agrega día 1");

  const raceD = clientVoice.createVoiceDictationCapture({ maxChars: 6000 });
  const genRaceD1 = raceD.start("");
  raceD.applyEvent(srEvent(0, [phrase("Agrega día 1", true)]), genRaceD1);
  raceD.requestStop();
  raceD.end();
  const genRaceD2 = raceD.start("");
  const staleOld = raceD.applyEvent(srEvent(0, [phrase("resultado viejo", true)]), genRaceD1);
  ok("seller D. previous generation is ignored after a new session", staleOld.ignored === true);
  folded = raceD.applyEvent(srEvent(0, [phrase("Agrega día 2", true)]), genRaceD2);
  eq("seller D. new session accepts only its own result", folded.text, "Agrega día 2");

  const raceE = clientVoice.createVoiceDictationCapture({ maxChars: 6000 });
  const genRaceE = raceE.start("Base previa");
  raceE.applyEvent(srEvent(0, [phrase("Agrega día", false)]), genRaceE);
  raceE.requestStop();
  folded = raceE.applyEvent(srEvent(0, [phrase("Agrega día 1", true)]), genRaceE);
  raceE.end();
  eq("seller E. Continue Stop keeps base plus one final", folded.text, "Base previa Agrega día 1");
  ok("seller E. Continue Stop then ignores the old generation", raceE.applyEvent(srEvent(0, [phrase("Agrega día 1", true)]), genRaceE).ignored === true);

  const growCap = clientVoice.createVoiceDictationCapture({ maxChars: 6000 });
  const growGen = growCap.start("");
  growCap.applyEvent(srEvent(0, [phrase("agrega día", false)]), growGen);
  growCap.applyEvent(srEvent(0, [phrase("agrega día 1", false)]), growGen);
  growCap.applyEvent(srEvent(0, [phrase("agrega día 1 para", false)]), growGen);
  folded = growCap.applyEvent(
    srEvent(0, [phrase("agrega día 1 para preparar el piso", true)]),
    growGen
  );
  eq("seller phone. index-0 growing interims then final", folded.text, "agrega día 1 para preparar el piso");
  eq("seller phone. one slot after growing interims", growCap.slotCount(), 1);
  ok("seller phone. earlier hypotheses are gone", folded.text.indexOf("agrega día 1 para") === 0 && folded.text.split("agrega día").length === 2);

  const growFinalsCap = clientVoice.createVoiceDictationCapture({ maxChars: 6000 });
  const growFinalsGen = growFinalsCap.start("");
  growFinalsCap.applyEvent(srEvent(0, [phrase("agrega día", true)]), growFinalsGen);
  growFinalsCap.applyEvent(srEvent(0, [phrase("agrega día 1", true)]), growFinalsGen);
  growFinalsCap.applyEvent(srEvent(0, [phrase("agrega día 1 para", true)]), growFinalsGen);
  folded = growFinalsCap.applyEvent(
    srEvent(0, [phrase("agrega día 1 para preparar el piso", true)]),
    growFinalsGen
  );
  eq("seller phone-final. each final at index 0 replaces the slot", folded.text, "agrega día 1 para preparar el piso");

  const snapCap = clientVoice.createVoiceDictationCapture({ maxChars: 6000 });
  const snapGen = snapCap.start("");
  folded = snapCap.applyEvent(
    srEvent(0, [
      phrase("agrega día", true),
      phrase("agrega día 1", true),
      phrase("agrega día 1 para", true),
      phrase("agrega día 1 para preparar el piso", true),
    ]),
    snapGen
  );
  eq("seller phone-list. growing snapshot at resultIndex 0 collapses", folded.text, "agrega día 1 para preparar el piso");
  eq("seller phone-list. collapsed to one slot", snapCap.slotCount(), 1);

  const dirtyCap = clientVoice.createVoiceDictationCapture({ maxChars: 6000 });
  const dirtyGen = dirtyCap.start("");
  dirtyCap.applyEvent(srEvent(0, [phrase("agrega día", false)]), dirtyGen);
  eq("seller phone. base is not the visible transcript", dirtyCap.currentBase(), "");
  folded = dirtyCap.applyEvent(srEvent(0, [phrase("agrega día 1", true)]), dirtyGen);
  eq("seller phone. later event still ignores any external textarea", folded.text, "agrega día 1");

  const genContinue = capture.start("Agrega día 1");
  ok("seller 9. a new session generation is distinct", genContinue !== genNew);
  const staleAfterRestart = capture.applyEvent(srEvent(0, [phrase("Agrega día 1 Agrega día 1", true)]), genNew);
  ok("seller 8. restart ignores the previous session generation", staleAfterRestart.ignored === true);
  folded = capture.applyEvent(srEvent(0, [phrase("Agrega día 1", true)]), genContinue);
  eq("seller 5. continue keeps prior text and adds one copy", folded.text, "Agrega día 1 Agrega día 1");
  folded = capture.applyEvent(srEvent(0, [phrase("Agrega día 1", true)]), genContinue);
  eq("seller 5. continue does not re-append the same Chrome final", folded.text, "Agrega día 1 Agrega día 1");
  ok("seller 9. only the current capture generation is listening", capture.isListening() === true && capture.currentGeneration() === genContinue);

  folded = capture.applyEvent(srEvent(0, [phrase("x".repeat(7000), true)]), genContinue);
  eq("seller 10. dictation clamps to 6000", folded.text.length, 6000);

  capture.cancel();
  const late = capture.applyEvent(srEvent(0, [phrase("late event after cancel", true)]), genContinue);
  ok("seller 11. cancel invalidates late recognition events", late.ignored === true);
  ok("seller 12. typed fallback remains in the seller modal", /type the instructions/i.test(html));
  ok("seller 13. owner voice ids stay out of sales.html", !/ownerVoicePlan|btnOwnerReviewConfirmOperationalPlan/.test(html));
  ok("seller 13. shared helper is the SpeechRecognition fold", typeof clientVoice.createVoiceDictationCapture === "function");

  console.log(`\nVoice Operational Plan Phase 2: ${passed} passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
