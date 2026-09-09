#!/usr/bin/env node
/**
 * Margin Guard Seller Shield V1 — orchestrate existing Seller contract suites.
 * Isolated: dummy identity env, no shell, no live Netlify/Supabase/Zapier/OpenAI/email.
 * Required: node scripts/test-mg-seller-shield-v1.js
 * Full:     node scripts/test-mg-seller-shield-v1.js --full
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const MANIFEST_PATH = path.join(__dirname, "mg-seller-shield-v1.json");
const KNOWN_GAP_PREFIX = "KNOWN GAP — NOT YET PROTECTED";
const OPTIONAL_004B = "scripts/test-mg-sales-ready-004b.js";

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
        ". Allowed: --full (adds optional suites such as test-mg-sales-ready-004b.js).",
    };
  }
  return { ok: true, full };
}

function parsePassedCount(stdout, stderr) {
  const text = stripAnsi(String(stdout || "") + "\n" + String(stderr || ""));
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
    "OPENAI_API_KEY",
    "NETLIFY_AUTH_TOKEN",
    "NETLIFY_SITE_ID",
  ].forEach((key) => {
    delete env[key];
  });
  env.SESSION_SECRET = "mg-seller-shield-v1-isolated-session";
  env.SUPABASE_URL = "https://example.supabase.co";
  env.SUPABASE_SERVICE_ROLE_KEY = "mg-seller-shield-v1-isolated-key";
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
  const ran004b = spawned.some((abs) => String(abs).replace(/\\/g, "/").endsWith("/test-mg-sales-ready-004b.js"));
  const ok = failed.length === 0 && !requiredIncomplete && requiredRan === required.length;
  const result = ok ? "PASS" : "FAIL";

  log("\n--- Margin Guard Seller Shield V1 ---");
  log("mode=" + (parsedArgs.full ? "full" : "required"));
  log("required ran: " + requiredRan + "/" + required.length);
  log("optional ran: " + optionalRan);
  log("optional omitted: " + optionalOmitted);
  log("total passed: " + totalPassed);
  log("duration_ms: " + durationMs);
  if (!parsedArgs.full) {
    log("004b executed: no (optional; pass --full to include " + OPTIONAL_004B + ")");
  } else {
    log("004b executed: " + (ran004b ? "yes" : "no"));
  }
  printKnownGaps(manifest.knownGaps, log);
  log("webhook: unsigned estimate Zapier JSON POST (not HMAC)");
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
    results,
    failed,
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
  ROOT,
  MANIFEST_PATH,
  isolatedChildEnv,
  loadManifest,
  parseArgv,
  parsePassedCount,
  resolveSuitePath,
  runShield,
  stripAnsi,
};

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  }
}
