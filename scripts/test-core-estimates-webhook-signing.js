#!/usr/bin/env node
/**
 * Core Security — estimates Zapier outbound HMAC Phase 1 (compatibility mode).
 * Run: node scripts/test-core-estimates-webhook-signing.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..");
const hmac = require("../netlify/functions/_lib/zapier-hmac-v1");

const SECRET = "mg-test-zapier-webhook-secret";
const UNSIGNED = {
  tenant_id: "11111111-1111-1111-1111-111111111111",
  tenant_slug: "demo",
  business_name: "Demo Co",
  to_name: "Pat",
  client_email: "pat@example.test",
  project_name: "Roof",
  subject: "Estimate",
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

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function main() {
  ok(
    "phase1 marker is frozen",
    hmac.ESTIMATES_HMAC_PHASE1_COMPATIBILITY_MODE === "ESTIMATES_HMAC_PHASE1_COMPATIBILITY_MODE"
  );

  const ts = "2026-09-10T17:00:00.000Z";
  const nonce = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const meta = hmac.buildZapierSignatureMeta(UNSIGNED, { secret: SECRET, timestamp: ts, nonce });
  ok("valid signature is hex", Boolean(meta && /^[0-9a-f]{64}$/.test(meta.signature)));
  ok("version is v1", meta.version === "v1");
  ok("timestamp is echoed", meta.timestamp === ts);
  ok("nonce is echoed", meta.nonce === nonce);

  const canonical = hmac.canonicalString(ts, nonce, UNSIGNED);
  const expected = crypto.createHmac("sha256", SECRET).update(canonical).digest("hex");
  ok("signature matches Invoice Hub canonical timestamp.nonce.JSON", meta.signature === expected);
  ok("verify accepts valid signature", hmac.verifyZapierSignature(UNSIGNED, meta, SECRET));

  const altered = Object.assign({}, UNSIGNED, { client_email: "other@example.test" });
  ok("altered payload fails verify", hmac.verifyZapierSignature(altered, meta, SECRET) === false);

  const again = hmac.buildZapierSignatureMeta(UNSIGNED, { secret: SECRET, timestamp: ts, nonce });
  ok("same payload+timestamp+nonce is deterministic", again.signature === meta.signature);

  const otherNonce = hmac.buildZapierSignatureMeta(UNSIGNED, {
    secret: SECRET,
    timestamp: ts,
    nonce: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  });
  ok("different nonce changes signature", otherNonce.signature !== meta.signature);

  const otherTs = hmac.buildZapierSignatureMeta(UNSIGNED, {
    secret: SECRET,
    timestamp: "2026-09-10T17:00:01.000Z",
    nonce,
  });
  ok("different timestamp changes signature", otherTs.signature !== meta.signature);

  const prev = process.env.ZAPIER_WEBHOOK_SECRET;
  delete process.env.ZAPIER_WEBHOOK_SECRET;
  const unsignedMeta = hmac.buildZapierSignatureMeta(UNSIGNED);
  ok("missing secret returns null in compatibility mode", unsignedMeta === null);
  const unsignedPayload = Object.assign({}, UNSIGNED);
  const attached = hmac.attachZapierSignature(unsignedPayload);
  ok("missing secret does not attach zapier_signature", unsignedPayload.zapier_signature == null);
  ok("missing secret still sets JSON content-type", attached.headers["Content-Type"] === "application/json");
  ok("missing secret does not set X-MG-Signature", attached.headers["X-MG-Signature"] == null);
  if (prev === undefined) delete process.env.ZAPIER_WEBHOOK_SECRET;
  else process.env.ZAPIER_WEBHOOK_SECRET = prev;

  const live = Object.assign({}, UNSIGNED);
  process.env.ZAPIER_WEBHOOK_SECRET = SECRET;
  const signed = hmac.attachZapierSignature(live, { timestamp: ts, nonce });
  ok("signed body includes zapier_signature", typeof live.zapier_signature === "string");
  ok("signed body includes zapier_timestamp", live.zapier_timestamp === ts);
  ok("signed body includes zapier_nonce", live.zapier_nonce === nonce);
  ok("signed body includes zapier_signature_version", live.zapier_signature_version === "v1");
  ok("signed headers include X-MG-Signature", signed.headers["X-MG-Signature"] === live.zapier_signature);
  ok("signed headers include X-MG-Timestamp", signed.headers["X-MG-Timestamp"] === ts);
  ok("signed headers include X-MG-Nonce", signed.headers["X-MG-Nonce"] === nonce);
  ok("signed headers include X-MG-Signature-Version", signed.headers["X-MG-Signature-Version"] === "v1");
  const unsignedAfterAttach = {
    tenant_id: live.tenant_id,
    tenant_slug: live.tenant_slug,
    business_name: live.business_name,
    to_name: live.to_name,
    client_email: live.client_email,
    project_name: live.project_name,
    subject: live.subject,
    public_quote_url: live.public_quote_url,
    pdf_url: live.pdf_url,
    additional_recipients: live.additional_recipients,
  };
  ok(
    "HMAC covers unsigned JSON not the mutated body",
    hmac.verifyZapierSignature(unsignedAfterAttach, signed.meta, SECRET)
  );
  ok(
    "HMAC does not cover body after signature fields are attached",
    hmac.verifyZapierSignature(live, signed.meta, SECRET) === false
  );
  delete process.env.ZAPIER_WEBHOOK_SECRET;

  const sendSrc = read("netlify/functions/send-quote-zapier.js");
  const resendSrc = read("netlify/functions/resend-tenant-quote.js");
  const helperSrc = read("netlify/functions/_lib/zapier-hmac-v1.js");
  ok("send-quote-zapier keeps Owner/Seller inbound auth", sendSrc.indexOf("resolveOwnerOrSellerContext") >= 0);
  ok("send-quote-zapier uses shared HMAC helper", sendSrc.indexOf('require("./_lib/zapier-hmac-v1")') >= 0);
  ok("resend-tenant-quote uses shared HMAC helper", resendSrc.indexOf('require("./_lib/zapier-hmac-v1")') >= 0);
  ok("send-quote-zapier marks PHASE1 compatibility", sendSrc.indexOf("ESTIMATES_HMAC_PHASE1_COMPATIBILITY_MODE") >= 0);
  ok("resend-tenant-quote marks PHASE1 compatibility", resendSrc.indexOf("ESTIMATES_HMAC_PHASE1_COMPATIBILITY_MODE") >= 0);
  ok("helper uses createHmac sha256", /createHmac\("sha256"/.test(helperSrc));
  ok("helper does not fail closed on missing secret", /if \(!secret\) return null/.test(helperSrc));
  ok("send-quote-zapier does not log ZAPIER_WEBHOOK_SECRET", sendSrc.indexOf("ZAPIER_WEBHOOK_SECRET") < 0);
  ok("resend-tenant-quote does not log ZAPIER_WEBHOOK_SECRET", resendSrc.indexOf("ZAPIER_WEBHOOK_SECRET") < 0);
  ok("helper does not console.log signature", helperSrc.indexOf("console.log") < 0 && helperSrc.indexOf("console.info") < 0);

  const publicJs = ["public/js/app.js", "public/js/estimate-public-send.js"]
    .map(read)
    .join("\n");
  ok("browser send path does not include HMAC helper", publicJs.indexOf("zapier-hmac-v1") < 0);
  ok("browser send path does not include ZAPIER_WEBHOOK_SECRET", publicJs.indexOf("ZAPIER_WEBHOOK_SECRET") < 0);
  ok("browser send path does not createHmac", publicJs.indexOf("createHmac") < 0);

  const manifest = JSON.parse(read("scripts/mg-core-security-shield-v1.json"));
  const required = manifest.required || [];
  const suite = required.find((row) => row && row.id === "core-estimates-webhook-signing");
  ok("manifest lists estimates signing suite as required", Boolean(suite));
  ok(
    "manifest estimates signing path is frozen",
    suite && suite.path === "scripts/test-core-estimates-webhook-signing.js"
  );
  ok("manifest estimates signing minPassed is 42", suite && suite.minPassed === 42);
  ok(
    "webhookContract names PHASE1 compatibility",
    String(manifest.webhookContract || "").indexOf("ESTIMATES_HMAC_PHASE1_COMPATIBILITY_MODE") >= 0
  );

  console.log("\nCore estimates webhook signing: " + passed + " passed");
}

try {
  main();
} catch (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
}
