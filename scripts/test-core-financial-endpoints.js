#!/usr/bin/env node
/**
 * Core Security Shield V1 — financial endpoints and server-side pricing.
 * Isolated dummy secrets only. No live Stripe/Supabase.
 * Run: node scripts/test-core-financial-endpoints.js
 */
"use strict";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET || "mg-core-financial-endpoints-test-secret";
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "mg-core-financial-endpoints-test-key";

const assert = require("assert");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const { buildSessionPayload, createSessionCookie } = require("../netlify/functions/_lib/session");
const {
  calculateQuotePublishFinancials,
  sanitizeWorkersForTenantPricing,
} = require("../netlify/functions/_lib/pricing-engine");

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
const OWNER_A = "owner-a@example.com";
const OWNER_B = "owner-b@example.com";

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

function cookieFor(email, tenantId) {
  return createSessionCookie(
    buildSessionPayload({ email: email, tenantId: tenantId, userId: "user-" + tenantId.slice(0, 4) })
  );
}

function loadFinancial() {
  [
    "../netlify/functions/_lib/supabase-admin",
    "../netlify/functions/_lib/membership-resolve",
    "../netlify/functions/_lib/owner-access",
    "../netlify/functions/_lib/tenant-for-session",
    "../netlify/functions/_lib/session",
    "../netlify/functions/_lib/fc-owner-context",
    "../netlify/functions/list-tenant-bank-accounts",
    "../netlify/functions/get-owner-financial-settings",
    "../netlify/functions/list-tenant-payments",
  ].forEach((rel) => {
    delete require.cache[require.resolve(rel)];
  });
  return {
    banks: require("../netlify/functions/list-tenant-bank-accounts"),
    settings: require("../netlify/functions/get-owner-financial-settings"),
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
      if (email === OWNER_B && (!tenantId || tenantId === TENANT_B)) {
        rows.push({
          id: "prof-b",
          tenant_id: TENANT_B,
          email: OWNER_B,
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
            name: "A",
            slug: "a",
          },
        ]);
      }
      if (id === TENANT_B) {
        return jsonRes(200, [
          {
            id: TENANT_B,
            owner_email: OWNER_B,
            plan_status: "active",
            name: "B",
            slug: "b",
          },
        ]);
      }
      return jsonRes(200, []);
    }
    if (table === "tenant_bank_accounts") {
      const tenantId = qp(restPath, "tenant_id");
      if (tenantId === TENANT_A) {
        return jsonRes(200, [
          {
            id: "bank-a",
            stripe_fc_account_id: "fca_secret_account_aaaa",
            tenant_label: "",
          },
        ]);
      }
      return jsonRes(200, []);
    }
    if (table === "tenant_financial_account_mapping") {
      return jsonRes(200, []);
    }
    if (table === "owner_settings") {
      const tenantId = qp(restPath, "tenant_id");
      if (tenantId === TENANT_A) {
        return jsonRes(200, [{ overhead_monthly: 1200, savings_target_months: 3 }]);
      }
      return jsonRes(200, []);
    }
    if (table === "tenant_project_payments") {
      return jsonRes(200, []);
    }
    return jsonRes(200, []);
  };
  try {
    return await fn({ mods: loadFinancial(), queries });
  } finally {
    globalThis.fetch = prev;
  }
}

async function main() {
  const sanitized = sanitizeWorkersForTenantPricing([
    { name: "A", type: "installer", days: 2, hours: 16, rate: 1, hourly_rate: 1 },
  ]);
  eq("client labor rate is stripped", sanitized[0].rate, undefined);
  ok("sanitized worker has no hourly_rate", sanitized[0].hourly_rate === undefined);

  const settings = {
    hoursPerDay: 8,
    baseInstaller: 75,
    baseHelper: 45,
    wcPct: 0,
    ficaPct: 0,
    futaPct: 0,
    casuiPct: 0,
    stdHours: 160,
    overheadMonthly: 0,
    profitPct: 40,
    reservePct: 5,
    minimumMarginPct: 15,
  };
  const honest = calculateQuotePublishFinancials(
    {
      workers: [{ type: "installer", days: 2, hours: 16, rate: 75 }],
      pricing_stage: 2,
    },
    settings
  );
  const cheapClient = calculateQuotePublishFinancials(
    {
      workers: [{ type: "installer", days: 2, hours: 16, rate: 1 }],
      price: 1,
      _manualPriceTouched: true,
      pricing_stage: 2,
    },
    settings
  );
  ok("server pricing produces a positive total", honest.total > 0);
  eq("client rate:1 cannot reduce protected labor pricing", cheapClient.total, honest.total);
  ok("manual $1 offer is not used when it is not an anchor", cheapClient.total !== 1);

  const below = calculateQuotePublishFinancials(
    {
      workers: [{ type: "installer", days: 2, hours: 16 }],
      pricing_stage: 0,
    },
    settings
  );
  ok("minimum stage is still computed server-side", below.minimum_price > 0);
  eq("stage 0 offered equals minimum_price", below.total, below.minimum_price);

  await withDb(async ({ mods, queries }) => {
    const missing = await mods.banks.handler({ httpMethod: "GET", headers: {} });
    eq("bank accounts without session are 401", missing.statusCode, 401);

    const wrong = await mods.settings.handler({
      httpMethod: "GET",
      headers: { cookie: String(cookieFor(OWNER_A, TENANT_B)).split(";")[0] },
    });
    eq("owner A with tenant B session hint cannot load tenant B financials", wrong.statusCode, 404);

    const okBanks = await mods.banks.handler({
      httpMethod: "GET",
      headers: { cookie: String(cookieFor(OWNER_A, TENANT_A)).split(";")[0] },
    });
    eq("owner A can list own bank accounts", okBanks.statusCode, 200);
    const bankBody = JSON.parse(okBanks.body);
    eq("bank payload ok", bankBody.ok, true);
    ok("raw stripe_fc_account_id is not returned", !JSON.stringify(bankBody).includes("fca_secret_account_aaaa"));
    eq("returned bank fields are id+label", Object.keys(bankBody.accounts[0]).sort().join(","), "id,label");
    const bankQuery = queries.find((q) => q.startsWith("tenant_bank_accounts?"));
    ok("bank query is tenant-scoped", bankQuery.indexOf("tenant_id=eq." + TENANT_A) >= 0);

    const settingsRes = await mods.settings.handler({
      httpMethod: "GET",
      headers: { cookie: String(cookieFor(OWNER_A, TENANT_A)).split(";")[0] },
    });
    eq("owner financial settings require a valid session", settingsRes.statusCode, 200);
    const settingsBody = JSON.parse(settingsRes.body);
    eq("financial settings tenant is A", settingsBody.tenant_id, TENANT_A);

    const payMissing = await mods.payments.handler({ httpMethod: "GET", headers: {} });
    eq("payments without session are 401", payMissing.statusCode, 401);

    const payWrong = await mods.payments.handler({
      httpMethod: "GET",
      headers: { cookie: String(cookieFor(OWNER_B, TENANT_A)).split(";")[0] },
    });
    eq("tenant B owner cannot use tenant A session hint", payWrong.statusCode, 422);
  });

  console.log("\nCore financial endpoints: " + passed + " passed");
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
