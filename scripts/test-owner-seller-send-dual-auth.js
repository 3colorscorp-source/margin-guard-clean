#!/usr/bin/env node
/**
 * Owner vs seller dual-auth for Enviar estimate.
 * Isolated mocks only. No live Netlify, Zapier, quotes, or email.
 * Run: node scripts/test-owner-seller-send-dual-auth.js
 */
"use strict";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET || "mg-owner-seller-send-dual-auth-test-secret";
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "mg-owner-seller-send-dual-auth-key";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const { buildSessionPayload, createSessionCookie } = require("../netlify/functions/_lib/session");
const {
  buildDeviceSessionPayload,
  createDeviceSessionCookieFromPayload,
} = require("../netlify/functions/_lib/device-session");

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

let passed = 0;
function ok(label, cond) {
  assert.ok(cond, label);
  passed += 1;
  console.log("PASS " + label);
}

function eq(label, a, b) {
  assert.strictEqual(a, b, label + " expected " + JSON.stringify(b) + " got " + JSON.stringify(a));
  passed += 1;
  console.log("PASS " + label);
}

function jsonRes(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return typeof body === "string" ? body : JSON.stringify(body);
    },
  };
}

function extractPath(url) {
  const s = String(url);
  const idx = s.indexOf("/rest/v1/");
  return idx >= 0 ? s.slice(idx + "/rest/v1/".length) : s;
}

function qp(restPath, key) {
  const q = restPath.split("?")[1] || "";
  const part = q.split("&").find((p) => p.startsWith(key + "="));
  if (!part) return "";
  return decodeURIComponent(part.slice(key.length + 1).replace(/^eq\./, ""));
}

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWNER_A = "owner-a@example.com";
const USER_A = "11111111-1111-4111-8111-111111111111";
const DEVICE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SELLER_MEM = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const DEVICE_SESS = "ffffffff-ffff-4fff-8fff-ffffffffffff";

function tenantRow(id, email) {
  return {
    id,
    slug: id.slice(0, 8),
    name: "Co " + id.slice(0, 4),
    owner_email: email,
    plan_status: "active",
    stripe_customer_id: null,
  };
}

function ownerProfile(tenantId, email) {
  return {
    id: "prof-" + tenantId.slice(0, 8),
    tenant_id: tenantId,
    email,
    role: "owner",
    status: "active",
    auth_user_id: USER_A,
  };
}

function sellerProfile() {
  return {
    id: SELLER_MEM,
    tenant_id: TENANT_A,
    email: "seller-a@example.com",
    role: "seller",
    status: "active",
    auth_user_id: "seller-user-a",
  };
}

function cookieOwner(fields) {
  return createSessionCookie(
    buildSessionPayload({
      email: fields.e || "",
      tenantId: fields.t || "",
      userId: fields.u || "",
      customerId: fields.c || "",
    })
  );
}

function loadGuard() {
  [
    "../netlify/functions/_lib/supabase-admin",
    "../netlify/functions/_lib/membership-resolve",
    "../netlify/functions/_lib/owner-access",
    "../netlify/functions/_lib/tenant-for-session",
    "../netlify/functions/_lib/device-session",
    "../netlify/functions/_lib/tenant-device-guard",
    "../netlify/functions/publish-public-quote",
    "../netlify/functions/send-quote-zapier",
    "../netlify/functions/calc-secure-pricing",
  ].forEach((rel) => {
    delete require.cache[require.resolve(rel)];
  });
  return {
    guard: require("../netlify/functions/_lib/tenant-device-guard"),
    publish: require("../netlify/functions/publish-public-quote"),
    zapier: require("../netlify/functions/send-quote-zapier"),
    calc: require("../netlify/functions/calc-secure-pricing"),
  };
}

