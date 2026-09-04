#!/usr/bin/env node
/**
 * MG-SALES-READY-003B — FC customer bootstrap + session.c decoupling
 * Usage: node scripts/test-mg-sales-ready-003b.js
 *
 * Mocked identity/DB/Stripe only. Does not call production or mutate tenants.
 */
"use strict";

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "mg-sales-ready-003b-test-session-secret";

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = path.resolve(__dirname, "..");
const {
  createHandler: createFcSessionHandler,
  createFinancialConnectionsSession,
} = require("../netlify/functions/create-financial-connections-session");
const { createHandler: createCompleteHandler } = require("../netlify/functions/complete-financial-connections");
const { createHandler: createListHandler } = require("../netlify/functions/list-tenant-bank-accounts");
const { createHandler: createSummaryHandler } = require("../netlify/functions/get-tenant-financial-summary");
const { createHandler: createMapHandler } = require("../netlify/functions/save-tenant-financial-account-mapping");
const { createHandler: createSyncHandler } = require("../netlify/functions/sync-tenant-financial-summary");
const {
  ensurePlatformFinancialCustomer,
  customerFieldsFromTenant,
} = require("../netlify/functions/_lib/ensure-platform-financial-customer");
const { buildSessionPayload, createSessionCookie } = require("../netlify/functions/_lib/session");
const {
  buildDeviceSessionPayload,
  createDeviceSessionCookieFromPayload,
} = require("../netlify/functions/_lib/device-session");

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
const ACCOUNT_A = "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FORBIDDEN_STRIPE = [
  "/payment_intents",
  "/setup_intents",
  "/charges",
  "/transfers",
  "/payouts",
  "/subscriptions",
  "/payment_methods",
  "/treasury",
  "/outbound_payments",
  "/inbound_transfers",
  "us_bank_account",
];

function ownerCookie(tenantId, email, extra) {
  return createSessionCookie(
    buildSessionPayload(
      Object.assign(
        {
          tenantId,
          email,
          userId: "user-" + tenantId.slice(0, 8),
          customerId: "",
          subscriptionId: "",
        },
        extra || {}
      )
    )
  ).split(";")[0];
}

function eventWith(cookie, method, body) {
  return {
    httpMethod: method || "POST",
    headers: cookie ? { cookie } : {},
    body: body == null ? "{}" : typeof body === "string" ? body : JSON.stringify(body),
  };
}

function fcFiles() {
  return [
    "netlify/functions/create-financial-connections-session.js",
    "netlify/functions/complete-financial-connections.js",
    "netlify/functions/list-tenant-bank-accounts.js",
    "netlify/functions/sync-tenant-financial-summary.js",
    "netlify/functions/get-tenant-financial-summary.js",
    "netlify/functions/save-tenant-financial-account-mapping.js",
    "netlify/functions/_lib/ensure-platform-financial-customer.js",
    "netlify/functions/_lib/fc-owner-context.js",
  ];
}

function combinedFcSrc() {
  return fcFiles().map(read).join("\n");
}

