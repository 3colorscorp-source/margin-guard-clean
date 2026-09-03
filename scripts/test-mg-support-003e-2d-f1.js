#!/usr/bin/env node
/**
 * MG-SUPPORT-003E.2D-F1 — Netlify schedule registration proof
 * (local zip-it ISC metadata only). Usage: node scripts/test-mg-support-003e-2d-f1.js
 *
 * Does not deploy, apply SQL, mutate production, set env, send email, or call Zapier.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = path.resolve(__dirname, "..");
const {
  ENV,
  isDeliveryEnabled,
} = require("../netlify/functions/_lib/mg-support/notification-delivery");
const {
  SWEEP_FUNCTION,
  SWEEP_SCHEDULE,
  SWEEP_BATCH_SIZE,
  PENDING_MIN_AGE_MS,
  ELIGIBLE_DELIVERY_STATUS,
  buildPendingSweepPath,
  pendingAgeCutoffIso,
  createHandler,
  sweepPendingSupportCaseNotifications,
} = require("../netlify/functions/_lib/mg-support/notification-sweep");

let failed = 0;
let passed = 0;

function assert(name, cond) {
  if (cond) {
    passed += 1;
    console.log("PASS  " + name);
  } else {
    failed += 1;
    console.log("FAIL  " + name);
  }
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function zisiIscUrl() {
  const rel =
    ".qa-ch013a48/netlify-cli-pkg/node_modules/netlify-cli/node_modules/@netlify/zip-it-and-ship-it/dist/runtimes/node/in_source_config/index.js";
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return null;
  return pathToFileURL(abs).href;
}

function zisiMainUrl() {
  const rel =
    ".qa-ch013a48/netlify-cli-pkg/node_modules/netlify-cli/node_modules/@netlify/zip-it-and-ship-it/dist/main.js";
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return null;
  return pathToFileURL(abs).href;
}

function cliVersion() {
  const pkgPath = path.join(
    ROOT,
    ".qa-ch013a48/netlify-cli-pkg/node_modules/netlify-cli/package.json"
  );
  if (!fs.existsSync(pkgPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(pkgPath, "utf8")).version || null;
  } catch (_err) {
    return null;
  }
}

async function main() {
  const sweepFnSrc = read("netlify/functions/mg-support-case-notification-sweep.js");
  const sweepLibSrc = read("netlify/functions/_lib/mg-support/notification-sweep.js");
  const tomlSrc = fs.existsSync(path.join(ROOT, "netlify.toml")) ? read("netlify.toml") : "";
  const NOW = "2026-08-29T01:00:00.000Z";
  const cutoff = pendingAgeCutoffIso(NOW, PENDING_MIN_AGE_MS);
  const listPath = decodeURIComponent(buildPendingSweepPath(cutoff));

  assert("1. schedule metadata exists in source", /export const config/.test(sweepFnSrc) && /schedule:/.test(sweepFnSrc));
  assert("2. cron exact string literal", SWEEP_SCHEDULE === "*/5 * * * *" && sweepFnSrc.includes('schedule: "*/5 * * * *"'));
  const configBlock = (sweepFnSrc.match(/export const config = \{[\s\S]*?\};/) || [""])[0];
  assert(
    "3. no path config",
    /export const config = \{/.test(configBlock) &&
      !/\bpath\s*:/.test(configBlock) &&
      !/excludedPath|includedPath/.test(configBlock) &&
      !/functions\."mg-support-case-notification-sweep"/.test(tomlSrc)
  );

  const iscHref = zisiIscUrl();
  const mainHref = zisiMainUrl();
  assert("4a. local zip-it-and-ship-it is present", Boolean(iscHref && mainHref));

  let parsed = null;
  let listed = null;
  if (iscHref && mainHref) {
    const { parseFile } = await import(iscHref);
    const { listFunction } = await import(mainHref);
    const file = path.join(ROOT, "netlify/functions/mg-support-case-notification-sweep.js");
    parsed = await parseFile(file, { functionName: SWEEP_FUNCTION });
    listed = await listFunction(file, { parseISC: true });
  }
  assert(
    "4. scheduled configuration recognized by local Netlify tooling",
    parsed &&
      parsed.runtimeAPIVersion === 2 &&
      parsed.config &&
      parsed.config.schedule === "*/5 * * * *" &&
      listed &&
      listed.name === SWEEP_FUNCTION &&
      listed.schedule === "*/5 * * * *" &&
      listed.runtimeAPIVersion === 2
  );
  assert(
    "4b. no generated public routes",
    parsed && Array.isArray(parsed.routes) && parsed.routes.length === 0 && listed && Array.isArray(listed.routes) && listed.routes.length === 0
  );
  assert("4c. V2 ESM input format", parsed && parsed.inputModuleFormat === "esm" && listed && listed.inputModuleFormat === "esm");
  assert("4d. no V1 handler export", !/exports\.handler/.test(sweepFnSrc) && /export default/.test(sweepFnSrc));
  assert(
    "4e. no createRequire / import.meta interop in scheduled entry",
    !/\bcreateRequire\b/.test(sweepFnSrc) &&
      !/from\s+["']node:module["']/.test(sweepFnSrc) &&
      !/import\.meta/.test(sweepFnSrc) &&
      /import\s+\{\s*createHandler\s*\}\s+from\s+["']\.\/_lib\/mg-support\/notification-sweep\.js["']/.test(sweepFnSrc)
  );

  assert(
    "5. no caller filters",
    !/queryStringParameters|event\.body/.test(sweepFnSrc) &&
      listPath.includes("delivery_status=eq.pending") &&
      listPath.includes("limit=10") &&
      !listPath.includes("tenant_id=")
  );
  assert(
    "6. kill switch remains fail-closed",
    isDeliveryEnabled({ env: {} }) === false &&
      isDeliveryEnabled({ env: { [ENV.ENABLED]: "TRUE" } }) === false &&
      isDeliveryEnabled({ env: { [ENV.ENABLED]: "true" } }) === true
  );

  const disabled = await sweepPendingSupportCaseNotifications({
    env: { [ENV.ENABLED]: "false" },
    supabaseRequest: async () => {
      throw new Error("sweep must not query when disabled");
    },
    fetchImpl: async () => {
      throw new Error("sweep must not POST when disabled");
    },
  });
  assert("6b. disabled sweep does not claim or POST", disabled.result === "delivery_disabled" && disabled.selected === 0);

  const getRes = await createHandler({
    env: { [ENV.ENABLED]: "true" },
    sweepPendingSupportCaseNotifications: async () => ({ result: "swept", selected: 1 }),
  })({ httpMethod: "GET", body: "{}" });
  assert("6c. GET defense-in-depth does not sweep", getRes.statusCode === 405);

  assert("7. pending-only + 30s + batch 10", ELIGIBLE_DELIVERY_STATUS === "pending" && PENDING_MIN_AGE_MS === 30000 && SWEEP_BATCH_SIZE === 10);
  assert("8. function name unchanged", SWEEP_FUNCTION === "mg-support-case-notification-sweep");
  assert("9. local Netlify CLI version readable", Boolean(cliVersion()));
  assert("10. D3 helper still owns CAS-free selection only", !/delivery_status:\s*"claimed"/.test(sweepLibSrc) && /dispatchPendingEvent/.test(sweepLibSrc));

  console.log("");
  console.log("zip-it parseFile.config.schedule =", parsed && parsed.config && parsed.config.schedule);
  console.log("zip-it listFunction.schedule =", listed && listed.schedule);
  console.log("zip-it runtimeAPIVersion =", parsed && parsed.runtimeAPIVersion);
  console.log("netlify-cli version =", cliVersion());
  console.log("");
  console.log(passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
