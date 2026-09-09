#!/usr/bin/env node
/**
 * Invoice Hub Shield V1 — fail if Hub files/regions change outside Invoice Hub scope.
 * Compare against origin/main by default. Override with BASE_REF.
 * Isolated: git metadata + local diffs only. No SQL, email, Zapier, or production mutation.
 * Run: node scripts/guard-invoice-hub-scope.js
 * Self-test: node scripts/guard-invoice-hub-scope.js --self-test
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const MANIFEST_PATH = path.join(__dirname, "invoice-hub-protected-surface.json");
const FAIL_MESSAGE =
  "Invoice Hub protected surface changed outside Invoice Hub scope. Stop and move this to an Invoice Hub PR.";

function loadManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

function normPath(p) {
  return String(p || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
}

function globToRegExp(glob) {
  const g = normPath(glob);
  let re = "";
  for (let i = 0; i < g.length; i += 1) {
    const ch = g[i];
    if (ch === "*") {
      re += "[^/]*";
    } else if (".+^${}()|[]\\".indexOf(ch) >= 0) {
      re += "\\" + ch;
    } else {
      re += ch;
    }
  }
  return new RegExp("^" + re + "$");
}

function matchesGlob(file, glob) {
  return globToRegExp(glob).test(normPath(file));
}

function isExactProtected(file, manifest) {
  const n = normPath(file);
  return (manifest.exact || []).some((p) => normPath(p) === n);
}

function isGlobProtected(file, manifest) {
  return (manifest.globs || []).some((g) => matchesGlob(file, g));
}

function isSharedScanFile(file, manifest) {
  const n = normPath(file);
  return Boolean(manifest.sharedScan && manifest.sharedScan[n]);
}

function git(args) {
  return spawnSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
  });
}

function currentBranch() {
  if (process.env.GITHUB_HEAD_REF) return String(process.env.GITHUB_HEAD_REF).trim();
  const r = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  return String(r.stdout || "").trim();
}

function readPrTitle() {
  const direct = String(process.env.PR_TITLE || process.env.INVOICE_HUB_PR_TITLE || "").trim();
  if (direct) return direct;
  const eventPath = String(process.env.GITHUB_EVENT_PATH || "").trim();
  if (!eventPath || !fs.existsSync(eventPath)) return "";
  try {
    const ev = JSON.parse(fs.readFileSync(eventPath, "utf8"));
    return String(ev.pull_request?.title || ev.title || "").trim();
  } catch (_err) {
    return "";
  }
}

function isExplicitInvoiceHubScope({ branch, prTitle, env } = {}) {
  const manifest = loadManifest();
  const envObj = env || process.env;
  const allowKey = manifest.explicitScope?.allowEnv || "ALLOW_INVOICE_HUB_TOUCH";
  if (String(envObj[allowKey] || "").trim() === "1") return true;

  const b = String(branch || "").toLowerCase();
  const needles = (manifest.explicitScope?.branchSubstrings || []).map((s) => String(s).toLowerCase());
  if (needles.some((n) => n && b.indexOf(n) >= 0)) return true;

  const token = String(manifest.explicitScope?.prTitleToken || "[Invoice Hub]");
  const title = String(prTitle || "");
  if (title && title.indexOf(token) >= 0) return true;
  return false;
}

function hubMarkerRegexes(manifest) {
  const markers = (manifest.sharedScan && manifest.sharedScan["public/js/app.js"]?.markers) || [];
  const list = markers.map((m) => {
    const escaped = String(m).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    return new RegExp(escaped, "i");
  });
  list.push(/\bhub[A-Z_][A-Za-z0-9_]*/);
  list.push(/\b(?:open|load|render|close)Hub[A-Za-z0-9_]*/);
  list.push(/\bHub(?:Form|Drawer|Row|View|Templates)[A-Za-z0-9_]*/);
  list.push(/\[Invoice Hub\]/i);
  list.push(/(?:^|[^A-Za-z])hub(?:[^A-Za-z]|$)/i);
  return list;
}

function changedLinesFromDiff(diff) {
  const lines = [];
  String(diff || "")
    .split(/\r?\n/)
    .forEach((line) => {
      if (
        line.startsWith("+++") ||
        line.startsWith("---") ||
        line.startsWith("diff ") ||
        line.startsWith("index ") ||
        line.startsWith("@@")
      ) {
        return;
      }
      if (line.startsWith("+") || line.startsWith("-")) {
        lines.push(line.slice(1));
      }
    });
  return lines;
}

function lineLooksLikeGithubFalsePositive(line) {
  return /\bgithub\b/i.test(line) && !/\binvoice hub\b/i.test(line) && !/\bhub[A-Z_]/u.test(line);
}

