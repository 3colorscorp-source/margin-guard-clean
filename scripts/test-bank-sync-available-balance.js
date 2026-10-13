#!/usr/bin/env node
/**
 * Cash Monitor sync reads spendable cash (cash.available) for type "cash".
 * Usage: node scripts/test-bank-sync-available-balance.js
 *
 * Does not call Stripe, Supabase, or production.
 */
"use strict";

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "mg-bank-sync-available-test-secret";

const {
  usdMinorFromBalance,
  usdAvailableMajorUnits,
  readUsdBalanceForAccount,
  createHandler: createSyncHandler,
} = require("../netlify/functions/sync-tenant-financial-summary");
const { buildSessionPayload, createSessionCookie } = require("../netlify/functions/_lib/session");

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_TENANT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

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

const cashBoth = {
  type: "cash",
  current: { usd: 55004 },
  cash: { available: { usd: 14004 } },
};

assert(
  "cash account prefers available over current",
  usdMinorFromBalance(cashBoth) === 14004
);

assert(
  "available zero is valid and does not fall back to current",
  usdMinorFromBalance({
    type: "cash",
    current: { usd: 55004 },
    cash: { available: { usd: 0 } },
  }) === 0
);

assert(
  "missing available falls back to current",
  usdMinorFromBalance({
    type: "cash",
    current: { usd: 44804 },
  }) === 44804
);

assert(
  "legacy payload without type keeps current before available",
  usdMinorFromBalance({
    current: { usd: 51124 },
    cash: { available: { usd: 15124 } },
  }) === 51124
);

assert(
  "uppercase USD is accepted on cash.available",
  usdMinorFromBalance({
    type: "cash",
    current: { usd: 100 },
    cash: { available: { USD: 44804 } },
  }) === 44804
);

assert(
  "cents convert to major units from available",
  usdAvailableMajorUnits({ balance: cashBoth }) === 140.04
);

assert("null payload returns null", usdMinorFromBalance(null) === null);
assert("array payload returns null", usdMinorFromBalance([]) === null);
assert("string payload returns null", usdMinorFromBalance("14004") === null);
assert(
  "missing balance returns null",
  usdAvailableMajorUnits({}) === null
);

function cashAccount(status, extraRefresh) {
  return {
    balance_refresh: Object.assign(
      {
        status: status,
        last_attempted_at: 100,
        next_refresh_available_at: 2000,
      },
      extraRefresh || {}
    ),
    balance: {
      type: "cash",
      as_of: 100,
      current: { usd: 55004 },
      cash: { available: { usd: 14004 } },
    },
  };
}

async function readWith(account, refresh) {
  return readUsdBalanceForAccount("fca_test", "", {
    stripeGet: async () => account,
    stripeRefreshBalanceOnly: refresh || (async () => account),
    sleep: async () => {},
    nowUnix: () => 1500,
  });
}

