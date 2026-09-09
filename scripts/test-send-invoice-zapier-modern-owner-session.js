#!/usr/bin/env node
/**
 * Invoice Hub send — modern owner session (email + tenant, no session.c).
 * Isolated: mocked Supabase only. Dry-run only — no Zapier, Gmail, or DB writes.
 * Run: node scripts/test-send-invoice-zapier-modern-owner-session.js
 */
"use strict";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET || "mg-send-invoice-zapier-modern-session-test-secret";
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "mg-send-invoice-zapier-modern-session-test-key";
process.env.ZAPIER_INVOICE_SEND_WEBHOOK_URL =
  process.env.ZAPIER_INVOICE_SEND_WEBHOOK_URL ||
  "https://hooks.zapier.com/hooks/catch/dry-run-must-not-call/";

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
const OWNER_A = "owner-a@example.com";
const USER_A = "11111111-1111-4111-8111-111111111111";
const CUS_A = "cus_legacySendTest1";
const INV_A = "11111111-1111-4111-8111-111111111111";
const INV_B = "22222222-2222-4222-8222-222222222222";

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

function eventFor(fields, body) {
  return {
    httpMethod: "POST",
    headers: fields
      ? { cookie: cookieFor(fields), host: "marginguardsystem.netlify.app" }
      : { host: "marginguardsystem.netlify.app" },
    body: JSON.stringify(body || {}),
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
    "../netlify/functions/send-invoice-zapier",
  ].forEach((rel) => {
    delete require.cache[require.resolve(rel)];
  });
  return require("../netlify/functions/send-invoice-zapier");
}

const invoiceA = {
  id: INV_A,
  tenant_id: TENANT_A,
  public_token: "inv_testtoken12345",
  invoice_no: "INV-TEST-1",
  customer_name: "Test Client",
  customer_email: "client@example.com",
  project_name: "Test Project",
  amount: 100,
  paid_amount: 0,
  balance_due: 100,
  status: "draft",
  invoice_label: "Manual Invoice",
  notes: "Service details",
  currency: "USD",
};

async function withDb(fn) {
  const prev = globalThis.fetch;
  const zapierCalls = [];
  const writes = [];
  const invoiceGets = [];

  globalThis.fetch = async (url, opts) => {
    const method = String((opts && opts.method) || "GET").toUpperCase();
    const urlStr = String(url);
    if (/hooks\.zapier\.com/i.test(urlStr)) {
      zapierCalls.push({ method, url: urlStr });
      return jsonRes(200, { ok: true });
    }
    const restPath = extractPath(urlStr);
    const table = restPath.split("?")[0];
    if (method !== "GET") {
      writes.push({ method, table, path: restPath.slice(0, 180) });
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
      const tenantId = qp(restPath, "tenant_id");
      const id = qp(restPath, "id");
      invoiceGets.push({ tenantId, id });
      if (id === INV_A && tenantId === TENANT_A) {
        return jsonRes(200, [invoiceA]);
      }
      return jsonRes(200, []);
    }
    return jsonRes(404, { message: "unmocked " + restPath });
  };

  try {
    return await fn(loadHandler(), { zapierCalls, writes, invoiceGets });
  } finally {
    globalThis.fetch = prev;
  }
}

async function main() {
  const src = read("netlify/functions/send-invoice-zapier.js");
  const appSrc = read("public/js/app.js");

  ok("send uses hasOwnerSessionIdentity", /hasOwnerSessionIdentity\(session\)/.test(src));
  ok("send does not require session.c", !/session\?\.e \|\| !session\?\.c/.test(src));
  ok("send still resolves tenant from session", /resolveTenantFromSession\(session\)/.test(src));
  ok("send still scopes invoice by tenant_id", /params\.set\("tenant_id", `eq\.\$\{tenantId\}`\)/.test(src));
  ok("dry_run still skips Zapier", /dry_run preview — Zapier not called/.test(src));
  ok("Hub maps Unauthorized to a friendly send error", /Could not send invoice\. Refresh the page and try again/.test(appSrc));

  const modern = { e: OWNER_A, t: TENANT_A, u: USER_A, c: "" };
  const legacy = { e: OWNER_A, c: CUS_A };
  const dryBody = { id: INV_A, dry_run: true };

  await withDb(async (handler, { zapierCalls, writes, invoiceGets }) => {
    const none = await handler.handler(eventFor(null, dryBody));
    eq("no cookie is 401", none.statusCode, 401);
    eq("unauthorized body", parse(none).error, "Unauthorized");

    const modernRes = await handler.handler(eventFor(modern, dryBody));
    eq("modern owner dry_run is 200", modernRes.statusCode, 200);
    const modernBody = parse(modernRes);
    ok("modern dry_run ok", modernBody.ok === true);
    eq("modern dry_run flag", modernBody.dry_run, true);
    eq("modern dry_run forwarded false", modernBody.forwarded, false);

    const previewRes = await handler.handler(eventFor(modern, { id: INV_A, email_preview: true }));
    eq("email_preview is 200", previewRes.statusCode, 200);
    eq("email_preview forwarded false", parse(previewRes).forwarded, false);

    const debugRes = await handler.handler(eventFor(modern, { id: INV_A, debug_preview: true }));
    eq("debug_preview is 200", debugRes.statusCode, 200);

    const legacyRes = await handler.handler(eventFor(legacy, dryBody));
    eq("legacy owner dry_run is 200", legacyRes.statusCode, 200);
    ok("legacy dry_run ok", parse(legacyRes).ok === true);

    const cross = await handler.handler(eventFor(modern, { id: INV_B, dry_run: true }));
    eq("cross-tenant invoice is 404", cross.statusCode, 404);
    eq("cross-tenant not found", parse(cross).error, "Invoice not found.");

    ok("invoice lookup used tenant_id", invoiceGets.some((g) => g.tenantId === TENANT_A && g.id === INV_A));
    ok("cross-tenant lookup still tenant-scoped", invoiceGets.some((g) => g.id === INV_B && g.tenantId === TENANT_A));
    eq("dry-run did not call Zapier", zapierCalls.length, 0);
    eq("dry-run did not PATCH sent_at or status", writes.length, 0);
  });

  console.log("\n" + passed + " passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
