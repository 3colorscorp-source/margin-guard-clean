/**
 * CH-014 — Send Quote hard block must match the visible numeric Minimum floor.
 * Run: node scripts/qa-ch014-send-quote-price-guard.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function checkSyntax(rel) {
  const r = spawnSync(process.execPath, ["--check", path.join(ROOT, rel)], { encoding: "utf8" });
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || rel);
}

/** Slice a top-level function declaration out of a source file by brace matching. */
function extractFunction(source, name) {
  const start = source.indexOf("function " + name + "(");
  assert.ok(start >= 0, "function not found: " + name);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error("unbalanced braces for " + name);
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log("PASS", name);
    passed += 1;
  } catch (err) {
    console.log("FAIL", name, "-", err.message);
    failed += 1;
  }
}

const appJs = read("public/js/app.js");
const salesHtml = read("public/sales.html");

const usd = (value) => "$" + Number(value).toFixed(2);

// Shared guard from public/js/app.js.
const invalidMessageDecl = appJs.match(/const SEND_QUOTE_PRICE_INVALID_MESSAGE = "[^"]+";/);
assert.ok(invalidMessageDecl, "SEND_QUOTE_PRICE_INVALID_MESSAGE declaration not found in app.js");
const appGuard = new Function(
  invalidMessageDecl[0] +
    extractFunction(appJs, "evaluateSendQuotePriceGuard") +
    "; return evaluateSendQuotePriceGuard;"
)();

// Seller fallback branch from public/sales.html, evaluated with app.js absent.
const sellerGuardFallback = (function () {
  const src = extractFunction(salesHtml, "evaluateSellerSendPriceGuard");
  const factory = new Function(
    "window",
    "sellerMoney",
    "round2",
    src + "; return evaluateSellerSendPriceGuard;"
  );
  return factory(
    {},
    (amount) => usd(amount),
    (value) => Math.round(Number(value || 0) * 100) / 100
  );
})();

const guards = [
  ["app.js", (metrics) => appGuard(metrics, { formatCurrency: usd })],
  ["sales.html fallback", (metrics) => sellerGuardFallback(metrics, {}, {})]
];

function forEachGuard(fn) {
  guards.forEach(([label, run]) => fn(run, label));
}

test("syntax check touched client files", () => {
  checkSyntax("public/js/app.js");
});

test("1 current 4898.23 / recommended 4898.23 / minimum 4353.98 is allowed", () => {
  forEachGuard((run, label) => {
    const res = run({ offered: 4898.23, recommended: 4898.23, minimum: 4353.98, marginBlocked: true });
    assert.strictEqual(res.ok, true, label + ": " + res.message);
    assert.strictEqual(res.effectivePrice, 4898.23, label);
    assert.strictEqual(res.minimumFloor, 4353.98, label);
  });
});

test("2 current exactly at the minimum is allowed", () => {
  forEachGuard((run, label) => {
    const res = run({ offered: 4353.98, recommended: 4898.23, minimum: 4353.98 });
    assert.strictEqual(res.ok, true, label + ": " + res.message);
  });
});

test("3 current one cent below the minimum is blocked", () => {
  forEachGuard((run, label) => {
    const res = run({ offered: 4353.97, recommended: 4898.23, minimum: 4353.98 });
    assert.strictEqual(res.ok, false, label);
    assert.strictEqual(res.code, "below_minimum", label);
  });
});

test("4 below-floor message shows current, minimum and difference", () => {
  forEachGuard((run, label) => {
    const res = run({ offered: 4353.97, recommended: 4898.23, minimum: 4353.98 });
    assert.ok(res.message.startsWith("Quote price is below the minimum."), label);
    assert.ok(res.message.includes("Current: $4353.97"), label + " current: " + res.message);
    assert.ok(res.message.includes("Minimum: $4353.98"), label + " minimum: " + res.message);
    assert.ok(res.message.includes("Difference: $0.01"), label + " difference: " + res.message);
    assert.strictEqual(res.difference, 0.01, label);
  });
});