function appJsDiffTouchesHub(diffText, manifest) {
  const lines = changedLinesFromDiff(diffText);
  if (!lines.length) return { touches: true, uncertain: true, reason: "empty_or_unreadable_app_js_diff" };
  const regexes = hubMarkerRegexes(manifest);
  const hits = [];
  lines.forEach((line) => {
    if (lineLooksLikeGithubFalsePositive(line) && !/\bhub[A-Z_]/u.test(line) && !/\b(?:open|load|render)Hub/u.test(line)) {
      return;
    }
    regexes.forEach((re) => {
      if (re.test(line)) hits.push(line.slice(0, 160));
    });
  });
  const unique = Array.from(new Set(hits));
  return { touches: unique.length > 0, uncertain: false, hits: unique.slice(0, 8) };
}

function classifyFile(file, manifest) {
  const n = normPath(file);
  if (isSharedScanFile(n, manifest)) return "shared";
  if (isExactProtected(n, manifest) || isGlobProtected(n, manifest)) return "protected";
  return "other";
}

function evaluateGuard({ files, diffsByFile, branch, prTitle, env } = {}) {
  const manifest = loadManifest();
  const scoped = isExplicitInvoiceHubScope({ branch, prTitle, env });
  const list = (files || []).map(normPath);
  const protectedHits = [];
  const sharedHits = [];
  const uncertainHits = [];

  list.forEach((file) => {
    const kind = classifyFile(file, manifest);
    if (kind === "protected") {
      protectedHits.push(file);
      return;
    }
    if (kind === "shared") {
      const scan = appJsDiffTouchesHub(diffsByFile && diffsByFile[file], manifest);
      if (scan.uncertain) {
        uncertainHits.push(file);
        sharedHits.push(file);
        return;
      }
      if (scan.touches) sharedHits.push(file);
    }
  });

  const hubTouched = protectedHits.length > 0 || sharedHits.length > 0;
  if (!hubTouched) {
    return {
      ok: true,
      scoped,
      hubTouched: false,
      regressionRequired: false,
      protectedHits,
      sharedHits,
      message: "No Invoice Hub protected surface changes.",
    };
  }
  if (!scoped) {
    return {
      ok: false,
      scoped,
      hubTouched: true,
      regressionRequired: true,
      protectedHits,
      sharedHits,
      uncertainHits,
      message: FAIL_MESSAGE,
    };
  }
  return {
    ok: true,
    scoped,
    hubTouched: true,
    regressionRequired: true,
    protectedHits,
    sharedHits,
    uncertainHits,
    message:
      "Invoice Hub protected files changed under Invoice Hub scope. Run: node scripts/test-invoice-hub-regression-suite.js",
  };
}

function unique(list) {
  return Array.from(new Set((list || []).map(normPath).filter(Boolean)));
}

function collectChangedFiles(baseRef) {
  const names = [];
  const cmds = [
    ["diff", "--name-only", "--diff-filter=ACMRD", baseRef + "...HEAD"],
    ["diff", "--name-only", "--diff-filter=ACMRD", baseRef],
    ["diff", "--name-only", "--cached", "--diff-filter=ACMRD"],
    ["ls-files", "--others", "--exclude-standard"],
  ];
  cmds.forEach((args) => {
    const r = git(args);
    String(r.stdout || "")
      .split(/\r?\n/)
      .forEach((line) => {
        if (line.trim()) names.push(line.trim());
      });
  });
  return unique(names);
}

function collectDiffs(baseRef, files) {
  const diffs = {};
  files.forEach((file) => {
    if (normPath(file) !== "public/js/app.js") return;
    const r = git(["diff", baseRef, "--", "public/js/app.js"]);
    const cached = git(["diff", "--cached", "--", "public/js/app.js"]);
    diffs[normPath(file)] = String(r.stdout || "") + "\n" + String(cached.stdout || "");
  });
  return diffs;
}

function resolveBaseRef() {
  const requested = String(process.env.BASE_REF || "origin/main").trim() || "origin/main";
  const probe = git(["rev-parse", "--verify", requested]);
  if (probe.status === 0) return requested;
  const main = git(["rev-parse", "--verify", "main"]);
  if (main.status === 0) return "main";
  return requested;
}

function assertSelf(label, cond) {
  if (!cond) throw new Error("self-test failed: " + label);
  console.log("PASS " + label);
}

