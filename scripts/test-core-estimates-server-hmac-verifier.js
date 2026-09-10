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
  eq("final_to from signed client_email", okBody.final_to, "pat@example.test");
  eq("empty signed additional stays empty", okBody.final_additional_recipients, "");
  ok("final_body from signed public_quote_url", okBody.final_body.indexOf("https://example.test/estimate-public.html?token=abc") >= 0);
  eq(
    "response keys are only the five outputs",
    Object.keys(okBody).sort().join(","),
    "final_additional_recipients,final_body,final_subject,final_to,signature_valid"
  );
  ok("attacker email is not in the valid response", JSON.stringify(okBody).indexOf("evil.example") < 0);

  const altered = Object.assign({}, fields);
  altered.zapier_signed_payload = String(altered.zapier_signed_payload).replace("Your estimate", "Hacked subject");
  const alteredRes = await post(mod, altered);
  const alteredBody = parseBody(alteredRes);
  eq("altered payload is 200", alteredRes.statusCode, 200);
  eq("altered payload signature_valid is false", alteredBody.signature_valid, false);
  eq("altered payload subject is empty", alteredBody.final_subject, "");
  eq("altered payload body is empty", alteredBody.final_body, "");
  eq("altered payload To is empty", alteredBody.final_to, "");
  eq("altered payload additional is empty", alteredBody.final_additional_recipients, "");

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
    client_email: "attacker@evil.example",
    additional_recipients: "bcc:injected@evil.example",
    hmac_secret: "attacker-secret",
  });
  const dupBody = parseBody(await post(liveMod, dup));
  eq("duplicate outer fields still verify", dupBody.signature_valid, true);
  eq("duplicate outer subject cannot override signed subject", dupBody.final_subject, "Your estimate");
  eq("duplicate outer client_email cannot override signed To", dupBody.final_to, "pat@example.test");
  eq("duplicate outer additional cannot inject BCC", dupBody.final_additional_recipients, "");
  ok("duplicate outer URL cannot override signed body", dupBody.final_body.indexOf("evil.example") < 0);
  ok("attacker email is not in additional", JSON.stringify(dupBody).indexOf("attacker@evil.example") < 0);

  const bccSigned = signedFields(
    Object.assign({}, UNSIGNED, { additional_recipients: "ok@example.test\nbcc:evil@evil.example" })
  );
  const bccBody = parseBody(await post(liveMod, bccSigned));
  eq("signed BCC injection still verifies", bccBody.signature_valid, true);
  eq("signed BCC injection does not add recipients", bccBody.final_additional_recipients, "");

  const ctrl = signedFields(
    Object.assign({}, UNSIGNED, { client_email: "pat@example.test\nbcc:evil@evil.example" })
  );
  const ctrlBody = parseBody(await post(liveMod, ctrl));
  eq("control-char To is rejected", ctrlBody.signature_valid, false);
  eq("control-char To is empty", ctrlBody.final_to, "");
  eq("control-char additional is empty", ctrlBody.final_additional_recipients, "");

  const dups = signedFields(
    Object.assign({}, UNSIGNED, {
      additional_recipients: "cc@example.test, CC@example.test, pat@example.test, other@example.test",
    })
  );
  const dupsBody = parseBody(await post(liveMod, dups));
  eq("duplicates collapse without expanding", dupsBody.final_additional_recipients, "cc@example.test,other@example.test");

  const tampered = Object.assign({}, fields);
  tampered.zapier_signed_payload = String(tampered.zapier_signed_payload).replace(
    "11111111-1111-1111-1111-111111111111",
    "22222222-2222-2222-2222-222222222222"
  );
  const tamperBody = parseBody(await post(liveMod, tampered));
  eq("cross-tenant signed tamper is rejected", tamperBody.signature_valid, false);
  eq("cross-tenant tamper does not leak To", tamperBody.final_to, "");

  const outerTenant = Object.assign({}, fields, {
    tenant_id: "22222222-2222-2222-2222-222222222222",
    client_email: "other-tenant@evil.example",
  });
  const outerTenantBody = parseBody(await post(liveMod, outerTenant));
  eq("outer cross-tenant email cannot override To", outerTenantBody.final_to, "pat@example.test");

  const getRes = await liveMod.handler({ httpMethod: "GET", headers: {}, queryStringParameters: fields, body: "" });
  eq("GET is 405", getRes.statusCode, 405);
  eq("GET signature_valid is false", parseBody(getRes).signature_valid, false);
  eq("GET To is empty", parseBody(getRes).final_to, "");

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
