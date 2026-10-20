#!/usr/bin/env node
/**
 * Scheduling-deposit maintenance guard.
 * Isolated: no live Stripe, Supabase, email, or Netlify.
 * Run: node scripts/test-scheduling-deposit-maintenance.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const prevFlag = process.env.SCHEDULING_DEPOSIT_CHECKOUT_ENABLED;

process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "mg-scheduling-maintenance-test-key";
process.env.STRIPE_SECRET_KEY = "sk_test_scheduling_maintenance";
process.env.URL = "https://example.test";
delete process.env.STRIPE_PLATFORM_SECRET_KEY;

const calls = [];
let blockFetch = false;

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body);
    },
  };
}

globalThis.fetch = async (url, opts) => {
  const entry = {
    url: String(url),
    method: String((opts && opts.method) || "GET").toUpperCase(),
  };
  calls.push(entry);
  if (blockFetch) {
    throw new Error("fetch blocked: " + entry.method + " " + entry.url);
  }
  if (entry.url.includes("api.stripe.com")) {
    if (entry.method === "POST") {
      return jsonResponse(200, {
        id: "cs_test_maintenance_new",
        url: "https://checkout.stripe.com/c/pay/cs_test_maintenance_new",
      });
    }
    return jsonResponse(200, {
      id: "cs_test_maintenance_existing",
      payment_status: "unpaid",
      status: "open",
    });
  }
  if (entry.url.includes("/rest/v1/quotes")) {
    return jsonResponse(200, [
      {
        id: "quote-maintenance",
        tenant_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        public_token: "publictokMaintenance",
        deposit_required: 1000,
        project_name: "Maintenance fixture",
        title: "Maintenance fixture",
        client_name: "Client",
        client_email: "client@example.com",
        accepted_at: "2026-04-22T12:00:00.000Z",
        exclusions_initials: "AB",
        exclusions_acknowledged_at: "2026-04-22T12:00:00.000Z",
        change_order_acknowledged_at: "2026-04-22T12:00:00.000Z",
        business_name: "Tenant Co",
        company_name: "",
        business_email: "owner@example.com",
        business_phone: "",
        business_address: "",
        client_phone: "",
        project_address: "",
        job_site: "",
        total: 5000,
        currency: "USD",
        notes: "",
        scope_of_work: "",
        terms: "",
        status: "accepted",
        issue_date: "2026-04-22",
        expiration_date: "2026-05-22",
      },
    ]);
  }
  if (entry.url.includes("/rest/v1/owner_settings")) {
    return jsonResponse(200, [{ deposit_payment_link: "https://pay.example.test/scheduling" }]);
  }
  if (entry.url.includes("/rest/v1/tenants")) {
    return jsonResponse(200, [
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        name: "Tenant Co",
        stripe_account_id: "acct_test_maintenance",
        stripe_charges_enabled: true,
      },
    ]);
  }
  if (entry.url.includes("/rest/v1/tenant_projects")) {
    return jsonResponse(200, [
      {
        id: "project-maintenance",
        tenant_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        quote_id: "quote-maintenance",
        status: "signed",
        deposit_paid: false,
      },
    ]);
  }
  return jsonResponse(200, []);
};

const auto = require("../netlify/functions/_lib/deposit-post-automation");
let emailCalls = 0;
auto.runDepositPostAutomation = async () => {
  emailCalls += 1;
};

function loadFresh(rel) {
  delete require.cache[require.resolve(rel)];
  return require(rel);
}

[
  "../netlify/functions/_lib/supabase-admin",
  "../netlify/functions/_lib/tenant-display",
  "../netlify/functions/_lib/scheduling-deposit-maintenance",
  "../netlify/functions/create-project-deposit-session",
  "../netlify/functions/finalize-project-deposit",
  "../netlify/functions/get-public-estimate",
].forEach((rel) => {
  delete require.cache[require.resolve(rel)];
});

const maintenance = require("../netlify/functions/_lib/scheduling-deposit-maintenance");
const createSession = require("../netlify/functions/create-project-deposit-session");
const finalizeDeposit = require("../netlify/functions/finalize-project-deposit");
const getPublicEstimate = loadFresh("../netlify/functions/get-public-estimate");

let passed = 0;
function ok(label, cond) {
  assert.ok(cond, label);
  passed += 1;
  console.log("PASS " + label);
}
function eq(label, actual, expected) {
  assert.strictEqual(actual, expected, label + " expected " + JSON.stringify(expected) + " got " + JSON.stringify(actual));
  passed += 1;
  console.log("PASS " + label);
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function parse(res) {
  return JSON.parse(res.body || "{}");
}

function setFlag(value) {
  if (value === undefined) delete process.env.SCHEDULING_DEPOSIT_CHECKOUT_ENABLED;
  else process.env.SCHEDULING_DEPOSIT_CHECKOUT_ENABLED = value;
}

function resetCalls() {
  calls.length = 0;
  emailCalls = 0;
  blockFetch = false;
}

function stripeCalls() {
  return calls.filter((c) => c.url.includes("api.stripe.com"));
}

function walkJs(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) walkJs(abs, out);
    else if (name.endsWith(".js")) out.push(abs);
  }
  return out;
}

async function main() {
  setFlag(undefined);
  eq("absent flag leaves checkout open", maintenance.schedulingDepositCheckoutClosed(), false);
  setFlag("false");
  eq("false closes checkout", maintenance.schedulingDepositCheckoutClosed(), true);
  setFlag(" FALSE ");
  eq("trimmed false closes checkout", maintenance.schedulingDepositCheckoutClosed(), true);
  for (const openValue of [undefined, "", "true", "TRUE", "1"]) {
    setFlag(openValue);
    eq("open when flag is " + JSON.stringify(openValue), maintenance.schedulingDepositCheckoutClosed(), false);
  }

  const checkoutBody = {
    public_token: "publictokMaintenance",
    project_name: "Maintenance fixture",
    customer_name: "Client",
    client_email: "client@example.com",
    deposit_required: 1000,
  };

  setFlag("false");
  resetCalls();
  blockFetch = true;
  const blockedCreate = parse(
    await createSession.handler({
      httpMethod: "POST",
      headers: {},
      body: JSON.stringify(checkoutBody),
    })
  );
  eq("maintenance create status implied by code", blockedCreate.code, "scheduling_deposit_maintenance");
  eq("maintenance create ok", blockedCreate.ok, false);
  eq("maintenance create copy", blockedCreate.error, maintenance.MAINTENANCE_PUBLIC_COPY);
  eq("maintenance create makes no fetch", calls.length, 0);
  eq("maintenance create makes no Stripe call", stripeCalls().length, 0);

  setFlag(undefined);
  resetCalls();
  const missingToken = parse(
    await createSession.handler({
      httpMethod: "POST",
      headers: {},
      body: JSON.stringify({ project_name: "Maintenance fixture" }),
    })
  );
  eq("open create still requires public token", missingToken.error, "Missing public_token");
  ok("open create is not the maintenance code", missingToken.code !== "scheduling_deposit_maintenance");
  eq("missing token does not call Stripe", stripeCalls().length, 0);

  setFlag("true");
  resetCalls();
  const openCreate = parse(
    await createSession.handler({
      httpMethod: "POST",
      headers: {},
      body: JSON.stringify(checkoutBody),
    })
  );
  eq("enabled create still returns a session", openCreate.ok, true);
  eq("enabled create session id", openCreate.session_id, "cs_test_maintenance_new");
  eq("enabled create calls Stripe once", stripeCalls().length, 1);
  eq("enabled create Stripe method", stripeCalls()[0].method, "POST");
  ok("enabled create is not maintenance", openCreate.code !== "scheduling_deposit_maintenance");

  setFlag("false");
  resetCalls();
  const blockedFinalize = await finalizeDeposit.handler({
    httpMethod: "POST",
    headers: {},
    body: JSON.stringify({ sessionId: "cs_test_already_paid", public_token: "publictokMaintenance" }),
  });
  const blockedFinalizeBody = parse(blockedFinalize);
  eq("closed finalize stays available", blockedFinalize.statusCode, 400);
  eq("closed finalize uses verified unpaid result", blockedFinalizeBody.code, "stripe_not_paid");
  ok("closed finalize is not the maintenance pause", blockedFinalizeBody.code !== "scheduling_deposit_maintenance");
  ok("closed finalize has no redirect", blockedFinalizeBody.redirect_url === undefined);
  ok("closed finalize does not mark deposit paid", !String(blockedFinalize.body).includes("deposit=paid"));
  eq("closed finalize reads Stripe", stripeCalls().length, 1);
  eq("closed finalize sends no email", emailCalls, 0);
  eq("closed finalize does not patch quotes", calls.filter((c) => c.method === "PATCH").length, 0);

  const blockedCreateRes = await createSession.handler({
    httpMethod: "POST",
    headers: {},
    body: JSON.stringify(checkoutBody),
  });
  eq("maintenance create status code", blockedCreateRes.statusCode, 503);

  setFlag(undefined);
  resetCalls();
  const openFinalize = await finalizeDeposit.handler({
    httpMethod: "POST",
    headers: {},
    body: JSON.stringify({ sessionId: "cs_test_maintenance_existing", public_token: "publictokMaintenance" }),
  });
  const openFinalizeBody = parse(openFinalize);
  eq("open finalize still reads Stripe", stripeCalls().length, 1);
  eq("open finalize Stripe method", stripeCalls()[0].method, "GET");
  eq("open unpaid finalize stays unrecorded", openFinalizeBody.code, "stripe_not_paid");
  ok("open finalize is not maintenance", openFinalizeBody.code !== "scheduling_deposit_maintenance");
  eq("open unpaid finalize sends no email", emailCalls, 0);
  eq(
    "open unpaid finalize does not patch quotes",
    calls.filter((c) => c.method === "PATCH").length,
    0
  );

  async function publicEstimate() {
    resetCalls();
    const res = await getPublicEstimate.handler({
      httpMethod: "GET",
      headers: {},
      queryStringParameters: { token: "publictokMaintenance" },
    });
    return { status: res.statusCode, body: parse(res) };
  }

  const hiddenLink = "https://pay.example.test/scheduling";
  setFlag("false");
  const closedPublic = await publicEstimate();
  eq("closed public status", closedPublic.status, 200);
  eq("closed public checkout flag", closedPublic.body.estimate.scheduling_deposit_checkout_enabled, false);
  eq("closed public hides the external link", closedPublic.body.estimate.deposit_payment_link, null);
  eq("closed public reports deposit payment unavailable", closedPublic.body.estimate.deposit_payment_available, false);
  eq("closed public still reports the unpaid verification state", closedPublic.body.estimate.deposit_verification_state, "unpaid");
  ok("closed public payload does not contain the external link", !JSON.stringify(closedPublic.body).includes(hiddenLink));
  eq("closed public does not call Stripe", stripeCalls().length, 0);

  setFlag(" FALSE ");
  const trimmedClosedPublic = await publicEstimate();
  eq("trimmed false hides the external link", trimmedClosedPublic.body.estimate.deposit_payment_link, null);
  eq("trimmed false reports deposit payment unavailable", trimmedClosedPublic.body.estimate.deposit_payment_available, false);
  ok(
    "trimmed false payload does not contain the external link",
    !JSON.stringify(trimmedClosedPublic.body).includes(hiddenLink)
  );

  setFlag(undefined);
  const openPublic = await publicEstimate();
  eq("open public checkout flag", openPublic.body.estimate.scheduling_deposit_checkout_enabled, true);
  eq("open public still returns external link", openPublic.body.estimate.deposit_payment_link, hiddenLink);
  eq("open public still reports a payment path", openPublic.body.estimate.deposit_payment_available, true);

  setFlag("true");
  const enabledPublic = await publicEstimate();
  eq("enabled public checkout flag", enabledPublic.body.estimate.scheduling_deposit_checkout_enabled, true);
  eq("enabled public still returns external link", enabledPublic.body.estimate.deposit_payment_link, hiddenLink);
  eq("enabled public still reports a payment path", enabledPublic.body.estimate.deposit_payment_available, true);

  const helperSrc = read("netlify/functions/_lib/scheduling-deposit-maintenance.js");
  ok(
    "helper documents that an existing Checkout Session stays payable",
    helperSrc.includes("Stripe Checkout Session that was already") &&
      helperSrc.includes("already shared")
  );
  ok(
    "helper keeps verified reconciliation available while checkout is closed",
    helperSrc.includes("verified") && helperSrc.includes("already-paid Stripe session")
  );

  const html = read("public/estimate-public.html");
  const start = html.indexOf("async function startDepositCheckout()");
  const stripeCall = html.indexOf('fetch("/.netlify/functions/create-project-deposit-session"', start);
  const slice = html.slice(start, stripeCall);
  const flagCheck = slice.indexOf("scheduling_deposit_checkout_enabled === false");
  const linkLookup = slice.indexOf("getDepositPaymentLinkFromQuote(quote)");
  ok("public checkout checks maintenance", flagCheck >= 0);
  ok("maintenance check is before the external link", flagCheck < linkLookup);
  ok("external link redirect remains before Stripe", slice.includes("window.location.href = paymentLink"));
  ok("external link still returns before Stripe", slice.includes("return"));
  ok("maintenance slice does not call checkout", !slice.includes("create-project-deposit-session"));
  ok("public copy says temporarily unavailable", html.includes("temporarily unavailable"));
  ok("public copy does not claim a missed payment", html.includes("does not mean a payment was missed"));
  ok("paid local state still says payment received", html.includes("Initial Scheduling Payment received. Project scheduling reserved."));
  ok("page does not read the server env flag", !html.includes("SCHEDULING_DEPOSIT_CHECKOUT_ENABLED"));

  const createSrc = read("netlify/functions/create-project-deposit-session.js");
  const finalizeSrc = read("netlify/functions/finalize-project-deposit.js");
  const createHandler = createSrc.indexOf("exports.handler");
  const finalizeHandler = finalizeSrc.indexOf("exports.handler");
  ok(
    "verified finalize is not paused by the maintenance flag",
    finalizeSrc.includes("record_verified_scheduling_deposit") &&
      finalizeSrc.includes("already-paid Stripe session") &&
      !finalizeSrc.includes("schedulingDepositCheckoutClosed") &&
      !finalizeSrc.includes("function patchQuote")
  );
  ok(
    "create stops before Stripe key lookup",
    createSrc.indexOf("schedulingDepositCheckoutClosed()", createHandler) <
      createSrc.indexOf("getStripeKey()", createHandler)
  );
  ok(
    "verified finalize emails only a new applied credit",
    finalizeSrc.indexOf('recorded.outcome === "applied_new"', finalizeHandler) <
      finalizeSrc.indexOf("runDepositPostAutomation(", finalizeHandler)
  );

  const readers = walkJs(path.join(ROOT, "netlify", "functions"), [])
    .filter((abs) => fs.readFileSync(abs, "utf8").includes("SCHEDULING_DEPOSIT_CHECKOUT_ENABLED"))
    .map((abs) => path.relative(ROOT, abs).replace(/\\/g, "/"));
  eq(
    "only the helper reads the maintenance env flag",
    readers.join("|"),
    "netlify/functions/_lib/scheduling-deposit-maintenance.js"
  );
  const usingHelper = walkJs(path.join(ROOT, "netlify", "functions"), [])
    .filter((abs) => fs.readFileSync(abs, "utf8").includes("scheduling-deposit-maintenance"))
    .map((abs) => path.relative(ROOT, abs).replace(/\\/g, "/"))
    .sort();
  eq(
    "maintenance helper is wired only to scheduling deposit",
    usingHelper.join("|"),
    [
      "netlify/functions/create-project-deposit-session.js",
      "netlify/functions/get-public-estimate.js",
    ].join("|")
  );

  for (const rel of [
    "netlify/functions/create-invoice-checkout-session.js",
    "netlify/functions/stripe-invoice-webhook.js",
    "netlify/functions/record-tenant-payment.js",
  ]) {
    const src = read(rel);
    ok(rel + " ignores scheduling maintenance", !src.includes("SCHEDULING_DEPOSIT_CHECKOUT_ENABLED"));
    ok(rel + " does not import the maintenance helper", !src.includes("scheduling-deposit-maintenance"));
  }

  console.log("scheduling deposit maintenance tests passed: " + passed);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    if (prevFlag === undefined) delete process.env.SCHEDULING_DEPOSIT_CHECKOUT_ENABLED;
    else process.env.SCHEDULING_DEPOSIT_CHECKOUT_ENABLED = prevFlag;
  });
