#!/usr/bin/env node
/**
 * Seller Shield V1 scope guard — fail if Seller files/regions change outside Seller scope.
 * Compare against origin/main by default. Override with BASE_REF.
 * Isolated: git metadata + local diffs only. No SQL, email, Zapier, or production mutation.
 * Run: node scripts/guard-seller-scope.js
 * Self-test: node scripts/guard-seller-scope.js --self-test
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const MANIFEST_PATH = path.join(__dirname, "mg-seller-shield-v1.json");
const FAIL_MESSAGE =
  "Seller protected surface changed outside Seller scope. Stop and move this to a Seller PR.";
const RUNNER = "node scripts/test-mg-seller-shield-v1.js";

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
    shell: false,
  });
}

function currentBranch() {
  if (process.env.GITHUB_HEAD_REF) return String(process.env.GITHUB_HEAD_REF).trim();
  const r = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  return String(r.stdout || "").trim();
}

function readPrTitle() {
  const direct = String(process.env.PR_TITLE || process.env.SELLER_PR_TITLE || "").trim();
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

function isExplicitSellerScope({ branch, prTitle, env } = {}) {
  const manifest = loadManifest();
  const envObj = env || process.env;
  const allowKey = manifest.explicitScope?.allowEnv || "ALLOW_SELLER_TOUCH";
  if (String(envObj[allowKey] || "").trim() === "1") return true;

  const b = String(branch || "").toLowerCase();
  const needles = (manifest.explicitScope?.branchSubstrings || []).map((s) => String(s).toLowerCase());
  if (needles.some((n) => n && b.indexOf(n) >= 0)) return true;

  const token = String(manifest.explicitScope?.prTitleToken || "[Seller]");
  const title = String(prTitle || "");
  if (title && title.indexOf(token) >= 0) return true;
  return false;
}

function markerRegexes(file, manifest) {
  const markers = (manifest.sharedScan && manifest.sharedScan[file]?.markers) || [];
  return markers.map((m) => {
    const escaped = String(m).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    return new RegExp(escaped, "i");
  });
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

function sharedDiffTouches(file, diffText, manifest) {
  const lines = changedLinesFromDiff(diffText);
  if (!lines.length) return { touches: true, uncertain: true, reason: "empty_or_unreadable_shared_diff" };
  const regexes = markerRegexes(file, manifest);
  const hits = [];
  lines.forEach((line) => {
    regexes.forEach((re) => {
      if (re.test(line)) hits.push(line.slice(0, 160));
    });
  });
  return { touches: hits.length > 0, uncertain: false, hits: Array.from(new Set(hits)).slice(0, 8) };
}

function classifyFile(file, manifest) {
  const n = normPath(file);
  if (isSharedScanFile(n, manifest)) return "shared";
  if (isExactProtected(n, manifest) || isGlobProtected(n, manifest)) return "protected";
  return "other";
}

function evaluateGuard({ files, diffsByFile, branch, prTitle, env } = {}) {
  const manifest = loadManifest();
  const scoped = isExplicitSellerScope({ branch, prTitle, env });
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
      const scan = sharedDiffTouches(file, diffsByFile && diffsByFile[file], manifest);
      if (scan.uncertain) {
        uncertainHits.push(file);
        sharedHits.push(file);
        return;
      }
      if (scan.touches) sharedHits.push(file);
    }
  });

  const sellerTouched = protectedHits.length > 0 || sharedHits.length > 0;
  if (!sellerTouched) {
    return {
      ok: true,
      scoped,
      sellerTouched: false,
      regressionRequired: false,
      protectedHits,
      sharedHits,
      message: "No Seller protected surface changes.",
    };
  }
  if (!scoped) {
    return {
      ok: false,
      scoped,
      sellerTouched: true,
      regressionRequired: true,
      protectedHits,
      sharedHits,
      uncertainHits,
      message: manifest.failMessage || FAIL_MESSAGE,
    };
  }
  return {
    ok: true,
    scoped,
    sellerTouched: true,
    regressionRequired: true,
    protectedHits,
    sharedHits,
    uncertainHits,
    message: "Seller protected files changed under Seller scope. Run: " + RUNNER,
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

function collectDiffs(baseRef, files, manifest) {
  const diffs = {};
  const shared = Object.keys((manifest && manifest.sharedScan) || {});
  files.forEach((file) => {
    const n = normPath(file);
    if (shared.indexOf(n) < 0) return;
    const r = git(["diff", baseRef, "--", n]);
    const cached = git(["diff", "--cached", "--", n]);
    diffs[n] = String(r.stdout || "") + "\n" + String(cached.stdout || "");
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

function runSelfTest() {
  const manifest = loadManifest();
  const src = fs.readFileSync(__filename, "utf8");
  let n = 0;
  const pass = (label, cond) => {
    if (!cond) throw new Error("self-test failed: " + label);
    console.log("PASS " + label);
    n += 1;
  };

  const newCritical = [
    ".github/workflows/seller-shield-v1.yml",
    "public/js/device-portal-auth.js",
    "public/portal-pair.html",
    "netlify/functions/get-seller-business-settings.js",
    "netlify/functions/get-sales-capacity-calendar.js",
    "netlify/functions/quote-internal-operational-plan.js",
    "netlify/functions/list-tenant-contacts.js",
    "netlify/functions/upsert-tenant-contact.js",
    "netlify/functions/pair-device.js",
    "netlify/functions/device-auth-status.js",
    "netlify/functions/device-heartbeat.js",
    "netlify/functions/device-logout.js",
  ];
  newCritical.forEach((file) => {
    pass(
      "non-Seller + " + file + " fails",
      evaluateGuard({
        files: [file],
        branch: "feat/owner-voice",
        prTitle: "[Owner] voice",
      }).ok === false
    );
  });

  pass(
    "non-Seller branch + sales.html fails",
    evaluateGuard({
      files: ["public/sales.html"],
      branch: "feat/support-layout",
      prTitle: "Support layout",
    }).ok === false
  );

  const scoped = evaluateGuard({
    files: ["public/sales.html"],
    branch: "feat/seller-shield-v2",
    prTitle: "Shield",
  });
  pass("Seller branch + protected file passes", scoped.ok === true);
  pass("Seller branch requires regression suite", scoped.regressionRequired === true);

  const titled = evaluateGuard({
    files: ["netlify/functions/pair-device.js"],
    branch: "feat/misc",
    prTitle: "[Seller] pairing",
  });
  pass("PR title [Seller] + protected file passes", titled.ok === true);
  pass("PR title [Seller] requires regression suite", titled.regressionRequired === true);

  pass(
    "Owner-only files pass",
    evaluateGuard({
      files: ["public/owner.html", "docs/INVOICE_HUB_PROTECTED_SURFACE.md"],
      branch: "feat/owner-voice",
      prTitle: "[Owner] voice",
    }).ok === true
  );

  pass(
    "Invoice Hub exclusive files pass",
    evaluateGuard({
      files: ["public/estimates-invoices.html", "netlify/functions/list-tenant-invoices.js"],
      branch: "feat/invoice-hub-shield-v2",
      prTitle: "[Invoice Hub] shield",
    }).ok === true
  );

  const nonSellerApp = evaluateGuard({
    files: ["public/js/app.js"],
    diffsByFile: {
      "public/js/app.js":
        "diff --git a/public/js/app.js b/public/js/app.js\n--- a/public/js/app.js\n+++ b/public/js/app.js\n@@ -1 +1 @@\n-const greeting = 'hi';\n+const greeting = 'hello';\n",
    },
    branch: "feat/support-layout",
  });
  pass("app.js non-Seller lines pass", nonSellerApp.ok === true && nonSellerApp.sellerTouched === false);

  const sellerApp = evaluateGuard({
    files: ["public/js/app.js"],
    diffsByFile: {
      "public/js/app.js":
        "diff --git a/public/js/app.js b/public/js/app.js\n--- a/public/js/app.js\n+++ b/public/js/app.js\n@@ -1 +1 @@\n-async function runSellerSend() { return false; }\n+async function runSellerSend() { return true; }\n",
    },
    branch: "feat/support-layout",
  });
  pass("app.js Seller region fails without Seller scope", sellerApp.ok === false);

  const sellerAppAllowed = evaluateGuard({
    files: ["public/js/app.js"],
    diffsByFile: {
      "public/js/app.js":
        "diff --git a/public/js/app.js b/public/js/app.js\n--- a/public/js/app.js\n+++ b/public/js/app.js\n@@ -1 +1 @@\n-async function runSellerSend() { return false; }\n+async function runSellerSend() { return true; }\n",
    },
    branch: "fix/seller-send-in-flight",
  });
  pass("app.js Seller lines pass with Seller branch", sellerAppAllowed.ok === true);
  pass("app.js Seller lines require regression", sellerAppAllowed.regressionRequired === true);

  const sharedAuth = evaluateGuard({
    files: ["netlify/functions/_lib/tenant-device-guard.js"],
    diffsByFile: {
      "netlify/functions/_lib/tenant-device-guard.js":
        "diff --git a/netlify/functions/_lib/tenant-device-guard.js b/netlify/functions/_lib/tenant-device-guard.js\n--- a/a\n+++ b/b\n@@ -1 +1 @@\n-async function requireSellerDevice() { return null; }\n+async function requireSellerDevice() { return {}; }\n",
    },
    branch: "feat/owner-voice",
  });
  pass("shared auth Seller region fails without Seller scope", sharedAuth.ok === false);

  const sharedPricing = evaluateGuard({
    files: ["netlify/functions/_lib/pricing-engine.js"],
    diffsByFile: {
      "netlify/functions/_lib/pricing-engine.js":
        "diff --git a/netlify/functions/_lib/pricing-engine.js b/netlify/functions/_lib/pricing-engine.js\n--- a/a\n+++ b/b\n@@ -1 +1 @@\n-function calculateQuotePublishFinancials() { return { minimum_price: 1 }; }\n+function calculateQuotePublishFinancials() { return { minimum_price: 0 }; }\n",
    },
    branch: "fix/business-settings-modern-owner-session",
  });
  pass("shared pricing Seller region fails without Seller scope", sharedPricing.ok === false);

  const uncertainApp = evaluateGuard({
    files: ["public/js/app.js"],
    diffsByFile: { "public/js/app.js": "" },
    branch: "feat/support-layout",
  });
  pass("empty/unreadable shared app.js diff fails safe", uncertainApp.ok === false);

  const uncertainDevice = evaluateGuard({
    files: ["netlify/functions/_lib/device-session.js"],
    diffsByFile: { "netlify/functions/_lib/device-session.js": "diff --git a/x b/x\n" },
    branch: "feat/misc",
  });
  pass("uncertain shared device-session diff fails safe", uncertainDevice.ok === false);

  pass(
    "Seller workflow file is protected",
    evaluateGuard({
      files: [".github/workflows/seller-shield-v1.yml"],
      branch: "feat/support-layout",
    }).ok === false
  );

  pass(
    "ALLOW_SELLER_TOUCH=1 allows protected file",
    evaluateGuard({
      files: ["public/sales.html"],
      branch: "feat/support-layout",
      env: { ALLOW_SELLER_TOUCH: "1" },
    }).ok === true
  );

  pass(
    "fail message is exact",
    evaluateGuard({
      files: ["public/js/sales-device-portal.js"],
      branch: "feat/misc",
    }).message === (manifest.failMessage || FAIL_MESSAGE)
  );

  pass("PR title is read from process.env", /process\.env\.PR_TITLE/.test(src));
  pass("git is spawned with array args", /spawnSync\("git", args/.test(src));
  pass("spawnSync is not invoked with shell true", !/shell:\s*true/.test(src));
  pass("workflow is in exact protected list", (manifest.exact || []).indexOf(".github/workflows/seller-shield-v1.yml") >= 0);

  console.log("\n" + n + " self-tests passed");
}

function main() {
  if (process.argv.indexOf("--self-test") >= 0) {
    runSelfTest();
    return;
  }

  const manifest = loadManifest();
  const baseRef = resolveBaseRef();
  const files = collectChangedFiles(baseRef);
  const diffsByFile = collectDiffs(baseRef, files, manifest);
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
    console.log("shared Seller-region files:\n- " + result.sharedHits.join("\n- "));
  }
  if (result.regressionRequired) {
    console.log("SELLER_REGRESSION_REQUIRED=1");
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
  isExplicitSellerScope,
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
