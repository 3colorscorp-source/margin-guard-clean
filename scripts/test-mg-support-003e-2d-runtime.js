#!/usr/bin/env node
/**
 * MG-SUPPORT-003E.2D-F2 — scheduled entry runtime load (createRequire crash)
 * Usage: node scripts/test-mg-support-003e-2d-runtime.js
 *
 * Loads the actual Functions v2 entry and a local zip-it bundle. Mocks DB and
 * network. Does not invoke production, mutate Supabase, send webhook/email,
 * or change env vars.
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = path.resolve(__dirname, "..");
const SWEEP_FILE = path.join(ROOT, "netlify/functions/mg-support-case-notification-sweep.js");
const { ENV } = require("../netlify/functions/_lib/mg-support/notification-delivery");

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

function zisiMainUrl() {
  const rel =
    ".qa-ch013a48/netlify-cli-pkg/node_modules/netlify-cli/node_modules/@netlify/zip-it-and-ship-it/dist/main.js";
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return null;
  return pathToFileURL(abs).href;
}

function walkFiles(dir, acc) {
  const list = acc || [];
  if (!fs.existsSync(dir)) return list;
  fs.readdirSync(dir, { withFileTypes: true }).forEach((ent) => {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(full, list);
    else list.push(full);
  });
  return list;
}

function scheduledRequest() {
  return new Request("https://marginguardsystem.netlify.app/.netlify/functions/mg-support-case-notification-sweep", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ next_run: "2026-09-03T22:55:00.000Z" }),
  });
}

async function parseResponse(res) {
  const text = await res.text();
  let body = {};
  try {
    body = JSON.parse(text || "{}");
  } catch (_err) {
    body = { raw: text };
  }
  return { status: res.status, body };
}

async function loadSweepModule() {
  const href = pathToFileURL(SWEEP_FILE).href + "?runtime=" + Date.now();
  return import(href);
}

function restoreEnv(key, previous) {
  if (previous === undefined) delete process.env[key];
  else process.env[key] = previous;
}

async function main() {
  const sweepFnSrc = fs.readFileSync(SWEEP_FILE, "utf8");
  assert("A1. source has no createRequire", !/\bcreateRequire\b/.test(sweepFnSrc));
  assert("A2. source has no import.meta", !/import\.meta/.test(sweepFnSrc));
  assert(
    "A3. source uses static ESM import of sweep helper",
    /import\s+\{\s*createHandler\s*\}\s+from\s+["']\.\/_lib\/mg-support\/notification-sweep\.js["']/.test(sweepFnSrc)
  );
  assert("A4. remains Functions v2 default export", /export default/.test(sweepFnSrc) && !/exports\.handler/.test(sweepFnSrc));
  assert("A5. schedule string literal preserved", sweepFnSrc.includes('schedule: "*/5 * * * *"'));

  const prevEnabled = process.env[ENV.ENABLED];
  process.env[ENV.ENABLED] = "false";

  let mod = null;
  let loadErr = null;
  try {
    mod = await loadSweepModule();
  } catch (err) {
    loadErr = err;
  }
  assert("B1. actual scheduled entry loads without createRequire crash", Boolean(mod) && !loadErr);
  if (loadErr) {
    console.log("      load error:", loadErr && loadErr.message);
  }
  assert("B2. default export is a function", Boolean(mod && typeof mod.default === "function"));
  assert("B3. createScheduledHandler is exported", Boolean(mod && typeof mod.createScheduledHandler === "function"));

  if (mod && typeof mod.default === "function") {
    const disabledRes = await parseResponse(await mod.default(scheduledRequest()));
    assert("C1. scheduled POST is accepted", disabledRes.status === 200);
    assert(
      "E. delivery_disabled remains fail-closed",
      disabledRes.body.result === "delivery_disabled" && disabledRes.body.selected === 0
    );
  } else {
    assert("C1. scheduled POST is accepted", false);
    assert("E. delivery_disabled remains fail-closed", false);
  }

  restoreEnv(ENV.ENABLED, prevEnabled);

  let enabledReachedSweep = false;
  let enabledSelected = -1;
  let fetchCalled = false;
  let supabaseCalled = false;
  if (mod && typeof mod.createScheduledHandler === "function") {
    const enabledHandler = mod.createScheduledHandler({
      env: { [ENV.ENABLED]: "true" },
      nowIso: () => "2026-09-03T22:55:00.000Z",
      supabaseRequest: async () => {
        supabaseCalled = true;
        return [{ id: "eeeeeeee-eeee-4eee-8eee-000000000001" }];
      },
      dispatchPendingEvent: async () => {
        enabledReachedSweep = true;
        return { result: "bridge_accepted" };
      },
      fetchImpl: async () => {
        fetchCalled = true;
        throw new Error("production HTTP must not be called");
      },
    });
    const enabledRes = await parseResponse(await enabledHandler(scheduledRequest()));
    enabledSelected = enabledRes.body && enabledRes.body.selected;
    assert("C2. enabled scheduled POST returns 200", enabledRes.status === 200);
    assert(
      "D. delivery_enabled path reaches sweep logic",
      enabledRes.body.result === "swept" &&
        enabledRes.body.selected === 1 &&
        enabledRes.body.bridge_accepted === 1 &&
        enabledReachedSweep === true &&
        supabaseCalled === true
    );
  } else {
    assert("C2. enabled scheduled POST returns 200", false);
    assert("D. delivery_enabled path reaches sweep logic", false);
  }
  assert("F1. no production HTTP/webhook/email from test", fetchCalled === false);

  const zipHref = zisiMainUrl();
  assert("I1. local zip-it-and-ship-it is present", Boolean(zipHref));
  let bundleOk = false;
  let bundledSrc = "";
  let bundleLoadOk = false;
  if (zipHref) {
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "mg-support-sweep-zip-"));
    try {
      const { zipFunction, ARCHIVE_FORMAT } = await import(zipHref);
      const zipped = await zipFunction(SWEEP_FILE, dest, {
        archiveFormat: ARCHIVE_FORMAT && ARCHIVE_FORMAT.NONE ? ARCHIVE_FORMAT.NONE : "none",
        basePath: ROOT,
        repositoryRoot: ROOT,
      });
      const searchRoot = (zipped && zipped.path) || dest;
      const files = walkFiles(searchRoot);
      const entry = files.find((f) => /mg-support-case-notification-sweep\.cjs$/i.test(f))
        || files.find((f) => /mg-support-case-notification-sweep\.js$/i.test(path.basename(f)));
      if (entry) bundledSrc = fs.readFileSync(entry, "utf8");
      const noCreateRequireCrash =
        Boolean(entry) &&
        !/createRequire\s*\(\s*import\.meta\.url\s*\)/.test(bundledSrc) &&
        !/createRequire\s*\(\s*void 0\s*\)/.test(bundledSrc) &&
        !/createRequire\s*\(\s*undefined\s*\)/.test(bundledSrc);
      bundleOk = noCreateRequireCrash && /notification-sweep/.test(bundledSrc);
      if (entry && /\.cjs$/i.test(entry)) {
        try {
          const bundled = require(entry);
          bundleLoadOk = Boolean(bundled) && (typeof bundled.default === "function" || typeof bundled.handler === "function");
        } catch (err) {
          bundleLoadOk = false;
          console.log("      bundled require error:", err && err.message);
        }
      } else {
        bundleLoadOk = bundleOk;
      }
      assert("I2. zip-it bundle exists", Boolean(entry));
      assert("I3. bundled entry does not call createRequire(import.meta.url)", noCreateRequireCrash);
      assert("I4. bundled entry still references sweep helper", /notification-sweep/.test(bundledSrc));
      assert("I5. bundled CJS loads without createRequire crash", bundleLoadOk);
    } finally {
      try {
        fs.rmSync(dest, { recursive: true, force: true });
      } catch (_err) {
        /* ignore */
      }
    }
  } else {
    assert("I2. zip-it bundle exists", false);
    assert("I3. bundled entry does not call createRequire(import.meta.url)", false);
    assert("I4. bundled entry still references sweep helper", false);
    assert("I5. bundled CJS loads without createRequire crash", false);
  }

  void enabledSelected;
  void bundleOk;

  console.log("");
  console.log(passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