async function withDb(fn) {
  const queries = [];
  const tenants = {
    [TENANT_A]: tenantRow(TENANT_A, OWNER_A),
    [TENANT_B]: tenantRow(TENANT_B, "owner-b@example.com"),
  };
  const profiles = [ownerProfile(TENANT_A, OWNER_A), ownerProfile(TENANT_B, "owner-b@example.com"), sellerProfile()];
  const sellerDevice = createDeviceSessionCookieFromPayload(
    buildDeviceSessionPayload({
      sessionId: DEVICE_SESS,
      deviceId: DEVICE_ID,
      tenantId: TENANT_A,
      membershipId: SELLER_MEM,
      portalType: "seller",
    })
  );

  const prev = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const restPath = extractPath(url);
    const table = restPath.split("?")[0];
    queries.push(table);
    if (table === "profiles") {
      const email = qp(restPath, "email");
      const tenantId = qp(restPath, "tenant_id");
      const id = qp(restPath, "id");
      const role = qp(restPath, "role");
      const rows = profiles.filter((p) => {
        if (email && p.email !== email) return false;
        if (tenantId && p.tenant_id !== tenantId) return false;
        if (id && p.id !== id) return false;
        if (role && p.role !== role) return false;
        return true;
      });
      return jsonRes(200, rows);
    }
    if (table === "tenants") {
      const id = qp(restPath, "id");
      const row = tenants[id];
      return jsonRes(200, row ? [row] : []);
    }
    if (table === "device_sessions") {
      const hash = qp(restPath, "session_token_hash");
      if (hash && hash === sellerDevice.tokenHash) {
        return jsonRes(200, [
          {
            id: DEVICE_SESS,
            device_id: DEVICE_ID,
            tenant_id: TENANT_A,
            membership_id: SELLER_MEM,
            portal_type: "seller",
            status: "active",
            expires_at: new Date(Date.now() + 86400000).toISOString(),
            session_token_hash: sellerDevice.tokenHash,
          },
        ]);
      }
      return jsonRes(200, []);
    }
    if (table === "tenant_devices") {
      const id = qp(restPath, "id");
      if (id === DEVICE_ID) {
        return jsonRes(200, [
          {
            id: DEVICE_ID,
            tenant_id: TENANT_A,
            portal_type: "seller",
            status: "active",
          },
        ]);
      }
      return jsonRes(200, []);
    }
    return jsonRes(200, []);
  };

  try {
    const mods = loadGuard();
    return await fn({ mods, queries, sellerDevice, tenants });
  } finally {
    globalThis.fetch = prev;
  }
}

function eventWithCookie(cookieHeader) {
  return {
    httpMethod: "POST",
    headers: cookieHeader ? { cookie: String(cookieHeader).split(";")[0] } : {},
    body: "{}",
  };
}

