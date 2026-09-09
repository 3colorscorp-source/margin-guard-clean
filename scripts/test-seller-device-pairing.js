#!/usr/bin/env node
/**
 * Isolated Seller device pairing / session tests against real handlers + pairing markup.
 * Dummy SESSION_SECRET and fake Supabase fetch. No live network, SQL, or secrets.
 * Run: node scripts/test-seller-device-pairing.js
 */
"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const FAKE_SUPABASE = "https://seller-pair.example.supabase.co";
const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MEMBERSHIP_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const DEVICE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const VALID_CODE = "AB12CD34";

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

function hashCode(code) {
  return crypto.createHash("sha256").update(String(code), "utf8").digest("hex");
}

function bustNetlifyFunctionsCache() {
  for (const key of Object.keys(require.cache)) {
    if (key.replace(/\\/g, "/").includes("/netlify/functions/")) {
      delete require.cache[key];
    }
  }
}

const html = fs.readFileSync(path.join(ROOT, "public/portal-pair.html"), "utf8");
const authJs = fs.readFileSync(path.join(ROOT, "public/js/device-portal-auth.js"), "utf8");

checkSyntax("netlify/functions/pair-device.js");
checkSyntax("netlify/functions/device-auth-status.js");
checkSyntax("netlify/functions/device-heartbeat.js");
checkSyntax("netlify/functions/device-logout.js");
checkSyntax("public/js/device-portal-auth.js");
ok("syntax pairing handlers and device-portal-auth", true);
ok("pairing UI posts to pair-device", html.indexOf("/pair-device") >= 0);
ok("pairing UI has seller portal option", /option value="seller"/.test(html));
ok("pairing UI enforces 8-character code", /maxlength="8"/.test(html) && /\[A-Z0-9\]\{8\}/.test(html));
ok("pairing UI says seller/supervisor tablets only", /seller and supervisor tablets only/i.test(html));
ok("device-portal-auth keeps pair-device portal redirect", /portal-pair\$\{qs\}/.test(authJs) && /p === "seller"/.test(authJs));
ok("device-portal-auth uses device-auth-status", /device-auth-status/.test(authJs));
ok("device-portal-auth uses device-heartbeat", /device-heartbeat/.test(authJs));
ok("device-portal-auth uses device-logout", /device-logout/.test(authJs));

function pendingDevice(overrides) {
  const future = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  return Object.assign(
    {
      id: DEVICE_ID,
      tenant_id: TENANT_A,
      assigned_membership_id: MEMBERSHIP_ID,
      portal_type: "seller",
      status: "pending_pair",
      display_name: "Seller tablet",
      pairing_expires_at: future,
      pairing_code_hash: hashCode(VALID_CODE),
    },
    overrides || {}
  );
}

function sellerMembership(overrides) {
  return Object.assign(
    {
      id: MEMBERSHIP_ID,
      tenant_id: TENANT_A,
      email: "seller@test.example",
      role: "seller",
      status: "active",
      display_name: "Seller One",
    },
    overrides || {}
  );
}

async function withHandlers(fetchImpl, fn) {
  const originalFetch = globalThis.fetch;
  const envBackup = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    SESSION_SECRET: process.env.SESSION_SECRET,
  };
  process.env.SUPABASE_URL = FAKE_SUPABASE;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "isolated-test-service-role";
  process.env.SESSION_SECRET = "isolated-seller-shield-v2-session-secret";
  const fetchLog = [];
  globalThis.fetch = async function mockFetch(url, options) {
    const u = String(url);
    const method = String((options && options.method) || "GET").toUpperCase();
    const body = options && options.body ? JSON.parse(options.body) : null;
    fetchLog.push({ url: u, method, body });
    if (!u.startsWith(FAKE_SUPABASE) || /zapier|hooks\.zapier/i.test(u)) {
      throw new Error("blocked non-isolated fetch: " + u);
    }
    return fetchImpl(u, method, body, fetchLog);
  };
  try {
    bustNetlifyFunctionsCache();
    const pair = require("../netlify/functions/pair-device");
    const status = require("../netlify/functions/device-auth-status");
    const heartbeat = require("../netlify/functions/device-heartbeat");
    const logout = require("../netlify/functions/device-logout");
    return await fn({ pair, status, heartbeat, logout, fetchLog });
  } finally {
    globalThis.fetch = originalFetch;
    process.env.SUPABASE_URL = envBackup.SUPABASE_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = envBackup.SUPABASE_SERVICE_ROLE_KEY;
    process.env.SESSION_SECRET = envBackup.SESSION_SECRET;
    bustNetlifyFunctionsCache();
  }
}

