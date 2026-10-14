#!/usr/bin/env node
/**
 * Reconnect stores the current fca_ accounts and remaps a bucket only
 * when the institution, last4, and category match exactly one account.
 *
 * Does not call Stripe, Supabase, or production.
 */
"use strict";

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "mg-bank-reconnect-test-secret";

const fs = require("fs");
const path = require("path");
const {
  accountFingerprint,
  createHandler: createCompleteHandler,
} = require("../netlify/functions/complete-financial-connections");
const { buildSessionPayload, createSessionCookie } = require("../netlify/functions/_lib/session");

const ROOT = path.resolve(__dirname, "..");
const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

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

const full = {
  institution_name: " Bank of America ",
  account_last4: "7601",
  account_category: " Checking ",
};
const normalized = {
  institution_name: "bank of america",
  account_last4: "7601",
  account_category: "checking",
};

assert(
  "fingerprint ignores case and extra spaces",
  accountFingerprint(full) === "bank of america|7601|checking" &&
    accountFingerprint(full) === accountFingerprint(normalized)
);
assert(
  "incomplete metadata does not match a complete account",
  accountFingerprint({ institution_name: "Bank of America", account_last4: "7601", account_category: "" }) === "" &&
    accountFingerprint({ institution_name: "Bank of America", account_last4: "", account_category: "checking" }) === "" &&
    accountFingerprint({ institution_name: "", account_last4: "7601", account_category: "checking" }) === ""
);

function stripeAccount(id) {
  return {
    id: id,
    institution_name: "Bank of America",
    last4: "7601",
    category: "checking",
  };
}

function ownerEvent() {
  const cookie = createSessionCookie(
    buildSessionPayload({
      tenantId: TENANT,
      email: "owner@example.com",
      userId: "user-test",
      customerId: "",
      subscriptionId: "",
    })
  ).split(";")[0];
  return {
    httpMethod: "POST",
    headers: { cookie },
    body: JSON.stringify({ financial_connections_session_id: "fcs_server" }),
  };
}

async function completeWith(accountsFromStripe, db) {
  const calls = [];
  const handler = createCompleteHandler({
    resolveTenantFromSession: async () => ({
      id: TENANT,
      owner_email: "owner@example.com",
      stripe_customer_id: "cus_test",
    }),
    retrieveFinancialConnectionsSession: async () => ({
      id: "fcs_server",
      account_holder: { type: "customer", customer: "cus_test" },
      accounts: { data: accountsFromStripe },
    }),
    listAccountsForSession: async () => accountsFromStripe,
    retrieveFinancialConnectionsAccount: async (id) => stripeAccount(id),
    supabaseRequest: async (p, options = {}) => {
      const method = String(options.method || "GET").toUpperCase();
      const pathName = String(p);
      calls.push({ path: pathName, method, body: options.body || null, prefer: options.prefer || "" });
      if (method === "DELETE") {
        throw new Error("delete is not allowed");
      }
      if (pathName.includes("tenant_financial_summary")) {
        throw new Error("summary must not be written");
      }
      if (pathName.includes("tenant_bank_connections") && method === "GET") {
        if (!pathName.includes("tenant_id=eq." + TENANT)) return [];
        return [{ id: "conn-1" }];
      }
      if (pathName.includes("tenant_bank_connections") && method === "PATCH") {
        return [{ id: "conn-1", status: "active" }];
      }
      if (pathName.includes("tenant_bank_accounts") && method === "GET" && pathName.includes("stripe_fc_account_id=eq.")) {
        return db.accounts.filter((row) => pathName.includes("stripe_fc_account_id=eq." + encodeURIComponent(row.stripe_fc_account_id)));
      }
      if (pathName.includes("tenant_bank_accounts") && method === "GET" && pathName.includes("id=eq.")) {
        if (!pathName.includes("tenant_id=eq." + TENANT) || pathName.includes(OTHER)) return [];
        const id = decodeURIComponent((pathName.split("id=eq.")[1] || "").split("&")[0]);
        return db.accounts.filter((row) => row.id === id && row.tenant_id === TENANT);
      }
      if (pathName === "tenant_bank_accounts" && method === "POST") {
        const row = { id: "acct-new-" + (db.accounts.length + 1), tenant_id: TENANT, ...options.body };
        db.accounts.push(row);
        return [row];
      }
      if (pathName.includes("tenant_bank_accounts") && method === "PATCH") {
        const id = decodeURIComponent((pathName.split("id=eq.")[1] || "").split("&")[0]);
        if (pathName.includes("tenant_id=eq.") && !pathName.includes("tenant_id=eq." + TENANT)) return [];
        const row = db.accounts.find((item) => item.id === id && item.tenant_id === TENANT);
        if (!row) return [];
        Object.assign(row, options.body);
        return [row];
      }
      if (pathName.includes("tenant_financial_account_mapping") && method === "GET") {
        if (!pathName.includes("tenant_id=eq." + TENANT)) return [];
        return db.mappings.map((row) => ({ ...row }));
      }
      if (pathName.includes("tenant_financial_account_mapping") && method === "PATCH") {
        if (!pathName.includes("tenant_id=eq." + TENANT)) return [];
        const bucket = decodeURIComponent((pathName.split("bucket=eq.")[1] || "").split("&")[0]);
        const row = db.mappings.find((item) => item.bucket === bucket);
        if (!row) return [];
        Object.assign(row, options.body);
        return [row];
      }
      return [];
    },
  });
  const response = await handler(ownerEvent());
  let body = {};
  try {
    body = JSON.parse(response.body || "{}");
  } catch (_err) {
    body = {};
  }
  return { response, body, calls, db };
}

