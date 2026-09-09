#!/usr/bin/env node
/**
 * Owner send price-guard contract — isolated source assertions.
 * Replaces the obsolete CH-014 Owner assertion (soldPriceGuard/currentMetrics).
 * Does not modify product. No network, secrets, quotes, or tenant writes.
 * Run: node scripts/test-owner-send-price-guard.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

let passed = 0;
function ok(label, cond) {
  assert.ok(cond, label);
  passed += 1;
  console.log("PASS " + label);
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function extractFunction(src, name) {
  const start = src.indexOf("function " + name + "(");
  assert.ok(start >= 0, "missing function " + name);
  const paren = src.indexOf("(", start);
  let depth = 0;
  let closeParen = -1;
  for (let i = paren; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        closeParen = i;
        break;
      }
    }
  }
  assert.ok(closeParen > 0, "missing params for " + name);
  const bodyStart = src.indexOf("{", closeParen);
  assert.ok(bodyStart > 0, "missing body for " + name);
  depth = 0;
  for (let i = bodyStart; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error("unterminated function " + name);
}

const appJs = read("public/js/app.js");
const ch014 = read("scripts/qa-ch014-send-quote-price-guard.js");
const openSend = extractFunction(appJs, "openSendModal");
const sendQuote = extractFunction(appJs, "sendQuote");
const evaluateGuard = extractFunction(appJs, "evaluateSendQuotePriceGuard");
const resolveVisible = extractFunction(appJs, "resolveVisibleSendQuoteMetrics");

ok(
  "openSendModal calls evaluateSendQuotePriceGuard",
  openSend.indexOf("evaluateSendQuotePriceGuard(") >= 0
);
ok(
  "openSendModal uses resolveVisibleSendQuoteMetrics",
  openSend.indexOf("resolveVisibleSendQuoteMetrics(") >= 0
);
ok(
  "openSendModal nests resolveVisible inside the guard",
  /evaluateSendQuotePriceGuard\(\s*resolveVisibleSendQuoteMetrics\(/.test(openSend)
);
ok(
  "sendQuote calls evaluateSendQuotePriceGuard",
  sendQuote.indexOf("evaluateSendQuotePriceGuard(") >= 0
);
ok(
  "sendQuote uses resolveVisibleSendQuoteMetrics",
  sendQuote.indexOf("resolveVisibleSendQuoteMetrics(") >= 0
);
ok(
  "sendQuote nests resolveVisible inside the guard",
  /evaluateSendQuotePriceGuard\(\s*resolveVisibleSendQuoteMetrics\(/.test(sendQuote)
);
ok(
  "Owner portal sendQuote delegates to runOwnerSellerPublicSend",
  /if \(\$\("ownerKpis"\)\) \{[\s\S]*runOwnerSellerPublicSend\(\)/.test(sendQuote)
);
ok(
  "window.__mgEvaluateSendQuotePriceGuard is assigned",
  appJs.indexOf("window.__mgEvaluateSendQuotePriceGuard = evaluateSendQuotePriceGuard") >= 0
);
ok("evaluateSendQuotePriceGuard reads metrics.offered", evaluateGuard.indexOf("metrics.offered") >= 0);
ok("evaluateSendQuotePriceGuard reads metrics.minimum", evaluateGuard.indexOf("metrics.minimum") >= 0);
ok(
  "resolveVisibleSendQuoteMetrics rebuilds Owner KPIs",
  resolveVisible.indexOf('$("ownerKpis")') >= 0 && resolveVisible.indexOf("calcOwner(") >= 0
);
ok("obsolete soldPriceGuard identifier is gone", appJs.indexOf("soldPriceGuard") < 0);
ok(
  "obsolete currentMetrics guard call is gone",
  !/evaluateSendQuotePriceGuard\(\s*currentMetrics/.test(appJs)
);
ok("legacy Price too low copy is gone", !/Price too low/.test(appJs));
ok("marginBlocked does not hard-block send", !/metrics\?\.marginBlocked/.test(appJs));
ok(
  "CH-014 still contains the obsolete Owner assertion for history",
  ch014.indexOf("const soldPriceGuard = evaluateSendQuotePriceGuard(currentMetrics, {") >= 0
);
ok(
  "this suite replaces CH-014 Owner coverage",
  ch014.indexOf("13 owner portal send paths use the shared guard") >= 0
);

console.log("\nOwner send price guard: " + passed + " passed");
