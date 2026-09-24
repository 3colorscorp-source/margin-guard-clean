#!/usr/bin/env node
/**
 * Desktop Chromium runtime: Dashboard/Owner sidebar → Seller.
 * Uses real public/sales.html, public/js/sales-device-portal.js, dashboard, owner, and mg-app-nav.
 * Auth/network are mocked; renderSales, layout, painters, timers, and OP edits are not replaced.
 *
 *   node scripts/test-seller-owner-preview-desktop-runtime.js
 *
 * Exit 0 = healthy, 1 = fail, 2 = no automatable browser.
 * Strict timeout FLOW_TIMEOUT_MS. Browser and static server close in finally.
 *
 * Not a Seller Shield CI required job (needs local Chrome). Wiring lives in
 * scripts/test-seller-owner-price-observer-freeze.js.
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const DEFAULT_ROOT = path.resolve(__dirname, "..");
const VIEWPORT = { width: 1600, height: 900 };
const STABILITY_MS = 30000;
const NAV_CYCLES = 10;
const FLOW_TIMEOUT_MS = 180000;
const HEARTBEAT_STALL_MS = 2000;
const EVAL_TIMEOUT_MS = 4000;
const IDENTICAL_WRITE_LIMIT = 0;
const MUTATION_STORM_LIMIT = 80;
const HEARTBEAT_MAX_RECOMMENDED_MS = 500;
const SELLER_HREF = "/sales?portal=owner";
const OWNER_HREF = "/owner";
const DASHBOARD_HREF = "/dashboard";

function parseArgs(argv) {
  const out = { root: DEFAULT_ROOT, expectRegression: false };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--root") {
      out.root = path.resolve(String(args[++i] || ""));
    } else if (args[i] === "--expect-regression") {
      out.expectRegression = true;
    } else if (args[i] === "--help") {
      out.help = true;
    } else {
      throw new Error("Unknown argument: " + args[i]);
    }
  }
  return out;
}

function findChrome() {
  const envPath = String(process.env.CHROME_PATH || process.env.EDGE_PATH || "").trim();
  const candidates = [
    envPath,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "Google\\Chrome\\Application\\chrome.exe")
      : "",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
  ].filter(Boolean);
  const pw = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "ms-playwright")
    : "";
  if (pw && fs.existsSync(pw)) {
    walkChrome(pw, candidates);
  }
  for (let i = 0; i < candidates.length; i += 1) {
    if (candidates[i] && fs.existsSync(candidates[i])) return candidates[i];
  }
  return "";
}

function walkChrome(dir, out, depth) {
  if ((depth || 0) > 4) return;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_err) {
    return;
  }
  for (let i = 0; i < entries.length; i += 1) {
    const full = path.join(dir, entries[i].name);
    if (entries[i].isFile() && /^chrome(?:\.exe)?$/i.test(entries[i].name)) out.push(full);
    if (entries[i].isDirectory()) walkChrome(full, out, (depth || 0) + 1);
  }
}

function mime(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".png") return "image/png";
  if (ext === ".ico") return "image/x-icon";
  return "application/octet-stream";
}

function startStaticServer(root) {
  const publicDir = path.join(root, "public");
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname.indexOf("/.netlify/functions/") === 0) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, mocked: true }));
      return;
    }
    let rel = url.pathname;
    if (rel === "/" || rel === "/sales" || rel === "/sales/") rel = "/sales.html";
    else if (rel === "/dashboard" || rel === "/dashboard/") rel = "/dashboard.html";
    else if (rel === "/owner" || rel === "/owner/") rel = "/owner.html";
    rel = path.normalize(rel).replace(/^[\\/]+/, "");
    if (rel.indexOf("..") >= 0) {
      res.writeHead(400);
      res.end("bad path");
      return;
    }
    let filePath = path.join(publicDir, rel);
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    let body = fs.readFileSync(filePath);
    if (path.basename(filePath) === "sales.html") {
      let html = body.toString("utf8");
      html = html.replace(
        /<script defer src="https:\/\/cdn\.jsdelivr\.net\/npm\/jspdf@[^"]+"><\/script>/,
        "<!-- jspdf stubbed by desktop runtime -->"
      );
      body = Buffer.from(html, "utf8");
    }
    res.writeHead(200, { "Content-Type": mime(filePath) });
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function chromeVersion(bin) {
  const r = spawn(bin, ["--version"], { windowsHide: true });
  return new Promise((resolve) => {
    let out = "";
    r.stdout.on("data", (d) => {
      out += d;
    });
    r.stderr.on("data", (d) => {
      out += d;
    });
    r.on("close", () => resolve(String(out || bin).trim()));
    setTimeout(() => resolve(bin), 3000);
  });
}

async function launchChrome(chromePath) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "mg-owner-preview-rt-"));
  const port = 9222 + Math.floor(Math.random() * 400);
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-extensions",
    "--disable-popup-blocking",
    "--disable-dev-shm-usage",
    "--remote-allow-origins=*",
    "--window-size=" + VIEWPORT.width + "," + VIEWPORT.height,
    "--user-data-dir=" + profile,
    "--remote-debugging-port=" + port,
    "about:blank",
  ];
  const child = spawn(chromePath, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let ready = "";
  child.stderr.on("data", (d) => {
    ready += d.toString();
  });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const ver = await fetch("http://127.0.0.1:" + port + "/json/version");
      if (ver.ok) {
        const json = await ver.json();
        return { child, port, profile, browser: json };
      }
    } catch (_err) {
      /* retry */
    }
    await sleep(200);
  }
  child.kill();
  throw new Error("Chrome DevTools did not start. stderr=" + ready.slice(0, 400));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || "cdp error"));
        else p.resolve(msg.result || {});
      }
    };
  }
  ready() {
    if (this.ws.readyState === 1) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = (err) => reject(err);
    });
  }
  send(method, params, timeoutMs) {
    const id = (this.id += 1);
    const ms = timeoutMs == null ? 8000 : timeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("CDP timeout " + method));
      }, ms);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  close() {
    try {
      this.ws.close();
    } catch (_err) {}
  }
}

