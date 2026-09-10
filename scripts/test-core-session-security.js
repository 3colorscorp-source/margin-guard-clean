#!/usr/bin/env node
/**
 * Core Security Shield V1 — owner and device session contracts.
 * Isolated dummy secrets only. No live Netlify/Supabase.
 * Run: node scripts/test-core-session-security.js
 */
"use strict";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET || "mg-core-session-security-test-secret";
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "mg-core-session-security-test-key";

const assert = require("assert");
const crypto = require("crypto");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const { buildSessionPayload, createSessionCookie, readSessionFromEvent } = require(
  "../netlify/functions/_lib/session"
);
const {
  buildDeviceSessionPayload,
  createDeviceSessionCookieFromPayload,
  readDeviceSessionFromEvent,
  verifySignedToken,
} = require("../netlify/functions/_lib/device-session");

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

function b64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function signRaw(payload, secret) {
  const encodedPayload = b64url(JSON.stringify(payload));
  const signature = crypto
    .createHmac("sha256", secret)
    .update(encodedPayload)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return encodedPayload + "." + signature;
}

function eventCookie(name, token) {
  return { headers: { cookie: name + "=" + encodeURIComponent(token) } };
}

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWNER_A = "owner-a@example.com";
const SECRET = process.env.SESSION_SECRET;

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

function loadGuard() {
  [
    "../netlify/functions/_lib/supabase-admin",
    "../netlify/functions/_lib/membership-resolve",
    "../netlify/functions/_lib/owner-access",
    "../netlify/functions/_lib/tenant-for-session",
    "../netlify/functions/_lib/device-session",
    "../netlify/functions/_lib/session",
    "../netlify/functions/_lib/tenant-device-guard",
  ].forEach((rel) => {
    delete require.cache[require.resolve(rel)];
  });
  return {
    guard: require("../netlify/functions/_lib/tenant-device-guard"),
    owner: require("../netlify/functions/_lib/owner-access"),
    tenant: require("../netlify/functions/_lib/tenant-for-session"),
  };
}

async function withDb(opts, fn) {
  const tenants = {
    [TENANT_A]: {
      id: TENANT_A,
      owner_email: OWNER_A,
      plan_status: opts.planStatus || "active",
      stripe_customer_id: opts.legacyCustomer || "cus_TESTOWNERA",
      name: "Tenant A",
      slug: "tenant-a",
    },
    [TENANT_B]: {
      id: TENANT_B,
      owner_email: "owner-b@example.com",
      plan_status: "active",
      stripe_customer_id: "cus_TESTOWNERB",
      name: "Tenant B",
      slug: "tenant-b",
    },
  };
  const profiles = [
    {
      id: "prof-a",
      tenant_id: TENANT_A,
      email: OWNER_A,
      role: opts.ownerRole || "owner",
      status: opts.membershipStatus || "active",
      auth_user_id: "user-a",
    },
    {
      id: "prof-b",
      tenant_id: TENANT_B,
      email: "owner-b@example.com",
      role: "owner",
      status: "active",
      auth_user_id: "user-b",
    },
  ].concat(opts.extraProfiles || []);
  const prev = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const restPath = extractPath(url);
    const table = restPath.split("?")[0];
    if (table === "profiles") {
      const email = qp(restPath, "email");
      const tenantId = qp(restPath, "tenant_id");
      const role = qp(restPath, "role");
      const id = qp(restPath, "id");
      const rows = profiles.filter((p) => {
        if (email && p.email !== email) return false;
        if (tenantId && p.tenant_id !== tenantId) return false;
        if (role && p.role !== role) return false;
        if (id && p.id !== id) return false;
        return true;
      });
      return jsonRes(200, rows);
    }
    if (table === "tenants") {
      const id = qp(restPath, "id");
      const cus = qp(restPath, "stripe_customer_id");
      if (id && tenants[id]) return jsonRes(200, [tenants[id]]);
      if (cus) {
        const row = Object.values(tenants).find((t) => t.stripe_customer_id === cus);
        return jsonRes(200, row ? [row] : []);
      }
      return jsonRes(200, []);
    }
    return jsonRes(200, []);
  };
  try {
    return await fn(loadGuard());
  } finally {
    globalThis.fetch = prev;
  }
}