async function main() {
  const old = {
    id: "acct-old",
    tenant_id: TENANT,
    stripe_fc_account_id: "fca_old7601",
    institution_name: "Bank of America",
    account_last4: "7601",
    account_category: "checking",
    status: "active",
  };
  const clear = await completeWith([stripeAccount("fca_new7601")], {
    accounts: [{ ...old }],
    mappings: [{ bucket: "operating", tenant_bank_account_id: "acct-old" }],
  });
  const oldAfter = clear.db.accounts.find((row) => row.id === "acct-old");
  const mappingWrites = clear.calls.filter(
    (call) => call.method === "PATCH" && call.path.includes("tenant_financial_account_mapping")
  );
  const inactiveWrites = clear.calls.filter(
    (call) => call.method === "PATCH" && call.path.includes("tenant_bank_accounts") && call.body && call.body.status === "inactive"
  );
  assert(
    "unambiguous reconnect remaps the bucket to the new account",
    clear.response.statusCode === 200 &&
      clear.db.mappings[0].tenant_bank_account_id !== "acct-old" &&
      String(clear.db.mappings[0].tenant_bank_account_id).startsWith("acct-new-") &&
      mappingWrites.length === 1 &&
      Array.isArray(clear.body.remapped_buckets) &&
      clear.body.remapped_buckets.length === 1 &&
      clear.body.remapped_buckets[0] === "operating"
  );
  assert(
    "displaced account is inactive and not deleted",
    oldAfter &&
      oldAfter.status === "inactive" &&
      inactiveWrites.length === 1 &&
      inactiveWrites[0].path.includes("tenant_id=eq." + TENANT) &&
      clear.calls.every((call) => call.method !== "DELETE") &&
      clear.db.accounts.some((row) => row.id === "acct-old")
  );
  assert(
    "summary balances are not written during remap",
    clear.calls.every((call) => !call.path.includes("tenant_financial_summary"))
  );

  const ambiguous = await completeWith(
    [stripeAccount("fca_new_a"), stripeAccount("fca_new_b")],
    {
      accounts: [{ ...old, id: "acct-old", status: "active" }],
      mappings: [{ bucket: "operating", tenant_bank_account_id: "acct-old" }],
    }
  );
  const ambiguousMappingWrites = ambiguous.calls.filter(
    (call) => call.method === "PATCH" && call.path.includes("tenant_financial_account_mapping")
  );
  const ambiguousOld = ambiguous.db.accounts.find((row) => row.id === "acct-old");
  assert(
    "ambiguous fingerprint does not rewrite the mapping",
    ambiguous.response.statusCode === 200 &&
      ambiguousMappingWrites.length === 0 &&
      ambiguous.db.mappings[0].tenant_bank_account_id === "acct-old" &&
      ambiguousOld.status === "active" &&
      Array.isArray(ambiguous.body.remapped_buckets) &&
      ambiguous.body.remapped_buckets.length === 0
  );

  const createSrc = read("netlify/functions/create-financial-connections-session.js");
  assert(
    "session prefetches balances only",
    /form\.append\("permissions\[\]", "balances"\)/.test(createSrc) &&
      /form\.append\("prefetch\[\]", "balances"\)/.test(createSrc) &&
      !/permissions\[\]", "transactions"/.test(createSrc) &&
      !/permissions\[\]", "ownership"/.test(createSrc) &&
      !/permissions\[\]", "payment_method"/.test(createSrc) &&
      !/prefetch\[\]", "transactions"/.test(createSrc) &&
      !/prefetch\[\]", "ownership"/.test(createSrc)
  );

  const uiSrc = read("public/js/bank-connection.js");
  assert(
    "a different Stripe session id stops connect",
    /sessionIdFromStripe !== createdSessionId/.test(uiSrc) &&
      /financial_connections_session_id: createdSessionId/.test(uiSrc) &&
      /Bucket mappings were moved to the current accounts\./.test(uiSrc)
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
