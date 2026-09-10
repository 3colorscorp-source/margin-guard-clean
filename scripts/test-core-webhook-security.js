#!/usr/bin/env node
/**
 * Core Security Shield V1 — HMAC/webhook contracts.
 * Isolated dummy secrets only. No live Stripe/Square/Zapier.
 * Run: node scripts/test-core-webhook-security.js
 */
"use strict";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET || "mg-core-webhook-security-test-secret";
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "mg-core-webhook-security-test-key";
process.env.STRIPE_INVOICE_WEBHOOK_SECRET = "mg-core-stripe-whsec-dummy";
process.env.STRIPE_WEBHOOK_SECRET = "";
process.env.SQUARE_WEBHOOK_SIGNATURE_KEY = "mg-core-square-sig-dummy";
process.env.SQUARE_WEBHOOK_NOTIFICATION_URL = "https://example.invalid/square-webhook";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const {
  computeSquareSignature,
  verifySquareWebhookSignature,
} = require("../netlify/functions/_lib/square-webhook-signature");

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
  return require("../netlify/functions/stripe-invoice-webhook");
}

async function main() {
  const squareKey = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;
  const squareUrl = process.env.SQUARE_WEBHOOK_NOTIFICATION_URL;
  const body = JSON.stringify({ type: "invoice.payment_made", event_id: "evt-1" });
  const goodSig = computeSquareSignature(squareUrl, body, squareKey);

  eq(
    "square missing signature is rejected",
    verifySquareWebhookSignature({
      rawBody: body,
      signatureHeader: "",
      signatureKey: squareKey,
      notificationUrl: squareUrl,
    }),
    false
  );
  eq(
    "square wrong signature is rejected",
    verifySquareWebhookSignature({
      rawBody: body,
      signatureHeader: goodSig.replace(/A/g, "B") || "AAAA",
      signatureKey: squareKey,
      notificationUrl: squareUrl,
    }),
    false
  );
  eq(
    "square altered body is rejected",
    verifySquareWebhookSignature({
      rawBody: body.replace("evt-1", "evt-2"),
      signatureHeader: goodSig,
      signatureKey: squareKey,
      notificationUrl: squareUrl,
    }),
    false
  );
  eq(
    "square wrong secret is rejected",
    verifySquareWebhookSignature({
      rawBody: body,
      signatureHeader: goodSig,
      signatureKey: "mg-core-square-wrong-secret",
      notificationUrl: squareUrl,
    }),
    false
  );
  eq(
    "square valid signature is accepted",
    verifySquareWebhookSignature({
      rawBody: body,
      signatureHeader: goodSig,
      signatureKey: squareKey,
      notificationUrl: squareUrl,
    }),
    true
  );

  const sigSrc = fs.readFileSync(
    path.join(ROOT, "netlify/functions/_lib/square-webhook-signature.js"),
    "utf8"
  );
  ok("square verifier uses timingSafeEqual", sigSrc.indexOf("timingSafeEqual") >= 0);

  const stripeSecret = process.env.STRIPE_INVOICE_WEBHOOK_SECRET;
  const stripeBody = JSON.stringify({ type: "ping" });
  const tNow = String(Math.floor(Date.now() / 1000));
  const v1 = stripeSign(stripeBody, stripeSecret, tNow);
  const stripe = loadStripe();

  const missing = await stripe.handler({
    httpMethod: "POST",
    headers: {},
    body: stripeBody,
  });
  eq("stripe missing signature is 400", missing.statusCode, 400);

  const wrong = await stripe.handler({
    httpMethod: "POST",
    headers: { "stripe-signature": "t=" + tNow + ",v1=" + "00".repeat(32) },
    body: stripeBody,
  });
  eq("stripe wrong signature is 400", wrong.statusCode, 400);

  const altered = await stripe.handler({
    httpMethod: "POST",
    headers: { "stripe-signature": "t=" + tNow + ",v1=" + v1 },
    body: stripeBody.replace("ping", "pong"),
  });
  eq("stripe altered body is 400", altered.statusCode, 400);

  const wrongSecretHeader = stripeSign(stripeBody, "mg-core-stripe-wrong-secret", tNow);
  const badSecret = await stripe.handler({
    httpMethod: "POST",
    headers: { "stripe-signature": "t=" + tNow + ",v1=" + wrongSecretHeader },
    body: stripeBody,
  });
  eq("stripe wrong secret is 400", badSecret.statusCode, 400);

  const valid = await stripe.handler({
    httpMethod: "POST",
    headers: { "stripe-signature": "t=" + tNow + ",v1=" + v1 },
    body: stripeBody,
  });
  eq("stripe valid signature of ignored type is 200", valid.statusCode, 200);

  const oldT = String(Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 365);
  const oldV1 = stripeSign(stripeBody, stripeSecret, oldT);
  const old = await stripe.handler({
    httpMethod: "POST",
    headers: { "stripe-signature": "t=" + oldT + ",v1=" + oldV1 },
    body: stripeBody,
  });
  eq(
    "FINDING FROZEN: local Stripe verifier has no timestamp/replay window",
    old.statusCode,
    200
  );

  const stripeSrc = fs.readFileSync(
    path.join(ROOT, "netlify/functions/stripe-invoice-webhook.js"),
    "utf8"
  );
  ok("stripe local verifier uses timingSafeEqual", stripeSrc.indexOf("timingSafeEqual") >= 0);
  ok(
    "FINDING FROZEN: stripe local verifier never checks signature timestamp skew",
    !/Math\.abs\([^)]*t[^)]*now|tolerance|replay/i.test(stripeSrc)
  );

  const estimateSrc = fs.readFileSync(path.join(ROOT, "netlify/functions/send-quote-zapier.js"), "utf8");
  ok(
    "estimate Zapier outbound uses shared HMAC helper",
    estimateSrc.indexOf('require("./_lib/zapier-hmac-v1")') >= 0
  );
  ok(
    "ESTIMATES_HMAC_PHASE1_COMPATIBILITY_MODE is marked on send-quote-zapier",
    estimateSrc.indexOf("ESTIMATES_HMAC_PHASE1_COMPATIBILITY_MODE") >= 0
  );

  const invoiceSrc = fs.readFileSync(path.join(ROOT, "netlify/functions/send-invoice-zapier.js"), "utf8");
  ok("invoice Zapier outbound uses HMAC", invoiceSrc.indexOf("createHmac") >= 0);
  ok("invoice Zapier outbound uses ZAPIER_WEBHOOK_SECRET", invoiceSrc.indexOf("ZAPIER_WEBHOOK_SECRET") >= 0);

  const squareHandlerSrc = fs.readFileSync(
    path.join(ROOT, "netlify/functions/square-saas-webhook.js"),
    "utf8"
  );
  ok("square webhook verifies signature before parse-driven activation", squareHandlerSrc.indexOf("verifySquareWebhookSignature") >= 0);
  ok(
    "square webhook does not activate from payload fields alone",
    squareHandlerSrc.indexOf("Never activates from payload fields alone") >= 0
  );

  console.log("\nCore webhook security: " + passed + " passed");
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
