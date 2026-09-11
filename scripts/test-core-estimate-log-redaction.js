#!/usr/bin/env node
/**
 * Core Security — estimate send/resend logs must not include recipient PII,
 * full payloads, public/PDF URLs, signatures, nonces, or secrets.
 * Run: node scripts/test-core-estimate-log-redaction.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const ops = require("../netlify/functions/_lib/ops-log");

const EMAIL = "pat@example.test";
const CC = "cc@example.test";
const PAYLOAD = {
  client_email: EMAIL,
  additional_recipients: [CC, "third@example.test"],
  to_name: "Pat Client",
  public_quote_url: "https://example.test/estimate-public.html?token=secret-token",
  pdf_url: "https://example.test/storage/v1/object/public/estimate-pdfs/a.pdf",
  zapier_signature: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  zapier_nonce: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  zapier_timestamp: "2026-09-10T18:00:00.000Z",
  messageText: "Hi Pat, see https://example.test/estimate-public.html?token=abc",
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

function captureConsole(fn) {
  const orig = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  const lines = [];
  function push() {
    lines.push(Array.prototype.slice.call(arguments).map(String).join(" "));
  }
  console.log = push;
  console.info = push;
  console.warn = push;
  console.error = push;
  try {
    fn();
    return lines.join("\n");
  } finally {
    console.log = orig.log;
    console.info = orig.info;
    console.warn = orig.warn;
    console.error = orig.error;
  }
}

function hasEmail(text) {
  return /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(String(text));
}

function hasUrl(text) {
  return /https?:\/\//i.test(String(text));
}

function main() {
  const sendSrc = read("netlify/functions/send-quote-zapier.js");
  const resendSrc = read("netlify/functions/resend-tenant-quote.js");
  const hmacSrc = read("netlify/functions/_lib/zapier-hmac-v1.js");
  const opsSrc = read("netlify/functions/_lib/ops-log.js");

  ok("send-quote-zapier has no direct console.log", !/console\.(log|info|warn|error)\s*\(/.test(sendSrc));
  ok("resend-tenant-quote has no direct console.log", !/console\.(log|info|warn|error)\s*\(/.test(resendSrc));
  ok("debug incoming dump is gone", sendSrc.indexOf("[CC DEBUG send-quote-zapier incoming]") < 0);
  ok("debug outbound dump is gone", sendSrc.indexOf("[CC DEBUG send-quote-zapier outbound]") < 0);
  ok("MG Zapier Email Payload dump is gone", sendSrc.indexOf("[MG Zapier Email Payload]") < 0);
  ok("send-quote-zapier still puts additional_recipients on the Zapier body", /additional_recipients\b/.test(sendSrc));
  ok("send-quote-zapier still sends client_email in the Zapier body", /client_email/.test(sendSrc));
  ok("send-quote-zapier still signs outbound Zapier", sendSrc.indexOf("dispatchSignedEstimatesWebhook") >= 0);
  ok("resend-tenant-quote still signs outbound Zapier", resendSrc.indexOf("dispatchSignedEstimatesWebhook") >= 0);
  ok("HMAC helper still has no console.log", hmacSrc.indexOf("console.log") < 0 && hmacSrc.indexOf("console.info") < 0);
  ok("ops-log forbids additional_recipients", opsSrc.indexOf('"additional_recipients"') >= 0);
  ok("ops-log forbids client_email", opsSrc.indexOf('"client_email"') >= 0);
  ok("ops-log forbids public_quote_url", opsSrc.indexOf('"public_quote_url"') >= 0);
  ok("ops-log forbids zapier_signature", opsSrc.indexOf('"zapier_signature"') >= 0);
  ok("resend no longer logs Zapier error body", resendSrc.indexOf("errText.slice") < 0);
  ok("resend no longer dumps the raw error object", resendSrc.indexOf('console.error("[resend-tenant-quote]"') < 0);

  ok("count additional recipients from array", ops.countAdditionalRecipients(["a@x.com", "b@y.com"]) === 2);
  ok("count additional recipients from empty", ops.countAdditionalRecipients("") === 0);

  const dumped = captureConsole(() => {
    ops.logOps({
      req_id: "req-1",
      fn: "send-quote-zapier",
      event: "zapier_dispatch",
      level: "info",
      outcome: "ok",
      tenant_id: "11111111-1111-4111-8111-111111111111",
      quote_id: "22222222-2222-4222-8222-222222222222",
      additional_recipient_count: ops.countAdditionalRecipients(PAYLOAD.additional_recipients),
      client_email: PAYLOAD.client_email,
      additional_recipients: PAYLOAD.additional_recipients,
      to_name: PAYLOAD.to_name,
      public_quote_url: PAYLOAD.public_quote_url,
      pdf_url: PAYLOAD.pdf_url,
      public_token: "secret-token-value",
      zapier_signature: PAYLOAD.zapier_signature,
      zapier_nonce: PAYLOAD.zapier_nonce,
      payload: PAYLOAD,
      body: JSON.stringify(PAYLOAD),
      detail: "webhook_post_ok",
    });
  });
  ok("console output is JSON", dumped.trim().charAt(0) === "{");
  const parsed = JSON.parse(dumped.trim());
  ok("safe log keeps event name", parsed.event === "zapier_dispatch");
  ok("safe log keeps outcome", parsed.outcome === "ok");
  ok("safe log keeps req_id", parsed.req_id === "req-1");
  ok("safe log keeps recipient count", parsed.additional_recipient_count === 2);
  ok("console does not include client_email field", parsed.client_email == null);
  ok("console does not include additional_recipients field", parsed.additional_recipients == null);
  ok("console does not include names", parsed.to_name == null);
  ok("console does not include public URL", parsed.public_quote_url == null);
  ok("console does not include pdf URL", parsed.pdf_url == null);
  ok("console does not include public_token", parsed.public_token == null);
  ok("console does not include signature", parsed.zapier_signature == null);
  ok("console does not include nonce", parsed.zapier_nonce == null);
  ok("console does not include full payload", parsed.payload == null && parsed.body == null);
  ok("console text has no email addresses", !hasEmail(dumped));
  ok("console text has no public URLs", !hasUrl(dumped));
  ok("console text has no signature hex", dumped.indexOf(PAYLOAD.zapier_signature) < 0);
  ok("console text has no nonce", dumped.indexOf(PAYLOAD.zapier_nonce) < 0);

  const dirtyDetail = captureConsole(() => {
    ops.logOps({
      req_id: "req-2",
      fn: "resend-tenant-quote",
      event: "zapier_dispatch",
      level: "warn",
      outcome: "fail",
      detail: `failed for ${EMAIL} at ${PAYLOAD.public_quote_url}`,
    });
  });
  ok("detail emails are redacted", !hasEmail(dirtyDetail) && dirtyDetail.indexOf("[redacted]") >= 0);
  ok("detail URLs are redacted", !hasUrl(dirtyDetail) && dirtyDetail.indexOf("[redacted-url]") >= 0);

  const fullPayloadDump = captureConsole(() => {
    ops.logOps({
      req_id: "req-3",
      fn: "send-quote-zapier",
      event: "zapier_dispatch",
      level: "info",
      outcome: "ok",
      detail: JSON.stringify(PAYLOAD),
    });
  });
  ok("stringified payload emails do not reach console", !hasEmail(fullPayloadDump));
  ok("stringified payload URLs do not reach console", !hasUrl(fullPayloadDump));

  console.log("\nCore estimate log redaction: " + passed + " passed");
}

main();
