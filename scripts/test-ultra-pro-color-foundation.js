/**
 * System ultra-pro color foundation — ink black + one teal, not neon SaaS.
 * Isolated source assertions. No live Netlify/Supabase.
 * Run: node scripts/test-ultra-pro-color-foundation.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function sliceFrom(src, startToken, endToken) {
  const i = src.indexOf(startToken);
  assert.ok(i >= 0, "missing " + startToken);
  const rest = src.slice(i);
  const j = rest.indexOf(endToken);
  return j > 0 ? rest.slice(0, j) : rest.slice(0, 8000);
}

let passed = 0;
function ok(label, cond) {
  assert.ok(cond, label);
  passed += 1;
  console.log("PASS " + label);
}

const css = read("public/styles.css");
const salesHtml = read("public/sales.html");
const ownerHtml = read("public/owner.html");
const dashboardHtml = read("public/dashboard.html");
const builderHtml = read("public/contract-builder.html");
const supervisorHtml = read("public/supervisor.html");

const firstRoot = sliceFrom(css, ":root{", "/* Step 3E-C16-Q3K-1");
const firstBody = sliceFrom(css, "html,body{ height:100%; }", "a{ color:inherit;");
const foundation = sliceFrom(
  css,
  "/* Step 3E-C16-Q3L-1 — global ultra-pro dark foundation */",
  "/* Step 3E-C16-Q3L-3"
);
const dashCleanup = sliceFrom(
  dashboardHtml,
  "/* Step 3E-C16-Q3L-2 — dashboard FCC ultra-pro dark cleanup */",
  ".fcc-hero-viz{"
);

ok("Owner Shield --panel token remains #0c1426", /--panel:#0c1426/.test(firstRoot));
ok("Owner Shield --green token remains #22c55e", /--green:#22c55e/.test(firstRoot));
ok("first body glow is teal, not neon green", firstBody.includes("rgba(15,118,110,.05)"));
ok("first body glow is not bronze", !firstBody.includes("180,83,9"));
ok("first body glow is not purple neon", !firstBody.includes("168,85,247"));
ok("foundation sets ink-black --bg", foundation.includes("--bg:#0b0b0a"));
ok("foundation sets quiet --panel", foundation.includes("--panel:#141413"));
ok("foundation sets paper --text", foundation.includes("--text:#f4f4f1"));
ok("foundation chrome matches page black", foundation.includes("background:#0b0b0a"));
ok("foundation hairlines are quiet white", foundation.includes("rgba(255,255,255,.07)"));
ok("foundation brand mark uses teal", foundation.includes("rgba(15,118,110,.12)"));
ok("foundation primary buttons use teal", foundation.includes("rgba(15,118,110,.16)"));
ok("dashboard cleanup uses ink black", dashCleanup.includes("#0b0b0a") && dashCleanup.includes("#141413"));
ok("seller field wells use quiet black", salesHtml.includes("background: #191918"));
ok("seller field wells no longer use icy navy", !salesHtml.includes("background: #1a2438"));
ok("seller focus ring is contract teal", salesHtml.includes("rgba(15, 118, 110, 0.50)"));
ok("owner field wells retint from global CSS, not owner.html", foundation.includes("/* owner field wells — ultra-pro retint without rewriting owner.html */"));
ok("owner.html field wells stay on the existing well color", ownerHtml.includes("background: #1a2438"));
ok("owner transcript fill stays frozen", /rgba\(\s*6,\s*10,\s*20,\s*0\.82\)/.test(ownerHtml));
ok("owner transcript caret still uses --green", ownerHtml.includes("caret-color: var(--green)"));
ok("contract builder chrome uses ink black", builderHtml.includes("--cb-shell: #0b0b0a"));
ok("contract preview studio background unchanged", builderHtml.includes("#d6d1c7"));
ok("supervisor navy is ink black", supervisorHtml.includes("--sup-navy: #0b0b0a"));

console.log("Passed " + passed + " assertions.");
