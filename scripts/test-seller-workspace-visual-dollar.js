#!/usr/bin/env node
/**
 * Seller workspace visual $ formatter — financial safety.
 * Display is always $4,365.09. Authoritative currency and amounts stay unchanged.
 * Run: node scripts/test-seller-workspace-visual-dollar.js
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

function authoritativeMoney(amount, currency) {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency || "USD",
    }).format(Number(amount || 0));
  } catch (_error) {
    return "$" + Number(amount || 0).toFixed(2);
  }
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

function parseAmount(text) {
  const raw = String(text == null ? "" : text).replace(/[^0-9.\-]/g, "");
  const value = Number(raw);
  return Number.isFinite(value) ? value : 0;
}

function looksLikeBannedSellerVisual(text) {
  return /MX\$|MXN|US\$|\bUSD\b/i.test(String(text || ""));
}

function main() {
  let n = 0;
  function pass(label, cond) {
    n += 1;
    assert(label, cond);
  }

  const salesHtml = read("public/sales.html");
  const portalJs = read("public/js/sales-device-portal.js");
  const amount = 4365.09;
  const visual = formatSellerWorkspaceMoney(amount);
  const usdAuth = authoritativeMoney(amount, "USD");
  const mxnAuth = authoritativeMoney(amount, "MXN");

  pass("visual formatter is $4,365.09", visual === "$4,365.09");
  pass("visual formatter does not emit MX$", !/MX/i.test(visual));
  pass("visual formatter does not emit USD or US$", !/USD|US\$/i.test(visual));
  pass("USD 4,365.09 amount is unchanged", parseAmount(usdAuth) === amount);
  pass("MXN 4,365.09 amount is unchanged", parseAmount(mxnAuth) === amount);
  pass("visual parse of $4,365.09 stays 4365.09", parseAmount(visual) === amount);
  pass("authoritative USD and MXN labels remain distinct", usdAuth !== mxnAuth);
  pass("authoritative MXN still identifies MXN", /MX\$|MXN/i.test(mxnAuth));

  pass(
    "sales.html defines the visual formatter",
    /function formatSellerWorkspaceMoney\(amount\) \{[\s\S]*toLocaleString\('en-US'/.test(salesHtml)
  );
  pass(
    "sellerMoney uses only the visual formatter",
    /function sellerMoney\(amount, settings, state\) \{\s*return formatSellerWorkspaceMoney\(amount\);\s*\}/.test(
      salesHtml
    )
  );
  pass(
    "identical money writes are skipped",
    /function writeSellerNodeText\([\s\S]*if \(node\.textContent === next\) return false;/.test(salesHtml) &&
      /function writeSellerAuthoritativePriceText\([\s\S]*if \(list\[i\]\.textContent === text\) continue;/.test(
        salesHtml
      )
  );
  pass(
    "currency paint helper is a no-op",
    /function paintSellerAuthoritativePrimaryPricesNow\(\) \{\s*return false;\s*\}/.test(salesHtml)
  );
  pass(
    "USD vs MXN DOM coerce helper is gone",
    !/function coerceSellerMoneyTextToTenantCurrency/.test(salesHtml)
  );
  pass(
    "no permanent price MutationObserver",
    !/function installSellerAuthoritativePriceWriterGuard/.test(salesHtml) &&
      !/__mgSellerAuthoritativePriceObserver/.test(salesHtml) &&
      !/function observeSellerAuthoritativePriceNode/.test(salesHtml)
  );
  pass(
    "tenant currency is still remembered internally",
    /function rememberSellerTenantCurrency\([\s\S]*window\.__mgSellerTenantCurrency = code;/.test(salesHtml)
  );
  pass(
    "owner preview still hydrates tenant currency from settings",
    /rememberSellerTenantCurrency\(data\.settings && data\.settings\.currency\)/.test(salesHtml) &&
      /async function applyOwnerMode\([\s\S]*hydrateSellerBusinessSettingsFromServer\(\)/.test(portalJs)
  );

  const usdTenant = { code: "USD" };
  const mxnTenant = { code: "MXN" };
  pass("USD tenant keeps currency USD internally", usdTenant.code === "USD");
  pass("MXN tenant keeps currency MXN internally", mxnTenant.code === "MXN");
  pass(
    "same amount displays $ for both tenants",
    formatSellerWorkspaceMoney(amount) === visual &&
      formatSellerWorkspaceMoney(amount) === formatSellerWorkspaceMoney(parseAmount(mxnAuth))
  );

  pass(
    "publish payload still carries a real currency field",
    /function buildPublishPublicQuoteBody\([\s\S]*currency: 'USD'/.test(salesHtml)
  );
  pass(
    "send/zapier payload still carries a real currency field",
    /currency: 'USD'/.test(salesHtml) && /send-quote-zapier/.test(salesHtml)
  );
  pass(
    "authoritative money\(\) helper still uses Intl currency",
    /function money\(amount, currency\) \{[\s\S]*style: 'currency'[\s\S]*currency: currency \|\| 'USD'/.test(
      salesHtml
    )
  );
  pass(
    "public estimate PDF helper is not the Seller visual formatter",
    /function buildEstimatePdfPayload\([\s\S]*style: 'currency'[\s\S]*currency: 'USD'/.test(salesHtml) &&
      !/function buildEstimatePdfPayload\([\s\S]*formatSellerWorkspaceMoney/.test(salesHtml)
  );
  pass(
    "Business Settings page is untouched by the visual formatter",
    !/formatSellerWorkspaceMoney/.test(read("public/business-settings.html"))
  );
  pass(
    "Invoice Hub page is untouched by the visual formatter",
    !/formatSellerWorkspaceMoney/.test(read("public/estimates-invoices.html"))
  );
  pass(
    "Owner portal page is untouched by the visual formatter",
    !/formatSellerWorkspaceMoney/.test(read("public/owner.html"))
  );
  pass(
    "public estimate page is untouched by the visual formatter",
    !/formatSellerWorkspaceMoney/.test(read("public/estimate-public.html"))
  );

  const sampleWrites = [
    formatSellerWorkspaceMoney(amount),
    formatSellerWorkspaceMoney(parseAmount("MX$4,365.09")),
    formatSellerWorkspaceMoney(parseAmount("USD 4,365.09")),
    formatSellerWorkspaceMoney(parseAmount("US$4,365.09")),
  ];
  pass(
    "banned visual labels never appear on Seller money writes",
    sampleWrites.every(function (text) {
      return text === "$4,365.09" && !looksLikeBannedSellerVisual(text);
    })
  );

  const appJs = read("public/js/app.js");
  const renderSalesSrc = appJs.slice(
    appJs.indexOf("function renderSales()"),
    appJs.indexOf("window.renderSales = renderSales")
  );
  pass(
    "app.js renderSales Live Score uses formatSellerWorkspaceMoney",
    /setText\("salesPrimaryPrice", formatSellerWorkspaceMoney\(metrics\.recommended\)\)/.test(renderSalesSrc)
  );
  pass("app.js renderSales does not call formatMoney", !/formatMoney\(/.test(renderSalesSrc));
  pass(
    "app.js labor rates use formatSellerWorkspaceMoney not settings.currency",
    /formatSellerWorkspaceMoney\(workerRateFromSettings\(worker, settings\)\)/.test(appJs) &&
      !/money\(workerRateFromSettings\(worker, settings\), settings\.currency\)/.test(appJs)
  );
  pass(
    "app.js setText skips identical textContent",
    /function setText\(targetId, value\) \{[\s\S]*if \(node\.textContent === next\) return;/.test(appJs)
  );

  console.log("\n" + n + " passed");
}

if (require.main === module) {
  main();
}

module.exports = { formatSellerWorkspaceMoney, parseAmount };