async function main() {
  const now = Math.floor(Date.now() / 1000);
  const validPayload = {
    e: OWNER_A,
    t: TENANT_A,
    c: "",
    iat: now,
    exp: now + 3600,
  };
  const validToken = signRaw(validPayload, SECRET);
  const validSession = readSessionFromEvent(eventCookie("mg_session", validToken));
  ok("valid owner HMAC is accepted", Boolean(validSession && validSession.e === OWNER_A));
  eq("valid owner session carries tenant", validSession.t, TENANT_A);

  const badSig = validToken.replace(/[A-Za-z0-9]$/, (ch) => (ch === "A" ? "B" : "A"));
  eq("invalid HMAC is rejected", readSessionFromEvent(eventCookie("mg_session", badSig)), null);

  const expired = signRaw({ e: OWNER_A, t: TENANT_A, iat: now - 100, exp: now - 10 }, SECRET);
  eq("expired owner session is rejected", readSessionFromEvent(eventCookie("mg_session", expired)), null);

  const cookie = createSessionCookie(buildSessionPayload({ email: OWNER_A, tenantId: TENANT_A }));
  const tampered = cookie.replace(/=/, "=x");
  const tamperEvent = { headers: { cookie: tampered.split(";")[0] } };
  eq("manipulated owner cookie is rejected", readSessionFromEvent(tamperEvent), null);

  const malformed = b64url("not-json") + "." + signRaw(validPayload, SECRET).split(".")[1];
  eq("malformed owner payload is rejected", readSessionFromEvent(eventCookie("mg_session", malformed)), null);

  eq("missing owner cookie is rejected", readSessionFromEvent({ headers: {} }), null);

  const modern = readSessionFromEvent(
    eventCookie("mg_session", signRaw({ e: OWNER_A, t: TENANT_A, c: "", iat: now, exp: now + 60 }, SECRET))
  );
  ok("modern email+tenant payload verifies", Boolean(modern && modern.e === OWNER_A && modern.t === TENANT_A));

  const legacy = readSessionFromEvent(
    eventCookie(
      "mg_session",
      signRaw({ e: OWNER_A, c: "cus_TESTOWNERA", t: "", iat: now, exp: now + 60 }, SECRET)
    )
  );
  ok("legacy email+customer payload still verifies", Boolean(legacy && legacy.c === "cus_TESTOWNERA"));

  const wrongSecret = signRaw(validPayload, "mg-core-wrong-session-secret");
  eq("owner cookie signed with wrong secret is rejected", readSessionFromEvent(eventCookie("mg_session", wrongSecret)), null);

  const devicePayload = buildDeviceSessionPayload({
    sessionId: "sid-1",
    deviceId: "dev-1",
    tenantId: TENANT_A,
    membershipId: "mem-1",
    portalType: "seller",
  });
  const device = createDeviceSessionCookieFromPayload(devicePayload);
  const deviceRead = readDeviceSessionFromEvent({
    headers: { cookie: "mg_device_session=" + encodeURIComponent(device.token) },
  });
  ok("valid device HMAC is accepted", Boolean(deviceRead && deviceRead.t === TENANT_A));
  eq("device portal type is seller", deviceRead.p, "seller");

  const deviceBad = device.token.replace(/[A-Za-z0-9]$/, (ch) => (ch === "A" ? "B" : "A"));
  eq("invalid device HMAC is rejected", verifySignedToken(deviceBad), null);

  const expiredDevice = signRaw(
    { sid: "sid-1", d: "dev-1", t: TENANT_A, m: "mem-1", p: "seller", iat: now - 10, exp: now - 1 },
    SECRET
  );
  eq("expired device session is rejected", verifySignedToken(expiredDevice), null);

  await withDb({}, async (mods) => {
    ok(
      "hasOwnerSessionIdentity accepts modern e+t",
      mods.owner.hasOwnerSessionIdentity({ e: OWNER_A, t: TENANT_A, c: "" }) === true
    );
    ok(
      "hasOwnerSessionIdentity accepts legacy e+c",
      mods.owner.hasOwnerSessionIdentity({ e: OWNER_A, t: "", c: "cus_TESTOWNERA" }) === true
    );
    ok(
      "hasOwnerSessionIdentity rejects email-only",
      mods.owner.hasOwnerSessionIdentity({ e: OWNER_A, t: "", c: "" }) === false
    );

    const modernEvent = eventCookie(
      "mg_session",
      signRaw({ e: OWNER_A, t: TENANT_A, c: "", u: "user-a", iat: now, exp: now + 60 }, SECRET)
    );
    const ownerCtx = await mods.guard.requireOwnerMembership(modernEvent);
    eq("modern e+t owner membership authMode", ownerCtx.authMode, "owner");
    eq("modern e+t owner membership tenant", ownerCtx.tenant.id, TENANT_A);

    const legacyEvent = eventCookie(
      "mg_session",
      signRaw({ e: OWNER_A, t: "", c: "cus_TESTOWNERA", u: "user-a", iat: now, exp: now + 60 }, SECRET)
    );
    const legacyTenant = await mods.tenant.resolveTenantFromSession(
      readSessionFromEvent(legacyEvent)
    );
    eq("legacy e+c still resolves entitled tenant", legacyTenant && legacyTenant.id, TENANT_A);
  });

  await withDb({ membershipStatus: "inactive" }, async (mods) => {
    const modernEvent = eventCookie(
      "mg_session",
      signRaw({ e: OWNER_A, t: TENANT_A, c: "", iat: now, exp: now + 60 }, SECRET)
    );
    const resolved = await mods.tenant.resolveTenantFromSession({
      e: OWNER_A,
      t: TENANT_A,
      c: "",
    });
    eq("inactive membership cannot resolve tenant", resolved, null);
    let code = "";
    try {
      await mods.guard.requireOwnerMembership(modernEvent);
    } catch (err) {
      code = err.code || "";
    }
    eq("inactive membership is rejected by owner gate", code, "tenant_not_found");
    const { membershipIsActive } = require("../netlify/functions/_lib/membership-resolve");
    eq("membershipIsActive is false for inactive", membershipIsActive({ status: "inactive" }), false);
  });

  await withDb({ planStatus: "paused" }, async (mods) => {
    const modernEvent = eventCookie(
      "mg_session",
      signRaw({ e: OWNER_A, t: TENANT_A, c: "", iat: now, exp: now + 60 }, SECRET)
    );
    let code = "";
    try {
      await mods.guard.requireOwnerMembership(modernEvent);
    } catch (err) {
      code = err.code || "";
    }
    eq("inactive tenant plan is rejected", code, "tenant_not_found");
  });

  await withDb(
    {
      ownerRole: "seller",
      extraProfiles: [
        {
          id: "prof-a-owner",
          tenant_id: TENANT_A,
          email: OWNER_A,
          role: "owner",
          status: "active",
          auth_user_id: "user-a",
        },
      ],
    },
    async (mods) => {
      const modernEvent = eventCookie(
        "mg_session",
        signRaw({ e: OWNER_A, t: TENANT_A, c: "", iat: now, exp: now + 60 }, SECRET)
      );
      let code = "";
      try {
        await mods.guard.requireOwnerMembership(modernEvent);
      } catch (err) {
        code = err.code || "";
      }
      eq("non-owner role is rejected", code, "owner_required");
    }
  );

  await withDb({}, async (mods) => {
    const modernNoC = eventCookie(
      "mg_session",
      signRaw({ e: OWNER_A, t: TENANT_A, c: "", iat: now, exp: now + 60 }, SECRET)
    );
    let code = "";
    try {
      await mods.guard.resolveOwnerOrSupervisorContext(modernNoC);
    } catch (err) {
      code = err.code || "";
    }
    eq(
      "FINDING FROZEN: resolveOwnerOrSupervisorContext still requires session.c for owner path",
      code,
      "no_device_session"
    );

    const legacyOwner = eventCookie(
      "mg_session",
      signRaw({ e: OWNER_A, t: TENANT_A, c: "cus_TESTOWNERA", iat: now, exp: now + 60 }, SECRET)
    );
    const ctx = await mods.guard.resolveOwnerOrSupervisorContext(legacyOwner);
    eq("legacy e+c still authorizes owner/supervisor owner path", ctx.auth_mode, "owner");
  });

  console.log("\nCore session security: " + passed + " passed");
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
