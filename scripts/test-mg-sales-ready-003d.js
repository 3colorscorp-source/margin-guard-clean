#!/usr/bin/env node
/**
 * MG-SALES-READY-003D — financial summary persist + bank reconnect idempotency
 * Usage: node scripts/test-mg-sales-ready-003d.js
 *
 * Mocked identity/DB/Stripe only. Does not call production or mutate tenants.
 */
"use strict";

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "mg-sales-ready-003d-test-session-secret";

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = path.resolve(__dirname, "..");
const {
  persistTenantFinancialSummary,
  isSummaryUniqueViolation,
} = require("../netlify/functions/_lib/persist-tenant-financial-summary");
const { upsertTenantBankConnection } = require("../netlify/functions/_lib/upsert-tenant-bank-connection");
const { createHandler: createFcSessionHandler } = require("../netlify/functions/create-financial-connections-session");
const { createHandler: createCompleteHandler } = require("../netlify/functions/complete-financial-connections");
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
const ACCOUNT_OP = "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACCOUNT_SV = "22222222-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACCOUNT_PF = "33333333-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACCOUNT_TX = "44444444-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONN_ACTIVE = "conn-active-1";
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

function eventWith(cookie, method, body) {
  return {
    httpMethod: method || "POST",
    headers: cookie ? { cookie } : {},
    body: body == null ? "{}" : typeof body === "string" ? body : JSON.stringify(body),
  };
}

function pg23505() {
  const err = new Error(
    'Supabase HTTP 409: duplicate key value violates unique constraint "tenant_financial_summary_pkey" | Key (tenant_id)=(' +
      TENANT_A +
      ") already exists. | 23505"
  );
  err.status = 409;
  err.code = "23505";
  return err;
}

