#!/usr/bin/env node
/**
 * Invoice Hub cancel — modern owner session (email + tenant, no session.c).
 * Isolated: mocked Supabase only. No live Netlify, email, SQL, or production cancel.
 * Run: node scripts/test-cancel-tenant-invoice-modern-owner-session.js
 */
"use strict";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET || "mg-cancel-tenant-invoice-modern-session-test-secret";
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "mg-cancel-tenant-invoice-modern-session-test-key";

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
const CUS_A = "cus_legacyCancelTest1";
const INV_DRAFT = "11111111-1111-4111-8111-aaaaaaaaaaaa";
const INV_PAID = "33333333-3333-4333-8333-333333333333";
const INV_LEDGER = "44444444-4444-4444-8444-444444444444";
const INV_OTHER = "22222222-2222-4222-8222-222222222222";

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
    headers: fields ? { cookie: cookieFor(fields) } : {},
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
    "../netlify/functions/cancel-tenant-invoice",
  ].forEach((rel) => {
    delete require.cache[require.resolve(rel)];
  });
  return require("../netlify/functions/cancel-tenant-invoice");
}

function invoiceRow(id, extra) {
  return {
    id,
    tenant_id: TENANT_A,
    public_token: "inv_cancel_" + id.slice(0, 8),
    invoice_no: "INV-CANCEL-" + id.slice(0, 8),
    customer_name: "Test Client",
    customer_email: "client@example.com",
    project_name: "Test Project",
    amount: 100,
    paid_amount: 0,
    balance_due: 100,
    status: "draft",
    invoice_label: "Manual Invoice",
    ...extra,
  };
}

async function withDb(fn) {
  const prev = globalThis.fetch;
  const invoiceGets = [];
  const patches = [];
  const deletes = [];
  const writes = [];

  const invoices = {
    [INV_DRAFT]: invoiceRow(INV_DRAFT),
    [INV_PAID]: invoiceRow(INV_PAID, { paid_amount: 50, balance_due: 50 }),
    [INV_LEDGER]: invoiceRow(INV_LEDGER),
  };

  globalThis.fetch = async (url, opts) => {
    const method = String((opts && opts.method) || "GET").toUpperCase();
    const restPath = extractPath(url);
    const table = restPath.split("?")[0];
    if (method === "DELETE") {
      deletes.push({ table, path: restPath.slice(0, 180) });
      return jsonRes(403, { message: "DELETE is not allowed" });
    }
    if (method !== "GET") {
      writes.push({ method, table });
      if (table === "invoices" && method === "PATCH") {
        let body = {};
        try {
          body = JSON.parse((opts && opts.body) || "{}");
        } catch (_e) {
          body = {};
        }
        patches.push(body);
        const id = qp(restPath, "id");
        const tenantId = qp(restPath, "tenant_id");
        if (tenantId !== TENANT_A || !invoices[id]) {
          return jsonRes(404, { message: "not found" });
        }
        const updated = {
          ...invoices[id],
          ...body,
        };
        invoices[id] = updated;
        return jsonRes(200, [updated]);
      }
      return jsonRes(403, { message: "unexpected write " + method + " " + table });
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
      if (tenantId === TENANT_A && invoices[id]) {
        return jsonRes(200, [invoices[id]]);
      }
      return jsonRes(200, []);
    }
    if (table === "tenant_project_payments") {
      const invoiceId = qp(restPath, "invoice_id");
      if (invoiceId === INV_LEDGER) {
        return jsonRes(200, [{ id: "pay-ledger-1", invoice_id: INV_LEDGER }]);
      }
      return jsonRes(200, []);
    }
    return jsonRes(404, { message: "unmocked " + restPath });
  };

  try {
    return await fn(loadHandler(), { invoiceGets, patches, deletes, writes });
  } finally {
    globalThis.fetch = prev;
  }
}

async function main() {
  const src = read("netlify/functions/cancel-tenant-invoice.js");
  const appSrc = read("public/js/app.js");

  ok("cancel uses hasOwnerSessionIdentity", /hasOwnerSessionIdentity\(session\)/.test(src));
  ok("cancel does not require session.c", !/session\?\.e \|\| !session\?\.c/.test(src));
  ok("cancel still resolves tenant from session", /resolveTenantFromSession\(session\)/.test(src));
  ok(
    "cancel still scopes invoice by tenant_id",
    /invoices\?id=eq\.\$\{iidEnc\}&tenant_id=eq\.\$\{tidEnc\}/.test(src)
  );
  ok("cancel archives instead of deleting", /status:\s*"archived"/.test(src) && /voided_at/.test(src));
  ok("cancel source has no DELETE", !/method:\s*"DELETE"/.test(src));
  ok("cancel still blocks paid_amount", /invoice_has_payments/.test(src));
  ok("cancel still blocks ledger payments", /invoice_has_ledger_payments/.test(src));
  ok(
    "Hub maps Unauthorized to a friendly cancel error",
    /Could not cancel invoice\. Refresh the page and try again/.test(appSrc)
  );

  const modern = { e: OWNER_A, t: TENANT_A, u: USER_A, c: "" };
  const legacy = { e: OWNER_A, c: CUS_A };

  await withDb(async (handler, { invoiceGets, patches, deletes, writes }) => {
    const none = await handler.handler(eventFor(null, { invoice_id: INV_DRAFT }));
    eq("no cookie is 401", none.statusCode, 401);
    eq("unauthorized body", parse(none).error, "Unauthorized");

    const paid = await handler.handler(eventFor(modern, { invoice_id: INV_PAID }));
    eq("paid_amount blocks cancel", paid.statusCode, 422);
    eq("paid reason", parse(paid).reason, "invoice_has_payments");

    const ledger = await handler.handler(eventFor(modern, { invoice_id: INV_LEDGER }));
    eq("ledger payment blocks cancel", ledger.statusCode, 422);
    eq("ledger reason", parse(ledger).reason, "invoice_has_ledger_payments");

    const beforePatches = patches.length;
    const cross = await handler.handler(eventFor(modern, { invoice_id: INV_OTHER }));
    eq("other-tenant invoice is 404", cross.statusCode, 404);
    eq("other-tenant reason", parse(cross).reason, "invoice_not_found");

    const legacyPaid = await handler.handler(eventFor(legacy, { invoice_id: INV_PAID }));
    eq("legacy session is authorized (reaches guards)", legacyPaid.statusCode, 422);

    const cancel = await handler.handler(eventFor(modern, { invoice_id: INV_DRAFT }));
    eq("modern draft cancel is 200", cancel.statusCode, 200);
    const cancelBody = parse(cancel);
    ok("modern cancel ok", cancelBody.ok === true);
    eq("cancel status archived", cancelBody.status, "archived");
    ok("cancel returns voided_at", Boolean(String(cancelBody.voided_at || "").trim()));

    ok(
      "lookup used tenant_id",
      invoiceGets.some((g) => g.tenantId === TENANT_A && g.id === INV_DRAFT)
    );
    ok(
      "cross-tenant lookup still tenant-scoped",
      invoiceGets.some((g) => g.id === INV_OTHER && g.tenantId === TENANT_A)
    );
    ok("draft cancel PATCHed archived", patches.some((p) => p.status === "archived" && p.voided_at));
    eq("no DELETE calls", deletes.length, 0);
    ok("paid/ledger/cross did not PATCH extra", patches.length === beforePatches + 1);
    ok("writes are PATCH only", writes.every((w) => w.method === "PATCH" && w.table === "invoices"));
  });

  console.log("\n" + passed + " passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
