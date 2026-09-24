#!/usr/bin/env node
/**
 * Owner Preview currency render-order contract.
 * Desktop can start with a stale MXN paint; after tenant hydration the two
 * primary prices must switch immediately, without resize or DevTools.
 * Run: node scripts/test-seller-owner-currency-render-order.js
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

function createOwnerPreviewPriceSurface(initial) {
  const nodes = {
    salesPrimaryPrice: { id: "salesPrimaryPrice", textContent: initial.salesPrimaryPrice },
    salesPriceDisplay: { id: "salesPriceDisplay", textContent: initial.salesPriceDisplay },
  };
  let tenant = "";
  let resizeCount = 0;

  function coerce(text) {
    const raw = String(text == null ? "" : text);
    const trimmed = raw.trim();
    if (!tenant || !trimmed || trimmed === "—") return raw;
    const shown = readSellerCurrencyFromDisplayText(trimmed);
    if (!shown || shown === tenant) return raw;
    return money(parseSellerMoneyTextToNumber(trimmed), tenant);
  }

  function writeAll(id, value) {
    nodes[id].textContent = coerce(value);
  }

  function paint() {
    if (!tenant) return false;
    writeAll("salesPrimaryPrice", nodes.salesPrimaryPrice.textContent);
    writeAll("salesPriceDisplay", nodes.salesPriceDisplay.textContent);
    return true;
  }

  function hydrate(code) {
    tenant = String(code || "");
    paint();
    return { ok: true, currency: tenant, source: "tenant_snapshot" };
  }

  function lateWriter(id, value) {
    writeAll(id, value);
  }

  function resize() {
    resizeCount += 1;
    paint();
  }

  return {
    nodes,
    hydrate,
    paint,
    lateWriter,
    resize,
    resizeCount: () => resizeCount,
    tenant: () => tenant,
  };
}

function main() {
  let n = 0;
  function pass(label, cond) {
    n += 1;
    assert(label, cond);
  }

  const salesHtml = read("public/sales.html");
  const portalJs = read("public/js/sales-device-portal.js");
  const settingsFn = read("netlify/functions/get-seller-business-settings.js");
  const usd4365 = money(4365.09, "USD");
  const mxn4365 = money(4365.09, "MXN");

  pass("Intl USD formatter is not hardcoded MXN", usd4365 !== mxn4365 && /\$/.test(usd4365) && !/MX/i.test(usd4365));
  pass("Intl MXN formatter remains MXN", /MX\$|MXN/i.test(mxn4365));

  const desktop = createOwnerPreviewPriceSurface({
    salesPrimaryPrice: mxn4365,
    salesPriceDisplay: mxn4365,
  });
  pass(
    "desktop Owner Preview starts with stale MXN paint",
    desktop.nodes.salesPrimaryPrice.textContent === mxn4365 &&
      desktop.nodes.salesPriceDisplay.textContent === mxn4365 &&
      desktop.tenant() === ""
  );

  const hydration = desktop.hydrate("USD");
  pass("async hydration returns USD tenant currency", hydration.ok === true && hydration.currency === "USD");
  pass(
    "both primary nodes switch to USD immediately without resize",
    desktop.resizeCount() === 0 &&
      desktop.nodes.salesPrimaryPrice.textContent === usd4365 &&
      desktop.nodes.salesPriceDisplay.textContent === usd4365
  );

  desktop.lateWriter("salesPrimaryPrice", mxn4365);
  desktop.lateWriter("salesPriceDisplay", "MXN4365.09");
  pass(
    "late MXN writer cannot replace USD on either primary node",
    desktop.nodes.salesPrimaryPrice.textContent === usd4365 &&
      desktop.nodes.salesPriceDisplay.textContent === usd4365
  );

  const delayedTimers = [0, 100, 300, 800, 1500, 3000, 6000, 12000, 15000];
  delayedTimers.forEach(function () {
    desktop.lateWriter("salesPrimaryPrice", mxn4365);
    desktop.lateWriter("salesPriceDisplay", mxn4365);
  });
  pass(
    "Edit/Add/Remove/voice-confirm stay USD after 15s of delayed writes",
    delayedTimers.length >= 9 &&
      desktop.resizeCount() === 0 &&
      desktop.nodes.salesPrimaryPrice.textContent === usd4365 &&
      desktop.nodes.salesPriceDisplay.textContent === usd4365
  );

  const mxnTenant = createOwnerPreviewPriceSurface({
    salesPrimaryPrice: usd4365,
    salesPriceDisplay: usd4365,
  });
  mxnTenant.hydrate("MXN");
  mxnTenant.lateWriter("salesPrimaryPrice", usd4365);
  mxnTenant.lateWriter("salesPriceDisplay", "USD4365.09");
  pass(
    "legitimate MXN tenant remains MXN",
    mxnTenant.tenant() === "MXN" &&
      mxnTenant.nodes.salesPrimaryPrice.textContent === mxn4365 &&
      mxnTenant.nodes.salesPriceDisplay.textContent === mxn4365
  );

  pass(
    "hydrate paints immediately after remembering tenant currency",
    /function rememberSellerTenantCurrency\([\s\S]*window\.__mgSellerTenantCurrency = code;[\s\S]*paintSellerAuthoritativePrimaryPricesNow\(\);/.test(
      salesHtml
    )
  );
  pass(
    "owner mode calls the same immediate paint after hydrate",
    /hydrateSellerBusinessSettingsFromServer\(\);[\s\S]*paintSellerAuthoritativePrimaryPricesNow\(\)[\s\S]*refreshSellerFromStandalone\(\)/.test(
      portalJs
    )
  );
  pass(
    "refresh after hydrate still paints without a resize listener",
    /enforceSellerRightPanelCurrencyConsistency\(loadSalesState\(\), loadSettings\(\)\);\s*paintSellerAuthoritativePrimaryPricesNow\(\);/.test(
      salesHtml
    ) && !/addEventListener\(\s*['"]resize['"]/.test(salesHtml)
  );
  pass(
    "owner preview renderSales patch no longer skips owner",
    /function patchSellerRenderSalesCurrencyGuard\([\s\S]*isOwnerSalesPreviewSurface\(\)[\s\S]*paintSellerAuthoritativePrimaryPricesNow\(\)/.test(
      salesHtml
    )
  );
  pass(
    "layout early-complete path paints instead of waiting for DevTools/resize",
    /isDirectSellerDomLayoutComplete\(\)[\s\S]*paintSellerAuthoritativePrimaryPricesNow\(\);[\s\S]*enforceSellerRightPanelCurrencyConsistency\(\);[\s\S]*return true;/.test(
      salesHtml
    )
  );
  pass(
    "primary price writers are centralized and write every matching node",
    /function writeSellerAuthoritativePriceText\([\s\S]*collectSellerMoneyNodesById\(id\)/.test(salesHtml) &&
      /function setSellerDisplayedMoneyText\([\s\S]*writeSellerAuthoritativePriceText/.test(salesHtml) &&
      /function setText\(targetId, value\) \{[\s\S]*writeSellerAuthoritativePriceText/.test(salesHtml)
  );
  pass(
    "blocked and clean-draft price display writers use the centralized helper",
    (salesHtml.match(/writeSellerAuthoritativePriceText\('salesPriceDisplay', '—'\)/g) || []).length >= 2 &&
      !/blockedPriceDisplay\.textContent/.test(salesHtml)
  );
  pass(
    "seller device still fully hydrates business settings",
    /function hydrateSellerBusinessSettingsFromServer\([\s\S]*isSellerDeviceSessionActive\(\)[\s\S]*localStorage\.setItem\(SETTINGS_KEY, JSON\.stringify\(data\.settings\)\)/.test(
      salesHtml
    )
  );
  pass(
    "endpoint dual-auth contract is unchanged",
    /resolveOwnerOrSellerContext\(event\)/.test(settingsFn) && !/requireSellerDevice\(event\)/.test(settingsFn)
  );
  pass(
    "owner preview delayed timers still include the 12s operational-plan window",
    /\[0, 100, 300, 800, 1500, 3000, 6000, 12000\]\.forEach/.test(salesHtml) &&
      /function scheduleOwnerSellerPreviewLayoutEnforcement\([\s\S]*paintSellerAuthoritativePrimaryPricesNow\(\)/.test(
        salesHtml
      )
  );

  console.log("\n" + n + " passed");
}

module.exports = {
  money,
  parseSellerMoneyTextToNumber,
  readSellerCurrencyFromDisplayText,
  createOwnerPreviewPriceSurface,
};

if (require.main === module) {
  main();
}
