#!/usr/bin/env node
/**
 * MG-SALES-READY-003E — Financial Command Center uses persisted owner_settings
 * Usage: node scripts/test-mg-sales-ready-003e.js
 *
 * Mocked identity/DB only. Does not call production or mutate tenants.
 */
"use strict";

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "mg-sales-ready-003e-test-session-secret";

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = path.resolve(__dirname, "..");
const {
  computeFinancialCommandMetrics,
} = require("../public/js/financial-command-metrics");
const { createHandler: createSettingsHandler } = require("../netlify/functions/get-owner-financial-settings");
const { createHandler: createSyncHandler } = require("../netlify/functions/sync-tenant-financial-summary");
const { buildSessionPayload, createSessionCookie } = require("../netlify/functions/_lib/session");

let failed = 0;
let passed = 0;

function assert(name, cond) {
  if (cond) {
    passed += 1;
    console.log("PASS  " + name);
  } else {
    failed += 1;
    console.log("FAIL  " + name);
  }
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function parse(res) {
  try {
    return JSON.parse(res.body || "{}");
  } catch (_err) {
    return {};
  }
}

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWNER_A = "owner-a@example.com";
const OWNER_B = "owner-b@example.com";
const ACCOUNT_OP = "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FCA_OP = "fca_operating111";

function ownerCookie(tenantId, email) {
  return createSessionCookie(
    buildSessionPayload({
      tenantId,
      email,
      userId: "user-" + tenantId.slice(0, 8),
      customerId: "",
      subscriptionId: "",
    })
  ).split(";")[0];
}

function eventGet(cookie) {
  return {
    httpMethod: "GET",
    headers: cookie ? { cookie } : {},
  };
}

async function main() {
  const appSrc = read("public/js/app.js");
  const metricsSrc = read("public/js/financial-command-metrics.js");
  const uiDash = read("public/dashboard.html");
  const bankSrc = read("public/js/bank-connection.js");
  const advisorSrc = read("public/js/owner-financial-advisor.js");
  const createFcSrc = read("netlify/functions/create-financial-connections-session.js");
  const settingsSrc = read("netlify/functions/get-owner-financial-settings.js");
  const syncSrc = read("netlify/functions/sync-tenant-financial-summary.js");

  assert(
    "0a. dashboard loads persisted owner financial settings",
    /get-owner-financial-settings/.test(appSrc) && /computeFinancialCommandMetrics/.test(appSrc)
  );
  assert(
    "0b. localStorage operatingMonthly is not the runway authority",
    !/state\.operatingMonthly > 0 \? totalCash \/ state\.operatingMonthly/.test(appSrc) &&
      !/num\("operatingMonthly"/.test(appSrc)
  );
  assert(
    "0c. savings target is not hardcoded * 12",
    !/state\.operatingMonthly \* 12/.test(appSrc) && /savings_target_months/.test(metricsSrc)
  );
  assert("0d. dashboard includes metrics script", /financial-command-metrics\.js/.test(uiDash));
  assert(
    "0e. bank sync refreshes Command Center",
    /__mgRefreshFinancialCommandCenter/.test(bankSrc) && /__mgLastFinancialSummary/.test(bankSrc)
  );
  assert(
    "0f. advisor ignores stale monthly cost when settings unavailable",
    /ownerSettingsAvailable === false/.test(advisorSrc)
  );
  assert(
    "0g. advisor does not send bank identifiers",
    !/fca_/.test(advisorSrc) && !/stripe_fc/.test(advisorSrc) && !/openai/i.test(advisorSrc)
  );
  assert(
    "0h. FC remains balances-only",
    /permissions\[\]", "balances"/.test(createFcSrc) && !/permissions\[\]", "transactions"/.test(createFcSrc)
  );
  assert("0i. settings loader does not write owner_settings", !/method:\s*["']POST["']/.test(settingsSrc) && !/method:\s*["']PATCH["']/.test(settingsSrc) && !/DELETE/.test(settingsSrc));
  assert("0j. sync persist path is unchanged", /persistTenantFinancialSummary/.test(syncSrc) && /persisted:\s*true/.test(syncSrc));

  const fixture = computeFinancialCommandMetrics({
    cashOnHand: 7148.73,
    savingsBalance: 550.04,
    operatingBalance: 5000,
    overheadMonthly: 4500,
    savingsTargetMonths: 12,
    runwayGreenDays: 60,
    runwayYellowDays: 30,
    settingsLoaded: true,
  });
  assert("1. persisted overhead_monthly is used", fixture.available === true && fixture.overheadMonthly === 4500);
  assert("2. persisted savings_target_months is used", fixture.savingsTargetMonths === 12);
  assert("3. runway = cash_on_hand / overhead_monthly", Math.abs(fixture.runwayMonths - 7148.73 / 4500) < 1e-9);
  assert("4. savings target = overhead_monthly * savings_target_months", fixture.savingsTarget === 54000);
  assert(
    "5. savings progress = savings_balance / target * 100",
    Math.abs(fixture.savingsPct - (550.04 / 54000) * 100) < 1e-9
  );

  const afterSync = computeFinancialCommandMetrics({
    cashOnHand: 9000,
    savingsBalance: 550.04,
    operatingBalance: 5000,
    overheadMonthly: 4500,
    savingsTargetMonths: 12,
    settingsLoaded: true,
  });
  assert("6. values update after bank sync cash_on_hand change", Math.abs(afterSync.runwayMonths - 9000 / 4500) < 1e-9);

  const lsOverride = computeFinancialCommandMetrics({
    cashOnHand: 7148.73,
    savingsBalance: 550.04,
    operatingBalance: 0,
    overheadMonthly: 4500,
    savingsTargetMonths: 12,
    localOperatingMonthly: 0,
    settingsLoaded: true,
  });
  assert(
    "7. localStorage-style 0 cannot override server overhead",
    lsOverride.available === true && lsOverride.overheadMonthly === 4500 && lsOverride.savingsTarget === 54000
  );

  const missing = computeFinancialCommandMetrics({
    cashOnHand: 7148.73,
    savingsBalance: 550.04,
    operatingBalance: 0,
    overheadMonthly: null,
    savingsTargetMonths: null,
    settingsLoaded: true,
  });
  assert(
    "8. missing settings do not display fake zero financial metrics",
    missing.available === false &&
      missing.runwayMonths == null &&
      missing.savingsTarget == null &&
      missing.savingsPct == null &&
      missing.runwayLabel === "Setup required" &&
      missing.savingsProgressLabel === "Setup required"
  );

  const failedLoad = computeFinancialCommandMetrics({
    cashOnHand: 7148.73,
    savingsBalance: 0,
    overheadMonthly: 0,
    settingsLoaded: false,
    settingsError: true,
  });
  assert(
    "9. missing/failed settings do not automatically produce High Risk",
    failedLoad.healthTone === "unknown" &&
      failedLoad.healthScore == null &&
      !/High risk/i.test(failedLoad.healthLabel) &&
      missing.healthTone === "unknown" &&
      missing.healthScore == null
  );

  const cookieA = ownerCookie(TENANT_A, OWNER_A);
  const cookieB = ownerCookie(TENANT_B, OWNER_B);
  const settingsByTenant = {
    [TENANT_A]: {
      overhead_monthly: 4500,
      savings_target_months: 12,
      runway_green_days: 60,
      runway_yellow_days: 30,
    },
    [TENANT_B]: {
      overhead_monthly: 8000,
      savings_target_months: 6,
      runway_green_days: 90,
      runway_yellow_days: 45,
    },
  };

  function settingsHandler() {
    return createSettingsHandler({
      resolveTenantFromSession: async (session) => {
        const tid = String(session && session.t ? session.t : "");
        if (session && session.e === OWNER_A && tid === TENANT_A) return { id: TENANT_A, owner_email: OWNER_A };
        if (session && session.e === OWNER_B && tid === TENANT_B) return { id: TENANT_B, owner_email: OWNER_B };
        return null;
      },
      supabaseRequest: async (p) => {
        const pathStr = String(p || "");
        if (!pathStr.startsWith("owner_settings?")) return [];
        if (pathStr.includes(TENANT_A)) return [settingsByTenant[TENANT_A]];
        if (pathStr.includes(TENANT_B)) return [settingsByTenant[TENANT_B]];
        return [];
      },
    });
  }

  const aRes = await settingsHandler()(eventGet(cookieA));
  const bRes = await settingsHandler()(eventGet(cookieB));
  const aBody = parse(aRes);
  const bBody = parse(bRes);
  assert("10a. tenant A receives only tenant A owner_settings", aRes.statusCode === 200 && aBody.overhead_monthly === 4500 && aBody.tenant_id === TENANT_A);
  assert("10b. tenant B receives only tenant B owner_settings", bRes.statusCode === 200 && bBody.overhead_monthly === 8000 && bBody.tenant_id === TENANT_B);
  assert("10c. tenant A settings cannot affect tenant B", aBody.savings_target_months === 12 && bBody.savings_target_months === 6);

  const unauth = await settingsHandler()(eventGet(null));
  assert("10d. unauthenticated caller cannot read owner_settings", unauth.statusCode === 401);

  const tenantA = {
    id: TENANT_A,
    owner_email: OWNER_A,
    name: "Acme",
    stripe_customer_id: "cus_Aexist",
  };
  const synced = await createSyncHandler({
    resolveTenantFromSession: async () => tenantA,
    readUsdBalanceForAccount: async () => 250,
    supabaseRequest: async (p, options = {}) => {
      const method = String(options.method || "GET").toUpperCase();
      if (String(p).includes("tenant_financial_account_mapping") && method === "GET") {
        return [{ bucket: "operating", tenant_bank_account_id: ACCOUNT_OP }];
      }
      if (String(p).includes("tenant_bank_accounts")) {
        return [{ id: ACCOUNT_OP, stripe_fc_account_id: FCA_OP, status: "active" }];
      }
      if (String(p).includes("tenant_financial_summary") && method === "GET") {
        return [{ tenant_id: TENANT_A }];
      }
      if (String(p).includes("tenant_financial_summary") && method === "PATCH") {
        return [{ tenant_id: TENANT_A, last_sync_at: options.body.last_sync_at, operating_balance: 250 }];
      }
      return [];
    },
  })({
    httpMethod: "POST",
    headers: { cookie: cookieA },
    body: "{}",
  });
  const syncBody = parse(synced);
  assert(
    "11. normal bank sync remains unchanged",
    synced.statusCode === 200 && syncBody.ok === true && syncBody.persisted === true && Number(syncBody.operating_balance) === 250
  );

  assert(
    "12. Financial Connections remains balances-only",
    /form\.append\("permissions\[\]", "balances"\)/.test(createFcSrc) &&
      !/ownership|transactions|payment_method/.test(createFcSrc.split("permissions")[1] || "")
  );

  const zisiCandidates = [
    path.join(
      ROOT,
      ".qa-ch013a48/netlify-cli-pkg/node_modules/netlify-cli/node_modules/@netlify/zip-it-and-ship-it/dist/main.js"
    ),
    path.join(
      "C:\\Margin Guard System\\margin-guard-clean",
      ".qa-ch013a48/netlify-cli-pkg/node_modules/netlify-cli/node_modules/@netlify/zip-it-and-ship-it/dist/main.js"
    ),
  ];
  const zisiPath = zisiCandidates.find((p) => fs.existsSync(p));
  const fnDir = path.join(ROOT, "netlify/functions");
  if (zisiPath) {
    const { listFunctions } = await import(pathToFileURL(zisiPath).href);
    const listed = await listFunctions(fnDir);
    const names = (listed || []).map((fn) => fn.name);
    assert("13. zip-it includes get-owner-financial-settings", names.includes("get-owner-financial-settings"));
    assert("13b. zip-it still includes sync-tenant-financial-summary", names.includes("sync-tenant-financial-summary"));
  } else {
    assert("13. get-owner-financial-settings file remains", fs.existsSync(path.join(fnDir, "get-owner-financial-settings.js")));
    assert("13b. sync function file remains", fs.existsSync(path.join(fnDir, "sync-tenant-financial-summary.js")));
  }

  console.log("");
  console.log(passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