const INIT_SCRIPT = String.raw`
(function () {
  if (window.__mgDesktopRuntime) return;
  var stats = {
    textWrites: { salesPrimaryPrice: 0, salesPriceDisplay: 0 },
    identicalWrites: { salesPrimaryPrice: 0, salesPriceDisplay: 0 },
    mutations: { salesPrimaryPrice: 0, salesPriceDisplay: 0 },
    paints: 0,
    renders: 0,
    layouts: 0,
    priceObservers: 0,
    consoleErrors: [],
    exceptions: [],
    heartbeatDelayMax: 0,
    heartbeatSamples: 0,
    lastHeartbeatAt: Date.now(),
    pendingTimeouts: 0,
    pendingIntervals: 0
  };
  window.__mgDesktopRuntime = stats;
  window.addEventListener("error", function (ev) {
    stats.exceptions.push(String((ev && ev.message) || ev));
  });
  window.addEventListener("unhandledrejection", function (ev) {
    stats.exceptions.push("unhandledrejection:" + String((ev && ev.reason) || ev));
  });
  var origError = console.error;
  console.error = function () {
    try { stats.consoleErrors.push(Array.prototype.join.call(arguments, " ")); } catch (_e) {}
    return origError.apply(this, arguments);
  };
  var origWarn = console.warn;
  console.warn = function () {
    var msg = Array.prototype.join.call(arguments, " ");
    if (/unresponsive|not responding/i.test(msg)) stats.consoleErrors.push(msg);
    return origWarn.apply(this, arguments);
  };
  var origFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = "";
    try { url = typeof input === "string" ? input : String(input && input.url || ""); } catch (_e) { url = ""; }
    function json(data, status) {
      return Promise.resolve(new Response(JSON.stringify(data), {
        status: status || 200,
        headers: { "Content-Type": "application/json" }
      }));
    }
    if (/auth-status/.test(url)) {
      return json({
        active: true,
        email: "owner-runtime@example.test",
        is_admin: true,
        tenantName: "Runtime Fixture"
      });
    }
    if (/get-seller-business-settings/.test(url)) {
      return json({
        ok: true,
        source: "tenant_snapshot",
        settings: {
          currency: "USD",
          baseInstaller: 136.87875,
          baseHelper: 45,
          hoursPerDay: 6,
          pricingMode: "hour",
          wcPct: 0,
          ficaPct: 0,
          futaPct: 0,
          casuiPct: 0,
          overheadMonthly: 0,
          stdHours: 160,
          profitPct: 0,
          minimumMarginPct: 0,
          reservePct: 0,
          salesCommissionPct: 0,
          workdaysEnabled: true
        }
      });
    }
    if (/bootstrap|get-tenant|get-owner|device-heartbeat|device-auth/.test(url)) {
      return json({ ok: true, active: true, tenant: { name: "Runtime Fixture" } });
    }
    if (/jsdelivr|cdn\./i.test(url)) {
      return Promise.resolve(new Response("", { status: 200 }));
    }
    return json({
      ok: true,
      active: true,
      is_admin: true,
      mocked: true,
      tenant: { name: "Runtime Fixture" },
      settings: { currency: "USD" }
    });
  };
  var staleSettings = {
    currency: "MXN",
    baseInstaller: 136.87875,
    baseHelper: 45,
    hoursPerDay: 6,
    pricingMode: "hour",
    wcPct: 0,
    ficaPct: 0,
    futaPct: 0,
    casuiPct: 0,
    overheadMonthly: 0,
    stdHours: 160,
    profitPct: 0,
    minimumMarginPct: 0,
    reservePct: 0,
    salesCommissionPct: 0,
    workdaysEnabled: true
  };
  var hours = 6;
  function day(n, phase) {
    return {
      day_number: n,
      phase: phase,
      workers: [
        { role: "Installer", worker_type: "pro", estimated_hours: hours },
        { role: "Assistant", worker_type: "helper", estimated_hours: hours }
      ]
    };
  }
  var sales = {
    clientName: "Runtime Client",
    estimateStatus: "draft",
    offeredPrice: 4365.09,
    price: 4365.09,
    pricingStage: 2,
    workers: [
      { name: "Installer 1", type: "installer", days: 4, rate: "" },
      { name: "Helper 1", type: "helper", days: 4, rate: "" }
    ],
    operational_plan: [
      day(1, "Prep"),
      day(2, "Waterproof"),
      day(3, "Install"),
      day(4, "Finish")
    ],
    labor_auto_sync_from_plan: true
  };
  try {
    localStorage.setItem("mg_settings_v2", JSON.stringify(staleSettings));
    localStorage.setItem("mg_sales_v2", JSON.stringify(sales));
  } catch (_ls) {}
  var desc = Object.getOwnPropertyDescriptor(Node.prototype, "textContent");
  if (desc && desc.set && desc.get) {
    Object.defineProperty(Node.prototype, "textContent", {
      configurable: true,
      enumerable: desc.enumerable,
      get: function () { return desc.get.call(this); },
      set: function (value) {
        var id = this && this.id;
        if (id === "salesPrimaryPrice" || id === "salesPriceDisplay") {
          var next = value == null ? "" : String(value);
          var prev = "";
          try { prev = String(desc.get.call(this) || ""); } catch (_p) {}
          if (prev === next) stats.identicalWrites[id] += 1;
          else stats.textWrites[id] += 1;
        }
        return desc.set.call(this, value);
      }
    });
  }
  var OrigMO = window.MutationObserver;
  window.MutationObserver = function (cb) {
    var mo = new OrigMO(cb);
    var origObserve = mo.observe.bind(mo);
    mo.observe = function (target, options) {
      if (target && (target.id === "salesPrimaryPrice" || target.id === "salesPriceDisplay") && !mo.__mgRuntimeMetrics) {
        stats.priceObservers += 1;
      }
      return origObserve(target, options);
    };
    return mo;
  };
  window.MutationObserver.prototype = OrigMO.prototype;
  function attachMetricsObserver() {
    ["salesPrimaryPrice", "salesPriceDisplay"].forEach(function (id) {
      var node = document.getElementById(id);
      if (!node || node.__mgRuntimeObserved) return;
      node.__mgRuntimeObserved = true;
      var mo = new OrigMO(function () {
        stats.mutations[id] += 1;
      });
      mo.__mgRuntimeMetrics = true;
      mo.observe(node, { characterData: true, childList: true, subtree: true });
    });
  }
  var origSetTimeout = window.setTimeout;
  var origSetInterval = window.setInterval;
  var origClearTimeout = window.clearTimeout;
  var origClearInterval = window.clearInterval;
  var liveTimeouts = {};
  var liveIntervals = {};
  window.setTimeout = function (fn, delay) {
    var id;
    var wrapped = function () {
      delete liveTimeouts[id];
      stats.pendingTimeouts = Object.keys(liveTimeouts).length;
      if (typeof fn === "function") return fn.apply(this, arguments);
    };
    var args = Array.prototype.slice.call(arguments);
    args[0] = wrapped;
    id = origSetTimeout.apply(this, args);
    liveTimeouts[id] = true;
    stats.pendingTimeouts = Object.keys(liveTimeouts).length;
    return id;
  };
  window.setInterval = function () {
    var id = origSetInterval.apply(this, arguments);
    liveIntervals[id] = true;
    stats.pendingIntervals = Object.keys(liveIntervals).length;
    return id;
  };
  window.clearTimeout = function (id) {
    delete liveTimeouts[id];
    stats.pendingTimeouts = Object.keys(liveTimeouts).length;
    return origClearTimeout(id);
  };
  window.clearInterval = function (id) {
    delete liveIntervals[id];
    stats.pendingIntervals = Object.keys(liveIntervals).length;
    return origClearInterval(id);
  };
  origSetInterval(function () {
    var now = Date.now();
    var delay = now - stats.lastHeartbeatAt - 50;
    stats.lastHeartbeatAt = now;
    stats.heartbeatSamples += 1;
    if (delay > stats.heartbeatDelayMax) stats.heartbeatDelayMax = delay;
  }, 50);
  origSetInterval(function () {
    attachMetricsObserver();
    if (typeof window.paintSellerAuthoritativePrimaryPricesNow === "function" && !window.paintSellerAuthoritativePrimaryPricesNow.__mgRt) {
      var p = window.paintSellerAuthoritativePrimaryPricesNow;
      var wrappedPaint = function () {
        stats.paints += 1;
        return p.apply(this, arguments);
      };
      wrappedPaint.__mgRt = true;
      window.paintSellerAuthoritativePrimaryPricesNow = wrappedPaint;
    }
    if (typeof window.renderSales === "function" && !window.renderSales.__mgRt) {
      var r = window.renderSales;
      var wrappedRender = function () {
        stats.renders += 1;
        return r.apply(this, arguments);
      };
      wrappedRender.__mgRt = true;
      window.renderSales = wrappedRender;
    }
    if (typeof window.forceOwnerSellerPreviewLayout === "function" && !window.forceOwnerSellerPreviewLayout.__mgRt) {
      var l = window.forceOwnerSellerPreviewLayout;
      var wrappedLayout = function () {
        stats.layouts += 1;
        return l.apply(this, arguments);
      };
      wrappedLayout.__mgRt = true;
      window.forceOwnerSellerPreviewLayout = wrappedLayout;
    }
  }, 25);
})();
`;

