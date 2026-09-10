#!/usr/bin/env node
/**
 * Margin Guard Core Security Shield V1 — orchestrate core security suites.
 * Isolated: dummy identity env, no shell, no live Netlify/Supabase/Zapier/OpenAI/email.
 * Required: node scripts/test-mg-core-security-shield-v1.js
 * Full:     node scripts/test-mg-core-security-shield-v1.js --full
 * Product behavior is not changed. Existing Seller/Owner/Invoice Hub runners are not copied.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const MANIFEST_PATH = path.join(__dirname, "mg-core-security-shield-v1.json");
const KNOWN_GAP_PREFIX = "KNOWN GAP — NOT YET PROTECTED";
const CATEGORIES = [
  "TENANT_SCOPED_CONFIRMED",
  "PUBLIC_TOKEN_SCOPED",
  "SIGNED_WEBHOOK",
  "PLATFORM_ADMIN_ONLY",
  "INTERNAL_SECRET_AUTH",
  "DOCUMENTED_EXCEPTION",
  "VULNERABILITY_REQUIRES_SEPARATE_PR",
];

function validateManifest(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "invalid_manifest" };
  }
  if (!Array.isArray(raw.required) || raw.required.length === 0) {
    return { ok: false, reason: "invalid_manifest" };
  }
  if (raw.optional != null && !Array.isArray(raw.optional)) {
    return { ok: false, reason: "invalid_manifest" };
  }
  const requiredPaths = new Set();
  for (let i = 0; i < raw.required.length; i += 1) {
    const row = raw.required[i];
    if (!row || typeof row !== "object" || !row.id || !row.path) {
      return { ok: false, reason: "invalid_manifest" };
    }
    if (requiredPaths.has(row.path)) {
      return { ok: false, reason: "invalid_manifest" };
    }
    requiredPaths.add(row.path);
  }
  const optional = raw.optional || [];
  for (let i = 0; i < optional.length; i += 1) {
    const row = optional[i];
    if (row && requiredPaths.has(row.path)) {
      return { ok: false, reason: "required_marked_optional" };
    }
  }
  if (Array.isArray(raw.handlerInventory)) {
    for (let i = 0; i < raw.handlerInventory.length; i += 1) {
      const row = raw.handlerInventory[i];
      if (!row || !row.file || CATEGORIES.indexOf(row.category) < 0) {
        return { ok: false, reason: "invalid_manifest" };
      }
    }
  }
  return { ok: true, manifest: raw };
}

function loadManifest(filePath) {
  const p = filePath || MANIFEST_PATH;
  if (!fs.existsSync(p)) {
    const err = new Error("missing_manifest");
    err.code = "missing_manifest";
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (_err) {
    const err = new Error("invalid_manifest");
    err.code = "invalid_manifest";
    throw err;
  }
  const validated = validateManifest(parsed);
  if (!validated.ok) {
    const err = new Error(validated.reason);
    err.code = validated.reason;
    throw err;
  }
  return validated.manifest;
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
        ". Allowed: --full (adds optional Core Security suites when present).",
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
    "ZAPIER_INVOICE_REMINDER_WEBHOOK",
    "ZAPIER_WEBHOOK_SECRET",
    "OPENAI_API_KEY",
    "NETLIFY_AUTH_TOKEN",
    "NETLIFY_SITE_ID",
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "STRIPE_INVOICE_WEBHOOK_SECRET",
    "SQUARE_ACCESS_TOKEN",
    "SQUARE_WEBHOOK_SIGNATURE_KEY",
    "INTERNAL_API_KEY",
    "SENDGRID_API_KEY",
    "SESSION_SECRET",
    "SUPABASE_SERVICE_ROLE_KEY",
  ].forEach((key) => {
    delete env[key];
  });
  env.SESSION_SECRET = "mg-core-security-shield-v1-isolated-session";
  env.SUPABASE_URL = "https://example.supabase.co";
  env.SUPABASE_SERVICE_ROLE_KEY = "mg-core-security-shield-v1-isolated-key";
  env.SUPABASE_ANON_KEY = "mg-core-security-shield-v1-isolated-anon";
  env.INTERNAL_API_KEY = "mg-core-security-shield-v1-isolated-internal";
  env.STRIPE_INVOICE_WEBHOOK_SECRET = "mg-core-security-shield-v1-isolated-stripe-whsec";
  env.SQUARE_WEBHOOK_SIGNATURE_KEY = "mg-core-security-shield-v1-isolated-square-key";
  env.SQUARE_WEBHOOK_NOTIFICATION_URL = "https://example.invalid/square-webhook";
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

function failClosed(writeErr, reason, extra) {
  const err = extra || {};
  writeErr((err.error || reason) + "\n");
  return Object.assign(
    {
      ok: false,
      result: "FAIL",
      error: err.error || reason,
      reason,
      requiredRan: 0,
      optionalRan: 0,
      optionalOmitted: 0,
      totalPassed: 0,
      durationMs: 0,
      spawned: [],
      results: [],
      failed: [{ rel: "manifest", reason }],
    },
    err
  );
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

  let manifest;
  try {
    if (opts.manifest) {
      const validated = validateManifest(opts.manifest);
      if (!validated.ok) {
        return failClosed(writeErr, validated.reason);
      }
      manifest = validated.manifest;
    } else {
      manifest = loadManifest(opts.manifestPath);
    }
  } catch (err) {
    const reason = (err && err.code) || "invalid_manifest";
    return failClosed(writeErr, reason, { error: reason });
  }

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
  const requiredSkipped = requiredResults.some((row) => row.skipped);
  const requiredIncomplete = requiredResults.some((row) => row.skipped || row.missing || !row.ok);
  const failed = results.filter((row) => !row.ok);
  if (requiredSkipped) {
    failed.push({ rel: "required", reason: "required_skipped", skipped: true });
  }
  const requiredRan = requiredResults.filter((row) => !row.missing && !row.skipped).length;
  const optionalRan = optionalResults.filter((row) => !row.missing && !row.skipped).length;
  const optionalOmitted =
    omittedOptional.length + optionalResults.filter((row) => row.skipped).length;
  const totalPassed = results.reduce((sum, row) => sum + Number(row.passed || 0), 0);
  const durationMs = Math.max(0, deps.now() - started);
  const ok = failed.length === 0 && !requiredIncomplete && requiredRan === required.length;
  const result = ok ? "PASS" : "FAIL";

  log("\n--- Margin Guard Core Security Shield V1 ---");
  log("mode=" + (parsedArgs.full ? "full" : "required"));
  log("required ran: " + requiredRan + "/" + required.length);
  log("optional ran: " + optionalRan);
  log("optional omitted: " + optionalOmitted);
  log("total passed: " + totalPassed);
  log("duration_ms: " + durationMs);
  printKnownGaps(manifest.knownGaps, log);
  log("webhook: ESTIMATES_HMAC_PHASE1_COMPATIBILITY_MODE");
  log("rls: PRODUCTION_RLS_NOT_VERIFIED");
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
  CATEGORIES,
  KNOWN_GAP_PREFIX,
  ROOT,
  MANIFEST_PATH,
  isolatedChildEnv,
  loadManifest,
  parseArgv,
  parsePassedCount,
  resolveSuitePath,
  runShield,
  stripAnsi,
  validateManifest,
};

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  }
}
