#!/usr/bin/env node
/**
 * Isolated tests for get-seller-business-settings.
 * Dummy device context + fake Supabase fetch. No live network, SQL, or secrets.
 * Run: node scripts/test-get-seller-business-settings.js
 */
"use strict";

const assert = require("assert");
const path = require("path");
const Module = require("module");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const FAKE_SUPABASE = "https://seller-settings.example.supabase.co";
const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";

let passed = 0;
function ok(label, cond) {
  assert.ok(cond, label);
  passed += 1;
  console.log("PASS " + label);
}

function eq(label, actual, expected) {
  assert.strictEqual(actual, expected, label + " expected " + JSON.stringify(expected) + " got " + JSON.stringify(actual));
  passed += 1;
  console.log("PASS " + label);
}

function checkSyntax(rel) {
  const r = spawnSync(process.execPath, ["--check", path.join(ROOT, rel)], { encoding: "utf8" });
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || rel);
}

function jsonRes(status, data) {
  const text = JSON.stringify(data);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
  };
}

function bustNetlifyFunctionsCache() {
  for (const key of Object.keys(require.cache)) {
    if (key.replace(/\\/g, "/").includes("/netlify/functions/")) {
      delete require.cache[key];
    }
  }
}

function isGuardRequest(request) {
  const n = String(request || "").replace(/\\/g, "/");
  return n === "./_lib/tenant-device-guard" || n.endsWith("/_lib/tenant-device-guard");
}

function sellerCtx(tenantId) {
  return {
    auth_mode: "device",
    portalType: "seller",
    tenant: { id: tenantId, name: "Tenant " + tenantId.slice(0, 4) },
    membership: { id: "mem-seller", role: "seller", status: "active" },
    device: { id: "dev-1", status: "active" },
  };
}

function guardErr(statusCode, message, code) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  err.isGuardError = true;
  return err;
}

const VALID_MG = {
  baseInstaller: 75,
  baseHelper: 45,
  hoursPerDay: 8,
  pricingMode: "hour",
  currency: "USD",
};

checkSyntax("netlify/functions/get-seller-business-settings.js");
ok("syntax get-seller-business-settings", true);

async function runWith({ deviceImpl, fetchImpl }) {
  const originalLoad = Module._load;
  const originalFetch = globalThis.fetch;
  const envBackup = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };
  const fetchLog = [];
  process.env.SUPABASE_URL = FAKE_SUPABASE;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "isolated-test-service-role";

  Module._load = function patchedLoad(request, parent, isMain) {
    if (isGuardRequest(request)) {
      return {
        requireSellerDevice: deviceImpl,
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  globalThis.fetch = async function mockFetch(url, options) {
    const u = String(url);
    fetchLog.push({ url: u, method: String((options && options.method) || "GET").toUpperCase() });
    if (!u.startsWith(FAKE_SUPABASE) || /zapier|netlify\.app/i.test(u)) {
      throw new Error("blocked non-isolated fetch: " + u);
    }
    return fetchImpl(u, options, fetchLog);
  };

  try {
    bustNetlifyFunctionsCache();
    const mod = require("../netlify/functions/get-seller-business-settings");
    const res = await mod.handler({ httpMethod: "GET", headers: {} });
    return { status: res.statusCode, body: JSON.parse(res.body || "{}"), fetchLog };
  } finally {
    Module._load = originalLoad;
    globalThis.fetch = originalFetch;
    process.env.SUPABASE_URL = envBackup.SUPABASE_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = envBackup.SUPABASE_SERVICE_ROLE_KEY;
    bustNetlifyFunctionsCache();
  }
}

(async function main() {
  const valid = await runWith({
    deviceImpl: async () => sellerCtx(TENANT_A),
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      eq("valid seller snapshot tenant query", parsed.searchParams.get("tenant_id"), "eq." + TENANT_A);
      ok("valid seller uses latest snapshot order", /created_at\.desc/.test(parsed.search));
      ok("valid seller limits to one snapshot", /limit=1/.test(parsed.search));
      return jsonRes(200, [
        { payload: { storage: { mg_settings_v2: VALID_MG } } },
      ]);
    },
  });
  eq("valid seller device status 200", valid.status, 200);
  eq("valid seller ok", valid.body.ok, true);
  eq("valid seller hoursPerDay", valid.body.settings.hoursPerDay, 8);
  eq("valid seller tenant A installer", valid.body.settings.baseInstaller, 75);
  eq("valid seller source is snapshot", valid.body.source, "tenant_snapshot");
  ok("valid seller fetch stayed on fake supabase", valid.fetchLog.every((row) => row.url.startsWith(FAKE_SUPABASE)));

  const cross = await runWith({
    deviceImpl: async () => sellerCtx(TENANT_A),
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      const tenantEq = parsed.searchParams.get("tenant_id");
      ok("cross-tenant query does not use tenant B", tenantEq !== "eq." + TENANT_B);
      eq("cross-tenant still scopes to seller tenant A", tenantEq, "eq." + TENANT_A);
      return jsonRes(200, [
        { payload: { storage: { mg_settings_v2: { ...VALID_MG, baseInstaller: 75 } } } },
      ]);
    },
  });
  eq("tenant A does not receive tenant B installer", cross.body.settings.baseInstaller, 75);
  ok("tenant A response is not tenant B payload", cross.body.settings.baseInstaller !== 999);

  const missing = await runWith({
    deviceImpl: async () => sellerCtx(TENANT_A),
    fetchImpl: async () => jsonRes(200, []),
  });
  eq("missing settings status 200", missing.status, 200);
  eq("missing settings ok false", missing.body.ok, false);
  eq("missing settings code", missing.body.code, "seller_settings_missing");

  const invalid = await runWith({
    deviceImpl: async () => sellerCtx(TENANT_A),
    fetchImpl: async () =>
      jsonRes(200, [{ payload: { storage: { mg_settings_v2: { hoursPerDay: 0 } } } }]),
  });
  eq("invalid settings code", invalid.body.code, "seller_settings_missing");

  const revoked = await runWith({
    deviceImpl: async () => {
      throw guardErr(401, "Device session revoked", "device_session_revoked");
    },
    fetchImpl: async (url) => {
      throw new Error("revoked session must not query snapshots: " + url);
    },
  });
  eq("revoked session status 401", revoked.status, 401);
  eq("revoked session ok false", revoked.body.ok, false);
  eq("revoked session did not fetch snapshots", revoked.fetchLog.length, 0);

  console.log("\n" + passed + " passed");
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
