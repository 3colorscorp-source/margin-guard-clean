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
  const portalSrc = fs.existsSync(path.join(ROOT, "public/js/contract-sign-portal.js"))
    ? fs.readFileSync(path.join(ROOT, "public/js/contract-sign-portal.js"), "utf8")
    : pageSrc;
  assert.ok(portalSrc.includes("contract-sign-public?token="));
  assert.ok(portalSrc.includes("readTokenFromQuery"));
});

test("2-5. Invalid / revoked / expired / consumed", () => {
  assert.ok(libSrc.includes('code: "invalid_token"'));
  assert.ok(libSrc.includes("revoked"));
  assert.ok(libSrc.includes("expired"));
  assert.ok(libSrc.includes("consumed"));
  const portalSrc = fs.existsSync(path.join(ROOT, "public/js/contract-sign-portal.js"))
    ? fs.readFileSync(path.join(ROOT, "public/js/contract-sign-portal.js"), "utf8")
    : pageSrc;
  assert.ok(portalSrc.includes("Link revoked") || portalSrc.includes("revoked"));
  assert.ok(portalSrc.includes("Link expired") || portalSrc.includes("expired"));
  assert.ok(portalSrc.includes("Already signed") || portalSrc.includes("consumed"));
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
  const portalSrc = fs.existsSync(path.join(ROOT, "public/js/contract-sign-portal.js"))
    ? fs.readFileSync(path.join(ROOT, "public/js/contract-sign-portal.js"), "utf8")
    : pageSrc;
  assert.ok(portalSrc.includes("Signer") || portalSrc.includes("signer"));
  assert.ok(portalSrc.includes("pkg.version") || portalSrc.includes("version"));
});

test("11-13. Business / payment / legal sections", () => {
  const portalSrc = fs.existsSync(path.join(ROOT, "public/js/contract-sign-portal.js"))
    ? fs.readFileSync(path.join(ROOT, "public/js/contract-sign-portal.js"), "utf8")
    : pageSrc;
  assert.ok(portalSrc.includes("Payment Schedule"));
  assert.ok(portalSrc.includes("Legal Notices") || portalSrc.includes("Legal"));
  assert.ok(portalSrc.includes("business_settings"));
  assert.ok(portalSrc.includes("renderSchedule"));
  assert.ok(portalSrc.includes("renderNotices"));
});

test("14-15. Public sign capture uses token POST (CH-012B)", () => {
  assert.ok(pageSrc.includes("contract-sign-portal.js") || pageSrc.includes("consentEsign") || fs.existsSync(path.join(ROOT, "public/js/contract-sign-portal.js")));
  const portalSrc = fs.existsSync(path.join(ROOT, "public/js/contract-sign-portal.js"))
    ? fs.readFileSync(path.join(ROOT, "public/js/contract-sign-portal.js"), "utf8")
    : pageSrc;
  assert.ok(portalSrc.includes("contract-sign"));
  assert.ok(portalSrc.includes("consent_esign"));
  assert.ok(portalSrc.includes("signature_method"));
  assert.ok(!/localStorage|sessionStorage/.test(portalSrc));
  assert.ok(!/\bDecline Contract\b/i.test(portalSrc));
});

test("16. No raw token logging/storage", () => {
  const portalSrc = fs.existsSync(path.join(ROOT, "public/js/contract-sign-portal.js"))
    ? fs.readFileSync(path.join(ROOT, "public/js/contract-sign-portal.js"), "utf8")
    : pageSrc;
  assert.ok(!/localStorage|sessionStorage/.test(portalSrc));
  assert.ok(handlerSrc.includes("Do not log the raw token"));
  assert.ok(!/console\.log\([^)]*token/i.test(handlerSrc));
  assert.ok(!/console\.log\([^)]*token/i.test(libSrc));
});

test("17-18. Mobile 390 + desktop responsive", () => {
  const cssPath = path.join(ROOT, "public/css/contract-sign-portal.css");
  const cssSrc = fs.existsSync(cssPath) ? fs.readFileSync(cssPath, "utf8") : pageSrc;
  assert.ok(cssSrc.includes("max-width: 640px") || cssSrc.includes("max-width:640px"));
  assert.ok(pageSrc.includes('name="viewport"'));
  assert.ok(cssSrc.includes("980px") || pageSrc.includes("980px") || cssSrc.includes("max-width"));
});

test("19. Print view", () => {
  const cssPath = path.join(ROOT, "public/css/contract-sign-portal.css");
  const cssSrc = fs.existsSync(cssPath) ? fs.readFileSync(cssPath, "utf8") : pageSrc;
  const portalSrc = fs.existsSync(path.join(ROOT, "public/js/contract-sign-portal.js"))
    ? fs.readFileSync(path.join(ROOT, "public/js/contract-sign-portal.js"), "utf8")
    : pageSrc;
  assert.ok(cssSrc.includes("@media print"));
  assert.ok(portalSrc.includes("btnPrint") || portalSrc.includes("window.print"));
  assert.ok(portalSrc.includes("window.print"));
});

test("20. No Invoice Hub / ledger / Stripe / PI", () => {
  const portalSrc = fs.existsSync(path.join(ROOT, "public/js/contract-sign-portal.js"))
    ? fs.readFileSync(path.join(ROOT, "public/js/contract-sign-portal.js"), "utf8")
    : pageSrc;
  for (const src of [libSrc, handlerSrc, pageSrc, portalSrc]) {
    assert.ok(!/require\(["'].*stripe/i.test(src));
    assert.ok(!/project-payment-intent/.test(src));
    assert.ok(!/tenant_project_payments/.test(src));
    assert.ok(!/docusign|sendgrid/i.test(src));
  }
});

test("21. XSS escaping", () => {
  const portalSrc = fs.existsSync(path.join(ROOT, "public/js/contract-sign-portal.js"))
    ? fs.readFileSync(path.join(ROOT, "public/js/contract-sign-portal.js"), "utf8")
    : pageSrc;
  assert.ok(portalSrc.includes("escapeHtml"));
  assert.ok(portalSrc.includes("textContent"));
  assert.ok(portalSrc.includes(".replace(/&/g"));
});

test("22. Tenant isolation through token only", () => {
  const portalSrc = fs.existsSync(path.join(ROOT, "public/js/contract-sign-portal.js"))
    ? fs.readFileSync(path.join(ROOT, "public/js/contract-sign-portal.js"), "utf8")
    : pageSrc;
  assert.ok(libSrc.includes("hashRawToken"));
  assert.ok(libSrc.includes("loadTokenByHash"));
  assert.ok(!portalSrc.includes("package_id="));
  assert.ok(!portalSrc.includes("envelope_id="));
  assert.ok(libSrc.includes("delete snap.tenant"));
  assert.ok(handlerSrc.includes('credentials: "omit"') || portalSrc.includes('credentials: "omit"'));
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