async function connectPage(debugPort) {
  const deadline = Date.now() + 10000;
  let target = null;
  while (Date.now() < deadline) {
    try {
      const list = await fetch("http://127.0.0.1:" + debugPort + "/json/list").then((r) => r.json());
      target = (list || []).find((t) => t.type === "page") || (list || [])[0];
      if (target && target.webSocketDebuggerUrl) break;
    } catch (_err) {}
    await sleep(200);
  }
  if (!target || !target.webSocketDebuggerUrl) throw new Error("no page websocket");
  const cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.ready();
  return cdp;
}

async function evalPage(cdp, expression, timeoutMs) {
  const result = await cdp.send(
    "Runtime.evaluate",
    {
      expression,
      awaitPromise: true,
      returnByValue: true,
      timeout: timeoutMs || EVAL_TIMEOUT_MS,
    },
    (timeoutMs || EVAL_TIMEOUT_MS) + 1000
  );
  if (result.exceptionDetails) {
    const text =
      (result.exceptionDetails.exception && result.exceptionDetails.exception.description) ||
      result.exceptionDetails.text;
    throw new Error(text || "evaluate exception");
  }
  return result.result ? result.result.value : undefined;
}

function snapshotExpr() {
  return `({
    ready: document.body && document.body.classList.contains("auth-ready"),
    tenant: window.__mgSellerTenantCurrency || "",
    primary: (document.getElementById("salesPrimaryPrice") || {}).textContent || "",
    display: (document.getElementById("salesPriceDisplay") || {}).textContent || "",
    observers: window.__mgDesktopRuntime ? window.__mgDesktopRuntime.priceObservers : -1,
    stats: window.__mgDesktopRuntime || null,
    canClick: !!(document.getElementById("btnAddOperationalDay")),
    dayCount: document.querySelectorAll(".sales-op-timeline-row").length
  })`;
}

