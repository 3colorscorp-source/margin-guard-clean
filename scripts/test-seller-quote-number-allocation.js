#!/usr/bin/env node
/**
 * Isolated quote-number allocation tests against the real publish-public-quote handler.
 * Fake Supabase fetch only. No live Supabase, Zapier, or Netlify.
 * Run: node scripts/test-seller-quote-number-allocation.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Module = require("module");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const FAKE_SUPABASE = "https://seller-quote-alloc.example.supabase.co";
const FAKE_TENANT_ID = "11111111-1111-4111-8111-111111111111";
const FAKE_QUOTE_ID = "99999999-9999-4999-8999-999999999999";

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

function isTenantDeviceGuardRequest(request) {
  const n = String(request || "").replace(/\\/g, "/");
  return n === "./_lib/tenant-device-guard" || n.endsWith("/_lib/tenant-device-guard");
}

const publishSrc = fs.readFileSync(path.join(ROOT, "netlify/functions/publish-public-quote.js"), "utf8");
checkSyntax("netlify/functions/publish-public-quote.js");
ok("syntax publish-public-quote", true);
ok("publish allocates via allocate_next_quote_number RPC", /rpc\/allocate_next_quote_number/.test(publishSrc));
ok("allocate requires tenant_id", /missing tenant_id \(cannot call RPC with empty body\)/.test(publishSrc));
ok("incomplete allocate response fails", /allocate_next_quote_number returned incomplete data/.test(publishSrc));
ok("no local Date.now quote-number fallback", !/quote_number_display\s*=\s*.*Date\.now/.test(publishSrc));
ok("no Math.random quote-number fallback", !/quote_number[\s\S]{0,80}Math\.random/.test(publishSrc));
ok("RPC body uses p_tenant_id", /body:\s*\{\s*p_tenant_id:\s*tid/.test(publishSrc));

const SETTINGS = {
  hoursPerDay: 8,
  baseInstaller: 75,
  baseHelper: 45,
  wcPct: 0,
  ficaPct: 0,
  futaPct: 0,
  casuiPct: 0,
  stdHours: 160,
  overheadMonthly: 0,
  profitPct: 30,
  reservePct: 5,
};

const hoursOnlyBody = {
  workers: [{ name: "Pro 1", type: "installer", days: 0, hours: 40 }],
  pricing_stage: 2,
  project_name: "Alloc Job",
  client_name: "Test Client",
  client_email: "client@test.example",
};

async function runPublish({ tenantId, allocImpl, insertCalls }) {
  const originalLoad = Module._load;
  const originalFetch = globalThis.fetch;
  const envBackup = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    URL: process.env.URL,
  };
  const fetchLog = [];
  const allocBodies = [];
  process.env.SUPABASE_URL = FAKE_SUPABASE;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "isolated-test-service-role";
  process.env.URL = FAKE_SUPABASE;

  Module._load = function patchedLoad(request, parent, isMain) {
    if (isTenantDeviceGuardRequest(request)) {
      return {
        resolveOwnerOrSellerContext: async () => ({
          auth_mode: "owner",
          tenant: { id: tenantId },
          session: { e: "owner@test.example" },
        }),
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  globalThis.fetch = async function mockFetch(url, options) {
    const u = String(url);
    const method = String((options && options.method) || "GET").toUpperCase();
    fetchLog.push({ method, url: u });
    if (/zapier|netlify\.app/i.test(u) || !u.startsWith(FAKE_SUPABASE)) {
      throw new Error("blocked non-isolated fetch: " + u);
    }
    const parsed = new URL(u);
    const pathname = parsed.pathname;
    if (pathname === "/rest/v1/tenant_snapshots") {
      return jsonRes(200, [{ payload: { storage: { mg_settings_v2: SETTINGS } } }]);
    }
    if (pathname === "/rest/v1/rpc/allocate_next_quote_number") {
      const body = JSON.parse((options && options.body) || "{}");
      allocBodies.push(body);
      return allocImpl(body);
    }
    if (pathname === "/rest/v1/tenants" || pathname === "/rest/v1/tenant_branding") {
      return jsonRes(200, []);
    }
    if (pathname === "/rest/v1/quotes" && method === "GET") {
      return jsonRes(200, []);
    }
    if (pathname === "/rest/v1/quotes" && method === "POST") {
      const payload = JSON.parse((options && options.body) || "{}");
      insertCalls.push(payload);
      return jsonRes(201, [{ id: FAKE_QUOTE_ID, tenant_id: FAKE_TENANT_ID, total: payload.total }]);
    }
    if (pathname === "/rest/v1/tenant_contacts") {
      return jsonRes(200, []);
    }
    if (pathname.indexOf("/rest/v1/rpc/") === 0) {
      return jsonRes(200, { ok: true });
    }
    throw new Error("unexpected isolated fetch: " + method + " " + u);
  };

  try {
    bustNetlifyFunctionsCache();
    const publishMod = require("../netlify/functions/publish-public-quote");
    const res = await publishMod.handler({
      httpMethod: "POST",
      headers: {},
      body: JSON.stringify(hoursOnlyBody),
    });
    return {
      status: res.statusCode,
      body: JSON.parse(res.body || "{}"),
      fetchLog,
      allocBodies,
    };
  } finally {
    Module._load = originalLoad;
    globalThis.fetch = originalFetch;
    process.env.SUPABASE_URL = envBackup.SUPABASE_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = envBackup.SUPABASE_SERVICE_ROLE_KEY;
    process.env.URL = envBackup.URL;
    bustNetlifyFunctionsCache();
  }
}

(async function main() {
  const missingTenantInserts = [];
  const missing = await runPublish({
    tenantId: "",
    insertCalls: missingTenantInserts,
    allocImpl: async () => {
      throw new Error("allocate must not run without tenant_id");
    },
  });
  ok("missing tenant_id does not INSERT quote", missingTenantInserts.length === 0);
  ok(
    "missing tenant_id fails before allocate or reports error",
    missing.status >= 400 || missing.body.ok === false || /tenant/i.test(String(missing.body.error || missing.body.message || ""))
  );

  const incompleteInserts = [];
  const incomplete = await runPublish({
    tenantId: FAKE_TENANT_ID,
    insertCalls: incompleteInserts,
    allocImpl: async (body) => {
      eq("incomplete alloc still sent p_tenant_id", body.p_tenant_id, FAKE_TENANT_ID);
      return jsonRes(200, { quote_year: 2026 });
    },
  });
  ok("incomplete allocate does not INSERT quote", incompleteInserts.length === 0);
  ok("incomplete allocate is not 200 ok insert", incomplete.status !== 201);
  ok("incomplete allocate surfaces failure", incomplete.status >= 400 || incomplete.body.ok === false);

  const firstInserts = [];
  let seq = 0;
  const first = await runPublish({
    tenantId: FAKE_TENANT_ID,
    insertCalls: firstInserts,
    allocImpl: async (body) => {
      eq("first alloc p_tenant_id", body.p_tenant_id, FAKE_TENANT_ID);
      seq += 1;
      return jsonRes(200, {
        quote_year: 2026,
        quote_sequence: seq,
        quote_number_display: "2026-00" + seq,
      });
    },
  });
  eq("first publish status 200", first.status, 200);
  eq("first publish inserted once", firstInserts.length, 1);
  eq("first quote number", firstInserts[0].quote_number_display, "2026-001");

  const secondInserts = [];
  const second = await runPublish({
    tenantId: FAKE_TENANT_ID,
    insertCalls: secondInserts,
    allocImpl: async (body) => {
      eq("second alloc p_tenant_id", body.p_tenant_id, FAKE_TENANT_ID);
      seq += 1;
      return jsonRes(200, {
        quote_year: 2026,
        quote_sequence: seq,
        quote_number_display: "2026-00" + seq,
      });
    },
  });
  eq("second publish status 200", second.status, 200);
  eq("second publish inserted once", secondInserts.length, 1);
  eq("second quote number", secondInserts[0].quote_number_display, "2026-002");
  ok("two publishes received distinct numbers", firstInserts[0].quote_number_display !== secondInserts[0].quote_number_display);
  ok("no zapier host in first fetch log", first.fetchLog.every((row) => row.url.startsWith(FAKE_SUPABASE)));
  ok("no zapier host in second fetch log", second.fetchLog.every((row) => row.url.startsWith(FAKE_SUPABASE)));

  console.log("\n" + passed + " passed");
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