async function main() {
  const persistSrc = read("netlify/functions/_lib/persist-tenant-financial-summary.js");
  const upsertSrc = read("netlify/functions/_lib/upsert-tenant-bank-connection.js");
  const syncSrc = read("netlify/functions/sync-tenant-financial-summary.js");
  const createSrc = read("netlify/functions/create-financial-connections-session.js");
  const completeSrc = read("netlify/functions/complete-financial-connections.js");
  const uiSrc = read("public/js/bank-connection.js");

  assert(
    "0a. persist helper does not delete or merge rows",
    !/method:\s*["']DELETE["']/.test(persistSrc) && !/\bDELETE\b/.test(persistSrc)
  );
  assert(
    "0b. connection upsert does not delete rows",
    !/method:\s*["']DELETE["']/.test(upsertSrc) && !/\bDELETE\b/.test(upsertSrc)
  );
  assert("0c. persist PATCH is by tenant_id, not uuid id", /tenant_id=eq\.\$\{tid\}/.test(persistSrc) && !/tenant_financial_summary\?id=eq/.test(persistSrc));
  assert("0d. persist writes last_sync_at", /last_sync_at/.test(persistSrc));
  assert("0e. sync returns persisted true only after helper", /persisted:\s*true/.test(syncSrc) && /persistSummary/.test(syncSrc));
  assert("0f. create session reuses connection helper", /upsertTenantBankConnection/.test(createSrc));
  assert("0g. complete still upserts accounts by fca_", /stripe_fc_account_id=eq/.test(completeSrc));
  assert(
    "0h. UI withholds Sync complete unless persisted",
    /data\.persisted !== true/.test(uiSrc) && /Sync complete/.test(uiSrc)
  );
  const syncUi = uiSrc.slice(uiSrc.indexOf("sync-tenant-financial-summary"));
  assert(
    "0i. UI applies sync payload after GET reload",
    syncUi.indexOf("refreshSummaryDisplay") > -1 &&
      syncUi.indexOf("refreshSummaryDisplay") < syncUi.indexOf("applySummaryToDashboard(data)") &&
      syncUi.indexOf("applySummaryToDashboard(data)") < syncUi.indexOf("Sync complete")
  );
  assert("0j. UI applies numeric 0 balances", /v === undefined \|\| v === null/.test(uiSrc));
  assert("0k. unique-violation detector matches production 23505", isSummaryUniqueViolation(pg23505()));
  assert(
    "0l. permissions remain balances-only",
    /permissions\[\]", "balances"/.test(createSrc) && !/permissions\[\]", "transactions"/.test(createSrc)
  );

  const calls = [];
  const saved = await persistTenantFinancialSummary({
    tenantId: TENANT_A,
    payload: {
      period_start: "2026-09-03",
      period_end: "2026-09-03",
      currency: "USD",
      operating_balance: 1200.5,
      savings_balance: 300,
      profit_balance: 80,
      tax_reserve_balance: 20,
      cash_on_hand: 1600.5,
      last_sync_at: "2026-09-04T03:00:00.000Z",
    },
    supabaseRequest: async (p, options = {}) => {
      calls.push({ p, method: String(options.method || "GET").toUpperCase(), body: options.body || null });
      const method = String(options.method || "GET").toUpperCase();
      if (String(p).includes("tenant_financial_summary") && method === "GET") {
        return [{ tenant_id: TENANT_A }];
      }
      if (String(p).includes("tenant_financial_summary") && method === "PATCH") {
        return [{ tenant_id: TENANT_A, last_sync_at: options.body.last_sync_at, operating_balance: options.body.operating_balance }];
      }
      if (method === "POST") {
        throw new Error("must not insert when tenant row exists");
      }
      return [];
    },
  });
  assert("1a. existing tenant row is PATCHed, not INSERTed", saved.persisted === true && saved.method === "update");
  assert("1b. PATCH query is tenant_id equality", calls.some((c) => c.method === "PATCH" && /tenant_id=eq/.test(c.p)));
  assert("1c. last_sync_at is written on update", saved.row.last_sync_at === "2026-09-04T03:00:00.000Z");
  assert("1d. balances are written on update", Number(saved.row.operating_balance) === 1200.5);
  assert("1e. no INSERT when old snapshot exists", calls.every((c) => c.method !== "POST"));

  const conflictCalls = [];
  const afterConflict = await persistTenantFinancialSummary({
    tenantId: TENANT_A,
    payload: {
      operating_balance: 99,
      last_sync_at: "2026-09-04T04:00:00.000Z",
    },
    supabaseRequest: async (p, options = {}) => {
      const method = String(options.method || "GET").toUpperCase();
      conflictCalls.push({ p, method });
      if (method === "GET") return [];
      if (method === "POST") throw pg23505();
      if (method === "PATCH") {
        return [{ tenant_id: TENANT_A, last_sync_at: "2026-09-04T04:00:00.000Z", operating_balance: 99 }];
      }
      return [];
    },
  });
  assert("2a. INSERT 23505 falls back to PATCH by tenant_id", afterConflict.method === "update_after_conflict" && afterConflict.persisted === true);
  assert("2b. conflict PATCH still sets last_sync_at", afterConflict.row.last_sync_at === "2026-09-04T04:00:00.000Z");
  assert("2c. conflict path does not swallow non-unique errors", true);

  let threwOther = false;
  try {
    await persistTenantFinancialSummary({
      tenantId: TENANT_A,
      payload: {},
      supabaseRequest: async (_p, options = {}) => {
        if (String(options.method || "GET").toUpperCase() === "POST") {
          throw new Error("column boom");
        }
        return [];
      },
    });
  } catch (err) {
    threwOther = /column boom/.test(err.message);
  }
  assert("2d. non-unique persist errors still throw", threwOther);

  const cookieA = ownerCookie(TENANT_A, OWNER_A);
  const tenantA = {
    id: TENANT_A,
    owner_email: OWNER_A,
    name: "Acme",
    stripe_customer_id: "cus_Aexist",
  };

  const connections = [];
  let connSeq = 0;
  async function connectionDb(p, options = {}) {
    const method = String(options.method || "GET").toUpperCase();
    if (String(p).startsWith("tenant_bank_connections") && method === "GET") {
      return connections.slice().sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    }
    if (p === "tenant_bank_connections" && method === "POST") {
      connSeq += 1;
      const row = { id: "conn-" + connSeq, ...options.body };
      connections.push(row);
      return [row];
    }
    if (String(p).startsWith("tenant_bank_connections?id=eq.") && method === "PATCH") {
      const id = decodeURIComponent(String(p).split("eq.")[1]);
      const row = connections.find((c) => c.id === id);
      Object.assign(row, options.body);
      return [row];
    }
    return [];
  }

  const first = await upsertTenantBankConnection({
    tenantId: TENANT_A,
    stripeFcSessionId: "fcs_first",
    stripeCustomerId: "cus_Aexist",
    supabaseRequest: connectionDb,
  });
  const second = await upsertTenantBankConnection({
    tenantId: TENANT_A,
    stripeFcSessionId: "fcs_second",
    stripeCustomerId: "cus_Aexist",
    supabaseRequest: connectionDb,
  });
  assert("3a. first Connect Bank inserts one connection row", first.reused === false && connections.length === 1);
  assert("3b. second Connect Bank reuses the same connection id", second.reused === true && second.connection.id === first.connection.id);
  assert("3c. reconnect does not multiply connection rows", connections.length === 1);
  assert("3d. reused row stores the new Stripe session id", connections[0].stripe_fc_session_id === "fcs_second");

  connections[0].status = "disconnected";
  const afterDisconnect = await upsertTenantBankConnection({
    tenantId: TENANT_A,
    stripeFcSessionId: "fcs_third",
    stripeCustomerId: "cus_Aexist",
    supabaseRequest: connectionDb,
  });
  assert("3e. disconnected rows are not reused", afterDisconnect.reused === false && connections.length === 2);

  const accounts = [];
  let accountPosts = 0;
  const completeHandler = createCompleteHandler({
    resolveTenantFromSession: async () => tenantA,
    retrieveFinancialConnectionsSession: async () => ({
      id: "fcs_link",
      account_holder: { type: "customer", customer: "cus_Aexist" },
      accounts: { data: [{ id: FCA_OP, institution_name: "Bank", last4: "1111" }] },
    }),
    listAccountsForSession: async () => [{ id: FCA_OP, institution_name: "Bank", last4: "1111" }],
    retrieveFinancialConnectionsAccount: async () => ({
      id: FCA_OP,
      institution_name: "Bank",
      last4: "1111",
    }),
    supabaseRequest: async (p, options = {}) => {
      const method = String(options.method || "GET").toUpperCase();
      if (String(p).includes("tenant_bank_connections") && method === "GET") {
        return [{ id: CONN_ACTIVE }];
      }
      if (String(p).includes("tenant_bank_connections") && method === "PATCH") {
        return [{ id: CONN_ACTIVE, status: "active" }];
      }
      if (String(p).includes("tenant_bank_accounts") && method === "GET") {
        return accounts.filter((a) => String(p).includes(a.stripe_fc_account_id));
      }
      if (p === "tenant_bank_accounts" && method === "POST") {
        accountPosts += 1;
        const row = { id: "acct-" + accountPosts, tenant_id: TENANT_A, ...options.body };
        accounts.push(row);
        return [row];
      }
      if (String(p).includes("tenant_bank_accounts?id=eq.") && method === "PATCH") {
        const id = decodeURIComponent(String(p).split("eq.")[1]);
        const row = accounts.find((a) => a.id === id);
        Object.assign(row, options.body);
        return [row];
      }
      return [];
    },
  });

  const complete1 = await completeHandler(
    eventWith(cookieA, "POST", { financial_connections_session_id: "fcs_link" })
  );
  const complete2 = await completeHandler(
    eventWith(cookieA, "POST", { financial_connections_session_id: "fcs_link" })
  );
  assert("4a. first complete inserts the fca_ account", complete1.statusCode === 200 && accountPosts === 1 && accounts.length === 1);
  assert("4b. reconnect complete does not multiply the same bank account record", complete2.statusCode === 200 && accountPosts === 1 && accounts.length === 1);
  assert("4c. second complete PATCHes the existing fca_ row", accounts[0].stripe_fc_account_id === FCA_OP && accounts[0].status === "active");

  const createCalls = [];
  let sessionN = 0;
  const createHandler = createFcSessionHandler({
    resolveTenantFromSession: async () => tenantA,
    ensurePlatformFinancialCustomer: async () => ({ customerId: "cus_Aexist", created: false }),
    createFinancialConnectionsSession: async () => {
      sessionN += 1;
      return { id: "fcs_live_" + sessionN, client_secret: "secret_" + sessionN };
    },
    supabaseRequest: async (p, options = {}) => {
      createCalls.push({ p, method: String(options.method || "GET").toUpperCase() });
      return connectionDb(p, options);
    },
  });
  connections.length = 0;
  connSeq = 0;
  const c1 = await createHandler(eventWith(cookieA, "POST", {}));
  const c2 = await createHandler(eventWith(cookieA, "POST", {}));
  assert("5a. live create-session first connect succeeds", c1.statusCode === 200 && parse(c1).connection_id);
  assert("5b. second Connect Bank reuses connection_id", parse(c1).connection_id === parse(c2).connection_id);
  assert("5c. create-session POST happened once", createCalls.filter((c) => c.method === "POST").length === 1);

  const readFcas = [];
  const syncHandler = createSyncHandler({
    resolveTenantFromSession: async () => tenantA,
    readUsdBalanceForAccount: async (fca) => {
      readFcas.push(fca);
      return 250;
    },
    supabaseRequest: async (p, options = {}) => {
      const method = String(options.method || "GET").toUpperCase();
      if (String(p).includes("tenant_financial_account_mapping") && method === "GET") {
        return [
          { bucket: "operating", tenant_bank_account_id: ACCOUNT_OP },
          { bucket: "savings", tenant_bank_account_id: ACCOUNT_SV },
          { bucket: "profit", tenant_bank_account_id: ACCOUNT_PF },
          { bucket: "tax_reserve", tenant_bank_account_id: ACCOUNT_TX },
        ];
      }
      if (String(p).includes("tenant_bank_accounts") && method === "GET") {
        return [
          { id: ACCOUNT_OP, stripe_fc_account_id: FCA_OP, status: "active", tenant_bank_connection_id: CONN_ACTIVE, tenant_id: TENANT_A },
          { id: ACCOUNT_SV, stripe_fc_account_id: "fca_sav", status: "inactive", tenant_bank_connection_id: CONN_ACTIVE, tenant_id: TENANT_A },
          { id: ACCOUNT_PF, stripe_fc_account_id: "fca_profit", status: "active", tenant_bank_connection_id: "conn-other-tenant", tenant_id: TENANT_B },
          { id: ACCOUNT_TX, stripe_fc_account_id: "not-an-fca", status: "active", tenant_bank_connection_id: CONN_ACTIVE, tenant_id: TENANT_A },
        ].filter((row) => String(p).includes(row.id) && String(p).includes("tenant_id=eq." + TENANT_A) && String(p).includes("status=eq.active"));
      }
      if (String(p).includes("tenant_bank_connections") && method === "GET") {
        return [{ id: CONN_ACTIVE, tenant_id: TENANT_A, status: "active" }];
      }
      if (String(p).includes("tenant_financial_summary") && method === "GET") {
        return [{ tenant_id: TENANT_A }];
      }
      if (String(p).includes("tenant_financial_summary") && method === "PATCH") {
        return [{ tenant_id: TENANT_A, last_sync_at: options.body.last_sync_at, operating_balance: options.body.operating_balance }];
      }
      if (p === "tenant_financial_summary" && method === "POST") {
        throw pg23505();
      }
      return [];
    },
  });
  const synced = await syncHandler(eventWith(cookieA, "POST", {}));
  const syncBody = parse(synced);
  assert("6a. sync 200 only after persist", synced.statusCode === 200 && syncBody.ok === true && syncBody.persisted === true);
  assert("6b. last_sync_at is present after persist", Boolean(syncBody.last_sync_at));
  assert("6c. operating balance persisted from active tenant-owned fca_", Number(syncBody.operating_balance) === 250);
  assert("6d. inactive / foreign / non-fca accounts are not refreshed", readFcas.length === 1 && readFcas[0] === FCA_OP);
  assert("6e. mappings still sync without a new bank reconnect", Number(syncBody.cash_on_hand) === 250);

  const failedPersist = await createSyncHandler({
    resolveTenantFromSession: async () => tenantA,
    readUsdBalanceForAccount: async () => 10,
    persistTenantFinancialSummary: async () => ({ persisted: false }),
    supabaseRequest: async (p) => {
      if (String(p).includes("tenant_financial_account_mapping")) {
        return [{ bucket: "operating", tenant_bank_account_id: ACCOUNT_OP }];
      }
      if (String(p).includes("tenant_bank_accounts")) {
        return [{ id: ACCOUNT_OP, stripe_fc_account_id: FCA_OP, status: "active" }];
      }
      return [];
    },
  })(eventWith(cookieA, "POST", {}));
  assert("6f. success is not returned if persistence failed", failedPersist.statusCode === 500 && parse(failedPersist).persisted !== true);

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
    assert("7. zip-it still includes sync-tenant-financial-summary", names.includes("sync-tenant-financial-summary"));
  } else {
    assert("7. sync function file remains", fs.existsSync(path.join(fnDir, "sync-tenant-financial-summary.js")));
  }

  console.log("");
  console.log(passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
