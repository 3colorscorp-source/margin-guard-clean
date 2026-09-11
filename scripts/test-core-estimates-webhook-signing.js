#!/usr/bin/env node
/**
 * Core Security — estimates Zapier outbound HMAC fail-closed (Zapier v15).
 * Isolated dummy secret only. Does not call Zapier, live Netlify, or production.
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
const RESEND = Object.assign({}, UNSIGNED, {
  event_type: "quote_resend",
  source: "owner_quote_resend",
  messageText: "Updated estimate: please review",
});

let passed = 0;
function ok(label, cond) {
  assert.ok(cond, label);
  passed += 1;
  console.log("PASS " + label);
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

async function main() {
  ok(
    "fail-closed marker is frozen",
    hmac.ESTIMATES_HMAC_FAIL_CLOSED === "ESTIMATES_HMAC_FAIL_CLOSED"
  );
  ok("compatibility marker is gone", hmac.ESTIMATES_HMAC_PHASE1_COMPATIBILITY_MODE == null);

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
  ok("missing secret returns null", unsignedMeta === null);
  const unsignedPayload = Object.assign({}, UNSIGNED);
  const attached = hmac.attachZapierSignature(unsignedPayload);
  ok("missing secret does not attach zapier_signature", unsignedPayload.zapier_signature == null);
  ok("missing secret does not attach zapier_timestamp", unsignedPayload.zapier_timestamp == null);
  ok("missing secret does not attach zapier_nonce", unsignedPayload.zapier_nonce == null);
  ok("missing secret does not attach zapier_signed_payload", unsignedPayload.zapier_signed_payload == null);
  ok("missing secret still sets JSON content-type", attached.headers["Content-Type"] === "application/json");
  ok("missing secret does not set X-MG-Signature", attached.headers["X-MG-Signature"] == null);
  ok("unsigned payload fails required-signature check", hmac.hasRequiredZapierSignature(unsignedPayload) === false);

  const missingCalls = [];
  const missingDispatch = await hmac.dispatchSignedEstimatesWebhook(
    "https://hooks.example.test/catch",
    unsignedPayload,
    function fakeFetch(url, opts) {
      missingCalls.push({ url: url, opts: opts });
      return { ok: true, status: 200 };
    }
  );
  ok("missing secret does not POST", missingDispatch.sent === false);
  ok("missing secret returns hmac_required", missingDispatch.code === "hmac_required");
  ok("missing secret fetch is never called", missingCalls.length === 0);
  ok(
    "missing secret payload stays unsigned JSON",
    JSON.stringify(unsignedPayload).indexOf("zapier_signed_payload") < 0 &&
      JSON.stringify(unsignedPayload).indexOf("zapier_signature") < 0
  );

  const resendUnsigned = Object.assign({}, RESEND);
  const resendMissing = await hmac.dispatchSignedEstimatesWebhook(
    "https://hooks.example.test/catch",
    resendUnsigned,
    function fakeFetch() {
      missingCalls.push({ resend: true });
      return { ok: true, status: 200 };
    }
  );
  ok("resend missing secret does not POST", resendMissing.sent === false && resendMissing.code === "hmac_required");
  ok("resend missing secret fetch is never called", missingCalls.length === 0);
  ok(
    "resend missing secret payload stays unsigned",
    JSON.stringify(resendUnsigned).indexOf("zapier_signed_payload") < 0
  );
  if (prev === undefined) delete process.env.ZAPIER_WEBHOOK_SECRET;
  else process.env.ZAPIER_WEBHOOK_SECRET = prev;

  const live = Object.assign({}, UNSIGNED);
  process.env.ZAPIER_WEBHOOK_SECRET = SECRET;
  const signed = hmac.attachZapierSignature(live, { timestamp: ts, nonce });
  ok("signed body includes zapier_signature", typeof live.zapier_signature === "string");
  ok("signed body includes zapier_timestamp", live.zapier_timestamp === ts);
  ok("signed body includes zapier_nonce", live.zapier_nonce === nonce);
  ok("signed body includes zapier_signature_version", live.zapier_signature_version === "v1");
  ok("signed body includes zapier_signed_payload", typeof live.zapier_signed_payload === "string");
  ok("required signature check accepts signed body", hmac.hasRequiredZapierSignature(live) === true);
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

  const sendCalls = [];
  const sendBody = Object.assign({}, UNSIGNED);
  const sendDispatch = await hmac.dispatchSignedEstimatesWebhook(
    "https://hooks.example.test/catch",
    sendBody,
    function fakeFetch(url, opts) {
      sendCalls.push({ url: url, body: JSON.parse(opts.body), headers: opts.headers });
      return { ok: true, status: 200 };
    }
  );
  ok("signed sender dispatch POSTs", sendDispatch.sent === true && sendDispatch.ok === true);
  ok("signed sender POST includes v1 signature", typeof sendCalls[0].body.zapier_signature === "string");
  ok("signed sender POST includes timestamp", typeof sendCalls[0].body.zapier_timestamp === "string");
  ok("signed sender POST includes nonce", typeof sendCalls[0].body.zapier_nonce === "string");
  ok("signed sender POST includes zapier_signed_payload", typeof sendCalls[0].body.zapier_signed_payload === "string");
  ok("signed sender POST version is v1", sendCalls[0].body.zapier_signature_version === "v1");

  const resendCalls = [];
  const resendBody = Object.assign({}, RESEND);
  const resendDispatch = await hmac.dispatchSignedEstimatesWebhook(
    "https://hooks.example.test/catch",
    resendBody,
    function fakeFetch(url, opts) {
      resendCalls.push({ url: url, body: JSON.parse(opts.body) });
      return { ok: true, status: 200 };
    }
  );
  ok("signed resend dispatch POSTs", resendDispatch.sent === true && resendDispatch.ok === true);
  ok("signed resend POST includes v1 signature", typeof resendCalls[0].body.zapier_signature === "string");
  ok("signed resend POST includes zapier_signed_payload", typeof resendCalls[0].body.zapier_signed_payload === "string");
  delete process.env.ZAPIER_WEBHOOK_SECRET;

  const sendSrc = read("netlify/functions/send-quote-zapier.js");
  const resendSrc = read("netlify/functions/resend-tenant-quote.js");
  const helperSrc = read("netlify/functions/_lib/zapier-hmac-v1.js");
  ok("send-quote-zapier keeps Owner/Seller inbound auth", sendSrc.indexOf("resolveOwnerOrSellerContext") >= 0);
  ok("send-quote-zapier uses shared HMAC helper", sendSrc.indexOf('require("./_lib/zapier-hmac-v1")') >= 0);
  ok("resend-tenant-quote uses shared HMAC helper", resendSrc.indexOf('require("./_lib/zapier-hmac-v1")') >= 0);
  ok("send-quote-zapier marks fail-closed", sendSrc.indexOf("ESTIMATES_HMAC_FAIL_CLOSED") >= 0);
  ok("resend-tenant-quote marks fail-closed", resendSrc.indexOf("ESTIMATES_HMAC_FAIL_CLOSED") >= 0);
  ok("send-quote-zapier has no PHASE1 marker", sendSrc.indexOf("ESTIMATES_HMAC_PHASE1_COMPATIBILITY_MODE") < 0);
  ok("resend-tenant-quote has no PHASE1 marker", resendSrc.indexOf("ESTIMATES_HMAC_PHASE1_COMPATIBILITY_MODE") < 0);
  ok("helper has no PHASE1 marker", helperSrc.indexOf("ESTIMATES_HMAC_PHASE1_COMPATIBILITY_MODE") < 0);
  ok("helper uses createHmac sha256", /createHmac\("sha256"/.test(helperSrc));
  ok("attach still returns null when secret missing", /if \(!secret\) return null/.test(helperSrc));
  ok("dispatch refuses unsigned when secret missing", helperSrc.indexOf('code: "hmac_required"') >= 0);
  ok("send-quote-zapier dispatches through signed helper", sendSrc.indexOf("dispatchSignedEstimatesWebhook") >= 0);
  ok("resend-tenant-quote dispatches through signed helper", resendSrc.indexOf("dispatchSignedEstimatesWebhook") >= 0);
  ok("send-quote-zapier does not POST webhookUrl directly", sendSrc.indexOf("fetch(webhookUrl") < 0);
  ok("resend-tenant-quote does not POST webhookUrl directly", resendSrc.indexOf("fetch(webhookUrl") < 0);
  ok("send-quote-zapier fail-closed uses hmac_required", sendSrc.indexOf("hmac_required") >= 0);
  ok("resend-tenant-quote fail-closed uses hmac_required", resendSrc.indexOf("hmac_required") >= 0);
  ok("send-quote-zapier generic fail-closed body", sendSrc.indexOf("Unable to send estimate") >= 0);
  ok("resend-tenant-quote generic fail-closed body", resendSrc.indexOf("Unable to send updated quote email.") >= 0);
  ok("send-quote-zapier keeps no-URL skip", sendSrc.indexOf("skipped_no_webhook_url") >= 0);
  ok("resend-tenant-quote keeps missing-URL 500", resendSrc.indexOf("zapier_not_configured") >= 0);
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
  ok("manifest estimates signing minPassed is 81", suite && suite.minPassed === 81);
  ok(
    "webhookContract names fail-closed",
    String(manifest.webhookContract || "").indexOf("ESTIMATES_HMAC_FAIL_CLOSED") >= 0
  );
  ok("webhookContract names Zapier v15", String(manifest.webhookContract || "").indexOf("v15") >= 0);
  ok(
    "knownGaps no longer list PHASE1 compatibility",
    !(manifest.knownGaps || []).some((gap) => /ESTIMATES_HMAC_PHASE1_COMPATIBILITY_MODE/.test(gap))
  );

  console.log("\nCore estimates webhook signing: " + passed + " passed");
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
