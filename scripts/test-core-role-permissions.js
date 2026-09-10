#!/usr/bin/env node
/**
 * Core Security Shield V1 — role, device, and platform-admin contracts.
 * Isolated dummy secrets only. No live Netlify/Supabase.
 * Run: node scripts/test-core-role-permissions.js
 */
"use strict";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET || "mg-core-role-permissions-test-secret";
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "mg-core-role-permissions-test-key";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const { buildSessionPayload, createSessionCookie } = require("../netlify/functions/_lib/session");
const {
  buildDeviceSessionPayload,
  createDeviceSessionCookieFromPayload,
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

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SELLER_MEM = "11111111-1111-4111-8111-111111111111";
const OTHER_SELLER = "22222222-2222-4222-8222-222222222222";
const SUPER_MEM = "33333333-3333-4333-8333-333333333333";
const DEVICE_ID = "44444444-4444-4444-8444-444444444444";
const SUPER_DEVICE = "55555555-5555-4555-8555-555555555555";
const SESS_ID = "66666666-6666-4666-8666-666666666666";
const SUPER_SESS = "77777777-7777-4777-8777-777777777777";
const PROJECT_A = "88888888-8888-4888-8888-888888888888";
const PROJECT_B = "99999999-9999-4999-8999-999999999999";
const QUOTE_A = "aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const OWNER_A = "owner-a@example.com";

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
    "../netlify/functions/_lib/mg-support/require-platform-admin",
  ].forEach((rel) => {
    delete require.cache[require.resolve(rel)];
  });
  return {
    guard: require("../netlify/functions/_lib/tenant-device-guard"),
    admin: require("../netlify/functions/_lib/mg-support/require-platform-admin"),
  };
}

function makeDevice(overrides) {
  const payload = buildDeviceSessionPayload(
    Object.assign(
      {
        sessionId: SESS_ID,
        deviceId: DEVICE_ID,
        tenantId: TENANT_A,
        membershipId: SELLER_MEM,
        portalType: "seller",
      },
      overrides.payload || {}
    )
  );
  return Object.assign(createDeviceSessionCookieFromPayload(payload), overrides.db || {});
}

