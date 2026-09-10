#!/usr/bin/env node
/**
 * Core Security Shield V2 — workflow wiring self-test.
 * Check name stays Core Security Shield V1. Does not mutate product,
 * Seller Shield, Owner Shield, or Invoice Hub Shield files.
 * Run: node scripts/test-core-security-shield-v2.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const WORKFLOW = path.join(ROOT, ".github", "workflows", "core-security-shield-v1.yml");
const CORE_WF = ".github/workflows/core-security-shield-v1.yml";
const OWNER_WF = ".github/workflows/owner-shield-v1.yml";
const SELLER_WF = ".github/workflows/seller-shield-v1.yml";
const HUB_WF = ".github/workflows/invoice-hub-shield-v2.yml";
const GUARD = path.join(ROOT, "scripts", "guard-core-security-scope.js");

function git(args) {
  return spawnSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
  });
}

function gitDiffEmpty(rel) {
  const r = git(["diff", "--exit-code", "origin/main", "--", rel]);
  return r.status === 0;
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function extractStep(yml, name) {
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp("- name: " + escaped + "[ \\t]*(?:\\r?\\n)");
  const match = re.exec(String(yml || ""));
  if (!match) return "";
  const start = match.index;
  const rest = yml.slice(start + match[0].length);
  const next = rest.search(/\n      - name: /);
  return next < 0 ? yml.slice(start) : yml.slice(start, start + match[0].length + next);
}

function stepHasIf(step) {
  return /^\s+if:/m.test(String(step || ""));
}

function assert(label, cond) {
  if (!cond) throw new Error("FAIL " + label);
  console.log("PASS " + label);
}

function main() {
  let n = 0;
  const pass = (label, cond) => {
    assert(label, cond);
    n += 1;
  };

  pass("workflow file exists", fs.existsSync(WORKFLOW));
  pass("guard file exists", fs.existsSync(GUARD));
  const yml = fs.readFileSync(WORKFLOW, "utf8");
  const guardSrc = fs.readFileSync(GUARD, "utf8");
  const manifest = JSON.parse(read("scripts/mg-core-security-shield-v1.json"));

  pass("workflow name is Core Security Shield V1", /^name:\s*Core Security Shield V1\s*$/m.test(yml));
  pass("job name is Core Security Shield V1", /^\s+name:\s*Core Security Shield V1\s*$/m.test(yml));
  pass("runs on pull_request to main", /pull_request:/.test(yml) && /branches:/.test(yml));
  pass("runs on merge_group", /merge_group:/.test(yml));
  pass("runs on workflow_dispatch", /workflow_dispatch:/.test(yml));
  pass("permissions contents read", /permissions:\s*\r?\n\s+contents:\s*read/.test(yml));
  pass("checkout action pinned SHA", yml.indexOf("actions/checkout@11d5960a326750d5838078e36cf38b85af677262") >= 0);
  pass("setup-node action pinned SHA", yml.indexOf("actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020") >= 0);
  pass("persist-credentials false", /persist-credentials:\s*false/.test(yml));
  pass("Node 20", /node-version:\s*"20"/.test(yml));
  pass("timeout is set", /timeout-minutes:/.test(yml));
  pass("does not use production secrets", !/secrets\./.test(yml));
  pass("does not use pull_request_target", yml.indexOf("pull_request_target") < 0);

  pass("guard self-test command is exact", yml.indexOf("node scripts/guard-core-security-scope.js --self-test") >= 0);
  pass("V2 wiring test command is exact", yml.indexOf("node scripts/test-core-security-shield-v2.js") >= 0);
  pass("real guard command is present", /node scripts\/guard-core-security-scope\.js/.test(yml));
  pass("guard uses pipefail so a failed guard fails the job", yml.indexOf("set -euo pipefail") >= 0);
  pass("PR_TITLE comes from github.event.pull_request.title", yml.indexOf("PR_TITLE: ${{ github.event.pull_request.title }}") >= 0);
  pass("GITHUB_HEAD_REF comes from github.head_ref", yml.indexOf("GITHUB_HEAD_REF: ${{ github.head_ref }}") >= 0);
  pass("BASE_REF comes from pull_request.base.sha", yml.indexOf("BASE_REF: ${{ github.event.pull_request.base.sha }}") >= 0);
  pass("BASE_REF is not defaulted to origin/main in YAML", yml.indexOf("origin/main") < 0);

  const guardStep = extractStep(yml, "Core Security scope guard");
  pass("real guard step exists", /id:\s*guard/.test(guardStep));
  pass(
    "real guard uses if: github.event_name == 'pull_request'",
    /if:\s*github\.event_name == 'pull_request'/.test(guardStep)
  );
  pass(
    "real guard does not use if: github.event_name != 'merge_group'",
    !/if:\s*github\.event_name != 'merge_group'/.test(guardStep)
  );
  pass(
    "workflow has no != 'merge_group' guard condition",
    yml.indexOf("github.event_name != 'merge_group'") < 0
  );
  pass("real guard skip is documented for merge_group and workflow_dispatch", /merge_group and\s+# workflow_dispatch/.test(yml) || /merge_group and workflow_dispatch/.test(yml));
  pass("title/branch authorization is pull_request-only", /must not treat missing title\/branch as authorization/.test(yml));
  pass("does not set ALLOW_CORE_SECURITY_TOUCH in env", !/ALLOW_CORE_SECURITY_TOUCH:\s*["']?1/.test(yml));
  pass("does not mention ALLOW_CORE_SECURITY_TOUCH as enabled", !/ALLOW_CORE_SECURITY_TOUCH=1/.test(yml));
  pass("captures CORE_SECURITY_REGRESSION_REQUIRED", yml.indexOf("CORE_SECURITY_REGRESSION_REQUIRED=1") >= 0);
  pass(
    "duplicate Core V1 complete step is gone",
    yml.indexOf("Core Security V1 complete (authorized protected change)") < 0
  );
  pass("does not re-run V1 from regression_required output", yml.indexOf("steps.guard.outputs.regression_required") < 0);

  const runnerSelfTest = extractStep(yml, "Core Security Shield V1 runner self-test");
  const requiredStep = extractStep(yml, "Core Security Shield V1 required");
  const fullStep = extractStep(yml, "Core Security Shield V1 full");
  const sellerRunner = extractStep(yml, "Seller Shield V1 canonical runner");
  const ownerRunner = extractStep(yml, "Owner Shield V1 canonical runner");
  const hubRunner = extractStep(yml, "Invoice Hub Shield V2 canonical regression");
  pass("runner self-test has no event if", runnerSelfTest.length > 0 && !stepHasIf(runnerSelfTest));
  pass("required V1 suite has no event if", requiredStep.length > 0 && !stepHasIf(requiredStep));
  pass("full V1 suite has no event if", fullStep.length > 0 && !stepHasIf(fullStep));
  pass("Seller canonical runner has no event if", sellerRunner.length > 0 && !stepHasIf(sellerRunner));
  pass("Owner canonical runner has no event if", ownerRunner.length > 0 && !stepHasIf(ownerRunner));
  pass("Invoice Hub canonical runner has no event if", hubRunner.length > 0 && !stepHasIf(hubRunner));
  pass("required V1 command still always runs", /node scripts\/test-mg-core-security-shield-v1\.js\s*$/m.test(requiredStep));
  pass("full V1 command still always runs", yml.indexOf("node scripts/test-mg-core-security-shield-v1.js --full") >= 0);
  pass(
    "workflow_dispatch can skip real guard without skipping suites",
    /workflow_dispatch:/.test(yml) &&
      /if:\s*github\.event_name == 'pull_request'/.test(guardStep) &&
      !stepHasIf(runnerSelfTest) &&
      !stepHasIf(requiredStep) &&
      !stepHasIf(fullStep) &&
      !stepHasIf(sellerRunner) &&
      !stepHasIf(ownerRunner) &&
      !stepHasIf(hubRunner)
  );
  pass(
    "merge_group omits the real guard",
    /if:\s*github\.event_name == 'pull_request'/.test(guardStep)
  );
  pass(
    "pull_request runs the guard with PR_TITLE, GITHUB_HEAD_REF, and BASE_REF",
    /if:\s*github\.event_name == 'pull_request'/.test(guardStep) &&
      guardStep.indexOf("PR_TITLE: ${{ github.event.pull_request.title }}") >= 0 &&
      guardStep.indexOf("GITHUB_HEAD_REF: ${{ github.head_ref }}") >= 0 &&
      guardStep.indexOf("BASE_REF: ${{ github.event.pull_request.base.sha }}") >= 0
  );

  const selfTestIdx = yml.indexOf("node scripts/guard-core-security-scope.js --self-test");
  const wiringIdx = yml.indexOf("node scripts/test-core-security-shield-v2.js");
  const realGuardIdx = yml.indexOf("id: guard");
  const requiredIdx = yml.indexOf("- name: Core Security Shield V1 required");
  pass("self-test appears before wiring test", selfTestIdx >= 0 && selfTestIdx < wiringIdx);
  pass("real guard appears before required V1 suite", realGuardIdx >= 0 && requiredIdx > realGuardIdx);

  pass("Seller Shield V1 name remains in workflow", yml.indexOf("Seller Shield V1") >= 0);
  pass("Owner Shield V1 name remains in workflow", yml.indexOf("Owner Shield V1") >= 0);
  pass("Invoice Hub Shield V2 name remains in workflow", yml.indexOf("Invoice Hub Shield V2") >= 0);
  pass("canonical Seller runner still runs", yml.indexOf("node scripts/test-mg-seller-shield-v1.js") >= 0);
  pass("canonical Owner runner still runs", yml.indexOf("node scripts/test-mg-owner-shield-v1.js") >= 0);
  pass("canonical Invoice Hub runner still runs", yml.indexOf("node scripts/test-invoice-hub-regression-suite.js") >= 0);

  const sellerYml = read(SELLER_WF);
  const ownerYml = read(OWNER_WF);
  const hubYml = read(HUB_WF);
  pass("Seller Shield V1 name frozen", /^name:\s*Seller Shield V1\s*$/m.test(sellerYml));
  pass("Owner Shield V1 name frozen", /^name:\s*Owner Shield V1\s*$/m.test(ownerYml));
  pass("Invoice Hub Shield V2 name frozen", /^name:\s*Invoice Hub Shield V2\s*$/m.test(hubYml));
  pass("Seller Shield workflow is untouched vs origin/main", gitDiffEmpty(SELLER_WF));
  pass("Owner Shield workflow is untouched vs origin/main", gitDiffEmpty(OWNER_WF));
  pass("Invoice Hub Shield workflow is untouched vs origin/main", gitDiffEmpty(HUB_WF));

  pass("guard spawnSync uses array git args", /spawnSync\("git", args/.test(guardSrc));
  pass("guard never uses shell true", !/shell:\s*true/.test(guardSrc));
  pass("guard uses shell false", /shell:\s*false/.test(guardSrc));
  pass("guard does not interpolate PR_TITLE into git args", !/git\(\[[^\]]*PR_TITLE/.test(guardSrc));
  pass("guard has no ALLOW_CORE_SECURITY_TOUCH bypass", !/ALLOW_CORE_SECURITY_TOUCH[\s\S]{0,80}return true/.test(guardSrc));

  pass("manifest requires title AND branch", manifest.explicitScope.requireTitleAndBranch === true);
  pass("manifest has no allowEnv bypass", manifest.explicitScope.allowEnv == null);
  pass("manifest title token is [Core Security]", manifest.explicitScope.prTitleToken === "[Core Security]");
  pass(
    "manifest branch prefixes are frozen",
    JSON.stringify(manifest.explicitScope.branchPrefixes) ===
      JSON.stringify(["feat/core-security-", "fix/core-security-", "security/core-"])
  );
  pass("required suite count stays 15", manifest.required.length === 15);
  pass("optional stays empty", Array.isArray(manifest.optional) && manifest.optional.length === 0);
  pass("handler inventory stays 10", manifest.handlerInventory.length === 10);

  const exact = manifest.exact || [];
  [
    ".github/workflows/core-security-shield-v1.yml",
    "scripts/mg-core-security-shield-v1.json",
    "scripts/test-mg-core-security-shield-v1.js",
    "scripts/test-mg-core-security-shield-v1-runner.js",
    "scripts/test-core-session-security.js",
    "scripts/test-core-tenant-isolation.js",
    "scripts/test-core-role-permissions.js",
    "scripts/test-core-secret-boundaries.js",
    "scripts/test-core-webhook-security.js",
    "scripts/test-core-financial-endpoints.js",
    "scripts/guard-core-security-scope.js",
    "scripts/test-core-security-shield-v2.js",
    "scripts/test-core-security-supabase-hardening-1.js",
    "scripts/test-core-estimates-webhook-signing.js",
    "scripts/test-core-contract-modern-owner-session.js",
    "scripts/test-core-estimate-log-redaction.js",
    "scripts/test-core-stripe-webhook-replay.js",
    "scripts/test-core-remaining-modern-owner-gates.js",
    "scripts/test-core-global-security-headers.js",
    "scripts/test-core-estimates-hmac-verifier.js",
    "scripts/test-core-estimates-server-hmac-verifier.js",
    "netlify/functions/_lib/zapier-hmac-v1.js",
    "netlify/functions/verify-estimates-zapier-hmac.js",
    "netlify/functions/_lib/ops-log.js",
    "netlify/functions/_lib/require-owner-or-admin.js",
    "docs/CORE_SECURITY_AUDIT.md",
    "docs/CORE_SECURITY_PROTECTED_SURFACE.md",
    "docs/CORE_SECURITY_ESTIMATES_ZAPIER_HMAC_VERIFIER.js",
    "SUPABASE_MG_CORE_SECURITY_HARDENING_1.sql",
    "SUPABASE_MG_CORE_SECURITY_HARDENING_1_ROLLBACK.sql",
    "SUPABASE_MG_CORE_SECURITY_HARDENING_1_VERIFY.sql",
  ].forEach((rel) => {
    pass("exact protects " + rel, exact.indexOf(rel) >= 0);
  });
  pass("exact count is 31", exact.length === 31);
  pass(
    "globs are frozen",
    JSON.stringify(manifest.globs) ===
      JSON.stringify([
        "scripts/fixtures/mg-core-security-shield/*",
        "scripts/test-core-security-*",
        "docs/CORE_SECURITY_*",
      ])
  );

  const sharedFiles = Object.keys(manifest.sharedScan || {});
  pass("sharedScan has 14 files", sharedFiles.length === 14);
  pass("sharedScan includes session.js", sharedFiles.indexOf("netlify/functions/_lib/session.js") >= 0);
  pass("sharedScan includes netlify.toml", sharedFiles.indexOf("netlify.toml") >= 0);
  pass("sharedScan includes square HMAC helper", sharedFiles.indexOf("netlify/functions/_lib/square-webhook-signature.js") >= 0);
  pass("sharedScan includes send-quote-zapier", sharedFiles.indexOf("netlify/functions/send-quote-zapier.js") >= 0);
  pass("sharedScan includes resend-tenant-quote", sharedFiles.indexOf("netlify/functions/resend-tenant-quote.js") >= 0);

  const {
    evaluateGuard,
    isAuthorizedCoreSecurity,
    isSafeGitSha,
    resolveBaseRef,
  } = require("./guard-core-security-scope.js");

  const coreFile = "scripts/test-core-session-security.js";
  pass(
    "wiring: no Core title + exact file fails",
    evaluateGuard({
      files: [coreFile],
      branch: "feat/core-security-shield-v2",
      prTitle: "Add tests",
    }).ok === false
  );
  pass(
    "wiring: title without Core branch fails",
    evaluateGuard({
      files: [coreFile],
      branch: "feat/seller-layout",
      prTitle: "[Core Security] harden",
    }).ok === false
  );
  pass(
    "wiring: Core branch without title fails",
    evaluateGuard({
      files: [coreFile],
      branch: "feat/core-security-shield-v2",
      prTitle: "Shield work",
    }).ok === false
  );
  const both = evaluateGuard({
    files: [coreFile],
    branch: "feat/core-security-shield-v2",
    prTitle: "[Core Security] Add Core Security Protected Surface V2",
  });
  pass("wiring: title and branch together pass", both.ok === true);
  pass("wiring: authorized change requires Core V1 regression", both.regressionRequired === true);
  pass(
    "wiring: unrelated change passes",
    evaluateGuard({ files: ["README.md"], branch: "feat/docs", prTitle: "Docs" }).ok === true
  );
  pass(
    "wiring: Seller-only change is Core scope PASS",
    evaluateGuard({
      files: ["public/sales.html"],
      branch: "feat/seller-hours-publish-parity",
      prTitle: "[Seller] hours",
    }).ok === true
  );
  pass(
    "wiring: Owner-only change is Core scope PASS",
    evaluateGuard({
      files: ["public/owner.html"],
      branch: "feat/owner-shield-v2",
      prTitle: "[Owner] voice",
    }).ok === true
  );
  pass(
    "wiring: Invoice Hub-only change is Core scope PASS",
    evaluateGuard({
      files: ["public/estimates-invoices.html"],
      branch: "feat/invoice-hub-shield-v2",
      prTitle: "[Invoice Hub] list",
    }).ok === true
  );
  pass(
    "wiring: bypass env has no effect",
    evaluateGuard({
      files: [coreFile],
      branch: "feat/misc",
      prTitle: "misc",
      env: { ALLOW_CORE_SECURITY_TOUCH: "1" },
    }).ok === false
  );
  pass(
    "wiring: generic security substring does not authorize",
    isAuthorizedCoreSecurity({
      branch: "feat/security-hardening",
      prTitle: "[Core Security] harden",
    }) === false
  );
  pass("wiring: unsafe sha is rejected", isSafeGitSha(";calc.exe") === false);
  pass(
    "wiring: missing BASE_REF fails closed",
    resolveBaseRef({}).ok === false && resolveBaseRef({}).reason === "unresolved_base_ref"
  );
  pass("wiring: Core workflow path is this shield", CORE_WF === ".github/workflows/core-security-shield-v1.yml");

  console.log("\n" + n + " passed");
}

main();