function parseRes(res) {
  return {
    status: res.statusCode,
    body: JSON.parse(res.body || "{}"),
    headers: res.headers || {},
  };
}

(async function main() {
  const store = {
    device: pendingDevice(),
    membership: sellerMembership(),
    activeSellerCount: 0,
    sessions: [],
  };

  await withHandlers(async (url, method, body) => {
    const parsed = new URL(url);
    const pathname = parsed.pathname;
    if (pathname === "/rest/v1/tenant_devices" && method === "GET" && /pairing_code_hash/.test(parsed.search)) {
      const want = parsed.searchParams.get("pairing_code_hash");
      if (want === "eq." + hashCode(VALID_CODE) && store.device) return jsonRes(200, [store.device]);
      return jsonRes(200, []);
    }
    if (pathname === "/rest/v1/tenant_devices" && method === "GET" && /portal_type=eq.seller/.test(parsed.search)) {
      const rows = [];
      for (let i = 0; i < store.activeSellerCount; i += 1) rows.push({ id: "active-" + i });
      return jsonRes(200, rows);
    }
    if (pathname === "/rest/v1/tenant_devices" && method === "PATCH") {
      store.device = Object.assign({}, store.device, body, { id: DEVICE_ID, status: body.status || "active" });
      return jsonRes(200, [store.device]);
    }
    if (pathname === "/rest/v1/profiles") {
      return jsonRes(200, [store.membership]);
    }
    if (pathname === "/rest/v1/tenants") {
      return jsonRes(200, [{ id: TENANT_A, name: "Tenant A", slug: "tenant-a" }]);
    }
    if (pathname === "/rest/v1/device_sessions" && method === "POST") {
      store.sessions.push(body);
      return jsonRes(201, [{ id: body.id, status: "active", expires_at: body.expires_at }]);
    }
    if (pathname === "/rest/v1/device_sessions" && method === "PATCH") {
      return jsonRes(200, [{ id: "sess-revoked", status: body.status || "revoked" }]);
    }
    throw new Error("unexpected fetch " + method + " " + url);
  }, async ({ pair, fetchLog }) => {
    const invalid = parseRes(
      await pair.handler({ httpMethod: "POST", body: JSON.stringify({ pairing_code: "nope" }) })
    );
    eq("invalid code format status 400", invalid.status, 400);
    eq("invalid code format code", invalid.body.code, "invalid_pairing_code_format");
    ok("invalid code did not query supabase", fetchLog.length === 0);

    const expired = parseRes(
      await pair.handler({ httpMethod: "POST", body: JSON.stringify({ pairing_code: "ZZ99ZZ99" }) })
    );
    eq("expired/unknown code status 401", expired.status, 401);
    eq("expired code code", expired.body.code, "pairing_code_invalid");

    store.membership = sellerMembership({ role: "supervisor" });
    const role = parseRes(
      await pair.handler({ httpMethod: "POST", body: JSON.stringify({ pairing_code: VALID_CODE }) })
    );
    eq("seller role required status 403", role.status, 403);
    eq("seller role mismatch code", role.body.code, "membership_role_mismatch");

    store.membership = sellerMembership({ tenant_id: TENANT_B });
    const tenant = parseRes(
      await pair.handler({ httpMethod: "POST", body: JSON.stringify({ pairing_code: VALID_CODE }) })
    );
    eq("wrong tenant status 403", tenant.status, 403);
    eq("wrong tenant code", tenant.body.code, "tenant_mismatch");

    store.membership = sellerMembership();
    store.activeSellerCount = 3;
    const limit = parseRes(
      await pair.handler({ httpMethod: "POST", body: JSON.stringify({ pairing_code: VALID_CODE }) })
    );
    eq("seller device limit status 403", limit.status, 403);
    eq("seller device limit code", limit.body.code, "seller_device_limit");

    store.activeSellerCount = 0;
    fetchLog.length = 0;
    const okPair = parseRes(
      await pair.handler({ httpMethod: "POST", body: JSON.stringify({ pairing_code: VALID_CODE }) })
    );
    eq("valid seller pair status 200", okPair.status, 200);
    eq("valid seller pair ok", okPair.body.ok, true);
    eq("valid seller pair tenant", okPair.body.tenant.id, TENANT_A);
    eq("valid seller pair portal", okPair.body.portal_type, "seller");
    ok("valid seller pair sets cookie", /mg_device_session=/.test(String(okPair.headers["Set-Cookie"] || "")));
    ok("session row posted", store.sessions.length === 1);
    eq("session row tenant", store.sessions[0].tenant_id, TENANT_A);
  });

  const Module = require("module");
  const originalLoad = Module._load;
  process.env.SUPABASE_URL = FAKE_SUPABASE;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "isolated-test-service-role";
  process.env.SESSION_SECRET = "isolated-seller-shield-v2-session-secret";
  const ctx = {
    portalType: "seller",
    tenant: { id: TENANT_A, name: "Tenant A" },
    membership: sellerMembership(),
    device: { id: DEVICE_ID, display_name: "Seller tablet", status: "active" },
    deviceSession: { id: "sess-1", expires_at: new Date(Date.now() + 86400000).toISOString() },
  };
  let heartbeatPatched = false;
  let logoutRevoked = false;
  globalThis.fetch = async function mockFetch(url, options) {
    const u = String(url);
    if (!u.startsWith(FAKE_SUPABASE)) throw new Error("blocked non-isolated fetch: " + u);
    const method = String((options && options.method) || "GET").toUpperCase();
    const body = options && options.body ? JSON.parse(options.body) : null;
    if (/device_sessions/.test(u) && method === "PATCH") {
      if (body && body.status === "revoked") logoutRevoked = true;
      heartbeatPatched = true;
      return jsonRes(200, [{ id: "sess-1", expires_at: ctx.deviceSession.expires_at }]);
    }
    if (/tenant_devices/.test(u) && method === "PATCH") {
      return jsonRes(200, [{ id: DEVICE_ID }]);
    }
    throw new Error("unexpected session fetch " + method + " " + u);
  };
  Module._load = function patchedLoad(request, parent, isMain) {
    const n = String(request || "").replace(/\\/g, "/");
    if (n === "./_lib/tenant-device-guard" || n.endsWith("/_lib/tenant-device-guard")) {
      return {
        requireDeviceSession: async () => ctx,
        resolveDeviceSession: async () => ctx,
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    bustNetlifyFunctionsCache();
    const statusMod = require("../netlify/functions/device-auth-status");
    const hbMod = require("../netlify/functions/device-heartbeat");
    const outMod = require("../netlify/functions/device-logout");
    const st = parseRes(await statusMod.handler({ httpMethod: "GET", headers: {} }));
    eq("device-auth-status 200", st.status, 200);
    eq("device-auth-status active", st.body.active, true);
    eq("device-auth-status tenant", st.body.tenant.id, TENANT_A);
    const hb = parseRes(await hbMod.handler({ httpMethod: "POST", headers: {} }));
    eq("heartbeat 200", hb.status, 200);
    eq("heartbeat ok", hb.body.ok, true);
    ok("heartbeat patched session", heartbeatPatched);
    const lo = parseRes(await outMod.handler({ httpMethod: "POST", headers: {} }));
    eq("logout 200", lo.status, 200);
    eq("logout ok", lo.body.ok, true);
    ok("logout revoked session", logoutRevoked);
    ok("logout clears cookie", /mg_device_session=/.test(String(lo.headers["Set-Cookie"] || "")));
  } finally {
    Module._load = originalLoad;
    delete globalThis.fetch;
    bustNetlifyFunctionsCache();
  }

  console.log("\n" + passed + " passed");
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
