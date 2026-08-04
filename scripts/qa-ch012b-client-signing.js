/**
 * CH-012B — Client signing experience QA (static).
 * Run: node scripts/qa-ch012b-client-signing.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const htmlPath = path.join(ROOT, "public/contract-sign.html");
const jsPath = path.join(ROOT, "public/js/contract-sign-portal.js");
const cssPath = path.join(ROOT, "public/css/contract-sign-portal.css");
const publicLib = path.join(ROOT, "netlify/functions/_lib/contract-sign-public.js");

const html = fs.readFileSync(htmlPath, "utf8");
const js = fs.readFileSync(jsPath, "utf8");
const css = fs.readFileSync(cssPath, "utf8");
const libSrc = fs.readFileSync(publicLib, "utf8");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log("PASS", name);
    passed += 1;
  } catch (err) {
    console.log("FAIL", name, "-", err.message);
    failed += 1;
  }
}

function check(file) {
  const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  assert.strictEqual(r.status, 0, r.stderr || r.stdout);
}

test("syntax portal JS", () => check(jsPath));

test("page wires CSS + JS", () => {
  assert.ok(html.includes("contract-sign-portal.css"));
  assert.ok(html.includes("contract-sign-portal.js"));
  assert.ok(html.includes('name="viewport"'));
  assert.ok(html.includes('rel="icon"'));
  assert.ok(html.includes("/favicon.svg"));
});

test("identity + contract reader + sticky nav", () => {
  assert.ok(js.includes("step-identity"));
  assert.ok(js.includes("step-contract"));
  assert.ok(css.includes("position: sticky") || css.includes("position:sticky"));
  assert.ok(js.includes("Payment Schedule"));
  assert.ok(js.includes("Legal Notices") || js.includes("sec-legal"));
});

test("ESIGN consent legal language", () => {
  assert.ok(js.includes("I agree to sign this contract electronically"));
  assert.ok(js.includes("legal effect"));
  assert.ok(js.includes("binding agreement"));
  assert.ok(js.includes("consent_esign"));
});

test("typed + drawn signature UX", () => {
  assert.ok(js.includes('data-method="typed"') || js.includes('method === "typed"'));
  assert.ok(js.includes("drawCanvas"));
  assert.ok(js.includes("btnClearDraw"));
  assert.ok(js.includes("Great Vibes") || css.includes("Great Vibes") || html.includes("Great+Vibes"));
  assert.ok(js.includes("svg_path"));
});

test("review + sign uses contract-sign", () => {
  assert.ok(js.includes("step-review"));
  assert.ok(js.includes("Sign Contract"));
  assert.ok(js.includes("/.netlify/functions/contract-sign"));
  assert.ok(js.includes("expected_updated_at"));
  assert.ok(js.includes("signature_payload"));
});

test("success + download affordance", () => {
  assert.ok(js.includes("Contract signed"));
  assert.ok(js.includes("btnDownloadPdf"));
  assert.ok(js.includes("window.print"));
});

test("error UX codes", () => {
  for (const code of [
    "invalid_token",
    "expired",
    "revoked",
    "consumed",
    "signature_already_recorded",
    "envelope_completed",
    "envelope_cancelled",
    "consent_required",
  ]) {
    assert.ok(js.includes(code), `missing ${code}`);
  }
});

test("responsive + print + dark", () => {
  assert.ok(css.includes("max-width: 640px") || css.includes("@media (max-width: 640px)"));
  assert.ok(css.includes("@media print"));
  assert.ok(css.includes("prefers-color-scheme: dark"));
});

test("no developer leak / no secrets storage", () => {
  assert.ok(!/localStorage|sessionStorage/.test(js));
  assert.ok(!js.includes("package_id="));
  assert.ok(!js.includes("envelope_id="));
  assert.ok(!/JSON\.stringify\(state\.payload/.test(js));
  assert.ok(!/tenant_id/.test(js));
});

test("no Invoice Hub / Stripe / email providers", () => {
  assert.ok(!/stripe|docusign|sendgrid|twilio|project-payment-intent/i.test(js));
  assert.ok(!/estimates-invoices|invoice-hub/i.test(js));
});

test("public payload exposes updated_at for sign concurrency", () => {
  assert.ok(libSrc.includes("updated_at"));
  assert.ok(libSrc.includes("updated_at: envelope.updated_at"));
});

test("APIs reused only", () => {
  assert.ok(js.includes("contract-sign-public"));
  assert.ok(js.includes("contract-sign"));
  assert.ok(!js.includes("contract-envelope-send"));
  assert.ok(!js.includes("contract-certificate-create"));
});

console.log("");
console.log(`CH-012B QA: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
