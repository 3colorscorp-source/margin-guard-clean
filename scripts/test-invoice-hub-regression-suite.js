#!/usr/bin/env node
/**
 * Invoice Hub regression suite — run known Hub tests. No production mutation.
 * Run: node scripts/test-invoice-hub-regression-suite.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const MANIFEST = JSON.parse(
  fs.readFileSync(path.join(__dirname, "invoice-hub-protected-surface.json"), "utf8")
);

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

function runOne(rel, required) {
  if (!exists(rel)) {
    if (required) {
      console.error("FAIL missing required test: " + rel);
      return { ok: false, required: true, missing: true, rel };
    }
    console.log("SKIP optional test not present: " + rel);
    return { ok: true, required: false, missing: true, rel };
  }
  console.log("\n=== " + rel + " ===");
  const r = spawnSync(process.execPath, [path.join(ROOT, rel)], {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0) {
    console.error("FAIL " + rel + " exit " + r.status);
    return { ok: false, required, missing: false, rel, status: r.status };
  }
  console.log("OK " + rel);
  return { ok: true, required, missing: false, rel, status: 0 };
}

function main() {
  const required = MANIFEST.requiredRegressionTests || [];
  const optional = MANIFEST.optionalRegressionTests || [];
  const results = [];
  required.forEach((rel) => results.push(runOne(rel, true)));
  optional.forEach((rel) => results.push(runOne(rel, false)));

  const failed = results.filter((r) => !r.ok);
  const skipped = results.filter((r) => r.missing && !r.required);
  console.log("\n--- Invoice Hub regression summary ---");
  console.log("ran " + results.filter((r) => !r.missing).length);
  console.log("skipped optional missing " + skipped.length);
  console.log("failed " + failed.length);
  if (failed.length) {
    process.exit(1);
  }
}

main();
