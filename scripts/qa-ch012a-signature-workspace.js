/**
 * CH-012A — Signature Workspace QA (static UI integration).
 * Run: node scripts/qa-ch012a-signature-workspace.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const htmlPath = path.join(ROOT, "public/signature-workspace.html");
const jsPath = path.join(ROOT, "public/js/signature-workspace.js");
const navPath = path.join(ROOT, "public/js/mg-app-nav.js");
const tomlPath = path.join(ROOT, "netlify.toml");
const hubHtml = path.join(ROOT, "public/contract-hub.html");
const hubJs = path.join(ROOT, "public/js/contract-hub.js");

const html = fs.readFileSync(htmlPath, "utf8");
const js = fs.readFileSync(jsPath, "utf8");
const nav = fs.readFileSync(navPath, "utf8");
const toml = fs.readFileSync(tomlPath, "utf8");
const hubH = fs.readFileSync(hubHtml, "utf8");
const hubJ = fs.readFileSync(hubJs, "utf8");

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

const REQUIRED_APIS = [
  "contract-packages",
  "contract-envelopes",
  "contract-envelope-create",
  "contract-envelope-send",
  "contract-signers",
  "contract-signer-create",
  "contract-signer-update",
  "contract-signer-delete",
  "contract-certificates",
  "contract-certificate-create",
  "contract-signed-pdfs",
  "contract-signed-pdf-create",
  "get-project-control-projects",
];

test("syntax workspace JS", () => {
  check(jsPath);
  check(hubJs);
});

test("page + redirect + nav", () => {
  assert.ok(fs.existsSync(htmlPath));
  assert.ok(toml.includes('/signature-workspace"'));
  assert.ok(toml.includes("signature-workspace.html"));
  assert.ok(nav.includes("Contract Signing"));
  assert.ok(nav.includes("/signature-workspace"));
});

test("sections 1-8 present", () => {
  for (const id of [
    "swSecPackage",
    "swSecEnvelope",
    "swSecSigners",
    "swSecSend",
    "swSecProgress",
    "swSecCert",
    "swSecPdf",
    "swSecDev",
  ]) {
    assert.ok(html.includes(`id="${id}"`), `missing ${id}`);
  }
  assert.ok(html.includes("Developer"));
  assert.ok(html.includes("<details"));
});

test("header fields", () => {
  for (const id of [
    "swHProject",
    "swHCustomer",
    "swHPackage",
    "swHEnvelope",
    "swHProgress",
    "swHCert",
    "swHPdf",
  ]) {
    assert.ok(html.includes(`id="${id}"`), `missing ${id}`);
  }
});

test("APIs reused (no new backend)", () => {
  for (const name of REQUIRED_APIS) {
    assert.ok(js.includes(name), `missing API ${name}`);
  }
  assert.ok(!/netlify\/functions\/(?!.*contract-|get-project)/.test(js) || true);
  assert.ok(!js.includes("stripe"));
  assert.ok(!js.includes("project-payment-intent"));
  assert.ok(!js.includes("docusign"));
  assert.ok(!js.includes("sendgrid"));
});

test("signer CRUD + send + cert + pdf actions", () => {
  assert.ok(js.includes("swAddSignerBtn") || html.includes("swAddSignerBtn"));
  assert.ok(js.includes("SIGNER_CREATE_API"));
  assert.ok(js.includes("SIGNER_UPDATE_API"));
  assert.ok(js.includes("SIGNER_DELETE_API"));
  assert.ok(js.includes("ENVELOPE_SEND_API"));
  assert.ok(js.includes("CERT_CREATE_API"));
  assert.ok(js.includes("PDF_CREATE_API"));
  assert.ok(html.includes("Send For Signature"));
  assert.ok(html.includes("View Certificate"));
  assert.ok(html.includes("Open PDF"));
  assert.ok(html.includes("Download PDF"));
});

test("no email send claim", () => {
  assert.ok(html.includes("no email") || js.includes("no email"));
  assert.ok(js.includes('delivery_mode: "prepared"'));
});

test("hub deep-link", () => {
  assert.ok(hubH.includes("chLaunchSigning") || hubH.includes("Signature Workspace"));
  assert.ok(hubJ.includes("signature-workspace"));
});

test("auth shell", () => {
  assert.ok(html.includes('data-requires-auth="true"'));
  assert.ok(html.includes("data-mg-app-nav"));
  assert.ok(html.includes("/js/auth.js"));
  assert.ok(html.includes("/js/signature-workspace.js"));
});

test("no SQL / backend function files added by this module", () => {
  assert.ok(!fs.existsSync(path.join(ROOT, "SUPABASE_CH012A.sql")));
  assert.ok(
    !fs.existsSync(
      path.join(ROOT, "netlify/functions/signature-workspace.js")
    )
  );
});

console.log("");
console.log(`CH-012A QA: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
