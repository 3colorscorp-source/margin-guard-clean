#!/usr/bin/env node
/**
 * Owner Shield V2 — runner wiring self-test.
 * Check name stays Owner Shield V1. Workflow file stays origin/main.
 * Does not mutate product, Seller Shield, or Invoice Hub Shield.
 * Run: node scripts/test-owner-shield-v2.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const WORKFLOW = path.join(ROOT, ".github", "workflows", "owner-shield-v1.yml");
const RUNNER = path.join(ROOT, "scripts", "test-mg-owner-shield-v1.js");
const OWNER_WF = ".github/workflows/owner-shield-v1.yml";
const HUB_WF = ".github/workflows/invoice-hub-shield-v2.yml";
const SELLER_WF = ".github/workflows/seller-shield-v1.yml";
const VOICE = path.join(ROOT, "public", "js", "owner-voice-operational-plan.js");

function isFullGitSha(value) {
  return /^[0-9a-f]{40}$/i.test(String(value || "").trim());
}

function git(args, gitImpl) {
  if (typeof gitImpl === "function") return gitImpl(args);
  return spawnSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
  });
}

function readPrBaseShaFromEvent(env, readFileImpl) {
  const eventPath = String((env || process.env).GITHUB_EVENT_PATH || "").trim();
  if (!eventPath) return "";
  try {
    const readFile = readFileImpl || fs.readFileSync;
    const ev = JSON.parse(readFile(eventPath, "utf8"));
    return String((ev && ev.pull_request && ev.pull_request.base && ev.pull_request.base.sha) || "").trim();
  } catch (_err) {
    return "";
  }
}

function refExists(ref, gitImpl) {
  const r = git(["cat-file", "-e", String(ref || "") + "^{commit}"], gitImpl);
  return Boolean(r && r.status === 0);
}

function resolveComparisonBase(options) {
  const opts = options || {};
  const env = opts.env || process.env;
  const gitImpl = opts.gitImpl;
  const eventSha = readPrBaseShaFromEvent(env, opts.readFileImpl);
  if (eventSha) {
    if (!isFullGitSha(eventSha)) {
      return { ok: false, ref: eventSha, reason: "invalid_pr_base_sha" };
    }
    if (!refExists(eventSha, gitImpl)) {
      return { ok: false, ref: eventSha, reason: "missing_pr_base_sha" };
    }
    return { ok: true, ref: eventSha, reason: "pr_base_sha" };
  }
  if (refExists("origin/main", gitImpl)) {
    return { ok: true, ref: "origin/main", reason: "origin_main_fallback" };
  }
  return { ok: false, ref: "", reason: "missing_comparison_base" };
}

function gitDiffEmpty(rel, baseRef, gitImpl) {
  const r = git(["diff", "--exit-code", baseRef, "--", rel], gitImpl);
  return Boolean(r && r.status === 0);
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function assert(label, cond) {
  if (!cond) throw new Error("FAIL " + label);
  console.log("PASS " + label);
}

function runResolverCoverage(pass) {
  const eventSha = "8145cff4c9a0898a0f8a8c6f671cbb010929b6cf";
  const prEvent = JSON.stringify({ pull_request: { base: { sha: eventSha } } });

  const fromEvent = resolveComparisonBase({
    env: { GITHUB_EVENT_PATH: "C:/fake/event.json" },
    readFileImpl: () => prEvent,
    gitImpl: (args) => {
      if (args[0] === "cat-file" && args[2] === eventSha + "^{commit}") return { status: 0 };
      return { status: 1, stdout: "", stderr: "not found" };
    },
  });
  pass(
    "resolver prefers PR base SHA",
    fromEvent.ok === true && fromEvent.ref === eventSha && fromEvent.reason === "pr_base_sha"
  );

  const invalid = resolveComparisonBase({
    env: { GITHUB_EVENT_PATH: "C:/fake/event.json" },
    readFileImpl: () => JSON.stringify({ pull_request: { base: { sha: "origin/main" } } }),
    gitImpl: () => ({ status: 0, stdout: "", stderr: "" }),
  });
  pass("resolver rejects non-hex SHA", invalid.ok === false && invalid.reason === "invalid_pr_base_sha");

  const shortSha = resolveComparisonBase({
    env: { GITHUB_EVENT_PATH: "C:/fake/event.json" },
    readFileImpl: () => JSON.stringify({ pull_request: { base: { sha: "8145cff4c9" } } }),
    gitImpl: () => ({ status: 0, stdout: "", stderr: "" }),
  });
  pass("resolver requires 40-character SHA", shortSha.ok === false && shortSha.reason === "invalid_pr_base_sha");

  const missingSha = resolveComparisonBase({
    env: { GITHUB_EVENT_PATH: "C:/fake/event.json" },
    readFileImpl: () => prEvent,
    gitImpl: () => ({ status: 1, stdout: "", stderr: "missing" }),
  });
  pass(
    "resolver fails when PR SHA is missing locally",
    missingSha.ok === false && missingSha.reason === "missing_pr_base_sha"
  );

  const localFallback = resolveComparisonBase({
    env: {},
    gitImpl: (args) => {
      if (args[0] === "cat-file" && args[2] === "origin/main^{commit}") return { status: 0 };
      return { status: 1, stdout: "", stderr: "" };
    },
  });
  pass(
    "resolver falls back to origin/main locally",
    localFallback.ok === true && localFallback.ref === "origin/main" && localFallback.reason === "origin_main_fallback"
  );

  const noBase = resolveComparisonBase({
    env: {},
    gitImpl: () => ({ status: 1, stdout: "", stderr: "missing origin/main" }),
  });
  pass("resolver errors when no comparison base exists", noBase.ok === false && noBase.reason === "missing_comparison_base");
}

function main() {
  let n = 0;
  const pass = (label, cond) => {
    assert(label, cond);
    n += 1;
  };

  runResolverCoverage(pass);

  const resolved = resolveComparisonBase();
  if (!resolved.ok) {
    throw new Error(
      "FAIL comparison base unavailable (" +
        resolved.reason +
        "). Need pull_request.base.sha from GITHUB_EVENT_PATH or a local origin/main."
    );
  }
  pass("comparison base resolved (" + resolved.reason + ")", Boolean(resolved.ref));

  pass("workflow file exists", fs.existsSync(WORKFLOW));
  pass("Owner Shield workflow is untouched vs comparison base", gitDiffEmpty(OWNER_WF, resolved.ref));
  const yml = fs.readFileSync(WORKFLOW, "utf8");
  pass("workflow name is Owner Shield V1", /^name:\s*Owner Shield V1\s*$/m.test(yml));
  pass("job name is Owner Shield V1", /^\s+name:\s*Owner Shield V1\s*$/m.test(yml));
  pass("runs on pull_request", /pull_request:/.test(yml));
  pass("runs on merge_group", /merge_group:/.test(yml));
  pass("runs on workflow_dispatch", /workflow_dispatch:/.test(yml));
  pass("permissions contents read", /permissions:\s*\r?\n\s+contents:\s*read/.test(yml));
  pass("checkout action pinned SHA", yml.indexOf("actions/checkout@11d5960a326750d5838078e36cf38b85af677262") >= 0);
  pass("setup-node action pinned SHA", yml.indexOf("actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020") >= 0);
  pass("required suite still runs", yml.indexOf("node scripts/test-mg-owner-shield-v1.js") >= 0);
  pass("full suite still runs", yml.indexOf("node scripts/test-mg-owner-shield-v1.js --full") >= 0);
  pass("independent YAML guard step remains", yml.indexOf("node scripts/guard-owner-scope.js") >= 0);
  pass("YAML still skips real guard on merge_group", yml.indexOf("github.event_name != 'merge_group'") >= 0);
  pass("does not set ALLOW_OWNER_TOUCH in workflow", !/ALLOW_OWNER_TOUCH:\s*["']?1/.test(yml));
  pass("does not use pull_request_target", yml.indexOf("pull_request_target") < 0);
  pass("does not run Seller guard", yml.indexOf("guard-seller-scope.js") < 0);
  pass("does not run Invoice Hub guard", yml.indexOf("guard-invoice-hub-scope.js") < 0);
  pass("does not run Seller shield runner", yml.indexOf("test-mg-seller-shield-v1.js") < 0);
  pass("does not run Invoice Hub regression suite", yml.indexOf("test-invoice-hub-regression-suite.js") < 0);

  const runnerSrc = fs.readFileSync(RUNNER, "utf8");
  pass("runner executes guard-owner-scope.js", runnerSrc.indexOf("scripts/guard-owner-scope.js") >= 0);
  pass("runner reads GITHUB_EVENT_PATH", runnerSrc.indexOf("GITHUB_EVENT_PATH") >= 0);
  pass("runner reads pull_request.base.sha", /base\.sha/.test(runnerSrc));
  pass("runner reads pull_request.title", /pr\.title/.test(runnerSrc));
  pass("runner reads pull_request.head.ref", /head\.ref/.test(runnerSrc));
  pass("runner skips real guard on merge_group", /GITHUB_EVENT_NAME[\s\S]{0,80}merge_group/.test(runnerSrc));
  pass("runner fetches missing SHA with --no-tags --depth=1", runnerSrc.indexOf('["fetch", "--no-tags", "--depth=1", "origin"') >= 0);
  pass("runner passes BASE_REF via env", /env\.BASE_REF\s*=\s*ctx\.baseSha/.test(runnerSrc));
  pass("runner passes PR_TITLE via env", /env\.PR_TITLE\s*=\s*ctx\.title/.test(runnerSrc));
  pass("runner passes GITHUB_HEAD_REF via env", /env\.GITHUB_HEAD_REF\s*=\s*ctx\.head/.test(runnerSrc));
  pass("runner guard spawn uses shell false", /shell:\s*false/.test(runnerSrc));
  pass("runner never assigns ALLOW_OWNER_TOUCH=1", !/ALLOW_OWNER_TOUCH\s*=\s*["']?1["']?/.test(runnerSrc));
  pass("runner strips ALLOW_OWNER_TOUCH", /delete env\.ALLOW_OWNER_TOUCH/.test(runnerSrc));
  pass("guard failure is nonzero_exit of runner", /reason:\s*"nonzero_exit"/.test(runnerSrc) && /RESULT: FAIL/.test(runnerSrc));

  pass("Seller Shield workflow exists", read(SELLER_WF).length > 0);
  pass("Invoice Hub Shield workflow exists", read(HUB_WF).length > 0);
  pass("Seller Shield workflow is untouched vs comparison base", gitDiffEmpty(SELLER_WF, resolved.ref));
  pass("Invoice Hub Shield workflow is untouched vs comparison base", gitDiffEmpty(HUB_WF, resolved.ref));

  const voiceSrc = fs.readFileSync(VOICE, "utf8");
  pass(
    "current_document uses EMPTY_DOCUMENT preview seed",
    /current_document:\s*EMPTY_DOCUMENT/.test(voiceSrc)
  );
  pass(
    "EMPTY_DOCUMENT is the empty keyboard seed",
    /EMPTY_DOCUMENT\s*=\s*\{\s*schema_version:\s*1,\s*source:\s*"keyboard",\s*days:\s*\[\]\s*\}/.test(voiceSrc)
  );
  pass(
    "voice source does not claim server persist of current_document",
    !/persist.*current_document|hydrate.*current_document/i.test(voiceSrc)
  );

  const { evaluateGuard } = require("./guard-owner-scope.js");
  const sim1 = evaluateGuard({
    files: ["public/owner.html"],
    branch: "feat/support-layout",
    prTitle: "Support layout",
  });
  pass("1. non-Owner branch + Owner file fails", sim1.ok === false);

  const sim2 = evaluateGuard({
    files: ["public/owner.html"],
    branch: "feat/owner-shield-v2",
    prTitle: "Shield",
  });
  pass("2. Owner-authorized branch + Owner file passes", sim2.ok === true);
  pass("3. Owner-authorized branch requires Owner regression", sim2.regressionRequired === true);

  const sim4 = evaluateGuard({
    files: ["public/owner.html"],
    branch: "feat/misc",
    prTitle: "[Owner] protected surface",
  });
  pass("4. PR title [Owner] + Owner file passes", sim4.ok === true);
  pass("5. PR title [Owner] requires Owner regression", sim4.regressionRequired === true);

  pass(
    "6. Seller/Invoice Hub files only from non-Owner branch pass",
    evaluateGuard({
      files: [
        "public/sales.html",
        "public/estimates-invoices.html",
        "netlify/functions/list-tenant-invoices.js",
      ],
      branch: "feat/support-layout",
    }).ok === true
  );

  pass(
    "Seller branch cannot authorize an Owner file",
    evaluateGuard({
      files: ["public/owner.html"],
      branch: "feat/seller-shield-v2",
      prTitle: "[Seller] shield v2",
    }).ok === false
  );

  const appJsOwner = evaluateGuard({
    files: ["public/js/app.js"],
    diffsByFile: {
      "public/js/app.js":
        "diff --git a/public/js/app.js b/public/js/app.js\n--- a/public/js/app.js\n+++ b/public/js/app.js\n@@ -1 +1 @@\n-function loadOwner() { return {}; }\n+function loadOwner() { return null; }\n",
    },
    branch: "feat/support-layout",
  });
  pass("app.js Owner region fails without Owner scope", appJsOwner.ok === false);

  const appJsPlain = evaluateGuard({
    files: ["public/js/app.js"],
    diffsByFile: {
      "public/js/app.js":
        "diff --git a/public/js/app.js b/public/js/app.js\n--- a/public/js/app.js\n+++ b/public/js/app.js\n@@ -1 +1 @@\n-const greeting = 'hi';\n+const greeting = 'hello';\n",
    },
    branch: "feat/support-layout",
  });
  pass("app.js non-Owner lines pass", appJsPlain.ok === true && appJsPlain.ownerTouched === false);

  const emptyApp = evaluateGuard({
    files: ["public/js/app.js"],
    diffsByFile: { "public/js/app.js": "" },
    branch: "feat/support-layout",
  });
  pass("empty shared app.js diff fails safe", emptyApp.ok === false);

  pass(
    "non-Owner workflow edit fails",
    evaluateGuard({
      files: [".github/workflows/owner-shield-v1.yml"],
      branch: "feat/support-layout",
    }).ok === false
  );

  console.log("\n" + n + " passed");
}

module.exports = {
  isFullGitSha,
  readPrBaseShaFromEvent,
  resolveComparisonBase,
  gitDiffEmpty,
};

if (require.main === module) {
  main();
}
