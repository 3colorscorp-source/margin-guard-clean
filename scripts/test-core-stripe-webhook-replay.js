#!/usr/bin/env node
/**
 * Core Security — local Stripe invoice webhook anti-replay window.
 * Isolated dummy secret only. Does not log body, signature, secret, or money.
 * Run: node scripts/test-core-stripe-webhook-replay.js
 */
"use strict";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET || "mg-core-stripe-replay-test-secret";
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "mg-core-stripe-replay-test-key";
process.env.STRIPE_INVOICE_WEBHOOK_SECRET = "mg-core-stripe-whsec-dummy";
process.env.STRIPE_WEBHOOK_SECRET = "";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SECRET = process.env.STRIPE_INVOICE_WEBHOOK_SECRET;
const NOW_MS = 1700000000000;
const NOW_SEC = Math.floor(NOW_MS / 1000);
const BODY = JSON.stringify({ type: "ping" });

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

function stripeSign(rawBody, secret, t) {
  const payload = String(t) + "." + String(rawBody);
  return crypto.createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

function loadStripe() {
  delete require.cache[require.resolve("../netlify/functions/stripe-invoice-webhook")];
  const mod = require("../netlify/functions/stripe-invoice-webhook");
  mod._test.setNowMs(NOW_MS);
  return mod;
}

function sigHeader(t, v1List) {
  const parts = ["t=" + String(t)];
  (Array.isArray(v1List) ? v1List : [v1List]).forEach((v) => {
    parts.push("v1=" + String(v));
  });
  return parts.join(",");
}

async function post(stripe, opts) {
  const headers = Object.assign({}, opts.headers || {});
  if (opts.signatureHeader != null) {
    headers["stripe-signature"] = opts.signatureHeader;
  }
  return stripe.handler({
    httpMethod: "POST",
    headers,
    queryStringParameters: opts.query || {},
    body: opts.body == null ? BODY : opts.body,
    isBase64Encoded: Boolean(opts.isBase64Encoded),
  });
}

async function main() {
  const stripe = loadStripe();
  const inWindow = stripeSign(BODY, SECRET, NOW_SEC);

  const valid = await post(stripe, {
    signatureHeader: sigHeader(NOW_SEC, inWindow),
  });
  eq("valid signature inside 300s window is 200", valid.statusCode, 200);

  const pastEdgeT = NOW_SEC - 300;
  const pastEdge = await post(stripe, {
    signatureHeader: sigHeader(pastEdgeT, stripeSign(BODY, SECRET, pastEdgeT)),
  });
  eq("signature exactly 300s in the past is 200", pastEdge.statusCode, 200);

  const futureEdgeT = NOW_SEC + 300;
  const futureEdge = await post(stripe, {
    signatureHeader: sigHeader(futureEdgeT, stripeSign(BODY, SECRET, futureEdgeT)),
  });
  eq("signature exactly 300s in the future is 200", futureEdge.statusCode, 200);

  const expiredT = NOW_SEC - 301;
  const expired = await post(stripe, {
    signatureHeader: sigHeader(expiredT, stripeSign(BODY, SECRET, expiredT)),
  });
  eq("replay older than 300s is 400", expired.statusCode, 400);

  const futureT = NOW_SEC + 301;
  const future = await post(stripe, {
    signatureHeader: sigHeader(futureT, stripeSign(BODY, SECRET, futureT)),
  });
  eq("timestamp more than 300s in the future is 400", future.statusCode, 400);

  const missingT = await post(stripe, {
    signatureHeader: "v1=" + inWindow,
  });
  eq("missing t= is 400", missingT.statusCode, 400);

  const emptyT = await post(stripe, {
    signatureHeader: "t=,v1=" + stripeSign(BODY, SECRET, ""),
  });
  eq("empty t= is 400", emptyT.statusCode, 400);

  const lettersT = await post(stripe, {
    signatureHeader: "t=abc,v1=" + stripeSign(BODY, SECRET, "abc"),
  });
  eq("non-numeric t= is 400", lettersT.statusCode, 400);

  const floatT = await post(stripe, {
    signatureHeader: "t=" + NOW_SEC + ".5,v1=" + stripeSign(BODY, SECRET, NOW_SEC + ".5"),
  });
  eq("fractional t= is 400", floatT.statusCode, 400);

  const junk = "00".repeat(32);
  const multi = await post(stripe, {
    signatureHeader:
      "t=" +
      NOW_SEC +
      ",v0=not-used,v1=" +
      junk +
      ",v1=" +
      inWindow,
  });
  eq("one valid v1 among several is 200", multi.statusCode, 200);

  const allBad = await post(stripe, {
    signatureHeader: sigHeader(NOW_SEC, [junk, "11".repeat(32)]),
  });
  eq("several invalid v1 values are 400", allBad.statusCode, 400);

  const altered = await post(stripe, {
    signatureHeader: sigHeader(NOW_SEC, inWindow),
    body: BODY.replace("ping", "pong"),
  });
  eq("altered body is 400", altered.statusCode, 400);

  const headerBypass = await post(stripe, {
    signatureHeader: sigHeader(expiredT, stripeSign(BODY, SECRET, expiredT)),
    headers: {
      "x-now": String(expiredT * 1000),
      "x-stripe-now": String(expiredT * 1000),
      "stripe-now": String(expiredT),
    },
    query: { now: String(expiredT), tolerance: "999999", t: String(NOW_SEC) },
  });
  eq("headers/query cannot bypass replay window", headerBypass.statusCode, 400);

  const prevInvoice = process.env.STRIPE_INVOICE_WEBHOOK_SECRET;
  const prevWebhook = process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.STRIPE_INVOICE_WEBHOOK_SECRET;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  let missingSecret;
  try {
    const stripeNoSecret = loadStripe();
    missingSecret = await post(stripeNoSecret, {
      signatureHeader: sigHeader(NOW_SEC, stripeSign(BODY, SECRET, NOW_SEC)),
    });
  } finally {
    process.env.STRIPE_INVOICE_WEBHOOK_SECRET = prevInvoice;
    process.env.STRIPE_WEBHOOK_SECRET = prevWebhook == null ? "" : prevWebhook;
    loadStripe();
  }
  eq("missing webhook secret is 500", missingSecret.statusCode, 500);
  eq(
    "missing secret does not mention financial fields",
    String(missingSecret.body || "").indexOf("amount") < 0,
    true
  );

  const src = fs.readFileSync(path.join(ROOT, "netlify/functions/stripe-invoice-webhook.js"), "utf8");
  ok("HMAC still covers t.rawBody", /payload = `\$\{sig\.t\}\.\$\{String\(rawBody \|\| ""\)\}`/.test(src));
  ok("verifier uses timingSafeEqual", src.indexOf("timingSafeEqual") >= 0);
  ok("tolerance is frozen at 300 seconds", /STRIPE_SIGNATURE_TOLERANCE_SEC\s*=\s*300/.test(src));
  ok("handler never passes event into verifyStripeSignature", /verifyStripeSignature\(rawBody, signatureHeader, secret\)/.test(src));
  ok("clock is module-level testNowMs only", /let testNowMs = null/.test(src));
  ok("handler does not read queryStringParameters", src.indexOf("queryStringParameters") < 0);
  ok("handler does not accept x-now clock headers", src.indexOf("x-now") < 0 && src.indexOf("x-stripe-now") < 0);
  ok("handler has no console.log", src.indexOf("console.log") < 0);
  ok("handler has no console.info", src.indexOf("console.info") < 0);
  ok("handler has no console.debug", src.indexOf("console.debug") < 0);
  ok("error path does not include signature header", src.indexOf("Invalid signature") >= 0 && !/text\(400,\s*signatureHeader/.test(src));

  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/mg-core-security-shield-v1.json"), "utf8"));
  const required = manifest.required || [];
  const suite = required.find((row) => row && row.id === "core-stripe-webhook-replay");
  ok("manifest lists stripe replay suite as required", Boolean(suite));
  ok(
    "manifest stripe replay path is frozen",
    suite && suite.path === "scripts/test-core-stripe-webhook-replay.js"
  );
  ok("manifest stripe replay minPassed is 30", suite && suite.minPassed === 30);
  ok(
    "knownGaps no longer lists Stripe replay",
    !(manifest.knownGaps || []).some((gap) => /Stripe invoice webhook verifier has no timestamp/i.test(String(gap)))
  );

  console.log("\nCore Stripe webhook replay: " + passed + " passed");
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