async function withDeviceDb(state, fn) {
  const prev = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const restPath = extractPath(url);
    const table = restPath.split("?")[0];
    if (table === "device_sessions") {
      const hash = qp(restPath, "session_token_hash");
      const row = state.sessions.find((s) => s.session_token_hash === hash);
      if (!row || (qp(restPath, "status") && row.status !== qp(restPath, "status"))) {
        return jsonRes(200, []);
      }
      return jsonRes(200, [row]);
    }
    if (table === "tenant_devices") {
      const id = qp(restPath, "id");
      const row = state.devices.find((d) => d.id === id);
      return jsonRes(200, row ? [row] : []);
    }
    if (table === "profiles") {
      const id = qp(restPath, "id");
      const tenantId = qp(restPath, "tenant_id");
      const email = qp(restPath, "email");
      const rows = state.profiles.filter((p) => {
        if (id && p.id !== id) return false;
        if (tenantId && p.tenant_id !== tenantId) return false;
        if (email && p.email !== email) return false;
        return true;
      });
      return jsonRes(200, rows);
    }
    if (table === "tenants") {
      const id = qp(restPath, "id");
      if (id === TENANT_A) {
        return jsonRes(200, [
          {
            id: TENANT_A,
            owner_email: OWNER_A,
            plan_status: "active",
            name: "A",
            slug: "a",
          },
        ]);
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

function cookieEvent(cookieHeader) {
  return { headers: { cookie: String(cookieHeader).split(";")[0] } };
}

function catchCode(fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => "")
    .catch((err) => err.code || err.message || "error");
}

async function main() {
  const seller = makeDevice({});
  const sellerState = {
    sessions: [
      {
        id: SESS_ID,
        device_id: DEVICE_ID,
        tenant_id: TENANT_A,
        membership_id: SELLER_MEM,
        portal_type: "seller",
        status: "active",
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        session_token_hash: seller.tokenHash,
      },
    ],
    devices: [{ id: DEVICE_ID, tenant_id: TENANT_A, portal_type: "seller", status: "active" }],
    profiles: [
      {
        id: SELLER_MEM,
        tenant_id: TENANT_A,
        email: "seller-a@example.com",
        role: "seller",
        status: "active",
        auth_user_id: "seller-user-a",
      },
    ],
  };

  await withDeviceDb(sellerState, async (mods) => {
    const ctx = await mods.guard.requireSellerDevice(cookieEvent(seller.cookie));
    eq("active seller device is accepted", ctx.portalType, "seller");
  });

  const revokedState = JSON.parse(JSON.stringify(sellerState));
  revokedState.sessions[0].status = "revoked";
  revokedState.sessions[0].session_token_hash = seller.tokenHash;
  await withDeviceDb(revokedState, async (mods) => {
    eq(
      "revoked device session is rejected",
      await catchCode(() => mods.guard.resolveDeviceSession(cookieEvent(seller.cookie))),
      "device_session_invalid"
    );
  });

  const inactiveDevice = JSON.parse(JSON.stringify(sellerState));
  inactiveDevice.sessions[0].session_token_hash = seller.tokenHash;
  inactiveDevice.devices[0].status = "inactive";
  await withDeviceDb(inactiveDevice, async (mods) => {
    eq(
      "inactive device is rejected",
      await catchCode(() => mods.guard.resolveDeviceSession(cookieEvent(seller.cookie))),
      "device_not_active"
    );
  });

  const tenantMismatchCookie = makeDevice({
    payload: { tenantId: TENANT_B, sessionId: SESS_ID, deviceId: DEVICE_ID, membershipId: SELLER_MEM },
  });
  const mismatchState = JSON.parse(JSON.stringify(sellerState));
  mismatchState.sessions[0].session_token_hash = tenantMismatchCookie.tokenHash;
  await withDeviceDb(mismatchState, async (mods) => {
    eq(
      "device cookie tenant mismatch is rejected",
      await catchCode(() => mods.guard.resolveDeviceSession(cookieEvent(tenantMismatchCookie.cookie))),
      "device_session_tenant_mismatch"
    );
  });

  const membershipMismatch = JSON.parse(JSON.stringify(sellerState));
  membershipMismatch.sessions[0].session_token_hash = seller.tokenHash;
  membershipMismatch.profiles = [];
  await withDeviceDb(membershipMismatch, async (mods) => {
    eq(
      "device membership mismatch is rejected",
      await catchCode(() => mods.guard.resolveDeviceSession(cookieEvent(seller.cookie))),
      "membership_not_found"
    );
  });

  const supervisorDevice = makeDevice({
    payload: {
      sessionId: SUPER_SESS,
      deviceId: SUPER_DEVICE,
      tenantId: TENANT_A,
      membershipId: SUPER_MEM,
      portalType: "supervisor",
    },
  });
  const superState = {
    sessions: [
      {
        id: SUPER_SESS,
        device_id: SUPER_DEVICE,
        tenant_id: TENANT_A,
        membership_id: SUPER_MEM,
        portal_type: "supervisor",
        status: "active",
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        session_token_hash: supervisorDevice.tokenHash,
      },
    ],
    devices: [
      { id: SUPER_DEVICE, tenant_id: TENANT_A, portal_type: "supervisor", status: "active" },
    ],
    profiles: [
      {
        id: SUPER_MEM,
        tenant_id: TENANT_A,
        email: "super-a@example.com",
        role: "supervisor",
        status: "active",
        auth_user_id: "super-user-a",
      },
    ],
  };

  await withDeviceDb(sellerState, async (mods) => {
    eq(
      "seller device cannot open supervisor portal",
      await catchCode(() => mods.guard.requireSupervisorDevice(cookieEvent(seller.cookie))),
      "portal_type_forbidden"
    );
  });

  await withDeviceDb(superState, async (mods) => {
    eq(
      "supervisor device cannot open seller portal",
      await catchCode(() => mods.guard.requireSellerDevice(cookieEvent(supervisorDevice.cookie))),
      "portal_type_forbidden"
    );
    const ctx = await mods.guard.requireSupervisorDevice(cookieEvent(supervisorDevice.cookie));
    eq("supervisor device is accepted on supervisor portal", ctx.portalType, "supervisor");

    eq(
      "unassigned supervisor cannot use project",
      await catchCode(() =>
        mods.guard.assertAssignedSupervisorProject(ctx, {
          id: PROJECT_A,
          tenant_id: TENANT_A,
          supervisor_user_id: "someone-else",
        })
      ),
      "supervisor_not_assigned"
    );
    mods.guard.assertAssignedSupervisorProject(ctx, {
      id: PROJECT_A,
      tenant_id: TENANT_A,
      supervisor_user_id: "super-user-a",
    });
    ok("assigned supervisor can use own project", true);

    eq(
      "supervisor cannot use tenant B project",
      await catchCode(() =>
        mods.guard.assertAssignedSupervisorProject(ctx, {
          id: PROJECT_B,
          tenant_id: TENANT_B,
          supervisor_user_id: "super-user-a",
        })
      ),
      "tenant_mismatch"
    );

    const superDual = await mods.guard.resolveOwnerOrSupervisorContext(
      cookieEvent(supervisorDevice.cookie)
    );
    eq("supervisor device dual-auth is device", superDual.auth_mode, "device");
    eq("supervisor device dual-auth portal is supervisor", superDual.portal_type, "supervisor");
  });

  await withDeviceDb(sellerState, async (mods) => {
    eq(
      "seller device is not upgraded to owner on supervisor dual-auth",
      await catchCode(() => mods.guard.resolveOwnerOrSupervisorContext(cookieEvent(seller.cookie))),
      "portal_type_forbidden"
    );
  });

  await withDeviceDb(sellerState, async (mods) => {
    const ctx = await mods.guard.requireSellerDevice(cookieEvent(seller.cookie));
    mods.guard.assertSellerOwnQuote(ctx, {
      id: QUOTE_A,
      tenant_id: TENANT_A,
      seller_membership_id: SELLER_MEM,
    });
    ok("seller can read own quote", true);
    eq(
      "seller cannot read another seller quote",
      await catchCode(() =>
        mods.guard.assertSellerOwnQuote(ctx, {
          id: QUOTE_A,
          tenant_id: TENANT_A,
          seller_membership_id: OTHER_SELLER,
        })
      ),
      "seller_quote_forbidden"
    );
    eq(
      "seller cannot read tenant B quote",
      await catchCode(() =>
        mods.guard.assertSellerOwnQuote(ctx, {
          id: QUOTE_A,
          tenant_id: TENANT_B,
          seller_membership_id: SELLER_MEM,
        })
      ),
      "tenant_mismatch"
    );
  });

  const { admin } = loadGuard();
  const ownerCookie = createSessionCookie(
    buildSessionPayload({ email: OWNER_A, tenantId: TENANT_A, userId: "user-a" })
  );
  const ownerDenied = await admin.assertPlatformAdminSession(cookieEvent(ownerCookie), {
    isPlatformAdmin: async () => false,
  });
  eq("tenant owner is not platform admin", ownerDenied.ok, false);
  eq("tenant owner admin result", ownerDenied.result, "not_authorized");

  const adminOk = await admin.assertPlatformAdminSession(cookieEvent(ownerCookie), {
    isPlatformAdmin: async () => true,
  });
  eq("platform admin session is accepted", adminOk.ok, true);

  const salesAdminSrc = fs.readFileSync(path.join(ROOT, "public/sales-admin.html"), "utf8");
  const salesAdminFn = fs.readFileSync(path.join(ROOT, "netlify/functions/get-sales-approvals.js"), "utf8");
  ok(
    "Sales Admin UI is not platform-admin authority",
    salesAdminSrc.indexOf("assertPlatformAdminSession") < 0
  );
  ok(
    "Sales Admin APIs are not platform-admin-only",
    salesAdminFn.indexOf("assertPlatformAdminSession") < 0
  );

  const dryRunSrc = fs.readFileSync(
    path.join(ROOT, "netlify/functions/admin-saas-square-dry-run.js"),
    "utf8"
  );
  ok("platform admin dry-run uses assertPlatformAdminSession", dryRunSrc.indexOf("assertPlatformAdminSession") >= 0);

  console.log("\nCore role permissions: " + passed + " passed");
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
