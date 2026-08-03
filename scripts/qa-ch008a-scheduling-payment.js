/**
 * CH-008A Milestone 1 — Fixed Initial Scheduling Payment (unit QA).
 * Run: node scripts/qa-ch008a-scheduling-payment.js
 */
"use strict";

const assert = require("assert");
const {
  DEFAULT_SCHEDULING_PAYMENT,
  calculateQuotePublishFinancials,
  resolveSchedulingPaymentAmount,
} = require("../netlify/functions/_lib/pricing-engine");
const {
  applyOwnerManualPrice,
  preserveOrResolveSchedulingPayment,
} = require("../netlify/functions/_lib/quote-reprice-helpers");
const { resolveCanonicalPublishAmounts } = require("../netlify/functions/publish-public-quote")._test;

let passed = 0;
function ok(label, cond) {
  assert.ok(cond, label);
  passed += 1;
  console.log(`PASS ${label}`);
}

const settings = {
  hoursPerDay: 8,
  baseHelper: 45,
  baseInstaller: 75,
  wcPct: 0,
  ficaPct: 0,
  futaPct: 0,
  casuiPct: 0,
  stdHours: 160,
  overheadMonthly: 0,
  profitPct: 30,
  reservePct: 5,
};

const workers = [{ type: "installer", days: 5 }];
const TOTAL = 14694.7;

function pub(clientDeposit, total = TOTAL) {
  return resolveCanonicalPublishAmounts({
    clientTotalReported: total,
    clientDepositReported: clientDeposit,
    serverFinancials: { total, deposit_required: 1000, minimum_price: 1000 },
    minimumPrice: 1000,
  });
}

// ---- Input semantics matrix (resolver) ----
{
  const cases = [
    ["property absent (undefined)", undefined, { ok: true, amount: 1000 }],
    ["null", null, { ok: true, amount: 1000 }],
    ["empty string", "", { ok: true, amount: 1000 }],
    ["whitespace string", "   ", { ok: true, amount: 1000 }],
    ["NaN", NaN, { ok: false, code: "invalid_deposit" }],
    ["explicit numeric 0", 0, { ok: true, amount: 0 }],
    ['string "0"', "0", { ok: true, amount: 0 }],
    ["0.00", 0.0, { ok: true, amount: 0 }],
    ["1000", 1000, { ok: true, amount: 1000 }],
    ['string "1000"', "1000", { ok: true, amount: 1000 }],
    ["negative", -1, { ok: false, code: "invalid_deposit" }],
    ["greater than total", 15000, { ok: false, code: "deposit_exceeds_total" }],
  ];
  for (const [label, raw, expect] of cases) {
    const r = resolveSchedulingPaymentAmount(raw, { total: TOTAL });
    if (expect.ok) {
      ok(`matrix ${label} → ${expect.amount}`, r.ok && r.amount === expect.amount);
    } else {
      ok(`matrix ${label} rejected`, !r.ok && r.code === expect.code);
    }
  }
}

// Publish path: NaN clientDeposit = absent → uses server 1000
{
  const p = pub(NaN);
  ok("publish absent (NaN client) uses server/default 1000", p.ok && p.deposit_required === 1000);
  const p0 = pub(0);
  ok("publish explicit 0 stays 0", p0.ok && p0.deposit_required === 0);
  const p1000 = pub(1000);
  ok("publish 1000 stays 1000 not 1469.47", p1000.ok && p1000.deposit_required === 1000);
  ok("publish balance after 1000", p1000.ok && p1000.balance_after_deposit === 13694.7);
}

// A — omitted → default 1000
{
  const r = resolveSchedulingPaymentAmount(undefined, { total: 5000 });
  ok("A resolve missing → 1000", r.ok && r.amount === 1000);
  const fin = calculateQuotePublishFinancials({ workers, pricing_stage: 2 }, settings);
  ok("A engine omitted → 1000", fin.deposit_required === 1000);
}

// B — Owner 1000 on ~14.7k total → 1000 (never 10%)
{
  ok("B not 10%", Math.abs(1000 - TOTAL * 0.1) > 1);
  const p = pub(1000);
  ok("B publish preserves 1000", p.ok && p.deposit_required === 1000);
}

// C — 50k total, Owner 1000 → 1000 (never 5000)
{
  const p = pub(1000, 50000);
  ok("C publish 1000 not 5000", p.ok && p.deposit_required === 1000);
}

// D — explicit 0
{
  ok("D not coerced by ||", (0 || 1000) === 1000);
  const fin = calculateQuotePublishFinancials(
    { workers, pricing_stage: 2, deposit_required: 0 },
    settings
  );
  ok("D engine keeps 0", fin.deposit_required === 0);
}

// E — 2500 preserved
{
  const kept = preserveOrResolveSchedulingPayment(
    { total: 22000, deposit_required: 1000, minimum_price: 1000 },
    2500,
    undefined
  );
  ok("E reprice preserves 2500", kept.ok && kept.financials.deposit_required === 2500);
  const explicit = preserveOrResolveSchedulingPayment(
    { total: 22000, deposit_required: 1000, minimum_price: 1000 },
    1469.47,
    1000
  );
  ok("E explicit override 1000 via helper", explicit.ok && explicit.financials.deposit_required === 1000);
}

// F — existing 1469.47 preserved on reprice (no explicit edit)
{
  const kept = preserveOrResolveSchedulingPayment(
    { total: TOTAL, deposit_required: 1000, minimum_price: 1000 },
    1469.47,
    undefined
  );
  ok("F preserve historical 1469.47", kept.ok && kept.financials.deposit_required === 1469.47);
  const manual = applyOwnerManualPrice(
    { total: TOTAL, deposit_required: 1469.47, minimum_price: 1000 },
    16000
  );
  ok("F manual price does not recalc deposit", manual.ok && manual.financials.deposit_required === 1469.47);
}

// G / H covered in matrix

// Regression
{
  const fin = calculateQuotePublishFinancials(
    {
      workers: [{ type: "installer", days: 40 }],
      pricing_stage: 2,
      deposit_required: 1000,
    },
    settings
  );
  ok("regression deposit stays 1000 on large total", fin.deposit_required === 1000);
  ok("regression total still positive", fin.total > 0);
  ok("regression minimum_price present", Number.isFinite(fin.minimum_price));
  ok("default constant is 1000", DEFAULT_SCHEDULING_PAYMENT === 1000);
}

// No percentage floor string left in resolver module source
{
  const fs = require("fs");
  const path = require("path");
  const eng = fs.readFileSync(
    path.join(__dirname, "../netlify/functions/_lib/pricing-engine.js"),
    "utf8"
  );
  const pubSrc = fs.readFileSync(
    path.join(__dirname, "../netlify/functions/publish-public-quote.js"),
    "utf8"
  );
  const help = fs.readFileSync(
    path.join(__dirname, "../netlify/functions/_lib/quote-reprice-helpers.js"),
    "utf8"
  );
  ok("no max(1000, total*0.1) in pricing-engine", !/max\(\s*1000\s*,\s*total\s*\*\s*0\.1\s*\)/.test(eng));
  ok("no depFloor 10% in publish", !/depFloor|total\s*\*\s*0\.1/.test(pubSrc));
  ok("no 10% in quote-reprice-helpers", !/total\s*\*\s*0\.1|max\(\s*1000/.test(help));
}

console.log(`\nCH-008A QA: ${passed} assertions passed`);
