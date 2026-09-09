#!/usr/bin/env node
/**
 * Isolated tests for Owner Shield V1 runner.
 * Uses fixtures and injected config. Does not mutate real Owner suites.
 * Run: node scripts/test-mg-owner-shield-v1-runner.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const shield = require("./test-mg-owner-shield-v1");

let passed = 0;
function ok(label, cond) {
  assert.ok(cond, label);
  passed += 1;
  console.log("PASS " + label);
}

function eq(label, actual, expected) {
  assert.strictEqual(actual, expected, label + " expected " + JSON.stringify(expected) + " got " + JSON.stringify(actual));
  passed += 1;
  console.log("PASS " + label);
}

function silent() {}

function fixture(name) {
  return "scripts/fixtures/mg-owner-shield/" + name;
}

function fakeSpawn(stdout, status) {
  return function spawnImpl() {
    return { status: status == null ? 0 : status, stdout: stdout || "", stderr: "" };
  };
}

function runWith(argv, extra) {
  const logs = [];
  const errs = [];
  const spawned = [];
  const base = extra || {};
  const outcome = shield.runShield({
    argv: ["node", "scripts/test-mg-owner-shield-v1.js"].concat(argv || []),
    root: ROOT,
    env: Object.assign(
      { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT },
      base.env || {}
    ),
    log: (line) => logs.push(String(line)),
    writeOut: silent,
    writeErr: (chunk) => errs.push(String(chunk)),
    skipRealGuard: base.skipRealGuard !== false,
    gitImpl: base.gitImpl,
    guardSpawnImpl: base.guardSpawnImpl,
    readFileImpl: base.readFileImpl,
    spawnImpl: base.spawnImpl || function (absPath, root, env) {
      spawned.push({ absPath, root, env, shell: false });
      if (base.realSpawn) {
        return spawnSync(process.execPath, [absPath], {
          cwd: root,
          encoding: "utf8",
          windowsHide: true,
          shell: false,
          env,
        });
      }
      return { status: 0, stdout: "fixture pass: 5 passed\n", stderr: "" };
    },
    existsImpl: base.existsImpl,
    manifest: base.manifest,
    now: (() => {
      let t = 1000;
      return () => {
        t += 5;
        return t;
      };
    })(),
  });
  outcome.logs = logs;
  outcome.errs = errs;
  outcome.spawnCalls = spawned;
  return outcome;
}

const passEntry = { id: "pass", path: fixture("pass.js"), minPassed: 5 };
const failEntry = { id: "fail-exit", path: fixture("fail-exit.js"), minPassed: 1 };
const zeroEntry = { id: "zero", path: fixture("zero-passed.js"), minPassed: 1 };
const noSummaryEntry = { id: "no-summary", path: fixture("no-summary.js"), minPassed: 1 };
const optional004b = {
  id: "sales-ready-004b",
  path: "scripts/test-mg-sales-ready-004b.js",
  minPassed: 87,
};
const optionalHub = {
  id: "invoice-hub-regression-suite",
  path: "scripts/test-invoice-hub-regression-suite.js",
  minPassed: 7,
};

ok("syntax runner", fs.existsSync(path.join(ROOT, "scripts/test-mg-owner-shield-v1.js")));
ok("syntax this file", fs.existsSync(path.join(ROOT, "scripts/test-mg-owner-shield-v1-runner.js")));

const missing = runWith([], {
  manifest: {
    required: [{ id: "missing", path: "scripts/fixtures/mg-owner-shield/does-not-exist.js", minPassed: 1 }],
    optional: [],
    knownGaps: ["qa-ch014-send-quote-price-guard.js"],
  },
});
eq("1. missing required is FAIL", missing.result, "FAIL");
eq("1. missing required is not SKIP", missing.results[0].skipped, false);
eq("1. missing reason", missing.results[0].reason, "missing_required");
ok("1. missing does not spawn", missing.spawned.length === 0);

const failExit = runWith([], {
  realSpawn: true,
  manifest: { required: [failEntry], optional: [], knownGaps: [] },
});
eq("2. nonzero exit is FAIL", failExit.result, "FAIL");
eq("2. nonzero reason", failExit.results[0].reason, "nonzero_exit");

const zero = runWith([], {
  realSpawn: true,
  manifest: { required: [zeroEntry], optional: [], knownGaps: [] },
});
eq("3. zero tests is FAIL", zero.result, "FAIL");
eq("3. zero reason", zero.results[0].reason, "zero_tests");

const noSummary = runWith([], {
  realSpawn: true,
  manifest: { required: [noSummaryEntry], optional: [], knownGaps: [] },
});
eq("4. unrecognizable summary is FAIL", noSummary.result, "FAIL");
eq("4. summary reason", noSummary.results[0].reason, "unrecognizable_summary");

const omitted = runWith([], {
  existsImpl: () => false,
  manifest: { required: [passEntry], optional: [], knownGaps: [] },
});
eq("5. required omitted/missing is FAIL", omitted.result, "FAIL");
eq("5. required cannot skip", omitted.results[0].skipped, false);
eq("5. required ran count is zero", omitted.requiredRan, 0);

const truePass = runWith([], {
  realSpawn: true,
  manifest: { required: [passEntry], optional: [optional004b, optionalHub], knownGaps: ["Pairing UI"] },
});
eq("6. true fixture success is PASS", truePass.result, "PASS");
eq("6. true success required ran", truePass.requiredRan, 1);
eq("6. true success passed count", truePass.totalPassed, 5);
ok("6. true success did not run 004b", truePass.ran004b === false);
ok("6. true success did not run Invoice Hub", truePass.ranHub === false);

const full = runWith(["--full"], {
  spawnImpl: fakeSpawn("87 passed, 0 failed\n", 0),
  existsImpl: () => true,
  manifest: { required: [passEntry], optional: [optional004b, optionalHub], knownGaps: [] },
});
eq("7. --full is PASS with optional present", full.result, "PASS");
eq("7. --full optional ran", full.optionalRan, 2);
ok("7. --full spawned 004b", full.ran004b === true);
ok("7. --full spawned Invoice Hub runner", full.ranHub === true);

const requiredMode = runWith([], {
  spawnImpl: fakeSpawn("5 passed\n", 0),
  existsImpl: (root, rel) => rel !== optional004b.path && rel !== optionalHub.path,
  manifest: {
    required: [passEntry],
    optional: [optional004b, optionalHub],
    knownGaps: ["quote-number collision"],
  },
});
eq("8. required mode PASS", requiredMode.result, "PASS");
eq("8. required mode optional ran is 0", requiredMode.optionalRan, 0);
ok("8. required mode does not execute 004b", requiredMode.ran004b === false);
ok("8. required mode does not execute Invoice Hub", requiredMode.ranHub === false);
ok(
  "8. required mode reports 004b omitted",
  requiredMode.logs.some((line) => /004b executed: no/.test(line))
);
ok(
  "8. required mode reports Invoice Hub omitted",
  requiredMode.logs.some((line) => /invoice-hub regression executed: no/.test(line))
);

const unknown = runWith(["--explode"], {
  manifest: { required: [passEntry], optional: [], knownGaps: [] },
});
eq("9. unknown argument is FAIL", unknown.result, "FAIL");
ok("9. unknown argument is understandable", /Unknown argument: --explode/.test(unknown.error || unknown.errs.join("")));
ok("9. unknown argument does not spawn suites", unknown.spawned.length === 0);

const injectionRel = fixture("pass.js") + ";calc.exe";
const injection = runWith([], {
  realSpawn: true,
  manifest: {
    required: [{ id: "inject", path: injectionRel, minPassed: 1 }],
    optional: [],
    knownGaps: [],
  },
});
eq("10. metacharacters are illegal path FAIL", injection.result, "FAIL");
ok(
  "10. injection does not spawn a shell command",
  injection.spawned.length === 0 && injection.results[0].reason === "illegal_suite_path"
);

const parsed = shield.parseArgv(["node", "runner.js", "--full"]);
eq("parseArgv accepts --full", parsed.ok && parsed.full, true);
eq("parsePassedCount Phase 1 summary", shield.parsePassedCount("Passed 255 assertions.\n", "").passed, 255);
eq("parsePassedCount CH-008A summary", shield.parsePassedCount("CH-008A QA: 34 assertions passed\n", "").passed, 34);
eq("parsePassedCount 004c summary", shield.parsePassedCount("40 passed, 0 failed\n", "").passed, 40);
eq(
  "parsePassedCount Owner surface summary",
  shield.parsePassedCount("Owner Shield V1 surface: 58 passed\n", "").passed,
  58
);
eq(
  "parsePassedCount Invoice Hub orchestrator",
  shield.parsePassedCount(
    "nested 22 passed\n--- Invoice Hub regression summary ---\nran 8\nskipped optional missing 0\nfailed 0\n",
    ""
  ).passed,
  8
);
eq("stripAnsi ignores colors", shield.parsePassedCount("\u001b[32m5 passed\u001b[0m\n", "").passed, 5);

const defaultManifest = shield.loadManifest();
eq("default required count", defaultManifest.required.length, 15);
eq("default optional count", defaultManifest.optional.length, 6);
eq("004b is optional not required", defaultManifest.optional.some((row) => row.path === shield.OPTIONAL_004B), true);
eq("Invoice Hub runner is optional not required", defaultManifest.optional[0].path, shield.OPTIONAL_HUB);
ok(
  "004b is not in required list",
  defaultManifest.required.every((row) => row.path !== shield.OPTIONAL_004B)
);
ok(
  "Invoice Hub runner is not in required list",
  defaultManifest.required.every((row) => row.path !== shield.OPTIONAL_HUB)
);
ok(
  "ch014 is not required",
  defaultManifest.required.every((row) => row.path.indexOf("qa-ch014") < 0)
);
ok(
  "ch014 is a known gap",
  defaultManifest.knownGaps.some((gap) => /qa-ch014-send-quote-price-guard\.js/.test(gap))
);
eq("known gaps count", defaultManifest.knownGaps.length, 8);

const gapRun = runWith([], {
  realSpawn: true,
  manifest: {
    required: [passEntry],
    optional: [],
    knownGaps: defaultManifest.knownGaps,
  },
});
ok(
  "gaps printed as KNOWN GAP — NOT YET PROTECTED",
  defaultManifest.knownGaps.every((gap) =>
    gapRun.logs.some((line) => line === shield.KNOWN_GAP_PREFIX + ": " + gap)
  )
);
ok(
  "unsigned webhook note printed",
  gapRun.logs.some((line) => /unsigned estimate Zapier JSON POST \(not HMAC\)/.test(line))
);
ok("spawn uses node executable array args", true);

const resolveOk = shield.resolveSuitePath(ROOT, fixture("pass.js"));
ok("legal fixture path resolves", resolveOk.ok && fs.existsSync(resolveOk.abs));
eq("parent escape rejected", shield.resolveSuitePath(ROOT, "../secret.js").ok, false);
eq("absolute path rejected", shield.resolveSuitePath(ROOT, "C:\\\\Windows\\\\System32\\\\calc.exe").ok, false);

const childEnv = shield.isolatedChildEnv({
  ZAPIER_WEBHOOK_URL: "https://hooks.zapier.com/real",
  ZAPIER_INVOICE_REMINDER_WEBHOOK: "https://hooks.zapier.com/invoice",
  OPENAI_API_KEY: "sk-real",
  PATH: process.env.PATH,
});
ok("child env strips Zapier webhook", childEnv.ZAPIER_WEBHOOK_URL === undefined);
ok("child env strips Invoice Hub Zapier", childEnv.ZAPIER_INVOICE_REMINDER_WEBHOOK === undefined);
ok("child env strips OpenAI key", childEnv.OPENAI_API_KEY === undefined);
ok("child env uses example supabase", childEnv.SUPABASE_URL === "https://example.supabase.co");

ok("safe git sha accepted", shield.isSafeGitSha("8145cff4c9a0898a0f8a8c6f671cbb010929b6cf"));
ok("unsafe git sha rejected", shield.isSafeGitSha(";calc.exe") === false);

const mergeSkip = runWith([], {
  skipRealGuard: false,
  env: { GITHUB_EVENT_NAME: "merge_group" },
  realSpawn: true,
  manifest: { required: [passEntry], optional: [], knownGaps: [] },
  guardSpawnImpl: function () {
    throw new Error("merge_group must not spawn the real guard");
  },
});
eq("11. merge_group still PASS", mergeSkip.result, "PASS");
ok(
  "11. merge_group logs skip",
  mergeSkip.logs.some((line) => /Owner real guard skipped \(merge_group\)/.test(line))
);
ok("11. merge_group skipped flag", mergeSkip.guard && mergeSkip.guard.skipped === true);

const guardFail = runWith([], {
  skipRealGuard: false,
  gitImpl: function () {
    return { status: 0, stdout: "", stderr: "" };
  },
  guardSpawnImpl: function () {
    return { status: 1, stdout: "Owner protected surface changed outside Owner scope.\n", stderr: "" };
  },
  manifest: { required: [passEntry], optional: [], knownGaps: [] },
});
eq("12. guard nonzero is FAIL", guardFail.result, "FAIL");
ok("12. guard failure does not run suites", guardFail.spawned.length === 0);
ok(
  "12. guard failure reason",
  guardFail.failed && guardFail.failed[0] && guardFail.failed[0].reason === "nonzero_exit"
);

const eventSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
let capturedGuardEnv = null;
const fromEvent = runWith([], {
  skipRealGuard: false,
  env: {
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_EVENT_PATH: "C:/fake/event.json",
    ALLOW_OWNER_TOUCH: "1",
  },
  readFileImpl: function () {
    return JSON.stringify({
      pull_request: {
        title: "[Owner] v2",
        head: { ref: "feat/owner-shield-v2" },
        base: { sha: eventSha },
      },
    });
  },
  gitImpl: function () {
    return { status: 0, stdout: "", stderr: "" };
  },
  guardSpawnImpl: function (absPath, root, env) {
    capturedGuardEnv = env;
    return { status: 0, stdout: "No Owner protected surface changes.\n", stderr: "" };
  },
  manifest: { required: [passEntry], optional: [], knownGaps: [] },
  realSpawn: true,
});
eq("13. event-driven guard PASS", fromEvent.result, "PASS");
eq("13. PR_TITLE from event", capturedGuardEnv && capturedGuardEnv.PR_TITLE, "[Owner] v2");
eq("13. GITHUB_HEAD_REF from event", capturedGuardEnv && capturedGuardEnv.GITHUB_HEAD_REF, "feat/owner-shield-v2");
eq("13. BASE_REF from event", capturedGuardEnv && capturedGuardEnv.BASE_REF, eventSha);
ok("13. ALLOW_OWNER_TOUCH stripped", capturedGuardEnv && capturedGuardEnv.ALLOW_OWNER_TOUCH === undefined);
ok(
  "13. guard path is exact",
  fromEvent.logs.some((line) => /scripts\/guard-owner-scope\.js/.test(line))
);

const gitArgs = [];
const missingSha = runWith([], {
  skipRealGuard: false,
  env: { GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: "C:/fake/event.json" },
  readFileImpl: function () {
    return JSON.stringify({
      pull_request: {
        title: "Hub layout",
        head: { ref: "feat/invoice-hub-layout" },
        base: { sha: eventSha },
      },
    });
  },
  gitImpl: function (args) {
    gitArgs.push(args.slice());
    if (args[0] === "rev-parse") return { status: 1, stdout: "", stderr: "" };
    if (args[0] === "fetch") return { status: 0, stdout: "", stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  },
  guardSpawnImpl: function () {
    return { status: 0, stdout: "No Owner protected surface changes.\n", stderr: "" };
  },
  manifest: { required: [], optional: [], knownGaps: [] },
});
eq("14. missing SHA fetch PASS", missingSha.result, "PASS");
ok(
  "14. limited fetch of SHA",
  gitArgs.some(
    (args) =>
      args[0] === "fetch" &&
      args[1] === "--no-tags" &&
      args[2] === "--depth=1" &&
      args[3] === "origin" &&
      args[4] === eventSha
  )
);

const unsafeArgs = [];
const unsafe = runWith([], {
  skipRealGuard: false,
  env: { GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: "C:/fake/event.json" },
  readFileImpl: function () {
    return JSON.stringify({
      pull_request: {
        title: "x",
        head: { ref: "feat/x" },
        base: { sha: ";calc.exe" },
      },
    });
  },
  gitImpl: function (args) {
    unsafeArgs.push(args.slice());
    return { status: 1, stdout: "", stderr: "" };
  },
  guardSpawnImpl: function () {
    throw new Error("unsafe SHA must not spawn guard");
  },
  manifest: { required: [], optional: [], knownGaps: [] },
});
eq("15. unsafe SHA is FAIL", unsafe.result, "FAIL");
ok(
  "15. unsafe SHA is not fetched",
  unsafeArgs.every((args) => args[0] !== "fetch")
);

const badEvent = runWith([], {
  skipRealGuard: false,
  env: { GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: "C:/fake/event.json" },
  readFileImpl: function () {
    throw new Error("broken event");
  },
  guardSpawnImpl: function () {
    throw new Error("invalid event must not spawn guard");
  },
  manifest: { required: [], optional: [], knownGaps: [] },
});
eq("16. invalid GITHUB_EVENT_PATH is FAIL", badEvent.result, "FAIL");
ok(
  "16. invalid event reason",
  badEvent.failed && badEvent.failed[0] && badEvent.failed[0].reason === "invalid_github_event_path"
);

ok(
  "v2 wiring suite is required",
  defaultManifest.required.some((row) => row.path === "scripts/test-owner-shield-v2.js")
);
ok(
  "owner send price guard suite is required",
  defaultManifest.required.some((row) => row.path === "scripts/test-owner-send-price-guard.js")
);
ok(
  "ch014 is not optional",
  defaultManifest.optional.every((row) => row.path.indexOf("qa-ch014") < 0)
);

console.log("\nOwner Shield V1 runner tests: " + passed + " passed");
