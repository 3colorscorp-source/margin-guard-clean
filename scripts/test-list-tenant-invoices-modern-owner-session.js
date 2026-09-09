#!/usr/bin/env node
/**
 * Invoice Hub list — modern owner session (email + tenant, no session.c).
 * Isolated: mocked Supabase only. No live Netlify, email, payments, or DB writes.
 * Run: node scripts/test-list-tenant-invoices-modern-owner-session.js
 */
"use strict";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET || "mg-list-tenant-invoices-modern-session-test-secret";
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "mg-list-tenant-invoices-modern-session-test-key";

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
const OWNER_A = "owner-a@example.com";
const USER_A = "11111111-1111-4111-8111-111111111111";
const CUS_A = "cus_legacyListTest1";

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

function eventFor(fields, query) {
  return {
    httpMethod: "GET",
    headers: fields ? { cookie: cookieFor(fields) } : {},
    queryStringParameters: query || {},
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

function loadHandler() {
  [
    "../netlify/functions/_lib/supabase-admin",
    "../netlify/functions/_lib/membership-resolve",
    "../netlify/functions/_lib/owner-access",
    "../netlify/functions/_lib/tenant-for-session",
    "../netlify/functions/list-tenant-invoices",
  ].forEach((rel) => {
    delete require.cache[require.resolve(rel)];
  });
  return require("../netlify/functions/list-tenant-invoices");
}

async function withDb(fn) {
  const prev = globalThis.fetch;
  const writes = [];

  globalThis.fetch = async (url, opts) => {
    const method = String((opts && opts.method) || "GET").toUpperCase();
    const restPath = extractPath(url);
    const table = restPath.split("?")[0];
    if (method !== "GET") {
      writes.push({ method, table });
      return jsonRes(403, { message: "writes are not allowed in this test" });
    }
    if (table === "profiles") {
      const email = qp(restPath, "email");
      const tenantId = qp(restPath, "tenant_id");
      if (email === OWNER_A && (!tenantId || tenantId === TENANT_A)) {
        return jsonRes(200, [
          {
            id: "prof-a",
            tenant_id: TENANT_A,
            email: OWNER_A,
            role: "owner",
            status: "active",
            auth_user_id: USER_A,
          },
        ]);
      }
      return jsonRes(200, []);
    }
    if (table === "tenants") {
      const id = qp(restPath, "id");
      const cus = qp(restPath, "stripe_customer_id");
      if (cus === CUS_A || !id || id === TENANT_A) {
        return jsonRes(200, [
          {
            id: TENANT_A,
            slug: "tenant-a",
            name: "Tenant A",
            owner_email: OWNER_A,
            plan_status: "active",
            stripe_customer_id: CUS_A,
          },
        ]);
      }
      return jsonRes(200, []);
    }
    if (table === "invoices") {
      return jsonRes(200, []);
    }
    if (table === "tenant_project_payments") {
      return jsonRes(200, []);
    }
    return jsonRes(404, { message: "unmocked " + restPath });
  };

  try {
    return await fn(loadHandler(), writes);
  } finally {
    globalThis.fetch = prev;
  }
}

async function main() {
  const src = read("netlify/functions/list-tenant-invoices.js");
  const appSrc = read("public/js/app.js");

  ok("list-tenant-invoices uses hasOwnerSessionIdentity", /hasOwnerSessionIdentity\(session\)/.test(src));
  ok("list-tenant-invoices does not require session.c", !/session\?\.e \|\| !session\?\.c/.test(src));
  ok("list-tenant-invoices still resolves tenant from session", /resolveTenantFromSession\(session\)/.test(src));
  ok("create success shows invoice number", /Invoice created: \$\{invoiceNo\}/.test(appSrc));
  ok("failed list does not assign empty cache", !/hubServerNormalizedInvoicesCache = \[\]/.test(appSrc));
  ok("create response is seeded into Hub cache", /seedHubServerInvoiceFromCreateResponse/.test(appSrc));
  ok("failed list keeps previous cache via apply helper", /function applyHubServerInvoiceListResult/.test(appSrc));
  ok("create still returns false on error", /Could not create invoice/.test(appSrc));

  const modern = { e: OWNER_A, t: TENANT_A, u: USER_A, c: "" };
  const legacy = { e: OWNER_A, c: CUS_A };

  await withDb(async (handler, writes) => {
    const none = await handler.handler(eventFor(null));
    eq("unauthorized session is 401", none.statusCode, 401);
    eq("unauthorized body", parse(none).error, "Unauthorized");

    const modernRes = await handler.handler(eventFor(modern, { limit: "20" }));
    eq("modern owner list is 200", modernRes.statusCode, 200);
    const modernBody = parse(modernRes);
    ok("modern list ok", modernBody.ok === true);
    ok("modern list invoices is an array", Array.isArray(modernBody.invoices));

    const legacyRes = await handler.handler(eventFor(legacy, { limit: "20" }));
    eq("legacy owner list is 200", legacyRes.statusCode, 200);
    ok("legacy list ok", parse(legacyRes).ok === true);

    eq("list test made no DB writes", writes.length, 0);
  });

  console.log("\n" + passed + " passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
