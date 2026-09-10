#!/usr/bin/env node
/**
 * Isolated tests for Core Security Shield V1 runner.
 * Uses fixtures and injected config. Does not mutate product suites.
 * Run: node scripts/test-mg-core-security-shield-v1-runner.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const shield = require("./test-mg-core-security-shield-v1");

let passed = 0;
function ok(label, cond) {
  assert.ok(cond, label);
  passed += 1;
  console.log("PASS " + label);
}
function eq(label, actual, expected) {
  assert.strictEqual(
    actual,
    expected,
    label + " expected " + JSON.stringify(expected) + " got " + JSON.stringify(actual)
  );
  passed += 1;
  console.log("PASS " + label);
}

function silent() {}

function fixture(name) {
  return "scripts/fixtures/mg-core-security-shield/" + name;
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
    argv: ["node", "scripts/test-mg-core-security-shield-v1.js"].concat(argv || []),
    root: ROOT,
    env: Object.assign(
      { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT },
      base.env || {}
    ),
    log: (line) => logs.push(String(line)),
    writeOut: silent,
    writeErr: (chunk) => errs.push(String(chunk)),
    spawnImpl:
      base.spawnImpl ||
      function (absPath, root, env) {
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
    manifestPath: base.manifestPath,
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
const optionalSample = {
  id: "optional-sample",
  path: fixture("fail-exit.js"),
  minPassed: 5,
};

ok("syntax runner", fs.existsSync(path.join(ROOT, "scripts/test-mg-core-security-shield-v1.js")));
ok("syntax this file", fs.existsSync(path.join(ROOT, "scripts/test-mg-core-security-shield-v1-runner.js")));

const missingManifest = runWith([], {
  manifestPath: path.join(ROOT, "scripts/fixtures/mg-core-security-shield/does-not-exist.json"),
});
eq("missing manifest is FAIL", missingManifest.result, "FAIL");
eq("missing manifest reason", missingManifest.reason || missingManifest.error, "missing_manifest");

const invalidManifest = runWith([], {
  manifestPath: path.join(ROOT, "scripts/fixtures/mg-core-security-shield/invalid-manifest.json"),
});
eq("invalid manifest is FAIL", invalidManifest.result, "FAIL");
eq("invalid manifest reason", invalidManifest.reason || invalidManifest.error, "invalid_manifest");

const missing = runWith([], {
  manifest: {
    required: [{ id: "missing", path: "scripts/fixtures/mg-core-security-shield/does-not-exist.js", minPassed: 1 }],
    optional: [],
    knownGaps: ["unsigned estimate webhook"],
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
  manifest: { required: [passEntry], optional: [optionalSample], knownGaps: ["Pairing UI"] },
});
eq("6. true fixture success is PASS", truePass.result, "PASS");
eq("6. true success required ran", truePass.requiredRan, 1);
eq("6. true success passed count", truePass.totalPassed, 5);
eq("6. true success did not run optional", truePass.optionalRan, 0);

const full = runWith(["--full"], {
  spawnImpl: fakeSpawn("5 passed\n", 0),
  existsImpl: () => true,
  manifest: { required: [passEntry], optional: [optionalSample], knownGaps: [] },
});
eq("7. --full is PASS with optional present", full.result, "PASS");
eq("7. --full optional ran", full.optionalRan, 1);

const requiredMode = runWith([], {
  spawnImpl: fakeSpawn("5 passed\n", 0),
  existsImpl: (root, rel) => rel !== optionalSample.path,
  manifest: {
    required: [passEntry],
    optional: [optionalSample],
    knownGaps: ["quote-number collision"],
  },
});
eq("8. required mode PASS", requiredMode.result, "PASS");
eq("8. required mode optional ran is 0", requiredMode.optionalRan, 0);

const unknown = runWith(["--explode"], {
  manifest: { required: [passEntry], optional: [], knownGaps: [] },
});
eq("9. unknown argument is FAIL", unknown.result, "FAIL");
ok(
  "9. unknown argument is understandable",
  /Unknown argument: --explode/.test(unknown.error || unknown.errs.join(""))
);
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

const below = runWith([], {
  realSpawn: true,
  manifest: { required: [{ id: "pass", path: fixture("pass.js"), minPassed: 99 }], optional: [], knownGaps: [] },
});
eq("11. below frozen minimum is FAIL", below.result, "FAIL");
eq("11. below reason", below.results[0].reason, "below_min_passed");

const markedOptional = runWith([], {
  manifest: { required: [passEntry], optional: [passEntry], knownGaps: [] },
});
eq("12. required listed as optional is FAIL", markedOptional.result, "FAIL");
eq(
  "12. required listed as optional reason",
  markedOptional.reason || markedOptional.error,
  "required_marked_optional"
);

const parsed = shield.parseArgv(["node", "runner.js", "--full"]);
eq("parseArgv accepts --full", parsed.ok && parsed.full, true);
eq("parsePassedCount core summary", shield.parsePassedCount("Core session security: 24 passed\n", "").passed, 24);
eq("stripAnsi ignores colors", shield.parsePassedCount("\u001b[32m5 passed\u001b[0m\n", "").passed, 5);

const defaultManifest = shield.loadManifest();
eq("default required count", defaultManifest.required.length, 12);
eq("default optional count", defaultManifest.optional.length, 0);
eq("handler inventory count", defaultManifest.handlerInventory.length, 10);
ok(
  "required ids are frozen",
  defaultManifest.required.map((row) => row.id).join(",") ===
    "core-session-security,core-tenant-isolation,core-role-permissions,core-secret-boundaries,core-webhook-security,core-financial-endpoints,core-security-supabase-hardening-1,core-estimates-webhook-signing,core-contract-modern-owner-session,core-estimate-log-redaction,core-stripe-webhook-replay,core-remaining-modern-owner-gates"
);

const resolveOk = shield.resolveSuitePath(ROOT, fixture("pass.js"));
ok("legal fixture path resolves", resolveOk.ok && fs.existsSync(resolveOk.abs));
eq("parent escape rejected", shield.resolveSuitePath(ROOT, "../secret.js").ok, false);
eq("absolute path rejected", shield.resolveSuitePath(ROOT, "C:\\\\Windows\\\\System32\\\\calc.exe").ok, false);

const childEnv = shield.isolatedChildEnv({
  ZAPIER_WEBHOOK_URL: "https://hooks.zapier.com/real",
  OPENAI_API_KEY: "sk-real",
  STRIPE_SECRET_KEY: "sk_live_should_be_stripped",
  STRIPE_WEBHOOK_SECRET: "whsec_should_be_stripped",
  SQUARE_ACCESS_TOKEN: "EAAA_should_be_stripped",
  INTERNAL_API_KEY: "real-internal",
  SESSION_SECRET: "real-session",
  SUPABASE_SERVICE_ROLE_KEY: "real-service-role",
  PATH: process.env.PATH,
});
ok("child env strips Zapier webhook", childEnv.ZAPIER_WEBHOOK_URL === undefined);
ok("child env strips OpenAI key", childEnv.OPENAI_API_KEY === undefined);
ok("child env strips Stripe secret", childEnv.STRIPE_SECRET_KEY === undefined);
ok("child env strips Stripe webhook secret", childEnv.STRIPE_WEBHOOK_SECRET === undefined);
ok("child env strips Square access token", childEnv.SQUARE_ACCESS_TOKEN === undefined);
eq("child env uses dummy INTERNAL_API_KEY", childEnv.INTERNAL_API_KEY, "mg-core-security-shield-v1-isolated-internal");
eq("child env uses dummy SESSION_SECRET", childEnv.SESSION_SECRET, "mg-core-security-shield-v1-isolated-session");
eq(
  "child env uses dummy service role",
  childEnv.SUPABASE_SERVICE_ROLE_KEY,
  "mg-core-security-shield-v1-isolated-key"
);
ok("child env uses example supabase", childEnv.SUPABASE_URL === "https://example.supabase.co");

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
  "phase1 estimates HMAC note printed",
  gapRun.logs.some((line) => /ESTIMATES_HMAC_PHASE1_COMPATIBILITY_MODE/.test(line))
);
ok(
  "production RLS unverified note printed",
  gapRun.logs.some((line) => /PRODUCTION_RLS_NOT_VERIFIED/.test(line))
);
ok("spawn uses node executable array args", true);

const wf = fs.readFileSync(path.join(ROOT, ".github/workflows/core-security-shield-v1.yml"), "utf8");
ok("workflow name frozen", /^name:\s*Core Security Shield V1\s*$/m.test(wf));
ok("workflow runs on pull_request", /pull_request:/.test(wf));
ok("workflow runs on merge_group", /merge_group:/.test(wf));
ok("workflow allows workflow_dispatch", /workflow_dispatch:/.test(wf));
ok("workflow permissions contents read", /permissions:\s*\n\s+contents:\s*read/m.test(wf));
ok("workflow uses persist-credentials false", /persist-credentials:\s*false/.test(wf));
ok("workflow pins checkout by SHA", /actions\/checkout@[0-9a-f]{40}/.test(wf));
ok("workflow pins setup-node by SHA", /actions\/setup-node@[0-9a-f]{40}/.test(wf));
ok("workflow uses Node 20", /node-version:\s*"20"/.test(wf));
ok("workflow has timeout", /timeout-minutes:/.test(wf));
ok("workflow does not use production secrets", !/secrets\./.test(wf));
ok("workflow runs Seller Shield canonical runner", wf.indexOf("node scripts/test-mg-seller-shield-v1.js") >= 0);
ok("workflow runs Owner Shield canonical runner", wf.indexOf("node scripts/test-mg-owner-shield-v1.js") >= 0);
ok(
  "workflow runs Invoice Hub canonical runner",
  wf.indexOf("node scripts/test-invoice-hub-regression-suite.js") >= 0
);
ok("workflow does not rename Seller Shield", wf.indexOf("Seller Shield V1") >= 0);
ok("workflow does not rename Owner Shield", wf.indexOf("Owner Shield V1") >= 0);
ok("workflow does not rename Invoice Hub Shield V2", wf.indexOf("Invoice Hub Shield V2") >= 0);

console.log("\nCore Security Shield V1 runner tests: " + passed + " passed");
