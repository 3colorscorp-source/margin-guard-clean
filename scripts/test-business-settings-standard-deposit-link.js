#!/usr/bin/env node
/**
 * Business Settings — provider-agnostic HTTPS Deposit Payment Link.
 * Isolated: no Netlify, Zapier, email, or live Supabase writes.
 * Run: node scripts/test-business-settings-standard-deposit-link.js
 */
"use strict";

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "mg-deposit-link-test-service-role";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function checkSyntax(rel) {
  const r = spawnSync(process.execPath, ["--check", path.join(ROOT, rel)], {
    encoding: "utf8",
  });
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || rel);
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

function jsonOk(body) {
  return {
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify(body);
    },
  };
}

function parse(res) {
  try {
    return JSON.parse(res.body || "{}");
  } catch (_err) {
    return {};
  }
}

function loadDepositLinkModule() {
  const rel = "../netlify/functions/owner-settings-deposit-link";
  delete require.cache[require.resolve(rel)];
  return require(rel);
}

function loadPublicEstimateModule() {
  [
    "../netlify/functions/_lib/supabase-admin",
    "../netlify/functions/_lib/tenant-display",
    "../netlify/functions/get-public-estimate",
  ].forEach((rel) => {
    delete require.cache[require.resolve(rel)];
  });
  return require("../netlify/functions/get-public-estimate");
}

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TOKEN_A = "publictokA123456";
const TOKEN_B = "publictokB123456";
const LINK_A = "https://square.link/u/tenant-a-checkout";
const LINK_B = "https://paypal.me/tenant-b";

function quoteRow(tenantId, token) {
  return {
    id: "quote-" + tenantId.slice(0, 8),
    tenant_id: tenantId,
    public_token: token,
    business_name: "Tenant Co",
    company_name: "",
    business_email: "owner@example.com",
    business_phone: "",
    business_address: "",
    title: "Deposit link isolation",
    project_name: "Deposit link isolation",
    client_name: "Client",
    client_email: "client@example.com",
    client_phone: "",
    project_address: "",
    job_site: "",
    total: 5000,
    currency: "USD",
    deposit_required: 1000,
    notes: "",
    scope_of_work: "",
    terms: "",
    status: "sent",
    accepted_at: null,
    exclusions_initials: "",
    exclusions_acknowledged_at: null,
    change_order_acknowledged_at: null,
    issue_date: "2026-09-05",
    expiration_date: "2026-09-20",
  };
}

function extractPath(url) {
  const s = String(url);
  const idx = s.indexOf("/rest/v1/");
  return idx >= 0 ? s.slice(idx + "/rest/v1/".length) : s;
}

async function withMockedPublicEstimateFetch(fn) {
  const prev = globalThis.fetch;
  const ownerSettingsQueries = [];
  globalThis.fetch = async (url) => {
    const restPath = extractPath(url);
    if (restPath.startsWith("quotes?public_token=eq.")) {
      const token = decodeURIComponent(restPath.split("public_token=eq.")[1].split("&")[0]);
      if (token === TOKEN_A) return jsonOk([quoteRow(TENANT_A, TOKEN_A)]);
      if (token === TOKEN_B) return jsonOk([quoteRow(TENANT_B, TOKEN_B)]);
      return jsonOk([]);
    }
    if (restPath.startsWith("owner_settings?tenant_id=eq.")) {
      const tid = decodeURIComponent(restPath.split("tenant_id=eq.")[1].split("&")[0]);
      ownerSettingsQueries.push(tid);
      if (tid === TENANT_A) return jsonOk([{ deposit_payment_link: LINK_A }]);
      if (tid === TENANT_B) return jsonOk([{ deposit_payment_link: LINK_B }]);
      return jsonOk([{ deposit_payment_link: "https://evil.example/wrong-tenant" }]);
    }
    if (restPath.startsWith("tenants?")) {
      return jsonOk([{ id: TENANT_A, name: "Tenant A Co", stripe_account_id: null, stripe_charges_enabled: false }]);
    }
    if (restPath.startsWith("tenant_branding?") || restPath.startsWith("tenant_snapshots?")) {
      return jsonOk([]);
    }
    return jsonOk([]);
  };
  try {
    return await fn(ownerSettingsQueries);
  } finally {
    globalThis.fetch = prev;
  }
}

