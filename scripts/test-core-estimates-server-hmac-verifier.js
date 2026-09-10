#!/usr/bin/env node
/**
 * Core Security — server-side estimates HMAC verifier.
 * Isolated dummy secret only. Does not call Zapier, live Netlify, or production.
 * Sender fail-closed is not activated.
 * Run: node scripts/test-core-estimates-server-hmac-verifier.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const hmac = require("../netlify/functions/_lib/zapier-hmac-v1");

const SECRET = "mg-test-estimates-server-hmac-secret";
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

function loadHandler() {
  const rel = "../netlify/functions/verify-estimates-zapier-hmac";
  delete require.cache[require.resolve(rel)];
  const mod = require(rel);
  mod._test.setNowMs(NOW_MS);
  return mod;
}

function signedFields(unsigned, opts) {
  const body = Object.assign({}, unsigned);
  hmac.attachZapierSignature(body, {
    secret: SECRET,
    timestamp: (opts && opts.timestamp) || TS,
    nonce: (opts && opts.nonce) || NONCE,
  });
  return {
    zapier_signature: body.zapier_signature,
    zapier_timestamp: body.zapier_timestamp,
    zapier_nonce: body.zapier_nonce,
    zapier_signature_version: body.zapier_signature_version,
    zapier_signed_payload: body.zapier_signed_payload,
  };
}

async function post(mod, bodyObj, extra) {
  const raw = typeof bodyObj === "string" ? bodyObj : JSON.stringify(bodyObj);
  const event = Object.assign(
    {
      httpMethod: "POST",
      headers: {},
      queryStringParameters: {},
      body: raw,
    },
    extra || {}
  );
  return mod.handler(event);
}

function parseBody(res) {
  return JSON.parse(res.body);
}

async function main() {
  const prev = process.env.ZAPIER_WEBHOOK_SECRET;
  process.env.ZAPIER_WEBHOOK_SECRET = SECRET;
  const mod = loadHandler();

  const fields = signedFields(UNSIGNED);
  const okRes = await post(mod, fields);
  eq("valid signature returns 200", okRes.statusCode, 200);
  eq("valid Cache-Control is no-store", okRes.headers["Cache-Control"], "no-store");
  const okBody = parseBody(okRes);
  eq("valid signature_valid is true", okBody.signature_valid, true);
  eq("final_subject from signed JSON", okBody.final_subject, "Your estimate");
  ok("final_body from signed public_quote_url", okBody.final_body.indexOf("https://example.test/estimate-public.html?token=abc") >= 0);
  eq("response keys are only the three outputs", Object.keys(okBody).sort().join(","), "final_body,final_subject,signature_valid");
  ok("client_email is not in the response", JSON.stringify(okBody).indexOf("pat@example.test") < 0);

  const altered = Object.assign({}, fields);
  altered.zapier_signed_payload = String(altered.zapier_signed_payload).replace("Your estimate", "Hacked subject");
  const alteredRes = await post(mod, altered);
  const alteredBody = parseBody(alteredRes);
  eq("altered payload is 200", alteredRes.statusCode, 200);
  eq("altered payload signature_valid is false", alteredBody.signature_valid, false);
  eq("altered payload subject is empty", alteredBody.final_subject, "");
  eq("altered payload body is empty", alteredBody.final_body, "");

  const stale = signedFields(UNSIGNED, { timestamp: "2026-09-10T17:54:59.000Z" });
  const staleBody = parseBody(await post(mod, stale));
  eq("replay at 301s is rejected", staleBody.signature_valid, false);
  eq("replay at 301s does not leak subject", staleBody.final_subject, "");

  const future = signedFields(UNSIGNED, { timestamp: "2026-09-10T18:00:01.000Z" });
  const futureBody = parseBody(await post(mod, future));
  eq("future timestamp is rejected", futureBody.signature_valid, false);
  eq("future timestamp does not leak body", futureBody.final_body, "");

  delete process.env.ZAPIER_WEBHOOK_SECRET;
  const missingMod = loadHandler();
  const missingBody = parseBody(await post(missingMod, fields));
  eq("missing env secret is rejected", missingBody.signature_valid, false);
  eq("missing env secret does not leak subject", missingBody.final_subject, "");
  process.env.ZAPIER_WEBHOOK_SECRET = SECRET;

  const liveMod = loadHandler();
  const big = '{"pad":"' + "x".repeat(9000) + '"}';
  const bigRes = await post(liveMod, big);
  eq("oversized body is 413", bigRes.statusCode, 413);
  eq("oversized body Cache-Control is no-store", bigRes.headers["Cache-Control"], "no-store");
  const bigBody = parseBody(bigRes);
  eq("oversized body signature_valid is false", bigBody.signature_valid, false);

  const dup = Object.assign({}, fields, {
    subject: "ATTACKER SUBJECT",
    messageText: "ATTACKER BODY",
    public_quote_url: "https://evil.example/phish",
    hmac_secret: "attacker-secret",
  });
  const dupBody = parseBody(await post(liveMod, dup));
  eq("duplicate outer fields still verify", dupBody.signature_valid, true);
  eq("duplicate outer subject cannot override signed subject", dupBody.final_subject, "Your estimate");
  ok("duplicate outer URL cannot override signed body", dupBody.final_body.indexOf("evil.example") < 0);

  const getRes = await liveMod.handler({ httpMethod: "GET", headers: {}, queryStringParameters: fields, body: "" });
  eq("GET is 405", getRes.statusCode, 405);
  eq("GET signature_valid is false", parseBody(getRes).signature_valid, false);

  const queryOnly = await liveMod.handler({
    httpMethod: "POST",
    headers: {},
    queryStringParameters: fields,
    body: "{}",
  });
  eq("query-string fields cannot bypass", parseBody(queryOnly).signature_valid, false);

  const headerOnly = await post(liveMod, {}, {
    headers: {
      "X-MG-Signature": fields.zapier_signature,
      "X-MG-Timestamp": fields.zapier_timestamp,
      "X-MG-Nonce": fields.zapier_nonce,
    },
    body: "{}",
  });
  eq("alternate headers cannot bypass", parseBody(headerOnly).signature_valid, false);

  const src = read("netlify/functions/verify-estimates-zapier-hmac.js");
  const helperSrc = read("netlify/functions/_lib/zapier-hmac-v1.js");
  const sendSrc = read("netlify/functions/send-quote-zapier.js");
  ok("function uses envSecretOnly", src.indexOf("envSecretOnly: true") >= 0);
  ok("function does not read a request secret field", src.indexOf("parsed.hmac_secret") < 0 && src.indexOf("body.hmac_secret") < 0);
  ok("function does not console.log", src.indexOf("console.log") < 0 && src.indexOf("console.info") < 0);
  ok("helper envSecretOnly ignores request hmac_secret", helperSrc.indexOf("envSecretOnly") >= 0);
  ok("sender still marks PHASE1 compatibility", sendSrc.indexOf("ESTIMATES_HMAC_PHASE1_COMPATIBILITY_MODE") >= 0);
  ok("function body limit is 8192", liveMod._test.MAX_BODY_BYTES === 8192);

  const manifest = JSON.parse(read("scripts/mg-core-security-shield-v1.json"));
  const suite = (manifest.required || []).find((row) => row && row.id === "core-estimates-server-hmac-verifier");
  ok("manifest lists server verifier suite as required", Boolean(suite));
  ok(
    "manifest server verifier path is frozen",
    suite && suite.path === "scripts/test-core-estimates-server-hmac-verifier.js"
  );
  ok(
    "exact protects the function",
    (manifest.exact || []).indexOf("netlify/functions/verify-estimates-zapier-hmac.js") >= 0
  );
  ok(
    "fail-closed sender remains a known gap",
    (manifest.knownGaps || []).some((gap) => /ESTIMATES_HMAC_PHASE1_COMPATIBILITY_MODE/.test(gap))
  );

  if (prev === undefined) delete process.env.ZAPIER_WEBHOOK_SECRET;
  else process.env.ZAPIER_WEBHOOK_SECRET = prev;

  console.log("\nCore estimates server HMAC verifier: " + passed + " passed");
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
