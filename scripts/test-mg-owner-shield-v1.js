#!/usr/bin/env node
/**
 * Margin Guard Owner Shield V1 — orchestrate existing Owner contract suites.
 * Isolated: dummy identity env, no shell, no live Netlify/Supabase/Zapier/OpenAI/email.
 * Required: node scripts/test-mg-owner-shield-v1.js
 * Full:     node scripts/test-mg-owner-shield-v1.js --full
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const MANIFEST_PATH = path.join(__dirname, "mg-owner-shield-v1.json");
const KNOWN_GAP_PREFIX = "KNOWN GAP — NOT YET PROTECTED";
const OPTIONAL_004B = "scripts/test-mg-sales-ready-004b.js";
const OPTIONAL_HUB = "scripts/test-invoice-hub-regression-suite.js";

function loadManifest(filePath) {
  return JSON.parse(fs.readFileSync(filePath || MANIFEST_PATH, "utf8"));
}

function stripAnsi(text) {
  return String(text || "").replace(/\u001b\[[0-9;]*m/g, "");
}

function parseArgv(argv) {
  const args = (argv || []).slice(2);
  let full = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--full") {
      full = true;
      continue;
    }
    return {
      ok: false,
      error:
        "Unknown argument: " +
        arg +
        ". Allowed: --full (adds Invoice Hub regression plus optional Owner-adjacent suites).",
    };
  }
  return { ok: true, full };
}

function parsePassedCount(stdout, stderr) {
  const text = stripAnsi(String(stdout || "") + "\n" + String(stderr || ""));
  const hub = text.match(
    /--- Invoice Hub regression summary ---\s*ran (\d+)\s*skipped optional missing \d+\s*failed (\d+)/
  );
  if (hub) {
    const ran = Number(hub[1]);
    const failed = Number(hub[2]);
    if (failed === 0 && ran > 0) {
      return {
        ok: true,
        passed: ran,
        line: "Invoice Hub ran " + ran + ", failed 0",
      };
    }
    return { ok: false, passed: 0, reason: "unrecognizable_summary" };
  }
  const lines = text.split(/\r?\n/);
  const patterns = [
    /Passed\s+(\d+)\s+assertions\.?/i,
    /(\d+)\s+assertions passed/i,
    /(\d+)\s+passed(?:\s*,\s*\d+\s+failed)?/i,
  ];
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    for (let p = 0; p < patterns.length; p += 1) {
      const match = line.match(patterns[p]);
      if (match) {
        return { ok: true, passed: Number(match[1]), line: line.trim() };
      }
    }
  }
  return { ok: false, passed: 0, reason: "unrecognizable_summary" };
}

function resolveSuitePath(root, rel) {
  const n = String(rel || "").replace(/\\/g, "/");
  if (!n || n.startsWith("/") || /^[a-zA-Z]:/.test(n)) {
    return { ok: false, reason: "illegal_suite_path" };
  }
  if (/[;&|`$<>]/.test(n)) {
    return { ok: false, reason: "illegal_suite_path" };
  }
  const parts = n.split("/");
  if (parts.some((part) => part === ".." || part === "")) {
    return { ok: false, reason: "illegal_suite_path" };
  }
  const rootAbs = path.resolve(root);
  const abs = path.resolve(rootAbs, n);
  const relToRoot = path.relative(rootAbs, abs);
  if (!relToRoot || relToRoot.startsWith("..") || path.isAbsolute(relToRoot)) {
    return { ok: false, reason: "path_escape" };
  }
  return { ok: true, abs, rel: n };
}

function isolatedChildEnv(baseEnv) {
  const env = Object.assign({}, baseEnv || {});
  [
    "ZAPIER_WEBHOOK_URL",
    "ZAPIER_ESTIMATE_CTA_WEBHOOK_URL",
    "ZAPIER_INVOICE_REMINDER_WEBHOOK",
    "ZAPIER_WEBHOOK_SECRET",
    "OPENAI_API_KEY",
    "NETLIFY_AUTH_TOKEN",
    "NETLIFY_SITE_ID",
  ].forEach((key) => {
    delete env[key];
  });
  env.SESSION_SECRET = "mg-owner-shield-v1-isolated-session";
  env.SUPABASE_URL = "https://example.supabase.co";
  env.SUPABASE_SERVICE_ROLE_KEY = "mg-owner-shield-v1-isolated-key";
  env.URL = "https://example.invalid";
  return env;
}

function defaultExists(root, rel) {
  return fs.existsSync(path.join(root, rel));
}

function defaultSpawn(absPath, root, env) {
  return spawnSync(process.execPath, [absPath], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    env,
  });
}

function endsWithRel(absPath, rel) {
  return String(absPath || "")
    .replace(/\\/g, "/")
    .endsWith("/" + String(rel || "").replace(/\\/g, "/").replace(/^\.\//, ""));
}

function runOne(entry, required, deps) {
  const rel = entry.path;
  const minPassed = Number(entry.minPassed || 1);
  const resolved = resolveSuitePath(deps.root, rel);
  if (!resolved.ok) {
    return {
      ok: false,
      required,
      missing: true,
      skipped: false,
      rel,
      reason: resolved.reason,
      passed: 0,
      ms: 0,
    };
  }
  if (!deps.existsImpl(deps.root, resolved.rel)) {
    if (required) {
      return {
        ok: false,
        required: true,
        missing: true,
        skipped: false,
        rel: resolved.rel,
        reason: "missing_required",
        passed: 0,
        ms: 0,
      };
    }
    return {
      ok: true,
      required: false,
      missing: true,
      skipped: true,
      rel: resolved.rel,
      reason: "missing_optional",
      passed: 0,
      ms: 0,
    };
  }

  const started = deps.now();
  deps.log("\n=== " + resolved.rel + " ===");
  const spawned = deps.spawnImpl(resolved.abs, deps.root, deps.env);
  const ms = Math.max(0, deps.now() - started);
  const stdout = spawned && spawned.stdout ? spawned.stdout : "";
  const stderr = spawned && spawned.stderr ? spawned.stderr : "";
  if (stdout) deps.writeOut(stdout);
  if (stderr) deps.writeErr(stderr);

  const status = spawned && typeof spawned.status === "number" ? spawned.status : 1;
  if (status !== 0) {
    return {
      ok: false,
      required,
      missing: false,
      skipped: false,
      rel: resolved.rel,
      reason: "nonzero_exit",
      status,
      passed: 0,
      ms,
    };
  }

  const parsed = parsePassedCount(stdout, stderr);
  if (!parsed.ok) {
    return {
      ok: false,
      required,
      missing: false,
      skipped: false,
      rel: resolved.rel,
      reason: "unrecognizable_summary",
      status,
      passed: 0,
      ms,
    };
  }
  if (parsed.passed === 0) {
    return {
      ok: false,
      required,
      missing: false,
      skipped: false,
      rel: resolved.rel,
      reason: "zero_tests",
      status,
      passed: 0,
      ms,
    };
  }
  if (parsed.passed < minPassed) {
    return {
      ok: false,
      required,
      missing: false,
      skipped: false,
      rel: resolved.rel,
      reason: "below_min_passed",
      status,
      passed: parsed.passed,
      minPassed,
      ms,
    };
  }

  deps.log("OK " + resolved.rel + " (" + parsed.passed + " passed, " + ms + "ms)");
  return {
    ok: true,
    required,
    missing: false,
    skipped: false,
    rel: resolved.rel,
    reason: "ok",
    status: 0,
    passed: parsed.passed,
    ms,
  };
}

function printKnownGaps(gaps, log) {
  (gaps || []).forEach((gap) => {
    log(KNOWN_GAP_PREFIX + ": " + gap);
  });
}

const GUARD_REL = "scripts/guard-owner-scope.js";

function isSafeGitSha(value) {
  return /^[0-9a-f]{7,40}$/i.test(String(value || "").trim());
}

function defaultGit(root, args) {
  return spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
  });
}

function readGithubPullRequestContext(env, readFileImpl) {
  const envObj = env || {};
  if (String(envObj.GITHUB_EVENT_NAME || "").trim() === "merge_group") {
    return { skip: true, reason: "merge_group", title: "", head: "", baseSha: "" };
  }
  let title = "";
  let head = "";
  let baseSha = "";
  const eventPath = String(envObj.GITHUB_EVENT_PATH || "").trim();
  if (eventPath) {
    try {
      const readFile = readFileImpl || fs.readFileSync;
      const ev = JSON.parse(readFile(eventPath, "utf8"));
      const pr = ev && ev.pull_request ? ev.pull_request : {};
      title = String(pr.title || "").trim();
      head = String((pr.head && pr.head.ref) || "").trim();
      baseSha = String((pr.base && pr.base.sha) || "").trim();
    } catch (_err) {
      return {
        skip: false,
        ok: false,
        reason: "invalid_github_event_path",
        title: "",
        head: "",
        baseSha: "",
      };
    }
  }
  if (!title) title = String(envObj.PR_TITLE || "").trim();
  if (!head) head = String(envObj.GITHUB_HEAD_REF || "").trim();
  if (!baseSha) baseSha = String(envObj.BASE_REF || "").trim();
  if (!baseSha) baseSha = "origin/main";
  return { skip: false, ok: true, reason: "", title, head, baseSha };
}

function ensureBaseRefAvailable(root, baseRef, gitImpl) {
  const git =
    gitImpl ||
    function (args) {
      return defaultGit(root, args);
    };
  const probe = git(["rev-parse", "--verify", String(baseRef || "") + "^{commit}"]);
  if (probe && probe.status === 0) return { ok: true, fetched: false };
  if (!isSafeGitSha(baseRef)) {
    return { ok: false, fetched: false, reason: "unresolved_base_ref" };
  }
  const fetched = git(["fetch", "--no-tags", "--depth=1", "origin", String(baseRef).trim()]);
  if (!fetched || fetched.status !== 0) {
    return { ok: false, fetched: false, reason: "fetch_failed" };
  }
  return { ok: true, fetched: true };
}

function guardChildEnv(baseEnv, ctx) {
  const env = Object.assign({}, baseEnv || {});
  delete env.ALLOW_OWNER_TOUCH;
  env.BASE_REF = ctx.baseSha;
  env.PR_TITLE = ctx.title;
  env.GITHUB_HEAD_REF = ctx.head;
  return env;
}

function defaultGuardSpawn(absPath, root, env) {
  return spawnSync(process.execPath, [absPath], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    env,
  });
}

function runRealOwnerGuard(opts) {
  const options = opts || {};
  const root = options.root || ROOT;
  const env = options.env || {};
  const log = options.log || console.log;
  const writeOut = options.writeOut || ((chunk) => process.stdout.write(chunk));
  const writeErr = options.writeErr || ((chunk) => process.stderr.write(chunk));
  const ctx = readGithubPullRequestContext(env, options.readFileImpl);
  if (ctx.skip) {
    log("Owner real guard skipped (" + ctx.reason + ")");
    return { ok: true, skipped: true, reason: ctx.reason, status: 0 };
  }
  if (ctx.ok === false) {
    log("FAIL " + GUARD_REL + " reason=" + ctx.reason);
    return { ok: false, skipped: false, reason: ctx.reason, status: 1 };
  }
  const ensured = ensureBaseRefAvailable(root, ctx.baseSha, options.gitImpl);
  if (!ensured.ok) {
    log("FAIL " + GUARD_REL + " reason=" + ensured.reason);
    return { ok: false, skipped: false, reason: ensured.reason, status: 1, env: guardChildEnv(env, ctx) };
  }
  const resolved = resolveSuitePath(root, GUARD_REL);
  if (!resolved.ok) {
    return { ok: false, skipped: false, reason: resolved.reason, status: 1 };
  }
  const childEnv = guardChildEnv(env, ctx);
  log("=== " + GUARD_REL + " ===");
  const spawnGuard = options.guardSpawnImpl || defaultGuardSpawn;
  const spawned = spawnGuard(resolved.abs, root, childEnv);
  const stdout = spawned && spawned.stdout ? spawned.stdout : "";
  const stderr = spawned && spawned.stderr ? spawned.stderr : "";
  if (stdout) writeOut(stdout);
  if (stderr) writeErr(stderr);
  const status = spawned && typeof spawned.status === "number" ? spawned.status : 1;
  if (status !== 0) {
    log("FAIL " + GUARD_REL + " reason=nonzero_exit");
    return { ok: false, skipped: false, reason: "nonzero_exit", status, env: childEnv };
  }
  log("OK " + GUARD_REL);
  return { ok: true, skipped: false, reason: "ok", status: 0, env: childEnv, fetched: ensured.fetched };
}

function runShield(options) {
  const opts = options || {};
  const root = opts.root || ROOT;
  const log = opts.log || console.log;
  const writeOut = opts.writeOut || ((chunk) => process.stdout.write(chunk));
  const writeErr = opts.writeErr || ((chunk) => process.stderr.write(chunk));
  const parsedArgs = parseArgv(opts.argv || process.argv);
  if (!parsedArgs.ok) {
    writeErr(parsedArgs.error + "\n");
    return {
      ok: false,
      result: "FAIL",
      error: parsedArgs.error,
      requiredRan: 0,
      optionalRan: 0,
      optionalOmitted: 0,
      totalPassed: 0,
      durationMs: 0,
      spawned: [],
    };
  }

  const manifest = opts.manifest || loadManifest();
  const required = manifest.required || [];
  const optional = parsedArgs.full ? manifest.optional || [] : [];
  const omittedOptional = parsedArgs.full ? [] : manifest.optional || [];
  const deps = {
    root,
    env: isolatedChildEnv(opts.env || process.env),
    existsImpl: opts.existsImpl || defaultExists,
    spawnImpl: opts.spawnImpl || defaultSpawn,
    now: opts.now || Date.now,
    log,
    writeOut,
    writeErr,
  };

  const started = deps.now();
  const results = [];
  const spawned = [];
  const originalSpawn = deps.spawnImpl;
  deps.spawnImpl = function trackedSpawn(absPath, spawnRoot, env) {
    spawned.push(absPath);
    return originalSpawn(absPath, spawnRoot, env);
  };

  let guard = { ok: true, skipped: true, reason: "skipped_by_option", status: 0 };
  if (opts.skipRealGuard !== true) {
    guard = runRealOwnerGuard({
      root,
      env: opts.env || process.env,
      log,
      writeOut,
      writeErr,
      gitImpl: opts.gitImpl,
      guardSpawnImpl: opts.guardSpawnImpl,
      readFileImpl: opts.readFileImpl,
    });
    if (!guard.ok) {
      const durationMs = Math.max(0, deps.now() - started);
      log("\n--- Margin Guard Owner Shield V1 ---");
      log("mode=" + (parsedArgs.full ? "full" : "required"));
      log("required ran: 0/" + required.length);
      log("optional ran: 0");
      log("optional omitted: " + omittedOptional.length);
      log("total passed: 0");
      log("duration_ms: " + durationMs);
      log("webhook: unsigned estimate Zapier JSON POST (not HMAC). Invoice Hub Zapier remains Hub-owned.");
      log("FAIL " + GUARD_REL + " reason=" + guard.reason);
      log("RESULT: FAIL");
      return {
        ok: false,
        result: "FAIL",
        full: parsedArgs.full,
        requiredRan: 0,
        optionalRan: 0,
        optionalOmitted: omittedOptional.length,
        totalPassed: 0,
        durationMs,
        spawned,
        ran004b: false,
        ranHub: false,
        results: [],
        failed: [{ rel: GUARD_REL, reason: guard.reason }],
        guard,
      };
    }
  }

  required.forEach((entry) => {
    results.push(runOne(entry, true, deps));
  });
  optional.forEach((entry) => {
    results.push(runOne(entry, false, deps));
  });

  const requiredResults = results.filter((row) => row.required);
  const optionalResults = results.filter((row) => !row.required);
  const requiredIncomplete = requiredResults.some((row) => row.skipped || row.missing || !row.ok);
  const failed = results.filter((row) => !row.ok);
  const requiredRan = requiredResults.filter((row) => !row.missing && !row.skipped).length;
  const optionalRan = optionalResults.filter((row) => !row.missing && !row.skipped).length;
  const optionalOmitted =
    omittedOptional.length + optionalResults.filter((row) => row.skipped).length;
  const totalPassed = results.reduce((sum, row) => sum + Number(row.passed || 0), 0);
  const durationMs = Math.max(0, deps.now() - started);
  const ran004b = spawned.some((abs) => endsWithRel(abs, OPTIONAL_004B));
  const ranHub = spawned.some((abs) => endsWithRel(abs, OPTIONAL_HUB));
  const ok = failed.length === 0 && !requiredIncomplete && requiredRan === required.length;
  const result = ok ? "PASS" : "FAIL";

  log("\n--- Margin Guard Owner Shield V1 ---");
  log("mode=" + (parsedArgs.full ? "full" : "required"));
  log("required ran: " + requiredRan + "/" + required.length);
  log("optional ran: " + optionalRan);
  log("optional omitted: " + optionalOmitted);
  log("total passed: " + totalPassed);
  log("duration_ms: " + durationMs);
  if (!parsedArgs.full) {
    log("004b executed: no (optional; pass --full to include " + OPTIONAL_004B + ")");
    log("invoice-hub regression executed: no (optional; pass --full to include " + OPTIONAL_HUB + ")");
  } else {
    log("004b executed: " + (ran004b ? "yes" : "no"));
    log("invoice-hub regression executed: " + (ranHub ? "yes" : "no"));
  }
  printKnownGaps(manifest.knownGaps, log);
  log("webhook: unsigned estimate Zapier JSON POST (not HMAC). Invoice Hub Zapier remains Hub-owned.");
  failed.forEach((row) => {
    log("FAIL " + row.rel + " reason=" + row.reason);
  });
  log("RESULT: " + result);

  return {
    ok,
    result,
    full: parsedArgs.full,
    requiredRan,
    optionalRan,
    optionalOmitted,
    totalPassed,
    durationMs,
    spawned,
    ran004b,
    ranHub,
    results,
    failed,
    guard,
  };
}

function main() {
  const outcome = runShield({
    argv: process.argv,
    root: ROOT,
    env: process.env,
  });
  process.exit(outcome.ok ? 0 : 1);
}

module.exports = {
  KNOWN_GAP_PREFIX,
  OPTIONAL_004B,
  OPTIONAL_HUB,
  GUARD_REL,
  ROOT,
  MANIFEST_PATH,
  isolatedChildEnv,
  loadManifest,
  parseArgv,
  parsePassedCount,
  resolveSuitePath,
  runShield,
  stripAnsi,
  isSafeGitSha,
  readGithubPullRequestContext,
  ensureBaseRefAvailable,
  guardChildEnv,
  runRealOwnerGuard,
};

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  }
}
