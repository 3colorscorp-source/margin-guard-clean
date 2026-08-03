/**
 * CH-011A — signature_method persistence regression (static).
 * Proves Save Draft → Confirm Method → reload hydrate → freeze readiness path.
 * Run: node scripts/qa-ch011a-signature-method-persist.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const jsPath = path.join(ROOT, "public/js/contract-builder.js");
const htmlPath = path.join(ROOT, "public/contract-builder.html");
const setupPath = path.join(ROOT, "netlify/functions/project-contract-setup.js");
const freezeLibPath = path.join(ROOT, "netlify/functions/_lib/contract-package.js");

const js = fs.readFileSync(jsPath, "utf8");
const html = fs.readFileSync(htmlPath, "utf8");
const setupSrc = fs.readFileSync(setupPath, "utf8");
const freezeLib = fs.readFileSync(freezeLibPath, "utf8");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log("PASS", name);
  } catch (err) {
    failed += 1;
    console.log("FAIL", name, "-", err.message);
  }
}

test("syntax contract-builder.js", () => {
  const r = spawnSync(process.execPath, ["--check", jsPath], { encoding: "utf8" });
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || "syntax failed");
});

test("UI field + Save Draft / Confirm Method wiring", () => {
  assert.match(html, /id="cbSigEditMethod"/);
  assert.match(html, /value="email_link"/);
  assert.match(html, /value="sign_on_device"/);
  assert.match(html, /value="both"/);
  assert.match(js, /"art-signatures":[\s\S]*?supportsEdit:\s*true/);
  assert.match(js, /"art-signatures":[\s\S]*?saveLabel:\s*"Save Draft"/);
  assert.match(js, /function saveSignatureWorkspace/);
  assert.match(js, /function workspaceConfirmSignature/);
  assert.match(js, /label:\s*"Confirm Method"/);
  assert.match(js, /signature_method:\s*method/);
});

test("save → confirm → reload hydrate survives", () => {
  assert.match(js, /await saveSignatureWorkspace\(\{\s*confirm:\s*false\s*\}\)/);
  assert.match(js, /await saveSignatureWorkspace\(\{\s*confirm:\s*true\s*\}\)/);
  assert.match(js, /draftEdits\.sigMethod = signatureMethodFromSetup/);
  assert.match(js, /function syncSignatureInputsFromModel/);
  assert.match(js, /sourceSnapshot\.contractSetup\s*=\s*\{[\s\S]*?setup:\s*res\.data\.setup/);
});

test("API accepts signature_method; freeze reads same field", () => {
  assert.match(setupSrc, /"signature_method"/);
  assert.match(setupSrc, /changes\.signature_method = method/);
  assert.match(setupSrc, /signature_method:\s*signatureMethodStatus/);
  assert.match(freezeLib, /setup\?\.signature_method && setup\.signature_method !== "not_configured"/);
  assert.match(freezeLib, /missing\.push\("signature_method"\)/);
});

test("no silent auto-configure / no readiness bypass", () => {
  assert.doesNotMatch(js, /signature_method:\s*"email_link"/);
  assert.doesNotMatch(js, /signature_method:\s*"sign_on_device"/);
  assert.doesNotMatch(js, /signature_method:\s*"both"/);
  assert.match(js, /Choose a signature method before saving/);
  assert.doesNotMatch(js, /readiness_incomplete[\s\S]{0,80}bypass/i);
});

console.log(`CH-011A signature persist QA: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
