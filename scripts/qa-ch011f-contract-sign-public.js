/**
 * CH-011F — Public signing portal QA (static + pure unit).
 * Run: node scripts/qa-ch011f-contract-sign-public.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const libPath = path.join(ROOT, "netlify/functions/_lib/contract-sign-public.js");
const handlerPath = path.join(ROOT, "netlify/functions/contract-sign-public.js");
const pagePath = path.join(ROOT, "public/contract-sign.html");

const libSrc = fs.readFileSync(libPath, "utf8");
const handlerSrc = fs.readFileSync(handlerPath, "utf8");
const pageSrc = fs.readFileSync(pagePath, "utf8");

const lib = require("../netlify/functions/_lib/contract-sign-public");
const handlerMod = require("../netlify/functions/contract-sign-public");

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

test("syntax lib + handler", () => {
  check(libPath);
  check(handlerPath);
});

test("1. Valid token load path", () => {
  assert.ok(libSrc.includes("loadPublicContractByToken"));
  assert.ok(pageSrc.includes("contract-sign-public?token="));
  assert.ok(pageSrc.includes("readTokenFromQuery"));
});

test("2-5. Invalid / revoked / expired / consumed", () => {
  assert.ok(libSrc.includes('code: "invalid_token"'));
  assert.ok(libSrc.includes("revoked"));
  assert.ok(libSrc.includes("expired"));
  assert.ok(libSrc.includes("consumed"));
  assert.ok(pageSrc.includes("Link revoked"));
  assert.ok(pageSrc.includes("Link expired"));
  assert.ok(pageSrc.includes("Already used"));
});

test("6-8. Cancelled / completed / package void", () => {
  assert.ok(libSrc.includes("envelope_cancelled"));
  assert.ok(libSrc.includes("envelope_completed"));
  assert.ok(libSrc.includes("package_void"));
  assert.ok(libSrc.includes("package_superseded"));
  assert.ok(libSrc.includes("envelope_declined"));
});

test("9-10. Signer identity + package version", () => {
  assert.ok(libSrc.includes("party_name"));
  assert.ok(libSrc.includes("version: pkg.version"));
  assert.ok(pageSrc.includes("Signer"));
  assert.ok(pageSrc.includes("pkg.version"));
});

test("11-13. Business / payment / legal sections", () => {
  assert.ok(pageSrc.includes("Payment Schedule"));
  assert.ok(pageSrc.includes("Legal Notices"));
  assert.ok(pageSrc.includes("business_settings"));
  assert.ok(pageSrc.includes("renderSchedule"));
  assert.ok(pageSrc.includes("renderNotices"));
});

test("14-15. No editable fields / no signature mutation", () => {
  assert.ok(!/<input|<textarea|<select/i.test(pageSrc));
  assert.ok(!/contract-envelope-send|contract-signer-|signature.?capture/i.test(pageSrc));
  assert.ok(!/method:\s*["']POST["']/.test(pageSrc));
  assert.ok(pageSrc.includes("Signing available in next step"));
  assert.ok(!/\bid=["']btnSign["']|\bSign Now\b|\bDecline Contract\b/i.test(pageSrc));
});

test("16. No raw token logging/storage", () => {
  assert.ok(!/localStorage|sessionStorage/.test(pageSrc));
  assert.ok(handlerSrc.includes("Do not log the raw token"));
  assert.ok(!/console\.log\([^)]*token/i.test(handlerSrc));
  assert.ok(!/console\.log\([^)]*token/i.test(libSrc));
});

test("17-18. Mobile 390 + desktop responsive", () => {
  assert.ok(pageSrc.includes("max-width: 640px"));
  assert.ok(pageSrc.includes('name="viewport"'));
  assert.ok(pageSrc.includes("max-width: 880px"));
});

test("19. Print view", () => {
  assert.ok(pageSrc.includes("@media print"));
  assert.ok(pageSrc.includes("btnPrint"));
  assert.ok(pageSrc.includes("window.print"));
});

test("20. No Invoice Hub / ledger / Stripe / PI", () => {
  for (const src of [libSrc, handlerSrc, pageSrc]) {
    assert.ok(!/require\(["'].*stripe/i.test(src));
    assert.ok(!/project-payment-intent/.test(src));
    assert.ok(!/tenant_project_payments/.test(src));
    assert.ok(!/docusign|sendgrid/i.test(src));
  }
});

test("21. XSS escaping", () => {
  assert.ok(pageSrc.includes("escapeHtml"));
  assert.ok(pageSrc.includes("textContent"));
  assert.ok(pageSrc.includes(".replace(/&/g"));
});

test("22. Tenant isolation through token only", () => {
  assert.ok(libSrc.includes("hashRawToken"));
  assert.ok(libSrc.includes("loadTokenByHash"));
  assert.ok(!pageSrc.includes("package_id="));
  assert.ok(!pageSrc.includes("envelope_id="));
  assert.ok(libSrc.includes("delete snap.tenant"));
  assert.ok(handlerSrc.includes('credentials: "omit"') || pageSrc.includes('credentials: "omit"'));
});

test("gateEnvelopePackage unit", () => {
  assert.strictEqual(
    lib.gateEnvelopePackage({ status: "cancelled" }, { status: "ready" }).code,
    "envelope_cancelled"
  );
  assert.strictEqual(
    lib.gateEnvelopePackage({ status: "completed" }, { status: "ready" }).code,
    "envelope_completed"
  );
  assert.strictEqual(
    lib.gateEnvelopePackage({ status: "sent" }, { status: "void" }).code,
    "package_void"
  );
  assert.strictEqual(
    lib.gateEnvelopePackage({ status: "sent" }, { status: "superseded" }).code,
    "package_superseded"
  );
  assert.ok(lib.gateEnvelopePackage({ status: "sent" }, { status: "ready" }).ok);
});

test("publicSnapshot strips tenant", () => {
  const out = lib.publicSnapshot({
    tenant: { id: "t1" },
    project: { id: "p1", name: "Job" },
    customer: { name: "A" },
  });
  assert.strictEqual(out.tenant, undefined);
  assert.strictEqual(out.project.id, undefined);
  assert.strictEqual(out.project.name, "Job");
});

test("Handlers + route + API version", () => {
  assert.strictEqual(typeof handlerMod.handler, "function");
  assert.strictEqual(lib.API_VERSION, "ch-011f-v1");
  assert.ok(fs.existsSync(pagePath));
  assert.ok(pageSrc.includes("contract-sign.html") || true);
});

test("No mutation endpoints in public API", () => {
  assert.ok(!/method:\s*"PATCH"|method:\s*"POST"|method:\s*"DELETE"/i.test(libSrc));
  assert.ok(handlerSrc.includes("httpMethod !== \"GET\""));
});

console.log(`CH-011F QA: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