test("5 blank current price reports missing or invalid", () => {
  forEachGuard((run, label) => {
    const res = run({ offered: "", recommended: "", minimum: 4353.98 });
    assert.strictEqual(res.ok, false, label);
    assert.strictEqual(res.code, "missing_price", label);
    assert.strictEqual(res.message, "Quote price is missing or invalid.", label);
    assert.ok(!/too low/i.test(res.message), label);
  });
});

test("6 NaN current price reports missing or invalid", () => {
  forEachGuard((run, label) => {
    const res = run({ offered: NaN, recommended: Number("abc"), minimum: 4353.98 });
    assert.strictEqual(res.code, "missing_price", label);
    assert.strictEqual(res.message, "Quote price is missing or invalid.", label);
  });
});

test("7 zero current price reports missing or invalid", () => {
  forEachGuard((run, label) => {
    const res = run({ offered: 0, recommended: 0, minimum: 4353.98 });
    assert.strictEqual(res.code, "missing_price", label);
    assert.strictEqual(res.message, "Quote price is missing or invalid.", label);
  });
});

test("7b recommended is used when offered is not a usable number", () => {
  forEachGuard((run, label) => {
    const res = run({ offered: null, recommended: 4898.23, minimum: 4353.98 });
    assert.strictEqual(res.ok, true, label);
    assert.strictEqual(res.effectivePrice, 4898.23, label);
  });
});

test("7c formatted currency strings are never parsed as the price", () => {
  forEachGuard((run, label) => {
    const res = run({ offered: "$4,898.23", recommended: "$4,898.23", minimum: 4353.98 });
    assert.strictEqual(res.code, "missing_price", label);
  });
});

