/**
 * CH-009-P2B — Acceptance bridge no longer creates invoices (static QA).
 * Run: node scripts/qa-ch009-p2b-accept-bridge.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const bridgePath = path.join(ROOT, "netlify/functions/_lib/quote-accept-bridge.js");
const publicStatusPath = path.join(ROOT, "netlify/functions/update-public-estimate-status.js");
const hubStepPath = path.join(ROOT, "netlify/functions/hub-quote-manual-step.js");

const bridgeSrc = fs.readFileSync(bridgePath, "utf8");
const publicSrc = fs.readFileSync(publicStatusPath, "utf8");
const hubSrc = fs.readFileSync(hubStepPath, "utf8");

let passed = 0;
function pass(name) {
  passed += 1;
  console.log(`PASS ${name}`);
}

assert.ok(bridgeSrc.includes("bridgeAcceptedQuoteToProject"), "exports project bridge");
pass("bridgeAcceptedQuoteToProject present");

assert.ok(
  bridgeSrc.includes("bridgeAcceptedQuoteToProjectAndInvoice"),
  "compat alias retained"
);
pass("compat alias retained");

assert.ok(!/invoices\?/.test(bridgeSrc), "bridge must not query invoices table");
pass("no invoices? query in bridge");

assert.ok(!/status:\s*"DRAFT"/.test(bridgeSrc), "no DRAFT invoice insert");
pass("no DRAFT invoice insert");

assert.ok(!/type:\s*"FINAL"/.test(bridgeSrc), "no FINAL invoice insert");
pass("no FINAL invoice insert");

assert.ok(!/makePublicToken\("inv"\)/.test(bridgeSrc), "no inv public token mint");
pass("no invoice public_token mint");

assert.ok(
  !/method:\s*"POST"[\s\S]{0,200}invoices|invoices[\s\S]{0,80}method:\s*"POST"/.test(bridgeSrc),
  "no invoices POST"
);
pass("no invoices POST pattern");

assert.ok(publicSrc.includes("bridgeAcceptedQuoteToProject"), "public accept uses project bridge");
pass("public accept imports project bridge");

assert.ok(publicSrc.includes("already_accepted"), "public accept idempotent path");
pass("public already_accepted path");

assert.ok(publicSrc.includes("quoteAlreadyAccepted"), "detects prior acceptance");
pass("quoteAlreadyAccepted helper");

assert.ok(
  !publicSrc.includes("bridgeAcceptedQuoteToProjectAndInvoice"),
  "public accept does not use deprecated invoice name"
);
pass("public accept dropped invoice-named import");

assert.ok(hubSrc.includes("bridgeAcceptedQuoteToProject"), "hub uses project bridge");
pass("hub imports project bridge");

assert.ok(hubSrc.includes("invoice_required") || hubSrc.includes("Create an invoice in Invoice Hub"), "hub requires Hub invoice");
pass("hub check_pending/deposit require existing invoice");

assert.ok(
  !/await bridgeAcceptedQuoteToProjectAndInvoice/.test(hubSrc),
  "hub no longer calls invoice-named bridge"
);
pass("hub dropped invoice-named bridge calls");

const bridgeMod = require("../netlify/functions/_lib/quote-accept-bridge");
assert.strictEqual(
  typeof bridgeMod.bridgeAcceptedQuoteToProject,
  "function",
  "project bridge export"
);
pass("project bridge is function");
assert.strictEqual(
  typeof bridgeMod.bridgeAcceptedQuoteToProjectAndInvoice,
  "function",
  "compat export"
);
pass("compat export is function");

console.log(`\nCH-009-P2B QA: ${passed} assertions passed`);
