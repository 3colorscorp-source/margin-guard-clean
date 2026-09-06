#!/usr/bin/env node
/**
 * Business Settings — modern owner session (no session.c required).
 * Isolated: mocked Supabase only. No live Netlify, Stripe, email, or DB writes.
 * Run: node scripts/test-business-settings-modern-owner-session.js
 */
"use strict";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET || "mg-bs-modern-owner-session-test-secret";
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "mg-bs-modern-session-test-key";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const { buildSessionPayload, createSessionCookie } = require("../netlify/functions/_lib/session");

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

function parse(res) {
  try {
    return JSON.parse(res.body || "{}");
  } catch (_err) {
    return {};
  }
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

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TENANT_INACTIVE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OWNER_A = "owner-a@example.com";
const OWNER_B = "owner-b@example.com";
const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const CUS_A = "cus_legacyOwnerA123";
const SQUARE_LINK = "https://square.link/u/tenant-a-checkout";

function tenantRow(id, email, extras) {
  return {
    id,
    slug: id.slice(0, 8),
    name: "Co " + id.slice(0, 4),
    owner_email: email,
    plan_status: "active",
    stripe_customer_id: extras && extras.stripe_customer_id ? extras.stripe_customer_id : null,
    stripe_account_id: extras && extras.stripe_account_id ? extras.stripe_account_id : null,
    stripe_charges_enabled: false,
    stripe_details_submitted: false,
    ...(extras || {}),
  };
}

function profileRow(tenantId, email, extras) {
  return {
    id: "prof-" + tenantId.slice(0, 8),
    tenant_id: tenantId,
    email,
    role: "owner",
    status: "active",
    auth_user_id: extras && extras.auth_user_id ? extras.auth_user_id : "",
    ...(extras || {}),
  };
}

function validPayload() {
  return {
    storage: {
      mg_settings_v2: {
        baseInstaller: 80,
        baseHelper: 50,
        pricingMode: "hour",
        hoursPerDay: 8,
        stdHours: 160,
        overheadMonthly: 0,
        wcPct: 10,
        ficaPct: 7.65,
        futaPct: 0.6,
        casuiPct: 3.4,
        profitPct: 30,
        minimumMarginPct: 15,
        salesCommissionPct: 10,
        supervisorBonusPct: 1,
        reservePct: 5,
      },
      mg_business_branding_v1: {
        businessName: "Tenant A Co",
      },
    },
  };
}

function cookieFor(fields) {
  return createSessionCookie(
    buildSessionPayload({
      email: fields.e || "",
      tenantId: fields.t || "",
      userId: fields.u || "",
      customerId: fields.c || "",
    })
  );
}

function eventFor(fields, opts) {
  const headers = {};
  if (fields) {
    headers.cookie = cookieFor(fields);
  }
  return {
    httpMethod: (opts && opts.method) || "GET",
    headers,
    queryStringParameters: (opts && opts.query) || {},
    body: opts && opts.body != null ? JSON.stringify(opts.body) : undefined,
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

function loadHandlers() {
  [
    "../netlify/functions/_lib/supabase-admin",
    "../netlify/functions/_lib/membership-resolve",
    "../netlify/functions/_lib/owner-access",
    "../netlify/functions/_lib/tenant-for-session",
    "../netlify/functions/save-tenant-snapshot",
    "../netlify/functions/load-tenant-snapshot",
    "../netlify/functions/owner-settings-deposit-link",
    "../netlify/functions/stripe-deposit-connect-sync",
    "../netlify/functions/stripe-deposit-connect-start",
  ].forEach((rel) => {
    delete require.cache[require.resolve(rel)];
  });
  return {
    save: require("../netlify/functions/save-tenant-snapshot"),
    load: require("../netlify/functions/load-tenant-snapshot"),
    deposit: require("../netlify/functions/owner-settings-deposit-link"),
    stripeSync: require("../netlify/functions/stripe-deposit-connect-sync"),
    stripeStart: require("../netlify/functions/stripe-deposit-connect-start"),
  };
}

async function withDb(fn) {
  const tenants = {
    [TENANT_A]: tenantRow(TENANT_A, OWNER_A, { stripe_customer_id: CUS_A }),
    [TENANT_B]: tenantRow(TENANT_B, OWNER_B),
    [TENANT_INACTIVE]: tenantRow(TENANT_INACTIVE, "inactive@example.com", {
      plan_status: "canceled",
    }),
  };
  const profiles = [
    profileRow(TENANT_A, OWNER_A, { auth_user_id: USER_A }),
    profileRow(TENANT_B, OWNER_B, { auth_user_id: USER_B }),
    profileRow(TENANT_INACTIVE, "inactive@example.com", { status: "active" }),
  ];
  const snapshots = { [TENANT_A]: [], [TENANT_B]: [], [TENANT_INACTIVE]: [] };
  const ownerSettings = {};
  const tenantPatches = [];

  const prev = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const method = String((init && init.method) || "GET").toUpperCase();
    const restPath = extractPath(url);
    const table = restPath.split("?")[0];
    let body = null;
    if (init && init.body) {
      try {
        body = JSON.parse(init.body);
      } catch (_e) {
        body = init.body;
      }
    }

    if (table === "profiles") {
      const email = qp(restPath, "email");
      const tenantId = qp(restPath, "tenant_id");
      const role = qp(restPath, "role");
      let rows = profiles.filter((p) => {
        if (email && p.email !== email) return false;
        if (tenantId && p.tenant_id !== tenantId) return false;
        if (role && p.role !== role) return false;
        return true;
      });
      return jsonRes(200, rows);
    }

    if (table === "tenants") {
      if (method === "PATCH") {
        tenantPatches.push({ path: restPath, body });
        return jsonRes(200, [body]);
      }
      const id = qp(restPath, "id");
      const cus = qp(restPath, "stripe_customer_id");
      let rows = Object.values(tenants);
      if (id) rows = rows.filter((t) => t.id === id);
      if (cus) rows = rows.filter((t) => t.stripe_customer_id === cus);
      return jsonRes(200, rows);
    }

    if (table === "tenant_snapshots") {
      if (method === "POST") {
        const row = {
          id: "snap-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
          tenant_id: body.tenant_id,
          payload: body.payload,
          snapshot_version: body.snapshot_version,
          source: body.source,
          created_by_email: body.created_by_email,
          created_at: new Date().toISOString(),
        };
        if (!snapshots[row.tenant_id]) snapshots[row.tenant_id] = [];
        snapshots[row.tenant_id].unshift(row);
        return jsonRes(201, [row]);
      }
      const tenantId = qp(restPath, "tenant_id");
      return jsonRes(200, snapshots[tenantId] ? snapshots[tenantId].slice(0, 1) : []);
    }

    if (table === "tenant_branding") {
      return jsonRes(201, [body || {}]);
    }

    if (table === "owner_settings") {
      if (method === "POST") {
        const row = { id: "os-" + body.tenant_id, tenant_id: body.tenant_id, ...body };
        ownerSettings[body.tenant_id] = row;
        return jsonRes(201, [row]);
      }
      if (method === "PATCH") {
        const id = qp(restPath, "id");
        const existing = Object.values(ownerSettings).find((r) => r.id === id);
        if (existing) Object.assign(existing, body);
        return jsonRes(200, existing ? [existing] : []);
      }
      const tenantId = qp(restPath, "tenant_id");
      const row = ownerSettings[tenantId];
      return jsonRes(200, row ? [row] : []);
    }

    return jsonRes(404, { message: "unmocked " + restPath });
  };

  try {
    const handlers = loadHandlers();
    return await fn({ handlers, snapshots, ownerSettings, tenantPatches, tenants });
  } finally {
    globalThis.fetch = prev;
  }
}

async function main() {
  const saveSrc = read("netlify/functions/save-tenant-snapshot.js");
  const loadSrc = read("netlify/functions/load-tenant-snapshot.js");
  const depositSrc = read("netlify/functions/owner-settings-deposit-link.js");
  const startSrc = read("netlify/functions/stripe-deposit-connect-start.js");
  const syncSrc = read("netlify/functions/stripe-deposit-connect-sync.js");

  ok("save uses hasOwnerSessionIdentity", /hasOwnerSessionIdentity\(session\)/.test(saveSrc));
  ok("load uses hasOwnerSessionIdentity", /hasOwnerSessionIdentity\(session\)/.test(loadSrc));
  ok("deposit uses hasOwnerSessionIdentity", /hasOwnerSessionIdentity\(session\)/.test(depositSrc));
  ok("stripe start uses hasOwnerSessionIdentity", /hasOwnerSessionIdentity\(session\)/.test(startSrc));
  ok("stripe sync uses hasOwnerSessionIdentity", /hasOwnerSessionIdentity\(session\)/.test(syncSrc));
  ok("save does not require session.c", !/session\?\.e \|\| !session\?\.c/.test(saveSrc));
  ok("load does not require session.c", !/session\?\.e \|\| !session\?\.c/.test(loadSrc));
  ok("deposit does not require session.c", !/session\?\.e \|\| !session\?\.c/.test(depositSrc));
  ok("save does not PATCH stripe_customer_id", !/stripe_customer_id:\s*session\.c/.test(saveSrc));
  ok("save uses resolveTenantFromSession", /resolveTenantFromSession\(session\)/.test(saveSrc));
  ok("HTTPS deposit normalizer still present", /normalizeDepositPaymentLink/.test(depositSrc));
  ok("handlers do not write deposit_paid_at", ![saveSrc, loadSrc, depositSrc, startSrc, syncSrc].some((s) => /deposit_paid_at/.test(s)));

  const modern = { e: OWNER_A, t: TENANT_A, u: USER_A, c: "" };
  const legacy = { e: OWNER_A, c: CUS_A };

  await withDb(async ({ handlers, tenantPatches }) => {
    const saveRes = await handlers.save.handler(
      eventFor(modern, { method: "POST", body: { payload: validPayload(), snapshot_version: 1 } })
    );
    eq("modern session can save snapshot", saveRes.statusCode, 200);
    ok("modern save ok", parse(saveRes).ok === true);

    const loadRes = await handlers.load.handler(eventFor(modern, { method: "GET" }));
    eq("modern session can load snapshot", loadRes.statusCode, 200);
    ok("loaded snapshot belongs to tenant A", parse(loadRes).snapshot?.tenant_id === TENANT_A);

    const postLink = await handlers.deposit.handler(
      eventFor(modern, {
        method: "POST",
        body: {
          deposit_payment_link: SQUARE_LINK,
          payment_link: null,
          payment_instructions: "Pay by Square checkout or Zelle to the number on file.",
        },
      })
    );
    eq("modern session POST with payment_link null is 200", postLink.statusCode, 200);
    eq("Square HTTPS persisted with empty invoice payment_link", parse(postLink).deposit_payment_link, SQUARE_LINK);
    ok("empty public payment_link stored as null", parse(postLink).payment_link == null || parse(postLink).payment_link === "");
    ok("payment_instructions saved", String(parse(postLink).payment_instructions || "").includes("Zelle"));

    const getLink = await handlers.deposit.handler(eventFor(modern, { method: "GET" }));
    eq("GET after null payment_link is 200", getLink.statusCode, 200);
    eq("Square HTTPS survives reload GET", parse(getLink).deposit_payment_link, SQUARE_LINK);
    ok("public Payment Link remains empty after reload", parse(getLink).payment_link == null || parse(getLink).payment_link === "");

    const syncRes = await handlers.stripeSync.handler(eventFor(modern, { method: "GET" }));
    eq("Stripe status is not Unauthorized", syncRes.statusCode, 200);
    eq("missing Connect account is Not connected", parse(syncRes).connected, false);
    eq("stripe_account_id null when not connected", parse(syncRes).stripe_account_id, null);

    ok(
      "save did not PATCH stripe_customer_id",
      !tenantPatches.some((p) => p.body && Object.prototype.hasOwnProperty.call(p.body, "stripe_customer_id"))
    );
  });

  await withDb(async ({ handlers }) => {
    const saveRes = await handlers.save.handler(
      eventFor(legacy, { method: "POST", body: { payload: validPayload(), snapshot_version: 1 } })
    );
    eq("legacy session.c with membership can save", saveRes.statusCode, 200);
    const loadRes = await handlers.load.handler(eventFor(legacy, { method: "GET" }));
    eq("legacy session.c with membership can load", loadRes.statusCode, 200);
  });

  await withDb(async ({ handlers }) => {
    const res = await handlers.save.handler({
      httpMethod: "POST",
      headers: {},
      body: JSON.stringify({ payload: validPayload() }),
    });
    eq("no session → 401 save", res.statusCode, 401);
    const load = await handlers.load.handler({ httpMethod: "GET", headers: {} });
    eq("no session → 401 load", load.statusCode, 401);
    const dep = await handlers.deposit.handler({ httpMethod: "GET", headers: {} });
    eq("no session → 401 deposit", dep.statusCode, 401);
    const sync = await handlers.stripeSync.handler({ httpMethod: "GET", headers: {} });
    eq("no session → 401 stripe sync", sync.statusCode, 401);
  });

  await withDb(async ({ handlers }) => {
    const weak = { e: OWNER_A, c: "", t: "", u: USER_A };
    const res = await handlers.save.handler(
      eventFor(weak, { method: "POST", body: { payload: validPayload() } })
    );
    eq("session without t or c → 401", res.statusCode, 401);
  });

  await withDb(async ({ handlers }) => {
    const inactive = { e: "inactive@example.com", t: TENANT_INACTIVE, u: "u-inactive", c: "" };
    const res = await handlers.save.handler(
      eventFor(inactive, { method: "POST", body: { payload: validPayload() } })
    );
    ok("inactive tenant rejected", res.statusCode === 403 || res.statusCode === 404);
    eq("inactive is not 401 Unauthorized", res.statusCode !== 401, true);
  });

  await withDb(async ({ handlers }) => {
    await handlers.save.handler(
      eventFor({ e: OWNER_B, t: TENANT_B, u: USER_B, c: "" }, {
        method: "POST",
        body: { payload: validPayload(), snapshot_version: 1 },
      })
    );
    await handlers.deposit.handler(
      eventFor({ e: OWNER_B, t: TENANT_B, u: USER_B, c: "" }, {
        method: "POST",
        body: { deposit_payment_link: "https://paypal.me/tenant-b" },
      })
    );

    const loadCross = await handlers.load.handler(
      eventFor({ e: OWNER_A, t: TENANT_B, u: USER_A, c: "" }, { method: "GET" })
    );
    ok(
      "tenant A cannot load tenant B snapshot",
      loadCross.statusCode === 403 ||
        loadCross.statusCode === 404 ||
        parse(loadCross).snapshot == null ||
        parse(loadCross).snapshot?.tenant_id !== TENANT_B
    );

    const depCross = await handlers.deposit.handler(
      eventFor({ e: OWNER_A, t: TENANT_B, u: USER_A, c: "" }, { method: "GET" })
    );
    const depBody = parse(depCross);
    ok(
      "tenant A cannot read tenant B deposit link",
      depCross.statusCode === 403 ||
        depCross.statusCode === 404 ||
        depBody.deposit_payment_link !== "https://paypal.me/tenant-b"
    );

    const saveCross = await handlers.save.handler(
      eventFor({ e: OWNER_A, t: TENANT_B, u: USER_A, c: "" }, {
        method: "POST",
        body: { payload: validPayload(), snapshot_version: 1, tenant_id: TENANT_B },
      })
    );
    ok(
      "tenant A cannot write tenant B snapshot via spoofed tenant_id",
      saveCross.statusCode === 403 || saveCross.statusCode === 404
    );
  });

  await withDb(async ({ handlers }) => {
    const start = await handlers.stripeStart.handler(eventFor(modern, { method: "POST", body: {} }));
    ok("Connect start is not Unauthorized for modern session", start.statusCode !== 401);
  });

  console.log("\n" + passed + " passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
