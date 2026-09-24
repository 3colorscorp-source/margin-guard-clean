#!/usr/bin/env node
/**
 * Owner Preview price-writer freeze contract.
 * The PR #113 MutationObserver re-entered after the writing flag dropped,
 * because textContent was assigned even when unchanged.
 * Run: node scripts/test-seller-owner-price-observer-freeze.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function assert(label, cond) {
  if (!cond) throw new Error("FAIL " + label);
  console.log("PASS " + label);
}

function money(amount, currency) {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency || "USD",
    }).format(Number(amount || 0));
  } catch (_error) {
    return "$" + Number(amount || 0).toFixed(2);
  }
}

function parseSellerMoneyTextToNumber(text) {
  const raw = String(text == null ? "" : text).replace(/[^0-9.\-]/g, "");
  const value = Number(raw);
  return Number.isFinite(value) ? value : 0;
}

function readSellerCurrencyFromDisplayText(text) {
  const raw = String(text == null ? "" : text).trim();
  if (!raw || raw === "—") return "";
  if (/MX\$|MXN|pesos?\s*mex/i.test(raw)) return "MXN";
  if (/USD|US\$/i.test(raw)) return "USD";
  if (/\$/.test(raw) && !/MX/i.test(raw)) return "USD";
  return "";
}

function coerce(text, tenant) {
  const raw = String(text == null ? "" : text);
  const trimmed = raw.trim();
  if (!tenant || !trimmed || trimmed === "—") return raw;
  const shown = readSellerCurrencyFromDisplayText(trimmed);
  if (!shown || shown === tenant) return raw;
  return money(parseSellerMoneyTextToNumber(trimmed), tenant);
}

function simulateBeforeObserverCycle(initialText, tenant) {
  const node = { textContent: initialText };
  let writes = 0;
  let writing = false;
  const queued = [];
  const MAX = 80;

  function write(value) {
    const text = coerce(value, tenant);
    writing = true;
    writes += 1;
    node.textContent = text;
    queued.push(observer);
    writing = false;
  }

  function observer() {
    if (writing) return;
    write(node.textContent);
  }

  write(initialText);
  while (queued.length && writes < MAX) queued.shift()();
  return { writes, stopped: queued.length === 0, text: node.textContent };
}

function createBoundedSurface(initialText, tenant) {
  const node = { textContent: initialText };
  let writes = 0;
  let paintActive = false;

  function assign(text) {
    if (node.textContent === text) return false;
    writes += 1;
    node.textContent = text;
    return true;
  }

  function write(value) {
    assign(coerce(value, tenant));
  }

  function paint() {
    if (paintActive) return false;
    if (!tenant) return false;
    paintActive = true;
    try {
      write(node.textContent);
      return true;
    } finally {
      paintActive = false;
    }
  }

  return {
    node,
    paint,
    lateWriter(value) {
      write(value);
    },
    rawWriter(value) {
      assign(String(value == null ? "" : value));
    },
    writes: () => writes,
  };
}

function main() {
  let n = 0;
  function pass(label, cond) {
    n += 1;
    assert(label, cond);
  }

  const salesHtml = read("public/sales.html");
  const usd = money(4365.09, "USD");
  const mxn = money(4365.09, "MXN");

  const before = simulateBeforeObserverCycle(usd, "USD");
  pass(
    "before: always-write observer does not stop after identical USD paint",
    before.writes >= 80 && before.stopped === false
  );
  pass("before: cycle keeps USD text while spinning", before.text === usd);

  const surface = createBoundedSurface(mxn, "USD");
  surface.paint();
  pass("hydrate paint corrects stale MXN to USD once", surface.node.textContent === usd && surface.writes() === 1);

  const writesAfterHydrate = surface.writes();
  for (let i = 0; i < 100; i += 1) surface.paint();
  pass(
    "100 repeated renders with the same price produce no new mutations",
    surface.writes() === writesAfterHydrate && surface.node.textContent === usd
  );

  const writesBeforeLate = surface.writes();
  surface.rawWriter(mxn);
  pass(
    "ungarded late MXN write is a single mutation",
    surface.node.textContent === mxn && surface.writes() === writesBeforeLate + 1
  );
  surface.paint();
  pass(
    "late MXN writer on USD tenant is corrected exactly once",
    surface.node.textContent === usd && surface.writes() === writesBeforeLate + 2
  );

  const writesAfterLate = surface.writes();
  surface.lateWriter(mxn);
  surface.lateWriter(usd);
  surface.rawWriter(usd);
  for (let i = 0; i < 20; i += 1) surface.paint();
  pass(
    "after correction the writer does not fire again",
    surface.writes() === writesAfterLate && surface.node.textContent === usd
  );

  const mxnSurface = createBoundedSurface(usd, "MXN");
  mxnSurface.paint();
  const mxnWrites = mxnSurface.writes();
  for (let i = 0; i < 100; i += 1) mxnSurface.paint();
  mxnSurface.rawWriter(usd);
  mxnSurface.paint();
  pass(
    "legitimate MXN tenant stays MXN with bounded writes",
    mxnSurface.node.textContent === mxn && mxnSurface.writes() === mxnWrites + 2
  );

  pass(
    "no observer/render cycle remains in sales.html",
    !/function installSellerAuthoritativePriceWriterGuard/.test(salesHtml) &&
      !/__mgSellerAuthoritativePriceObserver/.test(salesHtml) &&
      !/function observeSellerAuthoritativePriceNode/.test(salesHtml)
  );
  pass(
    "identical textContent is not written",
    /function writeSellerAuthoritativePriceText\([\s\S]*if \(list\[i\]\.textContent === text\) continue;/.test(
      salesHtml
    )
  );
  pass(
    "paint is reentrancy-guarded and finite",
    /function paintSellerAuthoritativePrimaryPricesNow\([\s\S]*if \(window\.__mgSellerAuthoritativePaintActive\) return false;/.test(
      salesHtml
    ) &&
      /window\.__mgSellerAuthoritativePaintActive = false;/.test(salesHtml)
  );
  pass(
    "DOM writes are counted only when text changes",
    /__mgSellerAuthoritativePriceWriteCount[\s\S]*list\[i\]\.textContent = text/.test(salesHtml)
  );
  pass(
    "no polling interval was added for currency correction",
    (function () {
      const start = salesHtml.indexOf("function paintSellerAuthoritativePrimaryPricesNow");
      const slice = start >= 0 ? salesHtml.slice(start, start + 900) : "";
      return start >= 0 && !/setInterval/.test(slice) && !/addEventListener\(\s*['"]resize['"]/.test(slice);
    })()
  );
  pass(
    "immediate tenant paint after hydrate remains",
    /function rememberSellerTenantCurrency\([\s\S]*paintSellerAuthoritativePrimaryPricesNow\(\);/.test(
      salesHtml
    )
  );
  pass(
    "edit/add/remove/voice still preserve currency through the refresh helper",
    /saveSalesState\(state\);\s*refreshSellerFromStandalonePreservingRenderedCurrency\(\);\s*openSalesOpDayEditor/.test(
      salesHtml
    ) &&
      /persistSalesOpDayEditorFromDom\(\);\s*closeSalesOpDayEditor\(\);\s*refreshSellerFromStandalonePreservingRenderedCurrency\(\);/.test(
        salesHtml
      )
  );
  pass("USD formatter remains $ not MX$", /\$/.test(usd) && !/MX/i.test(usd));
  pass("MXN formatter remains MX$", /MX\$|MXN/i.test(mxn));
  pass(
    "before-cycle write count exceeds the after-cycle bound",
    before.writes >= 80 && surface.writes() <= 4
  );

  console.log("\n" + n + " passed");
}

module.exports = {
  simulateBeforeObserverCycle,
  createBoundedSurface,
};

if (require.main === module) {
  main();
}
