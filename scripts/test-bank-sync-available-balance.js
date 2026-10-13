#!/usr/bin/env node
/**
 * Cash Monitor sync reads spendable cash (cash.available) for type "cash".
 * Usage: node scripts/test-bank-sync-available-balance.js
 *
 * Does not call Stripe, Supabase, or production.
 */
"use strict";

const {
  usdMinorFromBalance,
  usdAvailableMajorUnits,
  readUsdBalanceForAccount,
} = require("../netlify/functions/sync-tenant-financial-summary");

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