function usesMxn(text) {
  return /MX\$|\bMXN\b|pesos?\s*mex/i.test(String(text || ""));
}

function sellerVisualOk(text) {
  const raw = String(text || "");
  if (!/\$/.test(raw)) return false;
  if (/MX\$|\bMXN\b|US\$|\bUSD\b/i.test(raw)) return false;
  return true;
}

function isFixtureTotal(text) {
  return /4,365\.09|4365\.09/.test(String(text || ""));
}

async function waitHealthyOrStorm(cdp, ms, label, report) {
  const started = Date.now();
  let lastMut = -1;
  let grew = 0;
  while (Date.now() - started < ms) {
    const t0 = Date.now();
    let snap;
    try {
      snap = await evalPage(cdp, snapshotExpr(), EVAL_TIMEOUT_MS);
    } catch (err) {
      report.blocked = true;
      report.blockReason = label + ": " + String(err.message || err);
      return snap;
    }
    const evalDelay = Date.now() - t0;
    if (evalDelay > HEARTBEAT_STALL_MS) {
      report.blocked = true;
      report.blockReason = label + ": evaluate stall " + evalDelay + "ms";
      return snap;
    }
    const stats = snap && snap.stats;
    if (stats) {
      const mut =
        Number(stats.mutations.salesPrimaryPrice || 0) + Number(stats.mutations.salesPriceDisplay || 0);
      if (lastMut >= 0 && mut > lastMut + 4) grew += 1;
      lastMut = mut;
      if (mut > MUTATION_STORM_LIMIT) {
        report.storm = true;
        report.blockReason = label + ": mutation storm " + mut;
        return snap;
      }
      const ident =
        Number(stats.identicalWrites.salesPrimaryPrice || 0) +
        Number(stats.identicalWrites.salesPriceDisplay || 0);
      if (ident > 20) {
        report.repeatedWrites = true;
        report.blockReason = label + ": identical writes " + ident;
        return snap;
      }
    }
    await sleep(500);
  }
  if (grew >= 8) {
    report.storm = true;
    report.blockReason = label + ": continuous mutation growth";
  }
  return evalPage(cdp, snapshotExpr(), EVAL_TIMEOUT_MS);
}

