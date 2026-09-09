#!/usr/bin/env node
/**
 * Invoice Hub Shield V2 — workflow wiring self-test.
 * Does not mutate production, SQL, Zapier, or Invoice Hub product files.
 * Run: node scripts/test-invoice-hub-shield-v2.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const WORKFLOW = path.join(ROOT, ".github", "workflows", "invoice-hub-shield-v2.yml");
const OWNER_WF = ".github/workflows/owner-shield-v1.yml";
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
  const yml = fs.readFileSync(WORKFLOW, "utf8");
  pass("workflow name is Invoice Hub Shield V2", /^name:\s*Invoice Hub Shield V2\s*$/m.test(yml));
  pass("job name is Invoice Hub Shield V2", /^\s+name:\s*Invoice Hub Shield V2\s*$/m.test(yml));
  pass("runs on pull_request to main", /pull_request:/.test(yml) && /branches:/.test(yml));
  pass("guard command is exact", yml.indexOf("node scripts/guard-invoice-hub-scope.js") >= 0);
  pass("regression command is exact", yml.indexOf("node scripts/test-invoice-hub-regression-suite.js") >= 0);
  pass("guard uses pipefail so a failed guard fails the job", yml.indexOf("set -euo pipefail") >= 0);
  pass("regression is gated on INVOICE_HUB_REGRESSION_REQUIRED", yml.indexOf("INVOICE_HUB_REGRESSION_REQUIRED=1") >= 0);
  pass("does not set ALLOW_INVOICE_HUB_TOUCH in env", !/ALLOW_INVOICE_HUB_TOUCH:\s*["']?1/.test(yml));
  pass("does not edit Owner Shield workflow path in this file", yml.indexOf("owner-shield-v1.yml") < 0);
  pass("does not edit Seller Shield workflow path in this file", yml.indexOf("seller-shield-v1.yml") < 0);
  pass("does not run Owner guard", yml.indexOf("guard-owner-scope.js") < 0);
  pass("does not run Seller guard", yml.indexOf("guard-seller-scope.js") < 0);

  const ownerNow = read(OWNER_WF);
  const sellerNow = read(SELLER_WF);
  pass("Owner Shield workflow file exists", ownerNow.length > 0);
  pass("Seller Shield workflow file exists", sellerNow.length > 0);
  pass("Owner Shield workflow is untouched vs origin/main", gitDiffEmpty(OWNER_WF));
  pass("Seller Shield workflow is untouched vs origin/main", gitDiffEmpty(SELLER_WF));

  const { evaluateGuard } = require("./guard-invoice-hub-scope.js");
  pass(
    "non-Hub branch + protected file fails",
    evaluateGuard({
      files: ["public/estimates-invoices.html"],
      branch: "feat/seller-layout",
      prTitle: "Seller layout",
    }).ok === false
  );

  const scoped = evaluateGuard({
    files: ["public/estimates-invoices.html"],
    branch: "feat/invoice-hub-shield-v2",
    prTitle: "[Invoice Hub] Shield V2",
  });
  pass("Invoice-Hub branch + protected file passes", scoped.ok === true);
  pass("Invoice-Hub branch requires regression suite", scoped.regressionRequired === true);

  const titled = evaluateGuard({
    files: ["netlify/functions/list-tenant-invoices.js"],
    branch: "feat/misc",
    prTitle: "[Invoice Hub] list invoices",
  });
  pass("PR title [Invoice Hub] + protected file passes", titled.ok === true);
  pass("PR title [Invoice Hub] requires regression suite", titled.regressionRequired === true);

  pass(
    "non-Hub files only pass",
    evaluateGuard({
      files: ["public/owner.html", "public/sales.html"],
      branch: "feat/seller-layout",
    }).ok === true
  );

  console.log("\n" + n + " passed");
}

main();
