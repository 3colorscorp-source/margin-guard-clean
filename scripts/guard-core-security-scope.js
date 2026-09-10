#!/usr/bin/env node
/**
 * Core Security Shield V2 — fail if Core Security files/regions change without
 * BOTH a Core Security PR title and a Core Security branch prefix.
 * Compare against BASE_REF (required). Isolated: git metadata + local diffs only.
 * Run: node scripts/guard-core-security-scope.js
 * Self-test: node scripts/guard-core-security-scope.js --self-test
 *
 * Authorization requires both:
 *   1. PR title contains exactly "[Core Security]"
 *   2. Branch starts with feat/core-security- | fix/core-security- | security/core-
 * Title or branch alone is not enough. There is no ALLOW_CORE_SECURITY_TOUCH.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const MANIFEST_PATH = path.join(__dirname, "mg-core-security-shield-v1.json");
const FAIL_MESSAGE =
  "Core Security protected surface changed outside Core Security scope. Stop and move this to a Core Security PR.";
const RUNNER = "node scripts/test-mg-core-security-shield-v1.js";
const TITLE_TOKEN = "[Core Security]";
const BRANCH_PREFIXES = ["feat/core-security-", "fix/core-security-", "security/core-"];

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

function currentBranch(envObj) {
  const env = envObj || process.env;
  if (env.GITHUB_HEAD_REF) return String(env.GITHUB_HEAD_REF).trim();
  const r = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  return String(r.stdout || "").trim();
}

function readPrTitle(envObj) {
  const env = envObj || process.env;
  const direct = String(env.PR_TITLE || "").trim();
  if (direct) return direct;
  const eventPath = String(env.GITHUB_EVENT_PATH || "").trim();
  if (!eventPath || !fs.existsSync(eventPath)) return "";
  try {
    const ev = JSON.parse(fs.readFileSync(eventPath, "utf8"));
    return String((ev && ev.pull_request && ev.pull_request.title) || ev.title || "").trim();
  } catch (_err) {
    return "";
  }
}

function titleAuthorized(prTitle, manifest) {
  const token = String((manifest && manifest.explicitScope && manifest.explicitScope.prTitleToken) || TITLE_TOKEN);
  const title = String(prTitle || "");
  return Boolean(title && title.indexOf(token) >= 0);
}

function branchAuthorized(branch, manifest) {
  const prefixes =
    (manifest && manifest.explicitScope && manifest.explicitScope.branchPrefixes) || BRANCH_PREFIXES;
  const b = String(branch || "");
  return prefixes.some((prefix) => prefix && b.indexOf(prefix) === 0);
}

function isAuthorizedCoreSecurity({ branch, prTitle, env } = {}) {
  const manifest = loadManifest();
  const envObj = env || {};
  if (String(envObj.ALLOW_CORE_SECURITY_TOUCH || "").trim() === "1") {
    /* bypass is ignored */
  }
  return titleAuthorized(prTitle, manifest) && branchAuthorized(branch, manifest);
}

function markerRegexes(file, manifest) {
  const markers = (manifest.sharedScan && manifest.sharedScan[file] && manifest.sharedScan[file].markers) || [];
  return markers.map((m) => {
    const escaped = String(m).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    return new RegExp(escaped);
  });
}

function nearbyLinesFromDiff(diff) {
  const lines = [];
  const text = String(diff || "");
  if (!text.trim()) return lines;
  text.split(/\r?\n/).forEach((line) => {
    if (
      line.startsWith("+++") ||
      line.startsWith("---") ||
      line.startsWith("diff ") ||
      line.startsWith("index ") ||
      line.startsWith("@@")
    ) {
      return;
    }
    if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) {
      lines.push(line.slice(1));
    }
  });
  return lines;
}

