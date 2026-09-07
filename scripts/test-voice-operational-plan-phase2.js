#!/usr/bin/env node
/** Phase 2 voice dictation tests. No live AI, Supabase, quotes, email, or webhooks. */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");

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
    body: JSON.stringify({ transcript: "Agrega día tres, instalación de tile, un instalador por seis horas.", current_document: current, start_date: "2026-09-10" }),
  }));
  const successBody = await responseJson(success);
  eq("success status", success.status, 200);
  eq("auth checked once", authCalls, 1);
  eq("response is proposal only", successBody.persisted, false);
  eq("proposal has three days", successBody.proposed_document.days.length, 3);
  eq("new day keeps six hours", successBody.proposed_document.days[2].worker_assignments[0].hours_per_worker, 6);
  eq("proposal source mixed", successBody.proposed_document.source, "mixed");
  eq("model receives tenant hours per day", interpretArgs.hoursPerDay, 8);
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

  const html = read("public/sales.html");
  const fnSrc = read("netlify/functions/voice-operational-plan-command.mjs");
  ok("UI includes microphone and transcript controls", /voicePlanMicToggle/.test(html) && /voicePlanTranscript/.test(html));
  ok("UI supports Spanish and English", /value="es-US"/.test(html) && /value="en-US"/.test(html));
  ok("UI uses browser speech recognition", /webkitSpeechRecognition/.test(html) && /interimResults = true/.test(html));
  ok("UI has typed fallback", /type the instructions/i.test(html));
  ok("UI calls authenticated interpreter", /voice-operational-plan-command/.test(html) && /credentials: 'include'/.test(html));
  ok("interpreted document only updates preview draft", /voicePlanPreviewSession\.draft = proposed/.test(html));
  ok("existing Confirm and apply remains required", /Confirm and apply/.test(html) && /applyVoicePlanConfirm/.test(html));
  ok("close aborts interpretation", /voicePlanInterpretController\.abort/.test(html));
  ok("no audio blob is uploaded or stored", !/MediaRecorder|audio\/webm|FormData/.test(html + fnSrc));
  ok("endpoint never writes quote or project tables", !/quotes\?|tenant_projects|quote_internal_operational_plans/.test(fnSrc));
  ok("endpoint authenticates owner or seller", /resolveOwnerOrSellerContext/.test(fnSrc));
  ok("endpoint strips rate fields", /stripRateFields/.test(fnSrc));
  ok("Netlify timeout configured", /\[functions\."voice-operational-plan-command"\][\s\S]*timeout = 30/.test(read("netlify.toml")));

  console.log(`\nVoice Operational Plan Phase 2: ${passed} passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