async function clickSelector(cdp, selector) {
  return evalPage(
    cdp,
    `(function(){
      var el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, reason: "missing " + ${JSON.stringify(selector)} };
      el.scrollIntoView({ block: "center" });
      el.click();
      return { ok: true, text: String(el.textContent || "").trim(), href: String(el.getAttribute("href") || "") };
    })()`
  );
}

async function waitReady(cdp, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const state = await evalPage(cdp, "document.readyState", 3000);
      if (state === "complete" || state === "interactive") return true;
    } catch (_err) {}
    await sleep(200);
  }
  return false;
}

function navSelector(href) {
  return 'a.mg-sidebar__item[href="' + href + '"]';
}

async function waitNav(cdp, href, ms) {
  const sel = navSelector(href);
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const found = await evalPage(cdp, "!!document.querySelector(" + JSON.stringify(sel) + ")", 3000);
      if (found) return sel;
    } catch (_err) {}
    await sleep(200);
  }
  return "";
}

function timedOut(started) {
  return Date.now() - started > FLOW_TIMEOUT_MS;
}

async function runFlow(root, expectRegression) {
  const chromePath = findChrome();
  if (!chromePath) {
    return { blockedNoBrowser: true };
  }
  const version = await chromeVersion(chromePath);
  const started = Date.now();
  const report = {
    chromePath,
    version,
    root,
    expectRegression,
    blocked: false,
    storm: false,
    repeatedWrites: false,
    blockReason: "",
    snapshots: [],
  };
  const { server, port } = await startStaticServer(root);
  const launched = await launchChrome(chromePath);
  report.version = launched.browser.Browser || version;
  let cdp;
  try {
    cdp = await connectPage(launched.port);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Console.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: INIT_SCRIPT });
    await cdp.send("Page.navigate", {
      url: "http://127.0.0.1:" + port + DASHBOARD_HREF,
    });
    if (!(await waitReady(cdp, 20000))) {
      report.fail = "Dashboard/Owner did not load";
      return finish(report, started, null);
    }
    let sellerSel = await waitNav(cdp, SELLER_HREF, 15000);
    if (!sellerSel) {
      report.fail = "Seller sidebar link missing on Dashboard";
      return finish(report, started, null);
    }
    const dashClick = await clickSelector(cdp, sellerSel);
    if (!dashClick || !dashClick.ok) {
      report.fail = "could not click Seller in the sidebar";
      return finish(report, started, null);
    }
    if (!(await waitReady(cdp, 20000))) {
      report.fail = "Seller did not load after sidebar click";
      return finish(report, started, null);
    }
    let snap = await waitHealthyOrStorm(cdp, 12000, "seller-load", report);
    report.snapshots.push({ at: "seller-load", snap });
    if (report.blocked || report.storm || report.repeatedWrites) return finish(report, started, snap);

    const hydrateDeadline = Date.now() + 15000;
    while (Date.now() < hydrateDeadline && (!snap || snap.tenant !== "USD")) {
      if (timedOut(started)) {
        report.fail = "flow timeout";
        return finish(report, started, snap);
      }
      await sleep(250);
      snap = await evalPage(cdp, snapshotExpr());
    }
    report.snapshots.push({ at: "hydrate", snap });
    if (!snap || snap.tenant !== "USD") {
      report.fail = "tenant currency was not USD internally after hydrate";
      return finish(report, started, snap);
    }
    if (!sellerVisualOk(snap.primary) || !sellerVisualOk(snap.display)) {
      report.fail = "Seller amounts were not visual $: " + snap.primary + " / " + snap.display;
      return finish(report, started, snap);
    }
    if (!isFixtureTotal(snap.primary) || !isFixtureTotal(snap.display)) {
      report.fail = "hydrate total was not $4,365.09: " + snap.primary + " / " + snap.display;
      return finish(report, started, snap);
    }
    report.hydratePrices = { primary: snap.primary, display: snap.display, dayCount: snap.dayCount };

    const edit = await clickSelector(cdp, '#salesOperationalTimelineHost button[data-action="edit-day"]');
    if (!edit || !edit.ok) {
      report.fail = "could not click Edit";
      return finish(report, started, await evalPage(cdp, snapshotExpr()));
    }
    await sleep(400);
    await evalPage(
      cdp,
      `(function(){
        var modal = document.getElementById("salesOpDayModal");
        var phase = modal && modal.querySelector('[data-field="phase"]');
        if (phase && "value" in phase) phase.value = String(phase.value || "Prep") + " runtime";
        var save = document.getElementById("salesOpDayModalSave");
        if (save) save.click();
        return !!save;
      })()`
    );
    snap = await waitHealthyOrStorm(cdp, 2000, "edit", report);
    if (report.blocked || report.storm || report.repeatedWrites) return finish(report, started, snap);

    const add = await clickSelector(cdp, "#btnAddOperationalDay");
    if (!add || !add.ok) {
      report.fail = "could not click Add day";
      return finish(report, started, await evalPage(cdp, snapshotExpr()));
    }
    await sleep(400);
    await evalPage(
      cdp,
      `(function(){
        var save = document.getElementById("salesOpDayModalSave");
        if (save) save.click();
        return !!save;
      })()`
    );
    snap = await waitHealthyOrStorm(cdp, 2000, "add", report);
    if (report.blocked || report.storm || report.repeatedWrites) return finish(report, started, snap);

    const removed = await evalPage(
      cdp,
      `(function(){
        var buttons = document.querySelectorAll('#salesOperationalTimelineHost button[data-action="remove-day"]');
        var btn = buttons[buttons.length - 1];
        if (btn) btn.click();
        return { ok: !!btn, count: buttons.length };
      })()`
    );
    if (!removed || !removed.ok) {
      report.fail = "could not click Remove day";
      return finish(report, started, await evalPage(cdp, snapshotExpr()));
    }

    const beforeStable = await evalPage(cdp, snapshotExpr());
    snap = await waitHealthyOrStorm(cdp, STABILITY_MS, "stability", report);
    if (report.blocked || report.storm || report.repeatedWrites) return finish(report, started, snap);
    const mutBefore =
      Number(beforeStable.stats.mutations.salesPrimaryPrice) +
      Number(beforeStable.stats.mutations.salesPriceDisplay);
    const mutAfter =
      Number(snap.stats.mutations.salesPrimaryPrice) + Number(snap.stats.mutations.salesPriceDisplay);
    report.stability = { mutBefore: mutBefore, mutAfter: mutAfter };
    if (mutAfter > mutBefore) {
      report.storm = true;
      report.blockReason = "mutations grew during 30s stability " + mutBefore + " -> " + mutAfter;
    }

    for (let cycle = 1; cycle <= NAV_CYCLES; cycle += 1) {
      if (timedOut(started)) {
        report.fail = "flow timeout during Owner→Seller cycle " + cycle;
        return finish(report, started, snap);
      }
      let ownerSel = await waitNav(cdp, OWNER_HREF, 8000);
      if (!ownerSel) {
        await cdp.send("Page.navigate", { url: "http://127.0.0.1:" + port + OWNER_HREF });
        await waitReady(cdp, 15000);
        ownerSel = await waitNav(cdp, OWNER_HREF, 8000);
      }
      if (ownerSel) {
        const ownerClick = await clickSelector(cdp, ownerSel);
        if (!ownerClick || !ownerClick.ok) {
          report.fail = "cycle " + cycle + " could not click Owner";
          return finish(report, started, snap);
        }
      } else {
        await cdp.send("Page.navigate", { url: "http://127.0.0.1:" + port + OWNER_HREF });
      }
      if (!(await waitReady(cdp, 15000))) {
        report.fail = "cycle " + cycle + " Owner did not load";
        return finish(report, started, snap);
      }
      sellerSel = await waitNav(cdp, SELLER_HREF, 15000);
      if (!sellerSel) {
        report.fail = "cycle " + cycle + " Seller sidebar link missing";
        return finish(report, started, snap);
      }
      const sellerClick = await clickSelector(cdp, sellerSel);
      if (!sellerClick || !sellerClick.ok) {
        report.fail = "cycle " + cycle + " could not click Seller";
        return finish(report, started, snap);
      }
      if (!(await waitReady(cdp, 20000))) {
        report.fail = "cycle " + cycle + " Seller did not respond";
        return finish(report, started, snap);
      }
      snap = await waitHealthyOrStorm(cdp, 4000, "nav-" + cycle, report);
      if (report.blocked || report.storm || report.repeatedWrites) return finish(report, started, snap);
      if (!sellerVisualOk(snap.primary) || !sellerVisualOk(snap.display)) {
        report.fail = "cycle " + cycle + " visual $ failed: " + snap.primary + " / " + snap.display;
        return finish(report, started, snap);
      }
    }

    await evalPage(cdp, "window.scrollBy(0, 240); true");
    const clickAgain = await clickSelector(cdp, '#salesOperationalTimelineHost button[data-action="edit-day"]');
    const timerOk = await evalPage(
      cdp,
      `new Promise(function(resolve){ var t=Date.now(); setTimeout(function(){ resolve(Date.now()-t >= 40); }, 50); })`
    );
    report.post = {
      clickAgain: !!(clickAgain && clickAgain.ok),
      timerOk: timerOk === true,
      scrolled: true,
    };
    if (!report.post.clickAgain || !report.post.timerOk) {
      report.fail = "page not interactive after flow";
    }
    if (!sellerVisualOk(snap.primary) || !sellerVisualOk(snap.display)) {
      report.fail = "prices were not visual $ at the end";
    }
    return finish(report, started, snap);
  } catch (err) {
    report.blocked = /timeout|stall|socket/i.test(String(err && err.message));
    report.fail = String(err && err.message ? err.message : err);
    report.blockReason = report.blockReason || report.fail;
    return finish(report, started, null);
  } finally {
    if (cdp) cdp.close();
    try {
      launched.child.kill();
    } catch (_k) {}
    server.close();
  }
}

