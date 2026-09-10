#!/usr/bin/env node
/**
 * Core Security Shield V1 — tenant isolation and handler inventory.
 * Isolated dummy secrets only. No live Netlify/Supabase.
 * Run: node scripts/test-core-tenant-isolation.js
 */
"use strict";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET || "mg-core-tenant-isolation-test-secret";
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "mg-core-tenant-isolation-test-key";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const MANIFEST = JSON.parse(
  fs.readFileSync(path.join(ROOT, "scripts/mg-core-security-shield-v1.json"), "utf8")
);
const ALLOWLIST = JSON.parse(
  fs.readFileSync(path.join(ROOT, "scripts/netlify-function-tenant-scope-allowlist.json"), "utf8")
);

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

const CATEGORIES = [
  "TENANT_SCOPED_CONFIRMED",
  "PUBLIC_TOKEN_SCOPED",
  "SIGNED_WEBHOOK",
  "PLATFORM_ADMIN_ONLY",
  "INTERNAL_SECRET_AUTH",
  "DOCUMENTED_EXCEPTION",
  "VULNERABILITY_REQUIRES_SEPARATE_PR",
];
const SAFE_SUBSTRINGS = [
  "tenant_id=eq.",
  "tenant_id=not.is.null",
  "public_token=eq.",
  "stripe_customer_id=eq.",
  "tenant_id:",
  "tenants?id=eq.",
  "profiles?tenant_id=eq.",
];
const CONTROL_MARKERS = {
  TENANT_SCOPED_CONFIRMED: [
    "readSessionFromEvent",
    "resolveTenantFromSession",
    "requireOwnerMembership",
    "resolveDeviceSession",
    "requireFcOwnerTenant",
    "verifySupabaseAccessToken",
  ],
  PUBLIC_TOKEN_SCOPED: ["public_token"],
  SIGNED_WEBHOOK: ["verifySquareWebhookSignature", "verifyStripeSignature"],
  PLATFORM_ADMIN_ONLY: ["assertPlatformAdminSession"],
  INTERNAL_SECRET_AUTH: ["INTERNAL_API_KEY"],
  DOCUMENTED_EXCEPTION: ["email_action_token_hash", "timingSafeEqualHex"],
  VULNERABILITY_REQUIRES_SEPARATE_PR: [],
};

function usesSupabaseRest(src) {
  return (
    src.includes("supabaseRequest") ||
    src.includes("/rest/v1/") ||
    src.includes("rest/v1/quotes") ||
    src.includes("rest/v1/${")
  );
}
function passesHeuristic(src) {
  return SAFE_SUBSTRINGS.some((s) => src.includes(s));
}

function heuristicMarkedHandlers() {
  const dir = path.join(ROOT, "netlify", "functions");
  const names = fs.readdirSync(dir).filter((f) => f.endsWith(".js"));
  const marked = [];
  for (const name of names) {
    const src = fs.readFileSync(path.join(dir, name), "utf8");
    if (!usesSupabaseRest(src)) continue;
    if (passesHeuristic(src)) continue;
    if (Object.prototype.hasOwnProperty.call(ALLOWLIST, name)) continue;
    marked.push(name);
  }
  return marked.sort();
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
const INVOICE_B = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const QUOTE_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const PROJECT_B = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

function loadGuard() {
  [
    "../netlify/functions/_lib/supabase-admin",
    "../netlify/functions/_lib/membership-resolve",
    "../netlify/functions/_lib/owner-access",
    "../netlify/functions/_lib/tenant-for-session",
    "../netlify/functions/_lib/device-session",
    "../netlify/functions/_lib/session",
    "../netlify/functions/_lib/tenant-device-guard",
    "../netlify/functions/list-tenant-payments",
  ].forEach((rel) => {
    delete require.cache[require.resolve(rel)];
  });
  return {
    guard: require("../netlify/functions/_lib/tenant-device-guard"),
    tenant: require("../netlify/functions/_lib/tenant-for-session"),
    payments: require("../netlify/functions/list-tenant-payments"),
  };
}

async function withDb(fn) {
  const queries = [];
  const prev = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const restPath = extractPath(url);
    queries.push(restPath);
    const table = restPath.split("?")[0];
    if (table === "profiles") {
      const email = qp(restPath, "email");
      const tenantId = qp(restPath, "tenant_id");
      const rows = [];
      if (email === OWNER_A && (!tenantId || tenantId === TENANT_A)) {
        rows.push({
          id: "prof-a",
          tenant_id: TENANT_A,
          email: OWNER_A,
          role: "owner",
          status: "active",
          auth_user_id: "user-a",
        });
      }
      if (email === "owner-b@example.com" && (!tenantId || tenantId === TENANT_B)) {
        rows.push({
          id: "prof-b",
          tenant_id: TENANT_B,
          email: "owner-b@example.com",
          role: "owner",
          status: "active",
          auth_user_id: "user-b",
        });
      }
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
            stripe_customer_id: "cus_TESTOWNERA",
            name: "A",
            slug: "a",
          },
        ]);
      }
      if (id === TENANT_B) {
        return jsonRes(200, [
          {
            id: TENANT_B,
            owner_email: "owner-b@example.com",
            plan_status: "active",
            stripe_customer_id: "cus_TESTOWNERB",
            name: "B",
            slug: "b",
          },
        ]);
      }
      return jsonRes(200, []);
    }
    if (table === "tenant_project_payments") {
      return jsonRes(200, []);
    }
    return jsonRes(200, []);
  };
  try {
    const mods = loadGuard();
    return await fn({ mods, queries });
  } finally {
    globalThis.fetch = prev;
  }
}

