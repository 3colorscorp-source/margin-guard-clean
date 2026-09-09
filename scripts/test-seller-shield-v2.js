#!/usr/bin/env node
/**
 * Seller Shield V2 — runner wiring self-test.
 * Check name stays Seller Shield V1. Workflow file stays origin/main.
 * Does not mutate product or other shields.
 * Run: node scripts/test-seller-shield-v2.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const WORKFLOW = path.join(ROOT, ".github", "workflows", "seller-shield-v1.yml");
const RUNNER = path.join(ROOT, "scripts", "test-mg-seller-shield-v1.js");
const OWNER_WF = ".github/workflows/owner-shield-v1.yml";
const HUB_WF = ".github/workflows/invoice-hub-shield-v2.yml";
const SELLER_WF = ".github/workflows/seller-shield-v1.yml";

function gitDiffEmpty(rel) {
  const r = spawnSync("git", ["diff", "--exit-code", "origin/main", "--", rel], {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
  });
  return r.status === 0;
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
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
  pass("Seller Shield workflow is untouched vs origin/main", gitDiffEmpty(SELLER_WF));
  const yml = fs.readFileSync(WORKFLOW, "utf8");
  pass("workflow name is Seller Shield V1", /^name:\s*Seller Shield V1\s*$/m.test(yml));
  pass("job name is Seller Shield V1", /^\s+name:\s*Seller Shield V1\s*$/m.test(yml));
  pass("runs on pull_request", /pull_request:/.test(yml));
  pass("runs on merge_group", /merge_group:/.test(yml));
  pass("runs on workflow_dispatch", /workflow_dispatch:/.test(yml));
  pass("permissions contents read", /permissions:\s*\r?\n\s+contents:\s*read/.test(yml));
  pass("checkout action pinned SHA", yml.indexOf("actions/checkout@11d5960a326750d5838078e36cf38b85af677262") >= 0);
  pass("setup-node action pinned SHA", yml.indexOf("actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020") >= 0);
  pass("required suite still runs", yml.indexOf("node scripts/test-mg-seller-shield-v1.js") >= 0);
  pass("full suite still runs", yml.indexOf("node scripts/test-mg-seller-shield-v1.js --full") >= 0);
  pass("does not set ALLOW_SELLER_TOUCH in workflow", !/ALLOW_SELLER_TOUCH:\s*["']?1/.test(yml));
  pass("does not use pull_request_target", yml.indexOf("pull_request_target") < 0);
  pass("does not run Owner guard", yml.indexOf("guard-owner-scope.js") < 0);
  pass("does not run Invoice Hub guard", yml.indexOf("guard-invoice-hub-scope.js") < 0);
  pass("does not run Owner shield runner", yml.indexOf("test-mg-owner-shield-v1.js") < 0);
  pass("does not run Invoice Hub regression suite", yml.indexOf("test-invoice-hub-regression-suite.js") < 0);
  pass("workflow does not add a separate real-guard step", yml.indexOf("set -euo pipefail") < 0);

  const runnerSrc = fs.readFileSync(RUNNER, "utf8");
  pass("runner executes guard-seller-scope.js", runnerSrc.indexOf("scripts/guard-seller-scope.js") >= 0);
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
  pass("runner never assigns ALLOW_SELLER_TOUCH=1", !/ALLOW_SELLER_TOUCH\s*=\s*["']?1["']?/.test(runnerSrc));
  pass("runner strips ALLOW_SELLER_TOUCH", /delete env\.ALLOW_SELLER_TOUCH/.test(runnerSrc));
  pass("guard failure is nonzero_exit of runner", /reason:\s*"nonzero_exit"/.test(runnerSrc) && /RESULT: FAIL/.test(runnerSrc));

  pass("Owner Shield workflow exists", read(OWNER_WF).length > 0);
  pass("Invoice Hub Shield workflow exists", read(HUB_WF).length > 0);
  pass("Owner Shield workflow is untouched vs origin/main", gitDiffEmpty(OWNER_WF));
  pass("Invoice Hub Shield workflow is untouched vs origin/main", gitDiffEmpty(HUB_WF));

  const { evaluateGuard } = require("./guard-seller-scope.js");
  pass(
    "non-Seller + sales.html fails",
    evaluateGuard({
      files: ["public/sales.html"],
      branch: "feat/owner-voice",
      prTitle: "[Owner] voice",
    }).ok === false
  );
  pass(
    "non-Seller + get-seller-business-settings fails",
    evaluateGuard({
      files: ["netlify/functions/get-seller-business-settings.js"],
      branch: "fix/business-settings-modern-owner-session",
      prTitle: "Business Settings",
    }).ok === false
  );
  pass(
    "Invoice Hub files pass Seller guard",
    evaluateGuard({
      files: ["public/estimates-invoices.html", "netlify/functions/list-tenant-invoices.js"],
      branch: "feat/invoice-hub-shield-v2",
      prTitle: "[Invoice Hub] shield",
    }).ok === true
  );
  const sellerOk = evaluateGuard({
    files: ["public/sales.html"],
    branch: "feat/seller-shield-v2",
    prTitle: "[Seller] shield v2",
  });
  pass("Seller branch + Seller file passes", sellerOk.ok === true);
  pass("Seller branch requires regression", sellerOk.regressionRequired === true);
  pass(
    "non-Seller workflow edit fails",
    evaluateGuard({
      files: [".github/workflows/seller-shield-v1.yml"],
      branch: "feat/support-layout",
    }).ok === false
  );

  console.log("\n" + n + " passed");
}

main();