function finish(report, started, snap) {
  report.durationMs = Date.now() - started;
  report.final = snap;
  const stats = (snap && snap.stats) || {};
  report.metrics = {
    textWrites: stats.textWrites,
    identicalWrites: stats.identicalWrites,
    mutations: stats.mutations,
    paints: stats.paints,
    renders: stats.renders,
    layouts: stats.layouts,
    priceObservers: stats.priceObservers,
    pendingTimeouts: stats.pendingTimeouts,
    pendingIntervals: stats.pendingIntervals,
    heartbeatDelayMax: stats.heartbeatDelayMax,
    consoleErrors: stats.consoleErrors,
    exceptions: stats.exceptions,
  };
  const ident =
    Number((stats.identicalWrites && stats.identicalWrites.salesPrimaryPrice) || 0) +
    Number((stats.identicalWrites && stats.identicalWrites.salesPriceDisplay) || 0);
  const mut =
    Number((stats.mutations && stats.mutations.salesPrimaryPrice) || 0) +
    Number((stats.mutations && stats.mutations.salesPriceDisplay) || 0);
  const observers = Number(stats.priceObservers || 0);
  const heartbeat = Number(stats.heartbeatDelayMax || 0);
  const regression =
    report.blocked ||
    report.storm ||
    report.repeatedWrites ||
    ident > 20 ||
    mut > MUTATION_STORM_LIMIT ||
    observers > 0 && report.expectRegression;
  const healthy =
    !report.fail &&
    !report.blocked &&
    !report.storm &&
    !report.repeatedWrites &&
    ident <= IDENTICAL_WRITE_LIMIT &&
    observers === 0 &&
    heartbeat < HEARTBEAT_MAX_RECOMMENDED_MS &&
    snap &&
    sellerVisualOk(snap.primary) &&
    !usesMxn(snap.primary) &&
    !usesMxn(snap.display);
  report.regressionDetected = !!(regression || (observers > 0) || ident > IDENTICAL_WRITE_LIMIT && report.expectRegression);
  if (report.expectRegression) {
    report.outcome = report.regressionDetected || report.blocked || report.storm ? "REGRESSION_DETECTED" : "DOES_NOT_REPRODUCE";
    report.ok = report.outcome === "REGRESSION_DETECTED";
  } else {
    report.outcome = healthy ? "HEALTHY" : "UNHEALTHY";
    report.ok = healthy;
  }
  return report;
}