test("8 send paths rebuild metrics from the visible KPI builder before validating", () => {
  assert.ok(appJs.includes("function resolveVisibleSendQuoteMetrics(state, settings, fallbackMetrics)"));
  assert.ok(appJs.includes("window.__mgBuildVisibleSalesMetrics"));
  const rebuiltCalls = appJs.match(/evaluateSendQuotePriceGuard\(resolveVisibleSendQuoteMetrics\(/g) || [];
  assert.ok(rebuiltCalls.length >= 2, "openSendModal and sendQuote must rebuild metrics");
  assert.ok(
    salesHtml.includes("window.__mgBuildVisibleSalesMetrics = function (state, settings) {") &&
      salesHtml.includes("return buildSalesUIMetrics(state, settings || loadSettings());"),
    "seller must expose buildSalesUIMetrics as the visible metrics builder"
  );
});

test("9 no stale zero survives: zero metrics never resolve to an allowed send", () => {
  forEachGuard((run, label) => {
    const stale = run({ offered: 0, recommended: 0, minimum: 0 });
    assert.strictEqual(stale.ok, false, label);
    assert.strictEqual(stale.code, "missing_price", label);
    const fresh = run({ offered: 4898.23, recommended: 4898.23, minimum: 4353.98 });
    assert.strictEqual(fresh.ok, true, label);
  });
});

test("10 KPI Subtotal and guard effective price read metrics.offered", () => {
  assert.ok(salesHtml.includes("{ label: 'Subtotal', value: sellerMoney(offered, settings, state) }"));
  assert.ok(salesHtml.includes("const offered = metrics.offered || metrics.recommended || 0;"));
  const guardSrc = extractFunction(appJs, "evaluateSendQuotePriceGuard");
  assert.ok(guardSrc.includes("Number(metrics && metrics.offered)"));
  assert.ok(guardSrc.includes("Number(metrics && metrics.recommended)"));
});

test("11 KPI Minimum and guard floor read metrics.minimum", () => {
  assert.ok(salesHtml.includes("{ label: 'Minimum', value: sellerMoney(metrics.minimum, settings, state) }"));
  assert.ok(appJs.includes('{ label: "Minimum", value: formatMoney(metrics.minimum) }'));
  assert.ok(extractFunction(appJs, "evaluateSendQuotePriceGuard").includes("Number(metrics && metrics.minimum)"));
});

test("12 seller portal send, publish and sign paths use the shared guard", () => {
  assert.ok(salesHtml.includes("const prePriceGuard = evaluateSellerSendPriceGuard(preMetrics, preSettings, preState);"));
  assert.ok(salesHtml.includes("const sendPriceGuard = evaluateSellerSendPriceGuard(metrics, settings, state);"));
  assert.ok(salesHtml.includes("const publishPriceGuard = evaluateSellerSendPriceGuard(metrics, settings, state);"));
  assert.ok(salesHtml.includes("const signPriceGuard = evaluateSellerSendPriceGuard(metrics, settings, state);"));
  assert.ok(salesHtml.includes("window.__mgEvaluateSendQuotePriceGuard"));
  assert.ok(!/Price too low/.test(salesHtml), "seller must not alert the legacy copy");
});

test("13 owner portal send paths use the shared guard", () => {
  assert.ok(appJs.includes("window.__mgEvaluateSendQuotePriceGuard = evaluateSendQuotePriceGuard;"));
  assert.ok(appJs.includes("const soldPriceGuard = evaluateSendQuotePriceGuard(currentMetrics, {"));
  assert.ok(!/Price too low/.test(appJs), "owner/sales must not alert the legacy copy");
  assert.ok(!/metrics\?\.marginBlocked/.test(appJs), "marginBlocked must not hard-block send");
});

test("14 percentage margin still computes and stays advisory", () => {
  const marginSrc = extractFunction(appJs, "computeSalesMarginDecisionFromEconomics");
  const decide = new Function(
    "finiteNumber",
    "DEFAULTS",
    marginSrc + "; return computeSalesMarginDecisionFromEconomics;"
  )(
    (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback),
    { profitPct: 30, minimumMarginPct: 15 }
  );
  const gate = decide(4898.23, 3628.32, 181.42, { profitPct: 30, minimumMarginPct: 28 });
  assert.ok(Number.isFinite(gate.realMarginPct), "realMarginPct must still compute");
  assert.strictEqual(gate.level, "red");
  // Same economics: advisory red, but the dollar guard still allows the send.
  forEachGuard((run, label) => {
    const res = run({ offered: 4898.23, recommended: 4898.23, minimum: 4353.98 });
    assert.strictEqual(res.ok, true, label);
  });
  assert.ok(appJs.includes("metrics.marginBlocked && Boolean(state?._sliderTouched)"), "advisory copy retained");
  assert.ok(salesHtml.includes("metrics.marginLevel === 'green'"), "advisory margin line retained");
});

test("15 below-minimum protection remains for real underpricing", () => {
  forEachGuard((run, label) => {
    const res = run({ offered: 3000, recommended: 4898.23, minimum: 4353.98 });
    assert.strictEqual(res.ok, false, label);
    assert.strictEqual(res.code, "below_minimum", label);
    assert.strictEqual(res.difference, 1353.98, label);
  });
});

test("16 pricing formulas and out-of-scope areas untouched", () => {
  const diff = spawnSync("git", ["diff", "--name-only"], { cwd: ROOT, encoding: "utf8" });
  assert.strictEqual(diff.status, 0, diff.stderr);
  const changed = diff.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const allowed = new Set(["public/js/app.js", "public/sales.html"]);
  changed.forEach((file) => {
    assert.ok(allowed.has(file), "unexpected modified file: " + file);
  });
  // Pricing formulas unchanged.
  assert.ok(appJs.includes("const minimum = beforeProfit + minimumProfit + reserve;"));
  assert.ok(appJs.includes("const minimum = beforeProfit * (1 + minimumMarginPct / 100 + reservePct / 100);"));
  assert.ok(salesHtml.includes("const minimum = beforeProfit + minimumProfit + reserve;"));
  assert.ok(appJs.includes("const recommended = beforeProfit + recommendedProfit + reserve;"));
});

console.log("\nCH-014 send quote price guard:", passed, "passed,", failed, "failed");
process.exit(failed === 0 ? 0 : 1);
