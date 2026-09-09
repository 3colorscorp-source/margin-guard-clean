#!/usr/bin/env node
/**
 * Owner Shield V1 scope guard — fail if Owner files/regions change outside Owner scope.
 * Compare against origin/main by default. Override with BASE_REF.
 * Isolated: git metadata + local diffs only. No SQL, email, Zapier, or production mutation.
 * Run: node scripts/guard-owner-scope.js
 * Self-test: node scripts/guard-owner-scope.js --self-test
 *
 * Authorization is not the branch name alone. Protected files always fail unless one of:
 *   ALLOW_OWNER_TOUCH=1, PR title contains [Owner], or a deliberate Owner branch substring.
 * A branch that merely contains the word "owner" (for example modern-owner-session) is not enough.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const MANIFEST_PATH = path.join(__dirname, "mg-owner-shield-v1.json");
const FAIL_MESSAGE =
  "Owner protected surface changed outside Owner scope. Stop and move this to an Owner PR.";
const RUNNER = "node scripts/test-mg-owner-shield-v1.js";

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
  const direct = String(process.env.PR_TITLE || process.env.OWNER_PR_TITLE || "").trim();
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

function isExplicitOwnerScope({ branch, prTitle, env } = {}) {
  const manifest = loadManifest();
  const envObj = env || process.env;
  const allowKey = manifest.explicitScope?.allowEnv || "ALLOW_OWNER_TOUCH";
  if (String(envObj[allowKey] || "").trim() === "1") return true;

  const token = String(manifest.explicitScope?.prTitleToken || "[Owner]");
  const title = String(prTitle || "");
  if (title && title.indexOf(token) >= 0) return true;

  const b = String(branch || "").toLowerCase();
  const needles = (manifest.explicitScope?.branchSubstrings || []).map((s) => String(s).toLowerCase());
  if (needles.some((n) => n && b.indexOf(n) >= 0)) return true;
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
  const scoped = isExplicitOwnerScope({ branch, prTitle, env });
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

  const ownerTouched = protectedHits.length > 0 || sharedHits.length > 0;
  if (!ownerTouched) {
    return {
      ok: true,
      scoped,
      ownerTouched: false,
      regressionRequired: false,
      protectedHits,
      sharedHits,
      message: "No Owner protected surface changes.",
    };
  }
  if (!scoped) {
    return {
      ok: false,
      scoped,
      ownerTouched: true,
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
    ownerTouched: true,
    regressionRequired: true,
    protectedHits,
    sharedHits,
    uncertainHits,
    message: "Owner protected files changed under Owner scope. Run: " + RUNNER,
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

function isSafeGitSha(value) {
  return /^[0-9a-f]{7,40}$/i.test(String(value || "").trim());
}

function resolveBaseRef(envObj, gitImpl) {
  const env = envObj || process.env;
  const requested = String(env.BASE_REF || "origin/main").trim() || "origin/main";
  const runGit =
    gitImpl ||
    function (args) {
      return git(args);
    };
  const probe = runGit(["rev-parse", "--verify", requested + "^{commit}"]);
  if (probe && probe.status === 0) return { ok: true, ref: requested };
  return { ok: false, ref: requested, reason: "unresolved_base_ref" };
}

function inspectGithubEventPath(envObj, existsImpl, readFileImpl) {
  const env = envObj || process.env;
  const eventPath = String(env.GITHUB_EVENT_PATH || "").trim();
  if (!eventPath) return { ok: true, reason: "absent" };
  if (String(env.PR_TITLE || "").trim()) return { ok: true, reason: "pr_title_present" };
  const exists = existsImpl || fs.existsSync;
  if (!exists(eventPath)) return { ok: false, reason: "invalid_github_event_path" };
  try {
    const readFile = readFileImpl || fs.readFileSync;
    JSON.parse(readFile(eventPath, "utf8"));
    return { ok: true, reason: "readable" };
  } catch (_err) {
    return { ok: false, reason: "invalid_github_event_path" };
  }
}

function missingExactFiles(manifest, changedFiles, existsImpl) {
  const exists =
    existsImpl ||
    function (rel) {
      return fs.existsSync(path.join(ROOT, rel));
    };
  const changed = new Set((changedFiles || []).map(normPath));
  return (manifest.exact || []).filter((rel) => {
    const n = normPath(rel);
    if (changed.has(n)) return false;
    return !exists(n);
  });
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

  const simFail = evaluateGuard({
    files: ["public/owner.html"],
    branch: "feat/support-layout",
    prTitle: "Support layout",
  });
  pass("1. non-Owner branch + Owner file fails", simFail.ok === false);

  const simPass = evaluateGuard({
    files: ["public/owner.html"],
    branch: "feat/owner-shield-v2",
    prTitle: "Shield",
  });
  pass("2. Owner-authorized branch + Owner file passes", simPass.ok === true);
  pass("3. Owner-authorized branch requires Owner regression", simPass.regressionRequired === true);

  const titledEarly = evaluateGuard({
    files: ["netlify/functions/restore-owner-session.js"],
    branch: "feat/misc",
    prTitle: "[Owner] restore session cookie",
  });
  pass("4. PR title [Owner] + Owner file passes", titledEarly.ok === true);
  pass("5. PR title [Owner] requires Owner regression", titledEarly.regressionRequired === true);

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
      branch: "feat/seller-hours-publish-parity",
      prTitle: "[Seller] hours",
    }).ok === false
  );

  pass(
    "generic 'owner' inside modern-owner-session does not authorize",
    evaluateGuard({
      files: ["public/owner.html"],
      branch: "fix/business-settings-modern-owner-session",
    }).ok === false
  );

  const newCritical = [
    ".github/workflows/owner-shield-v1.yml",
    "public/js/owner-financial-advisor.js",
    "netlify/functions/owner-settings-deposit-link.js",
    "netlify/functions/get-owner-financial-settings.js",
    "MARGIN_GUARD_OWNER_PORTAL_SUMMARY.md",
    "scripts/test-owner-shield-v2.js",
    "scripts/test-owner-send-price-guard.js",
  ];
  newCritical.forEach((file) => {
    pass(
      "non-Owner + " + file + " fails",
      evaluateGuard({
        files: [file],
        branch: "feat/seller-hours-publish-parity",
        prTitle: "[Seller] hours",
      }).ok === false
    );
  });

  const nonOwnerApp = evaluateGuard({
    files: ["public/js/app.js"],
    diffsByFile: {
      "public/js/app.js":
        "diff --git a/public/js/app.js b/public/js/app.js\n--- a/public/js/app.js\n+++ b/public/js/app.js\n@@ -1 +1 @@\n-const greeting = 'hi';\n+const greeting = 'hello';\n",
    },
    branch: "feat/support-layout",
  });
  pass("app.js non-Owner lines pass", nonOwnerApp.ok === true && nonOwnerApp.ownerTouched === false);

  const ownerApp = evaluateGuard({
    files: ["public/js/app.js"],
    diffsByFile: {
      "public/js/app.js":
        "diff --git a/public/js/app.js b/public/js/app.js\n--- a/public/js/app.js\n+++ b/public/js/app.js\n@@ -1 +1 @@\n-function loadOwner() { return {}; }\n+function loadOwner() { return null; }\n",
    },
    branch: "feat/support-layout",
  });
  pass("app.js Owner lines fail without Owner scope", ownerApp.ok === false);

  const ownerAppAllowed = evaluateGuard({
    files: ["public/js/app.js"],
    diffsByFile: {
      "public/js/app.js":
        "diff --git a/public/js/app.js b/public/js/app.js\n--- a/public/js/app.js\n+++ b/public/js/app.js\n@@ -1 +1 @@\n-function loadOwner() { return {}; }\n+function loadOwner() { return null; }\n",
    },
    branch: "fix/owner-draft-reset",
  });
  pass("app.js Owner lines pass with fix/owner- branch", ownerAppAllowed.ok === true);

  const emptyShared = evaluateGuard({
    files: ["public/js/app.js"],
    diffsByFile: { "public/js/app.js": "" },
    branch: "feat/support-layout",
  });
  pass("empty shared app.js diff fails safe", emptyShared.ok === false);

  pass(
    "ALLOW_OWNER_TOUCH=1 allows protected file without Owner branch",
    evaluateGuard({
      files: ["public/owner.html"],
      branch: "feat/support-layout",
      env: { ALLOW_OWNER_TOUCH: "1" },
    }).ok === true
  );

  const sharedAuth = evaluateGuard({
    files: ["netlify/functions/_lib/tenant-device-guard.js"],
    diffsByFile: {
      "netlify/functions/_lib/tenant-device-guard.js":
        "diff --git a/netlify/functions/_lib/tenant-device-guard.js b/netlify/functions/_lib/tenant-device-guard.js\n--- a/a\n+++ b/b\n@@ -1 +1 @@\n-async function requireOwnerMembership() { return null; }\n+async function requireOwnerMembership() { return {}; }\n",
    },
    branch: "feat/support-layout",
  });
  pass("shared tenant-device-guard Owner region fails without Owner scope", sharedAuth.ok === false);

  const sharedTenant = evaluateGuard({
    files: ["netlify/functions/_lib/tenant-for-session.js"],
    diffsByFile: {
      "netlify/functions/_lib/tenant-for-session.js":
        "diff --git a/netlify/functions/_lib/tenant-for-session.js b/netlify/functions/_lib/tenant-for-session.js\n--- a/a\n+++ b/b\n@@ -1 +1 @@\n-function entitledOwnerTenant(tenant) { return tenant; }\n+function entitledOwnerTenant(tenant) { return null; }\n",
    },
    branch: "feat/seller-hours-publish-parity",
    prTitle: "[Seller] hours",
  });
  pass("shared tenant-for-session Owner region fails without Owner scope", sharedTenant.ok === false);

  const nonOwnerLib = evaluateGuard({
    files: ["netlify/functions/_lib/tenant-device-guard.js"],
    diffsByFile: {
      "netlify/functions/_lib/tenant-device-guard.js":
        "diff --git a/netlify/functions/_lib/tenant-device-guard.js b/netlify/functions/_lib/tenant-device-guard.js\n--- a/a\n+++ b/b\n@@ -1 +1 @@\n-const unused = 1;\n+const unused = 2;\n",
    },
    branch: "feat/support-layout",
  });
  pass("shared tenant-device-guard non-Owner lines pass", nonOwnerLib.ok === true && nonOwnerLib.ownerTouched === false);

  const emptyDevice = evaluateGuard({
    files: ["netlify/functions/_lib/tenant-device-guard.js"],
    diffsByFile: { "netlify/functions/_lib/tenant-device-guard.js": "" },
    branch: "feat/support-layout",
  });
  pass("empty shared tenant-device-guard diff fails safe", emptyDevice.ok === false);

  pass(
    "authorization is not branch-only: env works when branch is Support",
    isExplicitOwnerScope({
      branch: "feat/support-layout",
      env: { ALLOW_OWNER_TOUCH: "1" },
    }) === true
  );

  pass(
    "authorization is not branch-only: title works when branch is Support",
    isExplicitOwnerScope({
      branch: "feat/support-layout",
      prTitle: "[Owner] transcript",
    }) === true
  );

  pass(
    "fail message is exact",
    evaluateGuard({
      files: ["public/js/owner-voice-operational-plan.js"],
      branch: "feat/misc",
    }).message === (manifest.failMessage || FAIL_MESSAGE)
  );

  pass(
    "Seller files are not Owner-protected",
    evaluateGuard({
      files: ["public/sales.html", "public/js/sales-device-portal.js"],
      branch: "feat/misc",
    }).ok === true
  );

  pass(
    "Invoice Hub files are not Owner-protected",
    evaluateGuard({
      files: ["public/estimates-invoices.html", "netlify/functions/list-tenant-invoices.js"],
      branch: "feat/misc",
    }).ok === true
  );

  pass(
    "invalid GITHUB_EVENT_PATH fails safe",
    inspectGithubEventPath({ GITHUB_EVENT_PATH: "C:/missing/event.json" }, () => false).ok === false
  );
  pass(
    "GITHUB_EVENT_PATH skipped when PR_TITLE is present",
    inspectGithubEventPath(
      { GITHUB_EVENT_PATH: "C:/missing/event.json", PR_TITLE: "[Owner] x" },
      () => false
    ).ok === true
  );
  pass(
    "unresolved BASE_REF fails safe",
    resolveBaseRef({ BASE_REF: "not-a-real-ref" }, () => ({ status: 1 })).ok === false
  );
  pass("safe git sha accepted", isSafeGitSha("8145cff4c9a0898a0f8a8c6f671cbb010929b6cf") === true);
  pass("unsafe git sha rejected", isSafeGitSha(";calc.exe") === false);
  pass(
    "missing exact file fails safe",
    missingExactFiles(manifest, [], () => false).length > 0
  );
  pass(
    "deleted exact file is not treated as missing",
    missingExactFiles({ exact: ["public/owner.html"] }, ["public/owner.html"], () => false).length === 0
  );

  pass("PR title is read from process.env", /process\.env\.PR_TITLE/.test(src));
  pass("git is spawned with array args", /spawnSync\("git", args/.test(src));
  pass("spawnSync is not invoked with shell true", !/shell:\s*true/.test(src));
  pass(
    "workflow is in exact protected list",
    (manifest.exact || []).indexOf(".github/workflows/owner-shield-v1.yml") >= 0
  );
  pass("qa-ch014 is not required", (manifest.required || []).every((row) => String(row.path).indexOf("qa-ch014") < 0));
  pass("qa-ch014 is not optional", (manifest.optional || []).every((row) => String(row.path).indexOf("qa-ch014") < 0));

  console.log("\n" + n + " self-tests passed");
}

function main() {
  if (process.argv.indexOf("--self-test") >= 0) {
    runSelfTest();
    return;
  }

  const eventCheck = inspectGithubEventPath(process.env);
  if (!eventCheck.ok) {
    console.log("FAIL " + eventCheck.reason);
    process.exit(1);
  }

  const manifest = loadManifest();
  const base = resolveBaseRef();
  if (!base.ok) {
    console.log("FAIL " + base.reason);
    process.exit(1);
  }
  const files = collectChangedFiles(base.ref);
  const missing = missingExactFiles(manifest, files);
  if (missing.length) {
    console.log("FAIL missing_required_file");
    missing.forEach((rel) => {
      console.log("- " + rel);
    });
    process.exit(1);
  }
  const diffsByFile = collectDiffs(base.ref, files, manifest);
  const result = evaluateGuard({
    files,
    diffsByFile,
    branch: currentBranch(),
    prTitle: readPrTitle(),
    env: process.env,
  });

  console.log("BASE_REF=" + base.ref);
  console.log("branch=" + currentBranch());
  if (result.protectedHits && result.protectedHits.length) {
    console.log("protected files:\n- " + result.protectedHits.join("\n- "));
  }
  if (result.sharedHits && result.sharedHits.length) {
    console.log("shared Owner-region files:\n- " + result.sharedHits.join("\n- "));
  }
  if (result.regressionRequired) {
    console.log("OWNER_REGRESSION_REQUIRED=1");
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
  isExplicitOwnerScope,
  evaluateGuard,
  changedLinesFromDiff,
  isSafeGitSha,
  resolveBaseRef,
  inspectGithubEventPath,
  missingExactFiles,
};

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  }
}