function sharedDiffTouches(file, diffText, manifest) {
  const text = String(diffText || "");
  if (!text.trim()) {
    return { touches: true, uncertain: true, reason: "empty_or_unreadable_shared_diff" };
  }
  const lines = nearbyLinesFromDiff(text);
  if (!lines.length) {
    return { touches: true, uncertain: true, reason: "empty_or_unreadable_shared_diff" };
  }
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

function defaultExists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

function evaluateGuard({ files, diffsByFile, branch, prTitle, env, existsImpl } = {}) {
  const manifest = loadManifest();
  const scoped = isAuthorizedCoreSecurity({ branch, prTitle, env });
  const exists = existsImpl || defaultExists;
  const list = (files || []).map(normPath);
  const protectedHits = [];
  const sharedHits = [];
  const uncertainHits = [];
  const deletedHits = [];

  list.forEach((file) => {
    const kind = classifyFile(file, manifest);
    if (kind === "protected") {
      protectedHits.push(file);
      if (!exists(file)) deletedHits.push(file);
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

  if (deletedHits.length) {
    return {
      ok: false,
      scoped,
      coreTouched: true,
      regressionRequired: false,
      protectedHits,
      sharedHits,
      uncertainHits,
      deletedHits,
      reason: "protected_file_deleted",
      message: FAIL_MESSAGE,
    };
  }

  const coreTouched = protectedHits.length > 0 || sharedHits.length > 0;
  if (!coreTouched) {
    return {
      ok: true,
      scoped,
      coreTouched: false,
      regressionRequired: false,
      protectedHits,
      sharedHits,
      message: "No Core Security protected surface changes.",
    };
  }
  if (!scoped) {
    return {
      ok: false,
      scoped,
      coreTouched: true,
      regressionRequired: true,
      protectedHits,
      sharedHits,
      uncertainHits,
      reason: "unauthorized_core_security_touch",
      message: (manifest && manifest.scopeFailMessage) || FAIL_MESSAGE,
    };
  }
  return {
    ok: true,
    scoped,
    coreTouched: true,
    regressionRequired: true,
    protectedHits,
    sharedHits,
    uncertainHits,
    message: "Core Security protected files changed under Core Security scope. Run: " + RUNNER,
  };
}

function unique(list) {
  return Array.from(new Set((list || []).map(normPath).filter(Boolean)));
}

function isSafeGitSha(value) {
  return /^[0-9a-f]{7,40}$/i.test(String(value || "").trim());
}

function isSafeBaseRef(value) {
  const v = String(value || "").trim();
  if (!v) return false;
  if (isSafeGitSha(v)) return true;
  if (v === "origin/main") return true;
  return false;
}

function resolveBaseRef(envObj, gitImpl) {
  const env = envObj || process.env;
  const requested = String(env.BASE_REF || "").trim();
  if (!requested) return { ok: false, ref: "", reason: "unresolved_base_ref" };
  if (!isSafeBaseRef(requested)) return { ok: false, ref: requested, reason: "unsafe_base_ref" };
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

function hunk(body) {
  return "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n" + body;
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

  const coreFile = "scripts/test-core-session-security.js";
  const authorized = {
    branch: "feat/core-security-shield-v2",
    prTitle: "[Core Security] Add Core Security Protected Surface V2",
  };

  pass(
    "PR without Core title + exact file fails",
    evaluateGuard({
      files: [coreFile],
      branch: "feat/core-security-shield-v2",
      prTitle: "Add tests",
    }).ok === false
  );

  pass(
    "correct title but wrong branch fails",
    evaluateGuard({
      files: [coreFile],
      branch: "feat/seller-layout",
      prTitle: "[Core Security] harden",
    }).ok === false
  );

  pass(
    "correct branch but wrong title fails",
    evaluateGuard({
      files: [coreFile],
      branch: "feat/core-security-shield-v2",
      prTitle: "Shield work",
    }).ok === false
  );

  const both = evaluateGuard({
    files: [coreFile],
    ...authorized,
  });
  pass("title and branch together pass", both.ok === true);
  pass("title and branch require Core V1 regression", both.regressionRequired === true);

  pass(
    "unrelated change passes",
    evaluateGuard({
      files: ["README.md"],
      branch: "feat/docs",
      prTitle: "Docs",
    }).ok === true
  );

  pass(
    "Seller-only change is Core scope PASS",
    evaluateGuard({
      files: ["public/sales.html", "public/js/sales-device-portal.js"],
      branch: "feat/seller-hours-publish-parity",
      prTitle: "[Seller] hours",
    }).ok === true
  );

  pass(
    "Owner-only change is Core scope PASS",
    evaluateGuard({
      files: ["public/owner.html", "public/js/owner-voice-operational-plan.js"],
      branch: "feat/owner-shield-v2",
      prTitle: "[Owner] voice",
    }).ok === true
  );

  pass(
    "Invoice Hub-only change is Core scope PASS",
    evaluateGuard({
      files: ["public/estimates-invoices.html", "netlify/functions/list-tenant-invoices.js"],
      branch: "feat/invoice-hub-shield-v2",
      prTitle: "[Invoice Hub] list",
    }).ok === true
  );

  const sharedCore = evaluateGuard({
    files: ["netlify/functions/_lib/session.js"],
    diffsByFile: {
      "netlify/functions/_lib/session.js": hunk(
        "-function verify(token) { return null; }\n+function verify(token) { return {}; }\n"
      ),
    },
    branch: "feat/seller-layout",
    prTitle: "[Seller] hours",
  });
  pass("shared Core region without authorization fails", sharedCore.ok === false);

  const sharedPlain = evaluateGuard({
    files: ["netlify/functions/_lib/session.js"],
    diffsByFile: {
      "netlify/functions/_lib/session.js": hunk("-const unused = 1;\n+const unused = 2;\n"),
    },
    branch: "feat/seller-layout",
    prTitle: "[Seller] hours",
  });
  pass(
    "shared non-Core lines pass",
    sharedPlain.ok === true && sharedPlain.coreTouched === false
  );

  const emptyShared = evaluateGuard({
    files: ["netlify/functions/_lib/session.js"],
    diffsByFile: { "netlify/functions/_lib/session.js": "" },
    branch: "feat/seller-layout",
    prTitle: "[Seller] hours",
  });
  pass("empty shared diff fails closed", emptyShared.ok === false && emptyShared.uncertainHits.length > 0);

  const missingDiff = evaluateGuard({
    files: ["netlify/functions/_lib/tenant-device-guard.js"],
    diffsByFile: {},
    branch: "feat/seller-layout",
    prTitle: "[Seller] hours",
  });
  pass("missing shared diff fails closed", missingDiff.ok === false);

  const nearby = evaluateGuard({
    files: ["netlify/functions/_lib/session.js"],
    diffsByFile: {
      "netlify/functions/_lib/session.js":
        "diff --git a/session.js b/session.js\n--- a/a\n+++ b/b\n@@ -8,6 +8,6 @@\n function verify(token) {\n   const unused = 1;\n-  return old;\n+  return neu;\n }\n",
    },
    branch: "feat/seller-layout",
    prTitle: "[Seller] hours",
  });
  pass("nearby context marker in shared diff fails", nearby.ok === false);

  pass(
    "Core workflow modified outside scope fails",
    evaluateGuard({
      files: [".github/workflows/core-security-shield-v1.yml"],
      branch: "feat/seller-layout",
      prTitle: "[Seller] hours",
    }).ok === false
  );

  pass(
    "guard modified outside scope fails",
    evaluateGuard({
      files: ["scripts/guard-core-security-scope.js"],
      branch: "feat/misc",
      prTitle: "misc",
    }).ok === false
  );

  pass(
    "manifest modified outside scope fails",
    evaluateGuard({
      files: ["scripts/mg-core-security-shield-v1.json"],
      branch: "feat/owner-voice",
      prTitle: "[Owner] voice",
    }).ok === false
  );

  const deleted = evaluateGuard({
    files: [coreFile],
    existsImpl: () => false,
    ...authorized,
  });
  pass("protected file deleted fails even when authorized", deleted.ok === false);
  pass("protected file deleted reason", deleted.reason === "protected_file_deleted");

  pass(
    "missing BASE_REF fails",
    resolveBaseRef({}).ok === false && resolveBaseRef({}).reason === "unresolved_base_ref"
  );
  pass(
    "unresolved BASE_REF fails",
    resolveBaseRef({ BASE_REF: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, () => ({ status: 1 })).ok === false
  );
  pass("unsafe BASE_REF fails", resolveBaseRef({ BASE_REF: ";calc.exe" }).ok === false);
  pass("unsafe git sha rejected", isSafeGitSha(";calc.exe") === false);
  pass("safe git sha accepted", isSafeGitSha("64484a68959cd956485dd2bb0db6dbef92488bf8") === true);

  pass(
    "shell metacharacters in branch do not authorize",
    evaluateGuard({
      files: [coreFile],
      branch: ";rm -rf /",
      prTitle: "[Core Security] x",
    }).ok === false
  );
  pass("shell injection in BASE_REF fails", resolveBaseRef({ BASE_REF: "$(reboot)" }).ok === false);
  pass(
    "labels do not authorize",
    evaluateGuard({
      files: [coreFile],
      branch: "feat/misc",
      prTitle: "misc",
      env: { PR_LABELS: "security,core" },
    }).ok === false
  );
  pass(
    "prefix without trailing hyphen does not authorize",
    isAuthorizedCoreSecurity({
      branch: "feat/core-security",
      prTitle: "[Core Security] x",
    }) === false
  );
  pass(
    "git is spawned with array args",
    /spawnSync\("git", args/.test(src)
  );
  pass("spawnSync is not invoked with shell true", !/shell:\s*true/.test(src));
  pass("title is not interpolated into git args", !/git\(\[[^\]]*PR_TITLE/.test(src));

  pass(
    "ALLOW_CORE_SECURITY_TOUCH has no effect",
    evaluateGuard({
      files: [coreFile],
      branch: "feat/seller-layout",
      prTitle: "nope",
      env: { ALLOW_CORE_SECURITY_TOUCH: "1" },
    }).ok === false
  );
  pass(
    "generic security substring does not authorize",
    evaluateGuard({
      files: [coreFile],
      branch: "feat/security-hardening",
      prTitle: "[Core Security] harden",
    }).ok === false
  );
  pass(
    "[Core Security] with Seller branch does not authorize",
    evaluateGuard({
      files: [coreFile],
      branch: "feat/seller-shield-v2",
      prTitle: "[Core Security] no",
    }).ok === false
  );
  pass(
    "[Core Security] with Owner branch does not authorize",
    evaluateGuard({
      files: [coreFile],
      branch: "feat/owner-shield-v2",
      prTitle: "[Core Security] no",
    }).ok === false
  );
  pass(
    "Core branch without title does not authorize",
    evaluateGuard({
      files: [coreFile],
      branch: "fix/core-security-hmac",
      prTitle: "hmac",
    }).ok === false
  );
  pass(
    "bare core/owner/seller/support branches do not authorize",
    isAuthorizedCoreSecurity({ branch: "core", prTitle: "[Core Security] x" }) === false &&
      isAuthorizedCoreSecurity({ branch: "owner", prTitle: "[Core Security] x" }) === false &&
      isAuthorizedCoreSecurity({ branch: "seller", prTitle: "[Core Security] x" }) === false &&
      isAuthorizedCoreSecurity({ branch: "support", prTitle: "[Core Security] x" }) === false
  );

  const wfCore = fs.readFileSync(path.join(ROOT, ".github/workflows/core-security-shield-v1.yml"), "utf8");
  const wfSeller = fs.readFileSync(path.join(ROOT, ".github/workflows/seller-shield-v1.yml"), "utf8");
  const wfOwner = fs.readFileSync(path.join(ROOT, ".github/workflows/owner-shield-v1.yml"), "utf8");
  const wfHub = fs.readFileSync(path.join(ROOT, ".github/workflows/invoice-hub-shield-v2.yml"), "utf8");
  pass("Core Security Shield V1 name frozen", /^name:\s*Core Security Shield V1\s*$/m.test(wfCore));
  pass("Seller Shield V1 name frozen", /^name:\s*Seller Shield V1\s*$/m.test(wfSeller));
  pass("Owner Shield V1 name frozen", /^name:\s*Owner Shield V1\s*$/m.test(wfOwner));
  pass("Invoice Hub Shield V2 name frozen", /^name:\s*Invoice Hub Shield V2\s*$/m.test(wfHub));

  pass(
    "no allowEnv bypass key in manifest",
    !manifest.explicitScope || manifest.explicitScope.allowEnv == null
  );
  pass("requireTitleAndBranch is frozen", manifest.explicitScope.requireTitleAndBranch === true);
  pass(
    "guard and V2 test are exact protected",
    (manifest.exact || []).indexOf("scripts/guard-core-security-scope.js") >= 0 &&
      (manifest.exact || []).indexOf("scripts/test-core-security-shield-v2.js") >= 0
  );
  pass(
    "authorized Core workflow change requires regression",
    evaluateGuard({
      files: [".github/workflows/core-security-shield-v1.yml"],
      ...authorized,
    }).regressionRequired === true
  );

  const fixBranch = evaluateGuard({
    files: [coreFile],
    branch: "fix/core-security-hmac",
    prTitle: "[Core Security] hmac",
  });
  pass("fix/core-security- prefix authorizes with title", fixBranch.ok === true);
  const securityCore = evaluateGuard({
    files: [coreFile],
    branch: "security/core-hmac",
    prTitle: "[Core Security] hmac",
  });
  pass("security/core- prefix authorizes with title", securityCore.ok === true);

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
    console.log("shared Core-region files:\n- " + result.sharedHits.join("\n- "));
  }
  if (result.deletedHits && result.deletedHits.length) {
    console.log("deleted protected files:\n- " + result.deletedHits.join("\n- "));
  }
  if (result.regressionRequired) {
    console.log("CORE_SECURITY_REGRESSION_REQUIRED=1");
  }
  console.log(result.message);

  if (!result.ok) {
    process.exit(1);
  }
}

module.exports = {
  FAIL_MESSAGE,
  TITLE_TOKEN,
  BRANCH_PREFIXES,
  loadManifest,
  classifyFile,
  isAuthorizedCoreSecurity,
  evaluateGuard,
  nearbyLinesFromDiff,
  isSafeGitSha,
  isSafeBaseRef,
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
