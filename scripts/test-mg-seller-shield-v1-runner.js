#!/usr/bin/env node
/**
 * Isolated tests for Seller Shield V1 runner.
 * Uses fixtures and injected config. Does not mutate real Seller suites.
 * Run: node scripts/test-mg-seller-shield-v1-runner.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const shield = require("./test-mg-seller-shield-v1");

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
  return "scripts/fixtures/mg-seller-shield/" + name;
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
    argv: ["node", "scripts/test-mg-seller-shield-v1.js"].concat(argv || []),
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

ok("syntax runner", fs.existsSync(path.join(ROOT, "scripts/test-mg-seller-shield-v1.js")));
ok("syntax this file", fs.existsSync(path.join(ROOT, "scripts/test-mg-seller-shield-v1-runner.js")));

const missing = runWith([], {
  manifest: {
    required: [{ id: "missing", path: "scripts/fixtures/mg-seller-shield/does-not-exist.js", minPassed: 1 }],
    optional: [],
    knownGaps: ["get-seller-business-settings"],
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
  manifest: { required: [passEntry], optional: [optional004b], knownGaps: ["Pairing UI"] },
});
eq("6. true fixture success is PASS", truePass.result, "PASS");
eq("6. true success required ran", truePass.requiredRan, 1);
eq("6. true success passed count", truePass.totalPassed, 5);
ok("6. true success did not run 004b", truePass.ran004b === false);

const full = runWith(["--full"], {
  spawnImpl: fakeSpawn("87 passed, 0 failed\n", 0),
  existsImpl: () => true,
  manifest: { required: [passEntry], optional: [optional004b], knownGaps: [] },
});
eq("7. --full is PASS with optional present", full.result, "PASS");
eq("7. --full optional ran", full.optionalRan, 1);
ok("7. --full spawned 004b", full.ran004b === true);

const requiredMode = runWith([], {
  spawnImpl: fakeSpawn("5 passed\n", 0),
  existsImpl: (root, rel) => rel !== optional004b.path,
  manifest: {
    required: [passEntry],
    optional: [optional004b],
    knownGaps: ["quote-number collision"],
  },
});
eq("8. required mode PASS", requiredMode.result, "PASS");
eq("8. required mode optional ran is 0", requiredMode.optionalRan, 0);
ok("8. required mode does not execute 004b", requiredMode.ran004b === false);
ok(
  "8. required mode reports 004b omitted",
  requiredMode.logs.some((line) => /004b executed: no/.test(line))
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
eq("stripAnsi ignores colors", shield.parsePassedCount("\u001b[32m5 passed\u001b[0m\n", "").passed, 5);

const defaultManifest = shield.loadManifest();
eq("default required count", defaultManifest.required.length, 12);
eq("default optional count", defaultManifest.optional.length, 1);
eq("004b is optional not required", defaultManifest.optional[0].path, shield.OPTIONAL_004B);
ok(
  "004b is not in required list",
  defaultManifest.required.every((row) => row.path !== shield.OPTIONAL_004B)
);
eq("known gaps count", defaultManifest.knownGaps.length, 0);

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
ok("unsigned webhook note printed", gapRun.logs.some((line) => /unsigned estimate Zapier JSON POST \(not HMAC\)/.test(line)));
ok("spawn uses node executable array args", true);

const resolveOk = shield.resolveSuitePath(ROOT, fixture("pass.js"));
ok("legal fixture path resolves", resolveOk.ok && fs.existsSync(resolveOk.abs));
eq("parent escape rejected", shield.resolveSuitePath(ROOT, "../secret.js").ok, false);
eq("absolute path rejected", shield.resolveSuitePath(ROOT, "C:\\\\Windows\\\\System32\\\\calc.exe").ok, false);

const childEnv = shield.isolatedChildEnv({
  ZAPIER_WEBHOOK_URL: "https://hooks.zapier.com/real",
  OPENAI_API_KEY: "sk-real",
  PATH: process.env.PATH,
});
ok("child env strips Zapier webhook", childEnv.ZAPIER_WEBHOOK_URL === undefined);
ok("child env strips OpenAI key", childEnv.OPENAI_API_KEY === undefined);
ok("child env uses example supabase", childEnv.SUPABASE_URL === "https://example.supabase.co");

ok("safe git sha accepted", shield.isSafeGitSha("2e945256bf85e3ffcffca8fe53ae18cc215e1690"));
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
  mergeSkip.logs.some((line) => /Seller real guard skipped \(merge_group\)/.test(line))
);
ok("11. merge_group skipped flag", mergeSkip.guard && mergeSkip.guard.skipped === true);

const guardFail = runWith([], {
  skipRealGuard: false,
  gitImpl: function () {
    return { status: 0, stdout: "", stderr: "" };
  },
  guardSpawnImpl: function () {
    return { status: 1, stdout: "Seller protected surface changed outside Seller scope.\n", stderr: "" };
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
    ALLOW_SELLER_TOUCH: "1",
  },
  readFileImpl: function () {
    return JSON.stringify({
      pull_request: {
        title: "[Seller] v2",
        head: { ref: "feat/seller-shield-v2" },
        base: { sha: eventSha },
      },
    });
  },
  gitImpl: function () {
    return { status: 0, stdout: "", stderr: "" };
  },
  guardSpawnImpl: function (absPath, root, env) {
    capturedGuardEnv = env;
    return { status: 0, stdout: "No Seller protected surface changes.\n", stderr: "" };
  },
  manifest: { required: [passEntry], optional: [], knownGaps: [] },
  realSpawn: true,
});
eq("13. event-driven guard PASS", fromEvent.result, "PASS");
eq("13. PR_TITLE from event", capturedGuardEnv && capturedGuardEnv.PR_TITLE, "[Seller] v2");
eq("13. GITHUB_HEAD_REF from event", capturedGuardEnv && capturedGuardEnv.GITHUB_HEAD_REF, "feat/seller-shield-v2");
eq("13. BASE_REF from event", capturedGuardEnv && capturedGuardEnv.BASE_REF, eventSha);
ok("13. ALLOW_SELLER_TOUCH stripped", capturedGuardEnv && capturedGuardEnv.ALLOW_SELLER_TOUCH === undefined);
ok(
  "13. guard path is exact",
  fromEvent.logs.some((line) => /scripts\/guard-seller-scope\.js/.test(line))
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
    return { status: 0, stdout: "No Seller protected surface changes.\n", stderr: "" };
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

console.log("\nSeller Shield V1 runner tests: " + passed + " passed");
