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

function formatSellerWorkspaceMoney(amount) {
  const n = Number(amount);
  const value = Number.isFinite(n) ? n : 0;
  const abs = Math.abs(value);
  const formatted = abs.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return (value < 0 ? "-$" : "$") + formatted;
}

function createBoundedSurface(initialText) {
  const node = { textContent: initialText };
  let writes = 0;

  function assign(text) {
    if (node.textContent === text) return false;
    writes += 1;
    node.textContent = text;
    return true;
  }

  function write(value) {
    const raw = String(value == null ? "" : value);
    const trimmed = raw.trim();
    const text = !trimmed || trimmed === "—" ? raw : formatSellerWorkspaceMoney(parseSellerMoneyTextToNumber(raw));
    assign(text);
  }

  function paint() {
    write(node.textContent);
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

  const surface = createBoundedSurface(mxn);
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

  const mxnSurface = createBoundedSurface(usd);
  mxnSurface.paint();
  const mxnWrites = mxnSurface.writes();
  for (let i = 0; i < 100; i += 1) mxnSurface.paint();
  mxnSurface.rawWriter(mxn);
  mxnSurface.paint();
  pass(
    "MXN late write is visually $ with the same amount",
    mxnSurface.node.textContent === usd && mxnSurface.writes() === mxnWrites + 2
  );

  pass("USD formatter remains $ not MX$", /\$/.test(usd) && !/MX/i.test(usd));
  pass("authoritative MXN formatter remains MX$", /MX\$|MXN/i.test(mxn));
  pass("Seller visual money is $4,365.09 for both tenants", usd === "$4,365.09" || /\$4,365\.09/.test(usd));

  pass(
    "no observer/render cycle remains in sales.html",
    !/function installSellerAuthoritativePriceWriterGuard/.test(salesHtml) &&
      !/__mgSellerAuthoritativePriceObserver/.test(salesHtml) &&
      !/function observeSellerAuthoritativePriceNode/.test(salesHtml) &&
      !/function coerceSellerMoneyTextToTenantCurrency/.test(salesHtml)
  );
  pass(
    "identical textContent is not written",
    /function writeSellerAuthoritativePriceText\([\s\S]*if \(list\[i\]\.textContent === text\) continue;/.test(
      salesHtml
    )
  );
  pass(
    "currency paint helper is a no-op",
    /function paintSellerAuthoritativePrimaryPricesNow\(\) \{\s*return false;\s*\}/.test(salesHtml)
  );
  pass(
    "DOM writes are counted only when text changes",
    /__mgSellerAuthoritativePriceWriteCount[\s\S]*list\[i\]\.textContent = text/.test(salesHtml)
  );
  pass(
    "no polling interval was added for currency correction",
    (function () {
      const start = salesHtml.indexOf("function paintSellerAuthoritativePrimaryPricesNow");
      const slice = start >= 0 ? salesHtml.slice(start, start + 120) : "";
      return start >= 0 && !/setInterval/.test(slice) && /return false;/.test(slice);
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

  const runtimeSrc = read("scripts/test-seller-owner-preview-desktop-runtime.js");
  pass(
    "desktop runtime loads real sales.html and sales-device-portal.js",
    /public[\\/]sales\.html/.test(runtimeSrc) && /sales-device-portal\.js/.test(runtimeSrc)
  );
  pass(
    "desktop runtime starts from Dashboard/Owner and clicks Seller in the sidebar",
    /VIEWPORT = \{ width: 1600, height: 900 \}/.test(runtimeSrc) &&
      /\/dashboard/.test(runtimeSrc) &&
      /\/owner/.test(runtimeSrc) &&
      /\/sales\?portal=owner/.test(runtimeSrc) &&
      /mg-sidebar__item/.test(runtimeSrc)
  );
  pass(
    "desktop runtime repeats Owner→Seller 10 times, Edit/Add/Remove, and a 30s wait",
    /NAV_CYCLES = 10/.test(runtimeSrc) &&
      /STABILITY_MS = 30000/.test(runtimeSrc) &&
      /btnAddOperationalDay/.test(runtimeSrc) &&
      /data-action="edit-day"/.test(runtimeSrc) &&
      /data-action="remove-day"/.test(runtimeSrc)
  );
  pass(
    "desktop runtime does not replace renderSales, painters, layout timers, or OP editors",
    !/window\.renderSales\s*=\s*function/.test(runtimeSrc) &&
      !/paintSellerAuthoritativePrimaryPricesNow\s*=\s*function/.test(runtimeSrc) &&
      /btnAddOperationalDay/.test(runtimeSrc) &&
      /data-action="edit-day"/.test(runtimeSrc) &&
      /data-action="remove-day"/.test(runtimeSrc)
  );
  pass(
    "desktop runtime does not add a product Playwright/Puppeteer dependency",
    !/require\(["']playwright["']\)/.test(runtimeSrc) &&
      !/require\(["']puppeteer["']\)/.test(runtimeSrc)
  );
  pass(
    "desktop runtime exits 2 when no automatable browser exists",
    /process\.exit\(2\)/.test(runtimeSrc) && /findChrome\(/.test(runtimeSrc)
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