function runSelfTest() {
  const manifest = loadManifest();
  let n = 0;
  const pass = (label, cond) => {
    assertSelf(label, cond);
    n += 1;
  };

  pass(
    "non-Hub branch + protected file fails",
    evaluateGuard({
      files: ["netlify/functions/list-tenant-invoices.js"],
      branch: "feat/seller-layout",
      prTitle: "Seller layout",
    }).ok === false
  );

  const scopedHub = evaluateGuard({
    files: ["netlify/functions/list-tenant-invoices.js"],
    branch: "chore/invoice-hub-shield-v1",
    prTitle: "Shield",
  });
  pass("Invoice-Hub branch + protected file passes", scopedHub.ok === true);
  pass("Invoice-Hub branch requires regression suite", scopedHub.regressionRequired === true);

  pass(
    "non-Hub file only passes",
    evaluateGuard({
      files: ["public/owner.html", "docs/AI_CLOSER_STEP1_ISOLATED_LAB.md"],
      branch: "feat/seller-layout",
    }).ok === true
  );

  const nonHubApp = evaluateGuard({
    files: ["public/js/app.js"],
    diffsByFile: {
      "public/js/app.js":
        "diff --git a/public/js/app.js b/public/js/app.js\n--- a/public/js/app.js\n+++ b/public/js/app.js\n@@ -1 +1 @@\n-const greeting = 'hi';\n+const greeting = 'hello';\n",
    },
    branch: "feat/seller-layout",
  });
  pass("app.js non-Hub lines pass", nonHubApp.ok === true && nonHubApp.hubTouched === false);

  const hubApp = evaluateGuard({
    files: ["public/js/app.js"],
    diffsByFile: {
      "public/js/app.js":
        "diff --git a/public/js/app.js b/public/js/app.js\n--- a/public/js/app.js\n+++ b/public/js/app.js\n@@ -1 +1 @@\n-function hubRowIsPaidForReminder(row) { return false; }\n+function hubRowIsPaidForReminder(row) { return true; }\n",
    },
    branch: "feat/seller-layout",
  });
  pass("app.js Hub lines fail without Invoice Hub scope", hubApp.ok === false);

  const hubAppAllowed = evaluateGuard({
    files: ["public/js/app.js"],
    diffsByFile: {
      "public/js/app.js":
        "diff --git a/public/js/app.js b/public/js/app.js\n--- a/public/js/app.js\n+++ b/public/js/app.js\n@@ -1 +1 @@\n-function hubRowIsPaidForReminder(row) { return false; }\n+function hubRowIsPaidForReminder(row) { return true; }\n",
    },
    branch: "fix/invoice-hub-reminder",
  });
  pass("app.js Hub lines pass with Invoice Hub branch", hubAppAllowed.ok === true);

  pass(
    "ALLOW_INVOICE_HUB_TOUCH=1 allows protected file",
    evaluateGuard({
      files: ["public/estimates-invoices.html"],
      branch: "feat/seller-layout",
      env: { ALLOW_INVOICE_HUB_TOUCH: "1" },
    }).ok === true
  );

  pass(
    "PR title [Invoice Hub] allows protected file",
    evaluateGuard({
      files: ["netlify/functions/record-tenant-payment.js"],
      branch: "feat/misc",
      prTitle: "[Invoice Hub] record payment auth",
    }).ok === true
  );

  pass("fail message is exact", evaluateGuard({
    files: ["public/invoice-public.html"],
    branch: "feat/misc",
  }).message === (manifest.failMessage || FAIL_MESSAGE));

  console.log("\n" + n + " self-tests passed");
}

function main() {
  if (process.argv.indexOf("--self-test") >= 0) {
    runSelfTest();
    return;
  }

  const baseRef = resolveBaseRef();
  const files = collectChangedFiles(baseRef);
  const diffsByFile = collectDiffs(baseRef, files);
  const result = evaluateGuard({
    files,
    diffsByFile,
    branch: currentBranch(),
    prTitle: readPrTitle(),
    env: process.env,
  });

  console.log("BASE_REF=" + baseRef);
  console.log("branch=" + currentBranch());
  if (result.protectedHits && result.protectedHits.length) {
    console.log("protected files:\n- " + result.protectedHits.join("\n- "));
  }
  if (result.sharedHits && result.sharedHits.length) {
    console.log("shared Hub-region files:\n- " + result.sharedHits.join("\n- "));
  }
  if (result.regressionRequired) {
    console.log("INVOICE_HUB_REGRESSION_REQUIRED=1");
  }
  console.log(result.message);

  if (!result.ok) {
    process.exit(1);
  }
}

module.exports = {
  FAIL_MESSAGE,
  loadManifest,
  classifyFile,
  isExplicitInvoiceHubScope,
  appJsDiffTouchesHub,
  evaluateGuard,
  changedLinesFromDiff,
};

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  }
}