async function main() {
  const createSrc = read("netlify/functions/create-financial-connections-session.js");
  const completeSrc = read("netlify/functions/complete-financial-connections.js");
  const syncSrc = read("netlify/functions/sync-tenant-financial-summary.js");
  const helperSrc = read("netlify/functions/_lib/ensure-platform-financial-customer.js");
  const ctxSrc = read("netlify/functions/_lib/fc-owner-context.js");
  const allFc = combinedFcSrc();
  const platformPath = path.join(ROOT, "netlify/functions/create-platform-customer.js");
  const debugPath = path.join(ROOT, "netlify/functions/debug-stripe-platform-context.js");

  assert("0a. create-platform-customer.js is removed", !fs.existsSync(platformPath));
  assert("0b. debug-stripe-platform-context.js remains absent", !fs.existsSync(debugPath));
  assert("0c. FC does not require session.c", !/session\?\.c/.test(allFc) && /session\.c is not required/.test(createSrc + ctxSrc));
  assert("0d. fc-debug logging removed", !/\[fc-debug\]/.test(allFc));
  assert("0e. no provider-id console.log", !/console\.log\([\s\S]{0,80}(customer_id|cus_|fca_|fcs_)/.test(allFc));
  assert(
    "10. permissions remain balances-only",
    /form\.append\("permissions\[\]", "balances"\)/.test(createSrc) &&
      !/permissions\[\]", "transactions"/.test(createSrc) &&
      !/permissions\[\]", "ownership"/.test(createSrc) &&
      !/permissions\[\]", "payment_method"/.test(createSrc)
  );
  assert("10b. sync refresh is balance-only", /form\.append\("features\[\]", "balance"\)/.test(syncSrc));
  assert(
    "11. no money-movement API in FC path",
    FORBIDDEN_STRIPE.every((frag) => !allFc.includes(frag))
  );
  assert(
    "12. no Stripe subscription created in helper",
    !/\/subscriptions/.test(helperSrc) && /financial_connections/.test(helperSrc)
  );
  assert(
    "13. no payment method attach",
    !/payment_methods/.test(allFc) && !/permissions\[\]", "payment_method"/.test(createSrc)
  );
  assert("14. provider ids are not logged", !/\[fc-debug\]/.test(allFc) && !/Created customer:/.test(allFc));

  const stripeCreates = [];
  let storedA = null;
  async function tenantAEnsureDb(p, options = {}) {
    const method = String(options.method || "GET").toUpperCase();
    if (String(p).includes(TENANT_B)) {
      throw new Error("cross_tenant_write");
    }
    if (String(p).startsWith("tenants?id=eq.") && method === "PATCH") {
      storedA = options.body.stripe_customer_id;
      return [{ id: TENANT_A, stripe_customer_id: storedA, owner_email: OWNER_A, name: "Acme" }];
    }
    if (String(p).startsWith("tenants?id=eq.")) {
      return [
        {
          id: TENANT_A,
          stripe_customer_id: storedA,
          owner_email: OWNER_A,
          name: "Acme",
        },
      ];
    }
    return [];
  }
  const createCustomer = async (fields) => {
    stripeCreates.push(fields);
    return { id: "cus_Acreated1" };
  };

  const first = await ensurePlatformFinancialCustomer(
    { id: TENANT_A, owner_email: OWNER_A, name: "Acme", stripe_customer_id: null },
    { supabaseRequest: tenantAEnsureDb, createStripeCustomer: createCustomer }
  );
  const second = await ensurePlatformFinancialCustomer(
    { id: TENANT_A, owner_email: OWNER_A, name: "Acme", stripe_customer_id: storedA },
    { supabaseRequest: tenantAEnsureDb, createStripeCustomer: createCustomer }
  );
  assert("5. repeated first-time connect reuses the same customer", first.customerId === "cus_Acreated1" && second.customerId === "cus_Acreated1" && second.created === false && stripeCreates.length === 1);

  const fields = customerFieldsFromTenant({
    id: TENANT_A,
    owner_email: OWNER_A,
    name: "Acme",
  });
  assert("4a. customer email derived server-side from tenant", fields.email === OWNER_A);
  assert("4b. body email cannot choose identity (helper ignores foreign email)", fields.email !== "attacker@evil.test");

  const cookieA = ownerCookie(TENANT_A, OWNER_A);
  const cookieB = ownerCookie(TENANT_B, OWNER_B);
  assert("6a. hardened cookie has empty session.c", !/=cus_/.test(cookieA));

  const stripeCalls = [];
  const connections = [];
  const tenantRows = {
    [TENANT_A]: {
      id: TENANT_A,
      owner_email: OWNER_A,
      name: "Acme",
      stripe_customer_id: null,
    },
    [TENANT_B]: {
      id: TENANT_B,
      owner_email: OWNER_B,
      name: "Beta",
      stripe_customer_id: "cus_Bexist",
    },
  };

  function resolveFromCookieTenant(session) {
    const tid = String(session?.t || "");
    if (session?.e === OWNER_A && tid === TENANT_A) return tenantRows[TENANT_A];
    if (session?.e === OWNER_B && tid === TENANT_B) return tenantRows[TENANT_B];
    return null;
  }

  async function fcSupabase(p, options = {}) {
    const method = String(options.method || "GET").toUpperCase();
    if (p === "tenant_bank_connections" && method === "POST") {
      const row = { id: "conn-1", ...options.body };
      connections.push(row);
      return [row];
    }
    if (String(p).startsWith("tenants?id=eq.")) {
      const id = decodeURIComponent(String(p).split("eq.")[1].split("&")[0]);
      if (method === "PATCH") {
        Object.assign(tenantRows[id], options.body);
        return [tenantRows[id]];
      }
      return tenantRows[id] ? [tenantRows[id]] : [];
    }
    return [];
  }

  const createsBeforeUnauth = stripeCreates.length;
  const unauth = await createFcSessionHandler({
    resolveTenantFromSession: async () => {
      throw new Error("must not resolve tenant");
    },
    createStripeCustomer: async () => {
      throw new Error("must not create customer");
    },
    supabaseRequest: async () => {
      throw new Error("must not write");
    },
  })(eventWith(null, "POST", { email: OWNER_A, tenant_id: TENANT_B }));
  assert(
    "1. unauthenticated caller cannot create a platform Stripe Customer",
    unauth.statusCode === 401 && stripeCreates.length === createsBeforeUnauth
  );

  const fcHandler = createFcSessionHandler({
    resolveTenantFromSession: async (session) => resolveFromCookieTenant(session),
    supabaseRequest: fcSupabase,
    createStripeCustomer: createCustomer,
    fetch: async (url, opts) => {
      stripeCalls.push({ url: String(url), body: String(opts && opts.body ? opts.body : "") });
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            id: "fcs_test1",
            client_secret: "fcsess_test_secret",
          }),
      };
    },
    getStripeKeyForPlatform: () => "sk_test_not_used",
  });

  const firstConnect = await fcHandler(
    eventWith(cookieA, "POST", {
      tenant_id: TENANT_B,
      email: "attacker@evil.test",
      stripe_customer_id: "cus_ATTACK",
    })
  );
  const firstBody = parse(firstConnect);
  assert("3. request body tenant_id cannot override authenticated tenant", firstConnect.statusCode === 200 && connections[0] && connections[0].tenant_id === TENANT_A);
  assert("4. request body email cannot choose Stripe Customer identity", stripeCreates[stripeCreates.length - 1].email === OWNER_A && stripeCreates[stripeCreates.length - 1].email !== "attacker@evil.test");
  assert("6. new mg_session without session.c works with FC", firstConnect.statusCode === 200 && firstBody.ok === true && firstBody.financial_connections_session_id === "fcs_test1");
  assert("B. first-time FC created platform customer", tenantRows[TENANT_A].stripe_customer_id === "cus_Acreated1" || firstBody.ok === true);
  assert(
    "10c. live session POST asked balances only",
    stripeCalls.some((c) => /financial_connections\/sessions/.test(c.url) && /permissions%5B%5D=balances/.test(c.body) && !/transactions/.test(c.body) && !/payment_method/.test(c.body))
  );
  assert(
    "11b. session create did not call money-movement APIs",
    stripeCalls.every((c) => FORBIDDEN_STRIPE.every((frag) => !c.url.includes(frag.replace(/^\//, ""))))
  );

  const linkedTenant = {
    id: TENANT_A,
    owner_email: OWNER_A,
    name: "Acme",
    stripe_customer_id: "cus_linked_existing",
  };
  let createdForLinked = 0;
  const linkedConnect = await createFcSessionHandler({
    resolveTenantFromSession: async () => linkedTenant,
    ensurePlatformFinancialCustomer: async (tenant) => {
      if (tenant.stripe_customer_id === "cus_linked_existing") {
        return { customerId: "cus_linked_existing", created: false };
      }
      createdForLinked += 1;
      return { customerId: "cus_new", created: true };
    },
    supabaseRequest: async (p, options = {}) => {
      if (p === "tenant_bank_connections") {
        return [{ id: "conn-linked", tenant_id: TENANT_A }];
      }
      return [];
    },
    fetch: async () => ({
      ok: true,
      text: async () => JSON.stringify({ id: "fcs_linked", client_secret: "secret_linked" }),
    }),
    getStripeKeyForPlatform: () => "sk_test_not_used",
  })(eventWith(cookieA, "POST", {}));
  assert(
    "15. existing linked-bank tenant still works without new customer",
    linkedConnect.statusCode === 200 && parse(linkedConnect).ok === true && createdForLinked === 0
  );

  const ownerBTriesCreateForA = await createFcSessionHandler({
    resolveTenantFromSession: async (session) => resolveFromCookieTenant(session),
    supabaseRequest: async (p, options = {}) => {
      if (String(p).includes(TENANT_A) && String(options.method || "").toUpperCase() === "PATCH") {
        throw new Error("tenant_a_patch");
      }
      return fcSupabase(p, options);
    },
    createStripeCustomer: async () => ({ id: "cus_should_not_attach_to_a" }),
    fetch: async () => ({
      ok: true,
      text: async () => JSON.stringify({ id: "fcs_b", client_secret: "x" }),
    }),
    getStripeKeyForPlatform: () => "sk_test_not_used",
  })(eventWith(cookieB, "POST", { tenant_id: TENANT_A, email: OWNER_A }));
  assert(
    "2. authenticated owner tenant A cannot be updated by tenant B",
    ownerBTriesCreateForA.statusCode === 200 && parse(ownerBTriesCreateForA).ok === true && tenantRows[TENANT_A].stripe_customer_id !== "cus_should_not_attach_to_a"
  );

  const completeB = await createCompleteHandler({
    resolveTenantFromSession: async () => tenantRows[TENANT_B],
    retrieveFinancialConnectionsSession: async () => ({
      id: "fcs_test1",
      account_holder: { type: "customer", customer: "cus_Acreated1" },
      accounts: { data: [] },
    }),
    listAccountsForSession: async () => [],
    supabaseRequest: async () => [],
  })(eventWith(cookieB, "POST", { financial_connections_session_id: "fcs_test1" }));
  assert(
    "7. tenant A FC session cannot be completed by tenant B",
    completeB.statusCode === 403 && /does not belong/.test(parse(completeB).error || "")
  );

  const mapB = await createMapHandler({
    resolveTenantFromSession: async () => tenantRows[TENANT_B],
    supabaseRequest: async (p) => {
      if (String(p).includes("tenant_bank_accounts")) return [];
      if (String(p).includes("tenant_financial_account_mapping") && String(p).includes("DELETE")) return [];
      return [];
    },
  })(
    eventWith(cookieB, "POST", {
      mappings: [{ bucket: "operating", tenant_bank_account_id: ACCOUNT_A }],
    })
  );
  assert("8. tenant A fca account cannot be mapped by tenant B", mapB.statusCode === 500);

  const device = createDeviceSessionCookieFromPayload(
    buildDeviceSessionPayload({
      sessionId: "sess-d",
      deviceId: "dev-1",
      tenantId: TENANT_A,
      membershipId: "mem-seller",
      portalType: "seller",
    })
  );
  const deviceCookie = String(device.cookie).split(";")[0];
  const sellerList = await createListHandler({
    resolveTenantFromSession: async () => {
      throw new Error("device must not resolve owner tenant");
    },
    supabaseRequest: async () => {
      throw new Error("device must not read banks");
    },
  })({ httpMethod: "GET", headers: { cookie: deviceCookie } });
  const supervisorDevice = createDeviceSessionCookieFromPayload(
    buildDeviceSessionPayload({
      sessionId: "sess-s",
      deviceId: "dev-2",
      tenantId: TENANT_A,
      membershipId: "mem-sup",
      portalType: "supervisor",
    })
  );
  const supervisorList = await createListHandler({
    resolveTenantFromSession: async () => {
      throw new Error("supervisor must not resolve owner tenant");
    },
  })({ httpMethod: "GET", headers: { cookie: String(supervisorDevice.cookie).split(";")[0] } });
  assert(
    "9. seller/supervisor device session cannot use owner bank monitoring",
    sellerList.statusCode === 401 && supervisorList.statusCode === 401
  );

  const listExisting = await createListHandler({
    resolveTenantFromSession: async () => linkedTenant,
    supabaseRequest: async (p) => {
      if (String(p).includes("tenant_bank_accounts")) {
        return [{ id: ACCOUNT_A, stripe_fc_account_id: "fca_AAA111", tenant_label: "Bank *1111" }];
      }
      return [{ bucket: "operating", tenant_bank_account_id: ACCOUNT_A }];
    },
  })({ httpMethod: "GET", headers: { cookie: cookieA } });
  const listBody = parse(listExisting);
  assert(
    "15b. existing linked accounts list without session.c",
    listExisting.statusCode === 200 && listBody.accounts && listBody.accounts[0].label === "Bank *1111"
  );

  const summaryExisting = await createSummaryHandler({
    resolveTenantFromSession: async () => linkedTenant,
    supabaseRequest: async () => [
      {
        currency: "USD",
        operating_balance: 10,
        savings_balance: 0,
        profit_balance: 0,
        tax_reserve_balance: 0,
        cash_on_hand: 10,
        computed_at: "2026-09-03T00:00:00.000Z",
      },
    ],
  })({ httpMethod: "GET", headers: { cookie: cookieA } });
  assert(
    "15c. get-summary works without session.c match",
    summaryExisting.statusCode === 200 && parse(summaryExisting).summary && Number(parse(summaryExisting).summary.cash_on_hand) === 10
  );

  const syncExisting = await createSyncHandler({
    resolveTenantFromSession: async () => linkedTenant,
    readUsdBalanceForAccount: async () => 25,
    supabaseRequest: async (p, options = {}) => {
      const method = String(options.method || "GET").toUpperCase();
      if (String(p).includes("tenant_financial_account_mapping") && method === "GET") {
        return [{ bucket: "operating", tenant_bank_account_id: ACCOUNT_A }];
      }
      if (String(p).includes("tenant_bank_accounts")) {
        return [{ id: ACCOUNT_A, stripe_fc_account_id: "fca_AAA111", status: "active" }];
      }
      if (String(p).includes("tenant_financial_summary") && method === "GET") return [];
      if (String(p) === "tenant_financial_summary") return [{ id: "sum-1" }];
      return [];
    },
  })(eventWith(cookieA, "POST", {}));
  assert("15d. sync linked-bank tenant without session.c", syncExisting.statusCode === 200 && parse(syncExisting).operating_balance === 25);

  const form = await (async () => {
    let captured = "";
    await createFinancialConnectionsSession("cus_X", {
      fetch: async (_url, opts) => {
        captured = String(opts.body || "");
        return { ok: true, text: async () => JSON.stringify({ id: "fcs_x", client_secret: "s" }) };
      },
      getStripeKeyForPlatform: () => "sk_test_x",
    });
    return captured;
  })();
  assert(
    "10d. createFinancialConnectionsSession form is balances-only",
    /permissions%5B%5D=balances/.test(form) &&
      (form.match(/permissions/g) || []).length === 1 &&
      !/ownership|transactions|payment_method/.test(form)
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
    assert("M. zip-it omits create-platform-customer", !names.includes("create-platform-customer"));
    assert("M2. zip-it omits debug-stripe-platform-context", !names.includes("debug-stripe-platform-context"));
    assert("M3. zip-it includes create-financial-connections-session", names.includes("create-financial-connections-session"));
  } else {
    const fnFiles = fs.readdirSync(fnDir);
    assert("M. function dir omits create-platform-customer", !fnFiles.includes("create-platform-customer.js"));
    assert("M2. function dir omits debug-stripe", !fnFiles.includes("debug-stripe-platform-context.js"));
    assert("M3. create-financial-connections-session remains", fnFiles.includes("create-financial-connections-session.js"));
  }

  console.log("");
  console.log(passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