async function main() {
  const guardSrc = read("netlify/functions/_lib/tenant-device-guard.js");
  const publishSrc = read("netlify/functions/publish-public-quote.js");
  const zapierSrc = read("netlify/functions/send-quote-zapier.js");
  const calcSrc = read("netlify/functions/calc-secure-pricing.js");
  const contactSrc = read("netlify/functions/upsert-tenant-contact.js");
  const projectSrc = read("netlify/functions/upsert-tenant-project.js");
  const listContactsSrc = read("netlify/functions/list-tenant-contacts.js");
  const calendarSrc = read("netlify/functions/get-sales-capacity-calendar.js");
  const salesSrc = read("public/sales.html");
  const devicePortalSrc = read("public/js/sales-device-portal.js");
  const sendFn = salesSrc.slice(salesSrc.indexOf("async function runSellerSend"));

  ok("dual-auth helper uses hasOwnerSessionIdentity", /hasOwnerSessionIdentity\(session\)/.test(guardSrc));
  ok("owner path no longer requires session.c", !/session\?\.e && session\?\.c/.test(guardSrc.split("async function resolveOwnerOrSellerContext")[1].split("async function resolveOwnerOrSupervisorContext")[0]));
  ok("seller device fallback remains", /requireSellerDevice\(event\)/.test(guardSrc));
  ok("publish uses dual-auth helper", /resolveOwnerOrSellerContext/.test(publishSrc));
  ok("zapier uses dual-auth helper", /resolveOwnerOrSellerContext/.test(zapierSrc));
  ok("calc-secure-pricing uses dual-auth helper", /resolveOwnerOrSellerContext/.test(calcSrc));
  ok("contact upsert uses dual-auth helper", /resolveOwnerOrSellerContext/.test(contactSrc));
  ok("project upsert uses dual-auth helper", /resolveOwnerOrSellerContext/.test(projectSrc));
  ok("contact list uses dual-auth helper", /resolveOwnerOrSellerContext/.test(listContactsSrc));
  ok("capacity calendar uses dual-auth helper", /resolveOwnerOrSellerContext/.test(calendarSrc));

  const publishIdx = sendFn.indexOf("publish-public-quote");
  const zapierIdx = sendFn.indexOf("send-quote-zapier");
  ok("guardar/publicar happens before zapier send", publishIdx > 0 && zapierIdx > publishIdx);
  ok("owner publish fetch keeps credentials include", /fetch\('\/.netlify\/functions\/publish-public-quote'[\s\S]{0,180}credentials:\s*'include'/.test(sendFn));
  ok("owner send does not require device_session in browser", !/device_session/.test(sendFn));
  ok("publish 401 error is thrown into the UI path", /throw new Error\(publishParsed\.error/.test(sendFn));
  ok("seller-send still logs the real error", /console\.error\('\[seller-send\]',\s*error\)/.test(sendFn));
  ok("single click disables Confirmar y enviar", /sendButton\.disabled = true/.test(sendFn) && /cleanSendNow\.addEventListener\('click',\s*runSellerSend,\s*true\)/.test(salesSrc));
  ok("owner portal prefers auth-status not device pair", /tryOwnerAuth/.test(devicePortalSrc) && /applyOwnerMode\(ownerData\)/.test(devicePortalSrc));
  ok("forced seller portal does not inherit owner mode", /if \(forcedSeller\)[\s\S]{0,220}applySellerPortalBlockedState/.test(devicePortalSrc));
  ok("fetch guard does not rewrite owner fetch", /function installFetchGuard\(\) \{\s*if \(fetchGuardInstalled/.test(devicePortalSrc) && /fetchGuardInstalled = true;\s*\}/.test(devicePortalSrc));

  const modern = { e: OWNER_A, t: TENANT_A, u: USER_A, c: "" };

  await withDb(async ({ mods, queries, sellerDevice }) => {
    const ownerEvent = eventWithCookie(cookieOwner(modern));
    const ctx = await mods.guard.resolveOwnerOrSellerContext(ownerEvent);
    eq("owner modern session auth_mode is owner", ctx.auth_mode, "owner");
    eq("owner modern session tenant is session.t", ctx.tenant.id, TENANT_A);
    ok("owner modern session does not query device_sessions", !queries.includes("device_sessions"));

    const publishRes = await mods.publish.handler(ownerEvent);
    ok("publish with modern owner is not Device session required", publishRes.statusCode !== 401);
    ok(
      "publish with modern owner does not return device-session error",
      !/Device session required/.test(publishRes.body || "")
    );

    const zapierRes = await mods.zapier.handler(ownerEvent);
    ok("zapier with modern owner is not 401 device session", zapierRes.statusCode !== 401 || !/Device session required/.test(zapierRes.body || ""));

    const calcRes = await mods.calc.handler({
      httpMethod: "POST",
      headers: ownerEvent.headers,
      body: JSON.stringify({ workers: [], price: 1000 }),
    });
    ok("calc-secure-pricing with modern owner is not Device session required", !/Device session required/.test(calcRes.body || ""));
  });

  await withDb(async ({ mods, queries, sellerDevice }) => {
    const ctx = await mods.guard.resolveOwnerOrSellerContext(eventWithCookie(sellerDevice.cookie));
    eq("seller device auth_mode is device", ctx.auth_mode, "device");
    eq("seller device tenant stays isolated", ctx.tenant.id, TENANT_A);
    ok("seller is not granted owner auth_mode", ctx.auth_mode !== "owner");
    ok("seller path uses device_sessions", queries.includes("device_sessions"));
  });

  await withDb(async ({ mods }) => {
    let threw = null;
    try {
      await mods.guard.resolveOwnerOrSellerContext(eventWithCookie("mg_device_session=not-a-valid-device"));
    } catch (err) {
      threw = err;
    }
    ok("invalid seller session is rejected", threw && threw.isGuardError);
    eq("invalid seller session is 401", threw.statusCode, 401);
    ok("invalid seller is not upgraded to owner", threw.message !== "ok");
  });

  await withDb(async ({ mods }) => {
    let threw = null;
    try {
      await mods.guard.resolveOwnerOrSellerContext({ httpMethod: "POST", headers: {}, body: "{}" });
    } catch (err) {
      threw = err;
    }
    eq("no session still requires device session", threw && threw.message, "Device session required");
    eq("no session is 401", threw.statusCode, 401);
  });

  await withDb(async ({ mods }) => {
    const ownerA = eventWithCookie(cookieOwner(modern));
    const ctx = await mods.guard.resolveOwnerOrSellerContext(ownerA);
    ok("owner A cannot become tenant B via dual-auth", ctx.tenant.id !== TENANT_B);
  });

  console.log("");
  console.log(passed + " passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