function ownerCookie(fields) {
  return createSessionCookie(
    buildSessionPayload({
      email: fields.e || OWNER_A,
      tenantId: fields.t || TENANT_A,
      customerId: fields.c || "",
      userId: fields.u || "user-a",
    })
  );
}

async function main() {
  const inventory = MANIFEST.handlerInventory || [];
  eq("handler inventory has 10 entries", inventory.length, 10);
  const marked = heuristicMarkedHandlers();
  eq("heuristic currently marks 10 handlers", marked.length, 10);
  const inventoryFiles = inventory.map((row) => row.file).sort();
  eq("inventory matches heuristic-marked set", JSON.stringify(inventoryFiles), JSON.stringify(marked));

  const seen = new Set();
  inventory.forEach((row) => {
    ok("category is one of seven: " + row.file, CATEGORIES.indexOf(row.category) >= 0);
    ok("inventory file is unique: " + row.file, !seen.has(row.file));
    seen.add(row.file);
    ok("not added to substring allowlist: " + row.file, !Object.prototype.hasOwnProperty.call(ALLOWLIST, row.file));
    const src = fs.readFileSync(path.join(ROOT, "netlify", "functions", row.file), "utf8");
    const markers = CONTROL_MARKERS[row.category] || [];
    ok(
      "explicit control marker present: " + row.file,
      markers.some((m) => src.includes(m))
    );
    (row.controls || []).forEach((control) => {
      ok("documented control " + control + " in " + row.file, src.includes(control));
    });
  });

  eq("allowlist still only documents auth-status.js", Object.keys(ALLOWLIST).join(","), "auth-status.js");
  ok(
    "inventory is not substring-only",
    inventory.every((row) => Array.isArray(row.controls) && row.controls.length > 0)
  );

  const vuln = inventory.filter((row) => row.category === "VULNERABILITY_REQUIRES_SEPARATE_PR");
  eq("no inventory row is an unscoped vulnerability in this PR", vuln.length, 0);

  await withDb(async ({ mods, queries }) => {
    const sessionA = {
      e: OWNER_A,
      t: TENANT_A,
      c: "",
    };
    const tenantA = await mods.tenant.resolveTenantFromSession(sessionA);
    eq("owner A resolves tenant A", tenantA && tenantA.id, TENANT_A);

    const crossHint = await mods.tenant.resolveTenantFromSession({
      e: OWNER_A,
      t: TENANT_B,
      c: "",
    });
    eq("owner A cannot use tenant B id as session.t authority", crossHint, null);

    mods.guard.assertSameTenant(TENANT_A, TENANT_A);
    let mismatch = "";
    try {
      mods.guard.assertSameTenant(TENANT_A, TENANT_B);
    } catch (err) {
      mismatch = err.code || "";
    }
    eq("assertSameTenant rejects tenant B row", mismatch, "tenant_mismatch");

    const cookie = ownerCookie({ e: OWNER_A, t: TENANT_A });
    const res = await mods.payments.handler({
      httpMethod: "GET",
      headers: { cookie: String(cookie).split(";")[0] },
      queryStringParameters: {
        invoice_id: INVOICE_B,
        quote_id: QUOTE_B,
        project_id: PROJECT_B,
      },
    });
    eq("owner A listing payments with tenant B ids still returns 200", res.statusCode, 200);
    const payQuery = queries.find((q) => q.startsWith("tenant_project_payments?"));
    ok("payments query is present", Boolean(payQuery));
    ok("payments query is scoped to tenant A", payQuery.indexOf("tenant_id=eq." + TENANT_A) >= 0);
    ok("client invoice_id is only a filter", payQuery.indexOf("invoice_id=eq." + INVOICE_B) >= 0);
    ok("query string ids do not replace tenant A", payQuery.indexOf("tenant_id=eq." + TENANT_B) < 0);

    const bodyRes = await mods.payments.handler({
      httpMethod: "GET",
      headers: { cookie: String(cookie).split(";")[0] },
      queryStringParameters: {},
      body: JSON.stringify({ tenant_id: TENANT_B, invoice_id: INVOICE_B }),
    });
    eq("body tenant_id is ignored for list-tenant-payments", bodyRes.statusCode, 200);
    const lastPay = queries.filter((q) => q.startsWith("tenant_project_payments?")).pop();
    ok("body tenant_id is not authority", lastPay.indexOf("tenant_id=eq." + TENANT_A) >= 0);

    const noSession = await mods.payments.handler({
      httpMethod: "GET",
      headers: {},
      queryStringParameters: { tenant_id: TENANT_A },
    });
    eq("missing session cannot list payments via tenant_id query", noSession.statusCode, 401);
  });

  const envelopeSrc = fs.readFileSync(
    path.join(ROOT, "netlify/functions/contract-envelope-create.js"),
    "utf8"
  );
  const contractHelperSrc = fs.readFileSync(
    path.join(ROOT, "netlify/functions/_lib/require-owner-or-admin.js"),
    "utf8"
  );
  ok(
    "contract create rejects client tenant_id",
    envelopeSrc.indexOf('code: "tenant_id_forbidden"') >= 0
  );
  ok(
    "contract create derives tenant from session",
    envelopeSrc.indexOf('require("./_lib/require-owner-or-admin")') >= 0 &&
      contractHelperSrc.indexOf("resolveTenantFromSession") >= 0
  );

  const quoteEditSrc = fs.readFileSync(
    path.join(ROOT, "netlify/functions/get-tenant-quote-edit.js"),
    "utf8"
  );
  ok("quote edit uses session tenant, not client tenant_id", quoteEditSrc.indexOf("resolveTenantFromSession") >= 0);

  console.log("\nCore tenant isolation: " + passed + " passed");
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
