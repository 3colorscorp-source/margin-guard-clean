#!/usr/bin/env node
/**
 * Core Security — safe global CSP/HSTS/Permissions-Policy in netlify.toml.
 * Syntax and inventory only. Does not start Netlify, mutate product pages, or
 * add script-src/style-src. Microphone stays (self) for Seller/Owner voice.
 * Run: node scripts/test-core-global-security-headers.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");

const FROZEN_REDIRECTS = [
  { from: "/", to: "/index.html", status: 200 },
  { from: "/app", to: "/dashboard.html", status: 301 },
  { from: "/dashboard", to: "/dashboard.html", status: 200 },
  { from: "/estimates-invoices", to: "/estimates-invoices.html", status: 200 },
  { from: "/create-estimate", to: "/create-estimate.html", status: 200 },
  { from: "/estimate-public", to: "/estimate-public.html", status: 200 },
  { from: "/owner", to: "/owner.html", status: 200 },
  { from: "/business-settings", to: "/business-settings.html", status: 200 },
  { from: "/legal-notices", to: "/legal-notices.html", status: 200 },
  { from: "/terms", to: "/terms.html", status: 200 },
  { from: "/privacy", to: "/privacy.html", status: 200 },
  { from: "/sales", to: "/sales.html", status: 200 },
  { from: "/supervisor", to: "/supervisor.html", status: 200 },
  { from: "/sales-admin", to: "/sales-admin.html", status: 200 },
  { from: "/support-admin", to: "/support-admin.html", status: 200 },
  { from: "/saas-admin", to: "/saas-admin.html", status: 200 },
  { from: "/team-devices", to: "/team-devices.html", status: 200 },
  { from: "/portal-pair", to: "/portal-pair.html", status: 200 },
  { from: "/project-control", to: "/project-control.html", status: 200 },
  { from: "/contract-hub", to: "/contract-hub.html", status: 200 },
  { from: "/contract-builder", to: "/contract-builder.html", status: 200 },
  { from: "/signature-workspace", to: "/signature-workspace.html", status: 200 },
  { from: "/favicon.ico", to: "/favicon.svg", status: 200 },
  { from: "/success", to: "/success.html", status: 200 },
  { from: "/cancel", to: "/cancel.html", status: 200 },
];

const EXPECTED_CSP = "object-src 'none'; base-uri 'self'; frame-ancestors 'none'";
const EXPECTED_HSTS = "max-age=31536000";
const EXPECTED_PERMISSIONS = "microphone=(self), camera=(), geolocation=()";

let passed = 0;
function ok(label, cond) {
  assert.ok(cond, label);
  passed += 1;
  console.log("PASS " + label);
}
function eq(label, actual, expected) {
  assert.strictEqual(
    actual,
    expected,
    label + " expected " + JSON.stringify(expected) + " got " + JSON.stringify(actual)
  );
  passed += 1;
  console.log("PASS " + label);
}

function parseHeaderBlocks(toml) {
  const blocks = [];
  const parts = String(toml || "").split("[[headers]]").slice(1);
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    const forMatch = /for\s*=\s*"([^"]+)"/.exec(part);
    if (!forMatch) continue;
    const values = {};
    const after = part.split("[headers.values]")[1] || "";
    const lines = after.split(/\r?\n/);
    for (let j = 0; j < lines.length; j += 1) {
      const line = lines[j];
      if (/^\s*\[\[/.test(line)) break;
      if (/^\s*\[[^\]]+\]/.test(line) && !/^\s*\[headers/.test(line)) break;
      if (/^\s*#/.test(line) || !String(line).trim()) continue;
      const m = /^\s*([A-Za-z0-9-]+)\s*=\s*"(.*)"\s*$/.exec(line);
      if (m) values[m[1]] = m[2];
    }
    blocks.push({ for: forMatch[1], values: values });
  }
  return blocks;
}

function parseRedirects(toml) {
  const redirects = [];
  const parts = String(toml || "").split("[[redirects]]").slice(1);
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    const from = /from\s*=\s*"([^"]+)"/.exec(part);
    const to = /to\s*=\s*"([^"]+)"/.exec(part);
    const status = /status\s*=\s*(\d+)/.exec(part);
    if (!from) continue;
    redirects.push({
      from: from[1],
      to: to ? to[1] : "",
      status: status ? Number(status[1]) : 0,
    });
  }
  return redirects;
}

function cspDirectives(csp) {
  return String(csp || "")
    .split(";")
    .map((part) => String(part).trim())
    .filter(Boolean)
    .map((part) => {
      const sp = part.indexOf(" ");
      if (sp < 0) return { name: part, value: "" };
      return { name: part.slice(0, sp), value: part.slice(sp + 1).trim() };
    });
}

function gitFiles() {
  const r = spawnSync("git", ["ls-files", "public"], {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
  });
  if (!r || r.status !== 0) {
    throw new Error("git ls-files public failed");
  }
  return String(r.stdout || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function scanPublicApis(files) {
  const geo = [];
  const camera = [];
  files.forEach((rel) => {
    if (!/\.(html|js)$/i.test(rel)) return;
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    if (/navigator\.geolocation|getCurrentPosition|watchPosition/.test(src)) geo.push(rel);
    if (/getUserMedia|mediaDevices/.test(src)) camera.push(rel);
  });
  return { geo: geo, camera: camera };
}

function main() {
  const tomlPath = path.join(ROOT, "netlify.toml");
  ok("netlify.toml exists", fs.existsSync(tomlPath));
  const toml = fs.readFileSync(tomlPath, "utf8");
  const blocks = parseHeaderBlocks(toml);
  const global = blocks.filter((b) => b.for === "/*")[0];
  const html = blocks.filter((b) => b.for === "/*.html")[0];
  ok("global /* header block exists", Boolean(global));
  ok("/*.html charset block exists", Boolean(html));
  eq("exactly two [[headers]] blocks", blocks.length, 2);

  eq("X-Frame-Options is DENY", global.values["X-Frame-Options"], "DENY");
  eq("X-Content-Type-Options is nosniff", global.values["X-Content-Type-Options"], "nosniff");
  eq(
    "Referrer-Policy is strict-origin-when-cross-origin",
    global.values["Referrer-Policy"],
    "strict-origin-when-cross-origin"
  );
  eq("HSTS is max-age=31536000 only", global.values["Strict-Transport-Security"], EXPECTED_HSTS);
  ok(
    "HSTS does not include includeSubDomains",
    String(global.values["Strict-Transport-Security"] || "").indexOf("includeSubDomains") < 0
  );
  ok(
    "HSTS does not include preload",
    String(global.values["Strict-Transport-Security"] || "").indexOf("preload") < 0
  );

  eq("CSP is the three safe directives only", global.values["Content-Security-Policy"], EXPECTED_CSP);
  const dirs = cspDirectives(global.values["Content-Security-Policy"]);
  eq("CSP has exactly three directives", dirs.length, 3);
  eq("object-src is none", (dirs.filter((d) => d.name === "object-src")[0] || {}).value, "'none'");
  eq("base-uri is self", (dirs.filter((d) => d.name === "base-uri")[0] || {}).value, "'self'");
  eq(
    "frame-ancestors is none",
    (dirs.filter((d) => d.name === "frame-ancestors")[0] || {}).value,
    "'none'"
  );
  ok("CSP does not set script-src", dirs.every((d) => d.name !== "script-src"));
  ok("CSP does not set style-src", dirs.every((d) => d.name !== "style-src"));
  ok("CSP does not set default-src", dirs.every((d) => d.name !== "default-src"));
  ok("CSP has no wildcard *", String(global.values["Content-Security-Policy"] || "").indexOf("*") < 0);
  ok(
    "CSP has no unsafe-eval",
    String(global.values["Content-Security-Policy"] || "").indexOf("unsafe-eval") < 0
  );
  ok(
    "CSP has no unsafe-inline",
    String(global.values["Content-Security-Policy"] || "").indexOf("unsafe-inline") < 0
  );

  eq("Permissions-Policy keeps microphone self and blocks camera/geo", global.values["Permissions-Policy"], EXPECTED_PERMISSIONS);
  ok(
    "Permissions-Policy microphone=(self) for voice",
    /microphone=\(self\)/.test(String(global.values["Permissions-Policy"] || ""))
  );
  ok("Permissions-Policy camera=()", /camera=\(\)/.test(String(global.values["Permissions-Policy"] || "")));
  ok(
    "Permissions-Policy geolocation=()",
    /geolocation=\(\)/.test(String(global.values["Permissions-Policy"] || ""))
  );
  ok(
    "toml documents microphone=(self) for SpeechRecognition voice",
    /microphone=\(self\).*SpeechRecognition|SpeechRecognition[\s\S]*microphone=\(self\)/.test(toml)
  );

  const globalKeys = Object.keys(global.values);
  ok(
    "global block does not set Access-Control headers",
    globalKeys.every((k) => k.indexOf("Access-Control") < 0)
  );
  ok("global block does not set Cache-Control", globalKeys.indexOf("Cache-Control") < 0);
  ok("netlify.toml has no Access-Control keys", /Access-Control/.test(toml) === false);
  ok("netlify.toml has no Cache-Control keys", /Cache-Control/.test(toml) === false);

  eq("/*.html charset is text/html UTF-8", html.values["Content-Type"], "text/html; charset=UTF-8");
  eq("/*.html block has only Content-Type", Object.keys(html.values).join(","), "Content-Type");

  const redirects = parseRedirects(toml);
  eq("redirect count is frozen", redirects.length, FROZEN_REDIRECTS.length);
  eq("redirect inventory is frozen", JSON.stringify(redirects), JSON.stringify(FROZEN_REDIRECTS));
  [
    "/owner",
    "/sales",
    "/estimates-invoices",
    "/contract-hub",
    "/estimate-public",
    "/dashboard",
  ].forEach((from) => {
    const row = redirects.filter((r) => r.from === from)[0];
    ok("protected portal redirect remains " + from, Boolean(row) && row.status === 200);
  });

  ok("invoice-public.html exists for public invoice links", fs.existsSync(path.join(ROOT, "public/invoice-public.html")));
  ok("estimate-public.html exists for public estimate links", fs.existsSync(path.join(ROOT, "public/estimate-public.html")));
  ok("owner.html exists", fs.existsSync(path.join(ROOT, "public/owner.html")));
  ok("sales.html exists", fs.existsSync(path.join(ROOT, "public/sales.html")));
  ok("contract-hub.html exists", fs.existsSync(path.join(ROOT, "public/contract-hub.html")));
  ok("estimates-invoices.html exists", fs.existsSync(path.join(ROOT, "public/estimates-invoices.html")));

  const sales = fs.readFileSync(path.join(ROOT, "public/sales.html"), "utf8");
  const voice = fs.readFileSync(path.join(ROOT, "public/js/owner-voice-operational-plan.js"), "utf8");
  ok(
    "Seller voice uses SpeechRecognition",
    /SpeechRecognition|webkitSpeechRecognition/.test(sales)
  );
  ok(
    "Owner voice operational plan uses SpeechRecognition",
    /SpeechRecognition|webkitSpeechRecognition/.test(voice)
  );

  const publicFiles = gitFiles();
  ok("public tree is non-empty", publicFiles.length > 10);
  const apis = scanPublicApis(publicFiles);
  eq("no demonstrated geolocation API in public HTML/JS", apis.geo.length, 0);
  eq("no demonstrated camera getUserMedia in public HTML/JS", apis.camera.length, 0);

  ok('publish stays public', /publish\s*=\s*"public"/.test(toml));
  ok('functions stay netlify/functions', /functions\s*=\s*"netlify\/functions"/.test(toml));

  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/mg-core-security-shield-v1.json"), "utf8"));
  const requiredIds = (manifest.required || []).map((row) => row.id);
  ok(
    "required suite includes core-global-security-headers",
    requiredIds.indexOf("core-global-security-headers") >= 0
  );
  ok(
    "knownGaps no longer lists missing CSP/HSTS",
    !(manifest.knownGaps || []).some((gap) => /Content-Security-Policy|Strict-Transport-Security/.test(gap))
  );
  ok(
    "exact protects this suite",
    (manifest.exact || []).indexOf("scripts/test-core-global-security-headers.js") >= 0
  );
  ok(
    "sharedScan still watches netlify.toml CSP and HSTS",
    (manifest.sharedScan["netlify.toml"].markers || []).indexOf("Content-Security-Policy") >= 0 &&
      (manifest.sharedScan["netlify.toml"].markers || []).indexOf("Strict-Transport-Security") >= 0
  );
  ok(
    "sharedScan watches Permissions-Policy",
    (manifest.sharedScan["netlify.toml"].markers || []).indexOf("Permissions-Policy") >= 0
  );

  console.log("\nCore global security headers: " + passed + " passed");
}

main();