function extractStartDepositCheckout(src) {
  const start = src.indexOf("async function startDepositCheckout()");
  assert.ok(start >= 0, "startDepositCheckout present");
  const stripeCall = src.indexOf('fetch("/.netlify/functions/create-project-deposit-session"', start);
  assert.ok(stripeCall > start, "Stripe session fetch still exists as fallback");
  return src.slice(start, stripeCall);
}

async function main() {
  checkSyntax("netlify/functions/owner-settings-deposit-link.js");
  checkSyntax("netlify/functions/get-public-estimate.js");
  ok("syntax owner-settings-deposit-link.js", true);
  ok("syntax get-public-estimate.js", true);

  const { normalizeDepositPaymentLink } = loadDepositLinkModule()._test;
  ok("exports._test.normalizeDepositPaymentLink", typeof normalizeDepositPaymentLink === "function");

  eq("accepts Square HTTPS", normalizeDepositPaymentLink("https://square.link/u/abc").value, "https://square.link/u/abc");
  eq("accepts PayPal HTTPS", normalizeDepositPaymentLink("https://paypal.me/tenantco").value, "https://paypal.me/tenantco");
  eq(
    "accepts Stripe Payment Link HTTPS",
    normalizeDepositPaymentLink("https://buy.stripe.com/test_abc").value,
    "https://buy.stripe.com/test_abc"
  );
  eq(
    "accepts generic HTTPS domain",
    normalizeDepositPaymentLink("https://pay.example-contractor.com/checkout/job-1").value,
    "https://pay.example-contractor.com/checkout/job-1"
  );
  eq("accepts QuickBooks HTTPS", normalizeDepositPaymentLink("https://checkout.quickbooks.com/pay/abc").error, undefined);
  eq("empty string is optional null", normalizeDepositPaymentLink("").value, null);
  eq("whitespace is optional null", normalizeDepositPaymentLink("   ").value, null);
  eq("null is optional null", normalizeDepositPaymentLink(null).value, null);

  ok("rejects HTTP", !!normalizeDepositPaymentLink("http://square.link/u/abc").error);
  ok("rejects javascript:", !!normalizeDepositPaymentLink("javascript:alert(1)").error);
  ok("rejects data:", !!normalizeDepositPaymentLink("data:text/html,hi").error);
  ok("rejects invalid URL", !!normalizeDepositPaymentLink("not a url").error);
  ok("rejects protocol-relative", !!normalizeDepositPaymentLink("//square.link/u/abc").error);
  const tooLong = "https://pay.example.com/" + "a".repeat(2000);
  ok("rejects over 2000 characters", !!normalizeDepositPaymentLink(tooLong).error);

  const fnSrc = read("netlify/functions/owner-settings-deposit-link.js");
  ok("function still stores owner_settings.deposit_payment_link", /deposit_payment_link/.test(fnSrc));
  ok("function still isolates by tenant_id", /owner_settings\?tenant_id=eq\.\$\{encodeURIComponent\(tenantId\)\}/.test(fnSrc));
  ok("no Stripe-only deposit prefix left", !/buy\.stripe\.com/.test(fnSrc));
  ok("does not write deposit_paid_at", !/deposit_paid_at/.test(fnSrc));
  ok("does not alter payment_instructions normalizer max", /slice\(0,\s*8000\)/.test(fnSrc));
  ok("public invoice payment_link still separate", /normalizePublicPaymentLink/.test(fnSrc));

  const bsSrc = read("public/business-settings.html");
  ok("BS keeps Deposit Payment Link label", /<label for="depositPaymentLink">Deposit Payment Link<\/label>/.test(bsSrc));
  ok("BS placeholder is provider-neutral", /placeholder="https:\/\/your-payment-provider\.com\/checkout\/\.\.\."/.test(bsSrc));
  ok(
    "BS help explains optional HTTPS checkout",
    /Optional\. Paste the tenant.s secure HTTPS checkout link\. The client will open this link after completing the approval steps\./.test(
      bsSrc
    )
  );
  ok("BS no longer restricts to buy.stripe.com", !/buy\.stripe\.com/.test(bsSrc));
  ok(
    "BS HTTPS validation error copy",
    /Deposit Payment Link must be empty or a valid HTTPS URL\./.test(bsSrc)
  );
  ok("BS card sub is not Project deposits (Stripe)", !/Project deposits \(Stripe\)/.test(bsSrc));
  ok("BS presents Optional Stripe Connect", />Optional Stripe Connect</.test(bsSrc));
  ok("BS Connect button is optional", />Connect Stripe \(optional\)</.test(bsSrc));
  ok("BS save copy uses enlace de pago del depósito", /enlace de pago del depósito/.test(bsSrc));
  ok("BS save error is not a Stripe session", !/sesion \(Stripe\)/.test(bsSrc));
  ok("BS browser validator requires https:", /u\.protocol === 'https:'/.test(bsSrc));

  const estSrc = read("public/estimate-public.html");
  ok(
    "public estimate no longer requires Stripe",
    !/must connect Stripe/.test(estSrc) &&
      /must add a secure payment link in/.test(estSrc)
  );
  ok("public estimate does not say powered by Stripe", !/powered by Stripe/.test(estSrc));
  ok(
    "public estimate uses contractor provider copy",
    /Payment handled by your contractor.s selected payment provider/.test(estSrc)
  );

  const checkoutHead = extractStartDepositCheckout(estSrc);
  ok(
    "tenant link is opened before Stripe session create",
    /getDepositPaymentLinkFromQuote/.test(checkoutHead) &&
      /window\.location\.href = paymentLink/.test(checkoutHead) &&
      /return;/.test(checkoutHead) &&
      !/create-project-deposit-session/.test(checkoutHead)
  );
  ok(
    "public opener requires https only",
    /u\.protocol !== "https:"/.test(estSrc) && !/u\.protocol !== "http:" && u\.protocol !== "https:"/.test(estSrc)
  );
  ok("opening the link does not set deposit_paid_at", !/deposit_paid_at/.test(checkoutHead));

  const pubEstSrc = read("netlify/functions/get-public-estimate.js");
  ok(
    "get-public-estimate still selects deposit_payment_link by tenant_id",
    /owner_settings\?tenant_id=eq\.\$\{encodeURIComponent\(String\(tenantId\)\)\}&select=deposit_payment_link/.test(
      pubEstSrc
    )
  );
  ok("get-public-estimate still returns deposit_payment_link", /deposit_payment_link: ownerSettings\?\.deposit_payment_link/.test(pubEstSrc));

  await withMockedPublicEstimateFetch(async (queries) => {
    const { handler } = loadPublicEstimateModule();
    const resA = await handler({
      httpMethod: "GET",
      queryStringParameters: { token: TOKEN_A },
    });
    const bodyA = parse(resA);
    eq("public estimate A status 200", resA.statusCode, 200);
    eq("public estimate A returns tenant A link", bodyA.estimate?.deposit_payment_link, LINK_A);
    ok("public estimate A queried owner_settings for tenant A", queries.includes(TENANT_A));

    const resB = await handler({
      httpMethod: "GET",
      queryStringParameters: { token: TOKEN_B },
    });
    const bodyB = parse(resB);
    eq("public estimate B status 200", resB.statusCode, 200);
    eq("public estimate B returns tenant B link", bodyB.estimate?.deposit_payment_link, LINK_B);
    ok("public estimate B did not receive tenant A link", bodyB.estimate?.deposit_payment_link !== LINK_A);
  });

  console.log("\n" + passed + " passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