async function main() {
  const pending = await readWith(cashAccount("pending"));
  assert(
    "pending refresh with a usable balance returns that amount",
    pending && pending.amount === 140.04
  );
  assert(
    "pending refresh is reported as refresh_pending true",
    pending && pending.refresh_pending === true
  );

  const succeeded = await readWith(cashAccount("succeeded"));
  assert(
    "succeeded refresh returns the available balance",
    succeeded && succeeded.amount === 140.04
  );
  assert(
    "succeeded refresh is reported as refresh_pending false",
    succeeded && succeeded.refresh_pending === false
  );

  function pendingError() {
    const err = new Error("Bank balance is still updating. Try Sync again in a minute.");
    err.retryable = true;
    return err;
  }

  async function runSync(read, previous) {
    const queries = [];
    let persistCalls = 0;
    const handler = createSyncHandler({
      resolveTenantFromSession: async () => ({
        id: TENANT,
        owner_email: "owner@example.com",
        stripe_customer_id: "cus_test",
      }),
      readUsdBalanceForAccount: read,
      persistTenantFinancialSummary: async () => {
        persistCalls += 1;
        return { persisted: true };
      },
      supabaseRequest: async (p) => {
        const path = String(p);
        queries.push(path);
        if (path.includes("tenant_financial_account_mapping")) {
          return [
            { bucket: "operating", tenant_bank_account_id: "acct-op" },
            { bucket: "savings", tenant_bank_account_id: "acct-sv" },
          ];
        }
        if (path.includes("tenant_bank_accounts")) {
          return [
            { id: "acct-op", stripe_fc_account_id: "fca_operating", status: "active", tenant_bank_connection_id: "conn-1" },
            { id: "acct-sv", stripe_fc_account_id: "fca_savings", status: "active", tenant_bank_connection_id: "conn-1" },
          ].filter((row) => path.includes(row.id) && path.includes("tenant_id=eq." + TENANT));
        }
        if (path.includes("tenant_bank_connections")) {
          return [{ id: "conn-1", status: "active" }];
        }
        if (path.includes("tenant_financial_summary")) {
          return previous;
        }
        return [];
      },
    });
    const cookie = createSessionCookie(
      buildSessionPayload({
        tenantId: TENANT,
        email: "owner@example.com",
        userId: "user-test",
        customerId: "",
        subscriptionId: "",
      })
    ).split(";")[0];
    const response = await handler({ httpMethod: "POST", headers: { cookie }, body: "{}" });
    let body = {};
    try {
      body = JSON.parse(response.body || "{}");
    } catch (_err) {
      body = {};
    }
    return { response, body, queries, persistCalls };
  }

  const partial = await runSync(
    async (fca) => {
      if (fca === "fca_operating") return 80;
      if (fca === "fca_savings") throw pendingError();
      throw new Error("unexpected account");
    },
    [{ operating_balance: 1, savings_balance: 20, profit_balance: 3, tax_reserve_balance: 4 }]
  );
  const previousQuery = partial.queries.find((q) => q.includes("select=operating_balance"));
  assert("available account stores the new Stripe balance", partial.body.operating_balance === 80);
  assert("pending account keeps its previous balance", partial.body.savings_balance === 20);
  assert(
    "partial summary is persisted",
    partial.response.statusCode === 200 && partial.body.persisted === true && partial.persistCalls === 1
  );
  assert("cash on hand combines the new and preserved balances", partial.body.cash_on_hand === 100);
  assert(
    "pending_buckets identifies the pending bucket",
    Array.isArray(partial.body.pending_buckets) &&
      partial.body.pending_buckets.length === 1 &&
      partial.body.pending_buckets[0] === "savings"
  );
  assert(
    "preserved_buckets identifies the pending bucket",
    Array.isArray(partial.body.preserved_buckets) &&
      partial.body.preserved_buckets.length === 1 &&
      partial.body.preserved_buckets[0] === "savings"
  );
  assert(
    "previous summary query is restricted to the authenticated tenant",
    Boolean(previousQuery) &&
      previousQuery.includes("tenant_id=eq." + TENANT) &&
      !previousQuery.includes(OTHER_TENANT)
  );
  assert(
    "previous summary query selects only the four USD balances",
    Boolean(previousQuery) &&
      previousQuery.includes("currency=eq.USD") &&
      previousQuery.includes("select=operating_balance,savings_balance,profit_balance,tax_reserve_balance") &&
      !previousQuery.includes("cash_on_hand")
  );

  const nullPrevious = await runSync(
    async (fca) => {
      if (fca === "fca_operating") throw pendingError();
      if (fca === "fca_savings") return 20;
      throw new Error("unexpected account");
    },
    [{ operating_balance: null, savings_balance: 20, profit_balance: null, tax_reserve_balance: null }]
  );
  assert(
    "null previous balance is not converted to zero",
    nullPrevious.response.statusCode === 409 &&
      nullPrevious.persistCalls === 0 &&
      nullPrevious.body.operating_balance !== 0
  );

  const missingPrevious = await runSync(async () => {
    throw pendingError();
  }, []);
  assert(
    "pending bucket without a previous balance stays retryable 409",
    missingPrevious.response.statusCode === 409 && missingPrevious.body.retry === true
  );
  assert(
    "pending bucket without a previous balance does not persist",
    missingPrevious.persistCalls === 0 && missingPrevious.body.persisted !== true
  );

  const unsafe = await runSync(
    async (fca) => {
      if (fca === "fca_operating") return 80;
      throw new Error("Linked account does not belong to this tenant");
    },
    [{ operating_balance: 1, savings_balance: 99, profit_balance: 3, tax_reserve_balance: 4 }]
  );
  assert(
    "non-retryable error does not use the previous balance",
    unsafe.response.statusCode === 500 && unsafe.body.savings_balance !== 99
  );
  assert(
    "non-retryable error does not persist",
    unsafe.persistCalls === 0 && unsafe.body.persisted !== true
  );

  if (failed) {
    console.log("\n" + passed + " passed, " + failed + " failed");
    process.exit(1);
  }

  console.log("\n" + passed + " passed, 0 failed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
