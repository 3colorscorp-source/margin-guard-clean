#!/usr/bin/env node
/**
 * Seller Shield V2 — runner wiring self-test.
 * Check name stays Seller Shield V1. Workflow file stays origin/main.
 * Does not mutate product or other shields.
 * Run: node scripts/test-seller-shield-v2.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const WORKFLOW = path.join(ROOT, ".github", "workflows", "seller-shield-v1.yml");
const RUNNER = path.join(ROOT, "scripts", "test-mg-seller-shield-v1.js");
const OWNER_WF = ".github/workflows/owner-shield-v1.yml";
const HUB_WF = ".github/workflows/invoice-hub-shield-v2.yml";
const SELLER_WF = ".github/workflows/seller-shield-v1.yml";

function isFullGitSha(value) {
  return /^[0-9a-f]{40}$/i.test(String(value || "").trim());
}

function git(args, gitImpl) {
  if (typeof gitImpl === "function") return gitImpl(args);
  return spawnSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
  });
}

function readPrBaseShaFromEvent(env, readFileImpl) {
  const eventPath = String((env || process.env).GITHUB_EVENT_PATH || "").trim();
  if (!eventPath) return "";
  try {
    const readFile = readFileImpl || fs.readFileSync;
    const ev = JSON.parse(readFile(eventPath, "utf8"));
    return String((ev && ev.pull_request && ev.pull_request.base && ev.pull_request.base.sha) || "").trim();
  } catch (_err) {
    return "";
  }
}

function refExists(ref, gitImpl) {
  const r = git(["cat-file", "-e", String(ref || "") + "^{commit}"], gitImpl);
  return Boolean(r && r.status === 0);
}

function resolveComparisonBase(options) {
  const opts = options || {};
  const env = opts.env || process.env;
  const gitImpl = opts.gitImpl;
  const eventSha = readPrBaseShaFromEvent(env, opts.readFileImpl);
  if (eventSha) {
    if (!isFullGitSha(eventSha)) {
      return { ok: false, ref: eventSha, reason: "invalid_pr_base_sha" };
    }
    if (!refExists(eventSha, gitImpl)) {
      return { ok: false, ref: eventSha, reason: "missing_pr_base_sha" };
    }
    return { ok: true, ref: eventSha, reason: "pr_base_sha" };
  }
  if (refExists("origin/main", gitImpl)) {
    return { ok: true, ref: "origin/main", reason: "origin_main_fallback" };
  }
  return { ok: false, ref: "", reason: "missing_comparison_base" };
}

function gitDiffEmpty(rel, baseRef, gitImpl) {
  const r = git(["diff", "--exit-code", baseRef, "--", rel], gitImpl);
  return Boolean(r && r.status === 0);
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function assert(label, cond) {
  if (!cond) throw new Error("FAIL " + label);
  console.log("PASS " + label);
}

function runResolverCoverage(pass) {
  const eventSha = "2e945256bf85e3ffcffca8fe53ae18cc215e1690";
  const prEvent = JSON.stringify({ pull_request: { base: { sha: eventSha } } });

  const fromEvent = resolveComparisonBase({
    env: { GITHUB_EVENT_PATH: "C:/fake/event.json" },
    readFileImpl: () => prEvent,
    gitImpl: (args) => {
      if (args[0] === "cat-file" && args[2] === eventSha + "^{commit}") return { status: 0 };
      return { status: 1, stdout: "", stderr: "not found" };
    },
  });
  pass("resolver prefers PR base SHA", fromEvent.ok === true && fromEvent.ref === eventSha && fromEvent.reason === "pr_base_sha");

  const invalid = resolveComparisonBase({
    env: { GITHUB_EVENT_PATH: "C:/fake/event.json" },
    readFileImpl: () => JSON.stringify({ pull_request: { base: { sha: "origin/main" } } }),
    gitImpl: () => ({ status: 0, stdout: "", stderr: "" }),
  });
  pass("resolver rejects non-hex SHA", invalid.ok === false && invalid.reason === "invalid_pr_base_sha");

  const shortSha = resolveComparisonBase({
    env: { GITHUB_EVENT_PATH: "C:/fake/event.json" },
    readFileImpl: () => JSON.stringify({ pull_request: { base: { sha: "2e945256bf" } } }),
    gitImpl: () => ({ status: 0, stdout: "", stderr: "" }),
  });
  pass("resolver requires 40-character SHA", shortSha.ok === false && shortSha.reason === "invalid_pr_base_sha");

  const missingSha = resolveComparisonBase({
    env: { GITHUB_EVENT_PATH: "C:/fake/event.json" },
    readFileImpl: () => prEvent,
    gitImpl: () => ({ status: 1, stdout: "", stderr: "missing" }),
  });
  pass(
    "resolver fails when PR SHA is missing locally",
    missingSha.ok === false && missingSha.reason === "missing_pr_base_sha"
  );

  const localFallback = resolveComparisonBase({
    env: {},
    gitImpl: (args) => {
      if (args[0] === "cat-file" && args[2] === "origin/main^{commit}") return { status: 0 };
      return { status: 1, stdout: "", stderr: "" };
    },
  });
  pass(
    "resolver falls back to origin/main locally",
    localFallback.ok === true && localFallback.ref === "origin/main" && localFallback.reason === "origin_main_fallback"
  );

  const noBase = resolveComparisonBase({
    env: {},
    gitImpl: () => ({ status: 1, stdout: "", stderr: "missing origin/main" }),
  });
  pass("resolver errors when no comparison base exists", noBase.ok === false && noBase.reason === "missing_comparison_base");
}

function main() {
  let n = 0;
  const pass = (label, cond) => {
    assert(label, cond);
    n += 1;
  };

  runResolverCoverage(pass);

  const resolved = resolveComparisonBase();
  if (!resolved.ok) {
    throw new Error(
      "FAIL comparison base unavailable (" +
        resolved.reason +
        "). Need pull_request.base.sha from GITHUB_EVENT_PATH or a local origin/main."
    );
  }
  pass("comparison base resolved (" + resolved.reason + ")", Boolean(resolved.ref));

  pass("workflow file exists", fs.existsSync(WORKFLOW));
  pass("Seller Shield workflow is untouched vs comparison base", gitDiffEmpty(SELLER_WF, resolved.ref));
  const yml = fs.readFileSync(WORKFLOW, "utf8");
  pass("workflow name is Seller Shield V1", /^name:\s*Seller Shield V1\s*$/m.test(yml));
  pass("job name is Seller Shield V1", /^\s+name:\s*Seller Shield V1\s*$/m.test(yml));
  pass("runs on pull_request", /pull_request:/.test(yml));
  pass("runs on merge_group", /merge_group:/.test(yml));
  pass("runs on workflow_dispatch", /workflow_dispatch:/.test(yml));
  pass("permissions contents read", /permissions:\s*\r?\n\s+contents:\s*read/.test(yml));
  pass("checkout action pinned SHA", yml.indexOf("actions/checkout@11d5960a326750d5838078e36cf38b85af677262") >= 0);
  pass("setup-node action pinned SHA", yml.indexOf("actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020") >= 0);
  pass("required suite still runs", yml.indexOf("node scripts/test-mg-seller-shield-v1.js") >= 0);
  pass("full suite still runs", yml.indexOf("node scripts/test-mg-seller-shield-v1.js --full") >= 0);
  pass("does not set ALLOW_SELLER_TOUCH in workflow", !/ALLOW_SELLER_TOUCH:\s*["']?1/.test(yml));
  pass("does not use pull_request_target", yml.indexOf("pull_request_target") < 0);
  pass("does not run Owner guard", yml.indexOf("guard-owner-scope.js") < 0);
  pass("does not run Invoice Hub guard", yml.indexOf("guard-invoice-hub-scope.js") < 0);
  pass("does not run Owner shield runner", yml.indexOf("test-mg-owner-shield-v1.js") < 0);
  pass("does not run Invoice Hub regression suite", yml.indexOf("test-invoice-hub-regression-suite.js") < 0);
  pass("workflow does not add a separate real-guard step", yml.indexOf("set -euo pipefail") < 0);

  const runnerSrc = fs.readFileSync(RUNNER, "utf8");
  pass("runner executes guard-seller-scope.js", runnerSrc.indexOf("scripts/guard-seller-scope.js") >= 0);
  pass("runner reads GITHUB_EVENT_PATH", runnerSrc.indexOf("GITHUB_EVENT_PATH") >= 0);
  pass("runner reads pull_request.base.sha", /base\.sha/.test(runnerSrc));
  pass("runner reads pull_request.title", /pr\.title/.test(runnerSrc));
  pass("runner reads pull_request.head.ref", /head\.ref/.test(runnerSrc));
  pass("runner skips real guard on merge_group", /GITHUB_EVENT_NAME[\s\S]{0,80}merge_group/.test(runnerSrc));
  pass("runner fetches missing SHA with --no-tags --depth=1", runnerSrc.indexOf('["fetch", "--no-tags", "--depth=1", "origin"') >= 0);
  pass("runner passes BASE_REF via env", /env\.BASE_REF\s*=\s*ctx\.baseSha/.test(runnerSrc));
  pass("runner passes PR_TITLE via env", /env\.PR_TITLE\s*=\s*ctx\.title/.test(runnerSrc));
  pass("runner passes GITHUB_HEAD_REF via env", /env\.GITHUB_HEAD_REF\s*=\s*ctx\.head/.test(runnerSrc));
  pass("runner guard spawn uses shell false", /shell:\s*false/.test(runnerSrc));
  pass("runner never assigns ALLOW_SELLER_TOUCH=1", !/ALLOW_SELLER_TOUCH\s*=\s*["']?1["']?/.test(runnerSrc));
  pass("runner strips ALLOW_SELLER_TOUCH", /delete env\.ALLOW_SELLER_TOUCH/.test(runnerSrc));
  pass("guard failure is nonzero_exit of runner", /reason:\s*"nonzero_exit"/.test(runnerSrc) && /RESULT: FAIL/.test(runnerSrc));

  pass("Owner Shield workflow exists", read(OWNER_WF).length > 0);
  pass("Invoice Hub Shield workflow exists", read(HUB_WF).length > 0);
  pass("Owner Shield workflow is untouched vs comparison base", gitDiffEmpty(OWNER_WF, resolved.ref));
  pass("Invoice Hub Shield workflow is untouched vs comparison base", gitDiffEmpty(HUB_WF, resolved.ref));

  const { evaluateGuard } = require("./guard-seller-scope.js");
  pass(
    "non-Seller + sales.html fails",
    evaluateGuard({
      files: ["public/sales.html"],
      branch: "feat/owner-voice",
      prTitle: "[Owner] voice",
    }).ok === false
  );
  pass(
    "non-Seller + get-seller-business-settings fails",
    evaluateGuard({
      files: ["netlify/functions/get-seller-business-settings.js"],
      branch: "fix/business-settings-modern-owner-session",
      prTitle: "Business Settings",
    }).ok === false
  );
  pass(
    "Invoice Hub files pass Seller guard",
    evaluateGuard({
      files: ["public/estimates-invoices.html", "netlify/functions/list-tenant-invoices.js"],
      branch: "feat/invoice-hub-shield-v2",
      prTitle: "[Invoice Hub] shield",
    }).ok === true
  );
  const sellerOk = evaluateGuard({
    files: ["public/sales.html"],
    branch: "feat/seller-shield-v2",
    prTitle: "[Seller] shield v2",
  });
  pass("Seller branch + Seller file passes", sellerOk.ok === true);
  pass("Seller branch requires regression", sellerOk.regressionRequired === true);
  pass(
    "non-Seller workflow edit fails",
    evaluateGuard({
      files: [".github/workflows/seller-shield-v1.yml"],
      branch: "feat/support-layout",
    }).ok === false
  );

  const salesHtml = read("public/sales.html");
  pass(
    "seller preserves rendered currency helper exists",
    /function refreshSellerFromStandalonePreservingRenderedCurrency\(/.test(salesHtml)
  );
  pass(
    "seller captures visible currency before the operational-plan refresh",
    /function refreshSellerFromStandalonePreservingRenderedCurrency\([\s\S]*captureSellerQuoteCurrencyLock\(\);\s*refreshSellerFromStandalone\(\);/.test(
      salesHtml
    )
  );
  pass(
    "seller quote currency lock is not cleared after the refresh",
    (function () {
      const start = salesHtml.indexOf("function refreshSellerFromStandalonePreservingRenderedCurrency");
      const slice = start >= 0 ? salesHtml.slice(start, start + 420) : "";
      return (
        /captureSellerQuoteCurrencyLock\(\);\s*refreshSellerFromStandalone\(\);/.test(slice) &&
        !/delete window\.__mgSellerQuoteCurrencyLock/.test(slice)
      );
    })()
  );
  pass(
    "add day preserves the currently rendered currency",
    /saveSalesState\(state\);\s*refreshSellerFromStandalonePreservingRenderedCurrency\(\);\s*openSalesOpDayEditor/.test(
      salesHtml
    )
  );
  pass(
    "timeline remove day preserves the currently rendered currency",
    /action === 'remove-day' && dayIndex >= 0\) \{[\s\S]*?refreshSellerFromStandalonePreservingRenderedCurrency\(\);/.test(
      salesHtml
    )
  );
  pass(
    "edit day save preserves the currently rendered currency",
    /persistSalesOpDayEditorFromDom\(\);\s*closeSalesOpDayEditor\(\);\s*refreshSellerFromStandalonePreservingRenderedCurrency\(\);/.test(
      salesHtml
    )
  );
  pass(
    "modal remove day preserves the currently rendered currency",
    /closeSalesOpDayEditor\(\);\s*refreshSellerFromStandalonePreservingRenderedCurrency\(\);/.test(salesHtml)
  );
  pass(
    "voice plan confirm preserves the currently rendered currency",
    /closeVoicePlanPreviewModal\(\);\s*refreshSellerFromStandalonePreservingRenderedCurrency\(\);/.test(salesHtml)
  );
  pass(
    "visible currency reader inspects Recommended Price",
    /function readSellerCurrencyFromVisiblePanel\([\s\S]*salesPrimaryPrice/.test(salesHtml)
  );
  pass(
    "visible currency reader inspects Price Estimate",
    /function readSellerCurrencyFromVisiblePanel\([\s\S]*salesPriceDisplay/.test(salesHtml)
  );
  pass(
    "visible MXN display stays MXN",
    /function readSellerCurrencyFromDisplayText\([\s\S]*MXN/.test(salesHtml)
  );
  pass(
    "resolver prefers the quote currency lock",
    /function resolveSellerCurrency\([\s\S]*lockCode[\s\S]*if \(lockCode\) \{[\s\S]*return lockCode;/.test(salesHtml)
  );
  pass(
    "seller uses a persistent quote currency lock",
    /__mgSellerQuoteCurrencyLock/.test(salesHtml) && !/__mgSellerOpPlanCurrencyHold/.test(salesHtml)
  );
  pass(
    "edit day open captures the visible quote currency",
    /function openSalesOpDayEditor\([\s\S]*captureSellerQuoteCurrencyLock\(\);/.test(salesHtml)
  );
  pass(
    "visible reader searches duplicate Recommended Price nodes",
    /function collectSellerMoneyNodesById\([\s\S]*querySelectorAll\('\[id="' \+ id \+ '"\]'\)/.test(salesHtml)
  );
  pass(
    "visible reader prefers the displayed money node",
    /function readSellerCurrencyFromVisiblePanel\([\s\S]*isSellerDisplayedMoneyNode/.test(salesHtml)
  );
  pass(
    "duplicate Price Estimate nodes are included",
    /function readSellerCurrencyFromVisiblePanel\([\s\S]*salesPriceDisplay[\s\S]*isSellerDisplayedMoneyNode/.test(
      salesHtml
    )
  );
  pass(
    "new quote reset is the only lock clear",
    /function resetSalesQuoteStateForNewQuote\([\s\S]*delete window\.__mgSellerQuoteCurrencyLock;/.test(salesHtml) &&
      (salesHtml.match(/delete window\.__mgSellerQuoteCurrencyLock;/g) || []).length === 1
  );
  pass(
    "delayed renders keep the quote currency lock",
    (function () {
      const start = salesHtml.indexOf("function refreshSellerFromStandalonePreservingRenderedCurrency");
      const slice = start >= 0 ? salesHtml.slice(start, start + 420) : "";
      return (
        /function resolveSellerCurrency\([\s\S]*window\.__mgSellerQuoteCurrencyLock/.test(salesHtml) &&
        !/finally/.test(slice)
      );
    })()
  );
  pass(
    "legitimate MXN lock is returned without forcing USD",
    /if \(lockCode\) \{[\s\S]*rememberSellerValidCurrency\(lockCode\);[\s\S]*return lockCode;/.test(salesHtml)
  );
  pass(
    "displayed money writer updates visible duplicate price nodes",
    /function setSellerDisplayedMoneyText\([\s\S]*isSellerDisplayedMoneyNode[\s\S]*textContent = text/.test(salesHtml)
  );

  pass(
    "owner preview surface helper exists",
    /function isOwnerSalesPreviewSurface\(/.test(salesHtml) &&
      /function isOwnerSalesPreviewSurface\([\s\S]*isOwnerNavSalesPreview\(\)/.test(salesHtml)
  );
  pass(
    "owner preview hydrates tenant currency from seller business settings",
    /function hydrateSellerBusinessSettingsFromServer\([\s\S]*isOwnerSalesPreviewSurface\(\)[\s\S]*get-seller-business-settings/.test(
      salesHtml
    )
  );
  pass(
    "owner preview does not skip tenant currency hydration",
    /var ownerPreview = isOwnerSalesPreviewSurface\(\);\s*var serverControlled =[\s\S]*if \(!serverControlled && !ownerPreview\) \{/.test(
      salesHtml
    )
  );
  pass(
    "tenant currency is remembered from server settings",
    /function rememberSellerTenantCurrency\([\s\S]*window\.__mgSellerTenantCurrency = code;/.test(salesHtml)
  );
  pass(
    "resolver prefers tenant currency over lock and storage",
    /function resolveSellerCurrency\([\s\S]*const tenantCode = readSellerTenantCurrency\(\);[\s\S]*if \(tenantCode\) \{[\s\S]*return tenantCode;/.test(
      salesHtml
    )
  );
  pass(
    "owner USD tenant wins over stale MXN storage",
    /function resolveSellerCurrency\([\s\S]*readSellerTenantCurrency\(\)[\s\S]*if \(tenantCode\) \{[\s\S]*return tenantCode;[\s\S]*readSellerCurrencyFromSettingsStorage\(/.test(
      salesHtml
    )
  );
  pass(
    "legitimate tenant MXN is returned without forcing USD",
    /function rememberSellerTenantCurrency\([\s\S]*window\.__mgSellerTenantCurrency = code;[\s\S]*return code;/.test(
      salesHtml
    ) &&
      /function resolveSellerCurrency\([\s\S]*if \(tenantCode\) \{[\s\S]*return tenantCode;/.test(salesHtml)
  );
  pass(
    "edit day capture cannot override tenant currency with visible MXN",
    /function captureSellerQuoteCurrencyLock\([\s\S]*const tenantCode = readSellerTenantCurrency\(\);[\s\S]*if \(tenantCode\) \{[\s\S]*window\.__mgSellerQuoteCurrencyLock = tenantCode;[\s\S]*return tenantCode;/.test(
      salesHtml
    )
  );
  pass(
    "owner preview delayed Live Score still enforces tenant currency",
    /function enforceSellerRightPanelCurrencyConsistency\([\s\S]*isOwnerSalesPreviewSurface\(\)/.test(salesHtml)
  );
  pass(
    "add edit remove and voice-confirm still capture before refresh",
    /saveSalesState\(state\);\s*refreshSellerFromStandalonePreservingRenderedCurrency\(\);\s*openSalesOpDayEditor/.test(
      salesHtml
    ) &&
      /persistSalesOpDayEditorFromDom\(\);\s*closeSalesOpDayEditor\(\);\s*refreshSellerFromStandalonePreservingRenderedCurrency\(\);/.test(
        salesHtml
      ) &&
      /closeSalesOpDayEditor\(\);\s*refreshSellerFromStandalonePreservingRenderedCurrency\(\);/.test(salesHtml) &&
      /closeVoicePlanPreviewModal\(\);\s*refreshSellerFromStandalonePreservingRenderedCurrency\(\);/.test(salesHtml)
  );
  pass(
    "owner preview simulated delayed renders keep tenant currency lock",
    (function () {
      const start = salesHtml.indexOf("function refreshSellerFromStandalonePreservingRenderedCurrency");
      const slice = start >= 0 ? salesHtml.slice(start, start + 420) : "";
      return (
        /captureSellerQuoteCurrencyLock\(\);\s*refreshSellerFromStandalone\(\);/.test(slice) &&
        !/finally/.test(slice) &&
        /function resolveSellerCurrency\([\s\S]*readSellerTenantCurrency\(\)/.test(salesHtml)
      );
    })()
  );
  pass(
    "duplicate hidden price nodes still prefer the visible node",
    /function readSellerCurrencyFromVisiblePanel\([\s\S]*collectSellerMoneyNodesById[\s\S]*isSellerDisplayedMoneyNode/.test(
      salesHtml
    )
  );
  pass(
    "new quote clears quote lock but keeps tenant currency",
    /function resetSalesQuoteStateForNewQuote\([\s\S]*delete window\.__mgSellerQuoteCurrencyLock;/.test(salesHtml) &&
      (salesHtml.match(/delete window\.__mgSellerQuoteCurrencyLock;/g) || []).length === 1 &&
      !/delete window\.__mgSellerTenantCurrency/.test(salesHtml)
  );
  pass(
    "seller device still fully hydrates business settings",
    /function hydrateSellerBusinessSettingsFromServer\([\s\S]*isSellerDeviceSessionActive\(\)[\s\S]*localStorage\.setItem\(SETTINGS_KEY, JSON\.stringify\(data\.settings\)\)/.test(
      salesHtml
    )
  );
  pass(
    "owner preview merges tenant currency without replacing seller rates",
    /ownerPreview && !serverControlled[\s\S]*next\.currency = data\.settings\.currency;[\s\S]*currencyOnly: true/.test(
      salesHtml
    )
  );
  pass(
    "tenant currency immediately paints the two primary prices",
    /function rememberSellerTenantCurrency\([\s\S]*window\.__mgSellerTenantCurrency = code;[\s\S]*paintSellerAuthoritativePrimaryPricesNow\(\);[\s\S]*return code;/.test(
      salesHtml
    )
  );
  pass(
    "authoritative primary price writer is centralized",
    /function writeSellerAuthoritativePriceText\([\s\S]*collectSellerMoneyNodesById\(id\)[\s\S]*function setSellerDisplayedMoneyText\([\s\S]*isSellerAuthoritativePrimaryPriceId\(id\)[\s\S]*writeSellerAuthoritativePriceText/.test(
      salesHtml
    ) &&
      /function setText\(targetId, value\) \{[\s\S]*isSellerAuthoritativePrimaryPriceId\(targetId\)[\s\S]*writeSellerAuthoritativePriceText/.test(
        salesHtml
      )
  );
  pass(
    "late writers cannot keep a currency that disagrees with tenant",
    /function coerceSellerMoneyTextToTenantCurrency\([\s\S]*readSellerTenantCurrency\(\)[\s\S]*if \(!shown \|\| shown === tenant\) return raw;[\s\S]*return money\(parseSellerMoneyTextToNumber\(trimmed\), tenant\);/.test(
      salesHtml
    ) &&
      /new MutationObserver\(/.test(salesHtml)
  );
  pass(
    "owner preview renderSales currency guard no longer skips owner",
    /function patchSellerRenderSalesCurrencyGuard\([\s\S]*isOwnerSalesPreviewSurface\(\)[\s\S]*paintSellerAuthoritativePrimaryPricesNow\(\)/.test(
      salesHtml
    )
  );
  pass(
    "layout complete path paints tenant currency without waiting for resize",
    /if \(isDirectSellerDomLayoutComplete\(\)\) \{[\s\S]*paintSellerAuthoritativePrimaryPricesNow\(\);[\s\S]*enforceSellerRightPanelCurrencyConsistency\(\);[\s\S]*return true;/.test(
      salesHtml
    )
  );
  pass(
    "owner preview delayed layout still paints tenant currency",
    /function scheduleOwnerSellerPreviewLayoutEnforcement\([\s\S]*forceOwnerSellerPreviewLayout\('owner-preview-schedule'\);[\s\S]*paintSellerAuthoritativePrimaryPricesNow\(\);/.test(
      salesHtml
    )
  );
  pass(
    "currency correction does not register a resize listener",
    !/addEventListener\(\s*['"]resize['"]/.test(salesHtml)
  );
  pass(
    "authoritative writer does not hardcode USD",
    /function coerceSellerMoneyTextToTenantCurrency\([\s\S]*money\(parseSellerMoneyTextToNumber\(trimmed\), tenant\)/.test(
      salesHtml
    ) &&
      !/function coerceSellerMoneyTextToTenantCurrency\([\s\S]*return ['"]USD['"]/.test(salesHtml)
  );
  pass(
    "primary price writers do not depend on hidden getElementById",
    /function writeSellerAuthoritativePriceText\([\s\S]*collectSellerMoneyNodesById\(id\)[\s\S]*nodes\.length \? nodes : \[document\.getElementById\(id\)\]/.test(
      salesHtml
    )
  );

  const portalJs = read("public/js/sales-device-portal.js");
  pass(
    "owner mode hydrates seller business settings",
    /async function applyOwnerMode\([\s\S]*hydrateSellerBusinessSettingsFromServer\(\)/.test(portalJs)
  );
  pass(
    "owner auth awaits owner preview currency hydration",
    /await applyOwnerMode\(ownerData\);/.test(portalJs)
  );
  pass(
    "owner mode paints authoritative prices immediately after hydrate",
    /async function applyOwnerMode\([\s\S]*paintSellerAuthoritativePrimaryPricesNow\(\)[\s\S]*refreshSellerFromStandalone\(\)/.test(
      portalJs
    )
  );

  const settingsFn = read("netlify/functions/get-seller-business-settings.js");
  pass(
    "get-seller-business-settings admits owner or seller",
    /resolveOwnerOrSellerContext\(event\)/.test(settingsFn) &&
      !/requireSellerDevice\(event\)/.test(settingsFn)
  );

  console.log("\n" + n + " passed");
}

module.exports = {
  isFullGitSha,
  readPrBaseShaFromEvent,
  resolveComparisonBase,
  gitDiffEmpty,
};

if (require.main === module) {
  main();
}
