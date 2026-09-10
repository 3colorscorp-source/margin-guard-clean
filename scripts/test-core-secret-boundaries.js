#!/usr/bin/env node
/**
 * Core Security Shield V1 — secret boundaries, browser leakage, and log hygiene.
 * Isolated dummy secrets only. Does not print secret values.
 * Run: node scripts/test-core-secret-boundaries.js
 */
"use strict";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET || "mg-core-secret-boundaries-test-secret";
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "mg-core-secret-boundaries-test-key";
process.env.SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY || "mg-core-secret-boundaries-test-anon";
process.env.INTERNAL_API_KEY =
  process.env.INTERNAL_API_KEY || "mg-core-secret-boundaries-test-internal";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");

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

function gitFiles() {
  const r = spawnSync("git", ["ls-files"], {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
  });
  if (!r || r.status !== 0) {
    throw new Error("git ls-files failed");
  }
  return String(r.stdout || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const TEXT_EXT = /\.(js|mjs|cjs|json|html|css|md|yml|yaml|toml|sql|txt|svg)$/i;
const SECRET_PATTERNS = [
  { name: "stripe_live", re: /sk_live_[A-Za-z0-9]{16,}/ },
  { name: "stripe_whsec", re: /whsec_[A-Za-z0-9]{16,}/ },
  { name: "sendgrid", re: /SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/ },
];

function loadPublicConfig() {
  delete require.cache[require.resolve("../netlify/functions/get-supabase-public-config")];
  delete require.cache[require.resolve("../netlify/functions/get-stripe-publishable-key")];
  delete require.cache[require.resolve("../netlify/functions/get-tenant-webhook-secret")];
  return {
    publicConfig: require("../netlify/functions/get-supabase-public-config"),
    publishable: require("../netlify/functions/get-stripe-publishable-key"),
    webhookSecret: require("../netlify/functions/get-tenant-webhook-secret"),
  };
}

async function main() {
  const files = gitFiles();
  ok("git file list is non-empty", files.length > 10);

  const hits = [];
  files.forEach((rel) => {
    if (!TEXT_EXT.test(rel)) return;
    if (rel.indexOf("scripts/fixtures/") === 0) return;
    let src;
    try {
      src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    } catch (_err) {
      return;
    }
    SECRET_PATTERNS.forEach((pat) => {
      if (pat.re.test(src)) hits.push({ rel, name: pat.name });
    });
  });
  eq("no hardcoded live secret patterns in git tree", hits.length, 0);

  const publicJs = files.filter(
    (rel) => rel.startsWith("public/") && (rel.endsWith(".js") || rel.endsWith(".html"))
  );
  const browserLeaks = [];
  publicJs.forEach((rel) => {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    if (src.indexOf("SUPABASE_SERVICE_ROLE_KEY") >= 0) browserLeaks.push(rel + ":service_role");
    if (src.indexOf("SESSION_SECRET") >= 0) browserLeaks.push(rel + ":session_secret");
    if (src.indexOf("INTERNAL_API_KEY") >= 0) browserLeaks.push(rel + ":internal_api_key");
  });
  eq("no browser file contains service-role, session, or internal secrets", browserLeaks.length, 0);

  const adminSrc = fs.readFileSync(
    path.join(ROOT, "netlify/functions/_lib/supabase-admin.js"),
    "utf8"
  );
  ok("service role key is server-side only", adminSrc.indexOf("SUPABASE_SERVICE_ROLE_KEY") >= 0);
  ok("service role is sent as Bearer on server", adminSrc.indexOf("Authorization: `Bearer ${key}`") >= 0);

  process.env.SUPABASE_SERVICE_ROLE_KEY = "mg-core-secret-boundaries-test-key";
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy_not_used_in_response";
  process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_dummy_publishable";
  const mods = loadPublicConfig();
  const cfg = await mods.publicConfig.handler({ httpMethod: "GET", headers: {} });
  eq("public supabase config returns 200", cfg.statusCode, 200);
  const cfgBody = JSON.parse(cfg.body);
  eq("public config ok", cfgBody.ok, true);
  const cfgKeys = Object.keys(cfgBody).sort().join(",");
  eq("public config keys are only ok,supabaseUrl,supabaseAnonKey", cfgKeys, "ok,supabaseAnonKey,supabaseUrl");
  ok("public config does not include service role", JSON.stringify(cfgBody).indexOf("SERVICE_ROLE") < 0);
  ok(
    "public config does not include dummy service role value",
    JSON.stringify(cfgBody).indexOf("mg-core-secret-boundaries-test-key") < 0
  );

  const pub = await mods.publishable.handler({ httpMethod: "GET", headers: {} });
  const pubBody = JSON.parse(pub.body);
  ok("stripe publishable endpoint does not return secret key", !pubBody.secret_key && !pubBody.stripe_secret);
  eq("stripe publishable key only", pubBody.publishable_key, "pk_test_dummy_publishable");

  const noKey = await mods.webhookSecret.handler({
    httpMethod: "GET",
    headers: {},
    queryStringParameters: { tenant_email: "owner-a@example.com" },
  });
  eq("webhook secret without internal key is 401", noKey.statusCode, 401);

  const wrongKey = await mods.webhookSecret.handler({
    httpMethod: "GET",
    headers: { "x-internal-key": "wrong-internal-key" },
    queryStringParameters: { tenant_email: "owner-a@example.com" },
  });
  eq("webhook secret with wrong internal key is 401", wrongKey.statusCode, 401);
  ok("unauthorized webhook secret body does not include dynamic_secret", String(wrongKey.body).indexOf("dynamic_secret") < 0);

  const stripeLog = fs.readFileSync(
    path.join(ROOT, "netlify/functions/_lib/stripe-env-log.js"),
    "utf8"
  );
  ok("stripe logs only a key prefix", stripeLog.indexOf("sk.slice(0, 12)") >= 0);
  ok("stripe logs do not print the full secret", stripeLog.indexOf("console.log(sk)") < 0);

  const zapierSrc = fs.readFileSync(path.join(ROOT, "netlify/functions/send-quote-zapier.js"), "utf8");
  ok(
    "FINDING FROZEN: send-quote-zapier logs additional_recipients",
    zapierSrc.indexOf("additional_recipients: data?.additional_recipients") >= 0
  );
  ok(
    "FINDING FROZEN: send-quote-zapier logs client_email payload",
    zapierSrc.indexOf('console.info("[MG Zapier Email Payload]"') >= 0
  );

  const tree = files.join("\n");
  ok(
    "FINDING FROZEN: SendGrid rotation is not verifiable from current code",
    !/SENDGRID_API_KEY|SG\.[A-Za-z0-9_-]{8,}/.test(tree) && zapierSrc.indexOf("SENDGRID") < 0
  );

  const netlifyToml = fs.readFileSync(path.join(ROOT, "netlify.toml"), "utf8");
  ok(
    "FINDING FROZEN: no global Content-Security-Policy in netlify.toml",
    netlifyToml.indexOf("Content-Security-Policy") < 0
  );
  ok(
    "FINDING FROZEN: no global Strict-Transport-Security in netlify.toml",
    netlifyToml.indexOf("Strict-Transport-Security") < 0
  );

  const sellerWf = fs.readFileSync(path.join(ROOT, ".github/workflows/seller-shield-v1.yml"), "utf8");
  const ownerWf = fs.readFileSync(path.join(ROOT, ".github/workflows/owner-shield-v1.yml"), "utf8");
  const hubWf = fs.readFileSync(path.join(ROOT, ".github/workflows/invoice-hub-shield-v2.yml"), "utf8");
  eq("Seller Shield V1 name frozen", /^name:\s*Seller Shield V1\s*$/m.test(sellerWf), true);
  eq("Owner Shield V1 name frozen", /^name:\s*Owner Shield V1\s*$/m.test(ownerWf), true);
  eq("Invoice Hub Shield V2 name frozen", /^name:\s*Invoice Hub Shield V2\s*$/m.test(hubWf), true);
  ok("existing Seller runner is unchanged path", fs.existsSync(path.join(ROOT, "scripts/test-mg-seller-shield-v1.js")));
  ok("existing Owner runner is unchanged path", fs.existsSync(path.join(ROOT, "scripts/test-mg-owner-shield-v1.js")));
  ok(
    "existing Invoice Hub runner is unchanged path",
    fs.existsSync(path.join(ROOT, "scripts/test-invoice-hub-regression-suite.js"))
  );

  const rlsMentions = files.filter((rel) => /rls_disabled_in_public/.test(rel)).length;
  let rlsInContent = false;
  files.forEach((rel) => {
    if (!TEXT_EXT.test(rel)) return;
    if (rel.indexOf("docs/CORE_SECURITY") === 0) return;
    if (rel.indexOf("scripts/test-core-") === 0) return;
    if (rel.indexOf("scripts/mg-core-security") === 0) return;
    if (rel.indexOf("scripts/test-mg-core-security") === 0) return;
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    if (src.indexOf("rls_disabled_in_public") >= 0) {
      rlsInContent = true;
    }
  });
  ok("historical rls_disabled_in_public is not in current product source", rlsMentions === 0 && rlsInContent === false);

  const liveUrl = String(process.env.MG_PRODUCTION_SUPABASE_URL || "").trim();
  const liveKey = String(process.env.MG_PRODUCTION_SUPABASE_READONLY_KEY || "").trim();
  eq(
    "PRODUCTION_RLS_NOT_VERIFIED — no authorized read-only production access in this environment",
    Boolean(liveUrl && liveKey),
    false
  );

  console.log("\nCore secret boundaries: " + passed + " passed");
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
