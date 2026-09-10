#!/usr/bin/env node
/**
 * Core Security — estimates Zapier Catch Hook HMAC verifier (Phase 2 contract).
 * Simulates Catch Hook input. Does not call Zapier, Netlify, or production.
 * Fail-closed on Netlify is not activated.
 * Run: node scripts/test-core-estimates-hmac-verifier.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..");
const hmac = require("../netlify/functions/_lib/zapier-hmac-v1");
const paste = require("../docs/CORE_SECURITY_ESTIMATES_ZAPIER_HMAC_VERIFIER");

const SECRET = "mg-test-estimates-hmac-verifier-secret";
const NOW_MS = Date.parse("2026-09-10T18:00:00.000Z");
const TS = "2026-09-10T17:59:30.000Z";
const NONCE = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const UNSIGNED = {
  tenant_id: "11111111-1111-1111-1111-111111111111",
  tenant_slug: "demo",
  business_name: "Demo Co",
  to_name: "Pat",
  client_email: "pat@example.test",
  project_name: "Roof",
  subject: "Your estimate",
  public_quote_url: "https://example.test/estimate-public.html?token=abc",
  pdf_url: "",
  additional_recipients: "",
};

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

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function simulateCatchHook(rawBody, secret) {
  const parsed = JSON.parse(rawBody);
  const shuffled = {};
  Object.keys(parsed)
    .sort()
    .reverse()
    .forEach((key) => {
      shuffled[key] = parsed[key];
    });
  shuffled.hmac_secret = secret;
  return shuffled;
}

function reconstructUnsignedJson(parsed) {
  const unsigned = {};
  Object.keys(parsed)
    .sort()
    .forEach((key) => {
      if (String(key).indexOf("zapier_") === 0) return;
      unsigned[key] = parsed[key];
    });
  return JSON.stringify(unsigned);
}

function signedWire(unsigned, opts) {
  const body = Object.assign({}, unsigned);
  const attached = hmac.attachZapierSignature(body, {
    secret: SECRET,
    timestamp: (opts && opts.timestamp) || TS,
    nonce: (opts && opts.nonce) || NONCE,
  });
  return {
    body: body,
    raw: JSON.stringify(body),
    meta: attached.meta,
    headers: attached.headers,
  };
}

function main() {
  ok("phase1 compatibility marker remains", hmac.ESTIMATES_HMAC_PHASE1_COMPATIBILITY_MODE === "ESTIMATES_HMAC_PHASE1_COMPATIBILITY_MODE");
  eq("max age is 300 seconds", hmac.ESTIMATES_HMAC_MAX_AGE_MS, 300000);

  const contractDocs = read("docs/CH-013A21Z-ZAPIER-CONTRACT-EMAIL.md");
  ok(
    "repo evidence: Catch Raw Hook headers do not reach Code Step inputData",
    contractDocs.indexOf("inputData") >= 0 &&
      contractDocs.indexOf("does **not** reliably materialize mapped header fields") >= 0
  );
  ok(
    "repo evidence: HMAC material must live in the JSON body",
    contractDocs.indexOf("authoritative HMAC material lives **inside the JSON body**") >= 0
  );

  const invoiceSrc = read("netlify/functions/send-invoice-zapier.js");
  ok(
    "Invoice Hub documents Catch Hook field aliases, not raw body",
    invoiceSrc.indexOf("Zapier Catch Hook: snake_case + Title Case aliases") >= 0
  );

  const wire = signedWire(UNSIGNED);
  ok("zapier_signed_payload is the canonical timestamp.nonce.JSON string", wire.body.zapier_signed_payload === wire.meta.signed_payload);
  ok(
    "signed payload does not start with { so Catch Hook is less likely to JSON-parse it",
    String(wire.body.zapier_signed_payload).charAt(0) !== "{"
  );
  ok("HMAC is over zapier_signed_payload bytes", wire.body.zapier_signature === crypto.createHmac("sha256", SECRET).update(wire.body.zapier_signed_payload, "utf8").digest("hex"));

  const catchHook = simulateCatchHook(wire.raw, SECRET);
  ok("simulated Catch Hook drops X-MG headers", catchHook.hmac_secret === SECRET && catchHook["X-MG-Signature"] == null);
  ok("simulated Catch Hook still has zapier_signed_payload string", typeof catchHook.zapier_signed_payload === "string");

  const verified = hmac.verifyEstimatesCatchHook(catchHook, { nowMs: NOW_MS });
  eq("Catch Hook input verifies", verified.signature_valid, true);
  eq("final_subject comes from signed JSON", verified.final_subject, "Your estimate");
  ok("final_body uses signed public_quote_url not Catch Hook rebuild", verified.final_body.indexOf("https://example.test/estimate-public.html?token=abc") >= 0);
  ok("final_body does not echo client_email", verified.final_body.indexOf("pat@example.test") < 0);

  const pasteOut = paste.runEstimatesHmacCodeStep(catchHook, { nowMs: NOW_MS });
  eq("Code Step signature_valid is string true", pasteOut.signature_valid, "true");
  eq("Code Step final_subject matches", pasteOut.final_subject, verified.final_subject);
  eq("Code Step final_body matches", pasteOut.final_body, verified.final_body);
  eq(
    "helper and paste verifier agree",
    JSON.stringify(hmac.verifyEstimatesCatchHook(catchHook, { nowMs: NOW_MS })),
    JSON.stringify(paste.verifyEstimatesHmacCatchHook(catchHook, { nowMs: NOW_MS }))
  );

  const reconstructed = reconstructUnsignedJson(JSON.parse(wire.raw));
  ok(
    "reconstructed Catch Hook JSON is not the signed JSON",
    reconstructed !== JSON.stringify(UNSIGNED)
  );
  const rebuiltCanonical = hmac.canonicalString(TS, NONCE, JSON.parse(reconstructed));
  ok(
    "HMAC over reconstructed field order does not match",
    rebuiltCanonical !== wire.body.zapier_signed_payload
  );

  const noSecret = hmac.verifyEstimatesCatchHook(
    Object.assign({}, catchHook, { hmac_secret: "" }),
    { nowMs: NOW_MS }
  );
  eq("missing secret is rejected", noSecret.signature_valid, false);

  const badSig = hmac.verifyEstimatesCatchHook(
    Object.assign({}, catchHook, { zapier_signature: "00".repeat(32) }),
    { nowMs: NOW_MS }
  );
  eq("wrong signature is rejected", badSig.signature_valid, false);

  const badTs = hmac.verifyEstimatesCatchHook(
    Object.assign({}, catchHook, { zapier_timestamp: "not-a-date" }),
    { nowMs: NOW_MS }
  );
  eq("malformed timestamp is rejected", badTs.signature_valid, false);

  const badNonce = hmac.verifyEstimatesCatchHook(
    Object.assign({}, catchHook, { zapier_nonce: "xyz" }),
    { nowMs: NOW_MS }
  );
  eq("malformed nonce is rejected", badNonce.signature_valid, false);

  const parsedPayload = hmac.verifyEstimatesCatchHook(
    Object.assign({}, catchHook, { zapier_signed_payload: { not: "a string" } }),
    { nowMs: NOW_MS }
  );
  eq("Catch Hook parsed object payload is rejected", parsedPayload.signature_valid, false);

  const emptyPayload = hmac.verifyEstimatesCatchHook(
    Object.assign({}, catchHook, { zapier_signed_payload: "" }),
    { nowMs: NOW_MS }
  );
  eq("empty signed payload is rejected", emptyPayload.signature_valid, false);

  const futureWire = signedWire(UNSIGNED, { timestamp: "2026-09-10T18:00:01.000Z" });
  const futureIn = simulateCatchHook(futureWire.raw, SECRET);
  eq(
    "future timestamp is rejected",
    hmac.verifyEstimatesCatchHook(futureIn, { nowMs: NOW_MS }).signature_valid,
    false
  );

  const staleWire = signedWire(UNSIGNED, { timestamp: "2026-09-10T17:54:59.000Z" });
  const staleIn = simulateCatchHook(staleWire.raw, SECRET);
  eq(
    "timestamp older than 300s is rejected",
    hmac.verifyEstimatesCatchHook(staleIn, { nowMs: NOW_MS }).signature_valid,
    false
  );

  const edgeWire = signedWire(UNSIGNED, { timestamp: "2026-09-10T17:55:00.000Z" });
  const edgeIn = simulateCatchHook(edgeWire.raw, SECRET);
  eq(
    "timestamp exactly 300s old is accepted",
    hmac.verifyEstimatesCatchHook(edgeIn, { nowMs: NOW_MS }).signature_valid,
    true
  );

  const resend = Object.assign({}, UNSIGNED, {
    subject: "Updated estimate",
    messageText: "Hi Pat,\n\nUpdated estimate:\nhttps://example.test/estimate-public.html?token=abc\n",
  });
  const resendWire = signedWire(resend);
  const resendIn = simulateCatchHook(resendWire.raw, SECRET);
  const resendOut = hmac.verifyEstimatesCatchHook(resendIn, { nowMs: NOW_MS });
  eq("resend final_subject uses signed subject", resendOut.final_subject, "Updated estimate");
  ok("resend final_body uses signed messageText", resendOut.final_body.indexOf("Updated estimate:") >= 0);

  const prev = process.env.ZAPIER_WEBHOOK_SECRET;
  delete process.env.ZAPIER_WEBHOOK_SECRET;
  const unsignedBody = Object.assign({}, UNSIGNED);
  const unsignedAttach = hmac.attachZapierSignature(unsignedBody);
  ok("missing secret still returns null meta (not fail-closed)", unsignedAttach.meta === null);
  ok("missing secret does not attach zapier_signed_payload", unsignedBody.zapier_signed_payload == null);
  ok("missing secret still sets JSON content-type", unsignedAttach.headers["Content-Type"] === "application/json");
  if (prev === undefined) delete process.env.ZAPIER_WEBHOOK_SECRET;
  else process.env.ZAPIER_WEBHOOK_SECRET = prev;

  const sendSrc = read("netlify/functions/send-quote-zapier.js");
  const resendSrc = read("netlify/functions/resend-tenant-quote.js");
  const helperSrc = read("netlify/functions/_lib/zapier-hmac-v1.js");
  const pasteSrc = read("docs/CORE_SECURITY_ESTIMATES_ZAPIER_HMAC_VERIFIER.js");
  ok("send-quote-zapier still marks PHASE1 compatibility", sendSrc.indexOf("ESTIMATES_HMAC_PHASE1_COMPATIBILITY_MODE") >= 0);
  ok("resend-tenant-quote still marks PHASE1 compatibility", resendSrc.indexOf("ESTIMATES_HMAC_PHASE1_COMPATIBILITY_MODE") >= 0);
  ok("helper still returns null when secret missing", /if \(!secret\) return null/.test(helperSrc));
  ok("helper does not console.log", helperSrc.indexOf("console.log") < 0 && helperSrc.indexOf("console.info") < 0);
  ok("paste Code Step does not console.log", pasteSrc.indexOf("console.log") < 0 && pasteSrc.indexOf("console.info") < 0);
  ok("paste Code Step uses timingSafeEqual", pasteSrc.indexOf("timingSafeEqual") >= 0);
  ok("paste Code Step documents Catch Hook header gap", pasteSrc.indexOf("X-MG-*") >= 0 || pasteSrc.indexOf("X-MG-") >= 0);
  ok("send-quote-zapier does not log ZAPIER_WEBHOOK_SECRET", sendSrc.indexOf("ZAPIER_WEBHOOK_SECRET") < 0);
  ok("verifier output keys are only signature_valid, final_subject, final_body", Object.keys(verified).sort().join(",") === "final_body,final_subject,signature_valid");

  const manifest = JSON.parse(read("scripts/mg-core-security-shield-v1.json"));
  const suite = (manifest.required || []).find((row) => row && row.id === "core-estimates-hmac-verifier");
  ok("manifest lists estimates HMAC verifier suite as required", Boolean(suite));
  ok(
    "manifest verifier path is frozen",
    suite && suite.path === "scripts/test-core-estimates-hmac-verifier.js"
  );
  ok(
    "fail-closed remains a known gap",
    (manifest.knownGaps || []).some((gap) => /ESTIMATES_HMAC_PHASE1_COMPATIBILITY_MODE/.test(gap))
  );

  console.log("\nCore estimates HMAC verifier: " + passed + " passed");
}

try {
  main();
} catch (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
}