function printReport(report) {
  console.log("browser=" + report.version);
  console.log("chromePath=" + report.chromePath);
  console.log("root=" + report.root);
  console.log("outcome=" + report.outcome);
  console.log("duration_ms=" + report.durationMs);
  console.log("blockReason=" + (report.blockReason || report.fail || ""));
  console.log("metrics=" + JSON.stringify(report.metrics, null, 2));
  if (report.final) {
    console.log("primary=" + JSON.stringify(report.final.primary));
    console.log("display=" + JSON.stringify(report.final.display));
    console.log("tenant=" + report.final.tenant);
  }
  if (report.hydratePrices) console.log("hydrate=" + JSON.stringify(report.hydratePrices));
  if (report.stability) console.log("stability_mutations=" + JSON.stringify(report.stability));
  if (report.post) console.log("post=" + JSON.stringify(report.post));
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log("node scripts/test-seller-owner-preview-desktop-runtime.js [--root DIR] [--expect-regression]");
    process.exit(0);
  }
  if (!fs.existsSync(path.join(args.root, "public", "sales.html"))) {
    throw new Error("sales.html missing under " + args.root);
  }
  if (!findChrome()) {
    console.error("BLOCKED: no automatable Chromium/Edge/Chrome found");
    process.exit(2);
  }
  const report = await runFlow(args.root, args.expectRegression);
  if (report.blockedNoBrowser) {
    console.error("BLOCKED: no automatable Chromium/Edge/Chrome found");
    process.exit(2);
  }
  printReport(report);
  const passedLine = report.ok ? "1 passed" : "0 passed, 1 failed";
  console.log("\n" + (report.ok ? "1" : "0") + " passed");
  process.exit(report.ok ? 0 : 1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });
}

module.exports = { findChrome, parseArgs };
