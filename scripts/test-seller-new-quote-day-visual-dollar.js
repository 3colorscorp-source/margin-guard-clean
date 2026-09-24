#!/usr/bin/env node
/**
 * Existing quote → New Quote → Add/Edit Day. Real sales.html, app.js, sales-device-portal.js.
 * Local Chrome gate only. Not a Seller Shield CI required job.
 * Hard timeout 120s. Fails immediately if Chrome stays on about:blank.
 * Exit 2 if no automatable browser is found.
 *
 *   node scripts/test-seller-new-quote-day-visual-dollar.js
 *   node scripts/test-seller-new-quote-day-visual-dollar.js --root DIR --expect-regression
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const DEFAULT_ROOT = path.resolve(__dirname, "..");
const HARD_TIMEOUT_MS = 120000;
const BLANK_FAIL_MS = 5000;
const WAIT_AFTER_SAVE_MS = 60000;
const A639BE7 = "a639be7214121f7ba70e81b4131ddec6af58bde6";

function parseArgs(argv) {
  const out = { root: DEFAULT_ROOT, expectRegression: false };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--root") out.root = path.resolve(String(argv[++i] || ""));
    else if (argv[i] === "--expect-regression") out.expectRegression = true;
    else throw new Error("Unknown argument: " + argv[i]);
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
  for (let i = 0; i < candidates.length; i += 1) {
    if (candidates[i] && fs.existsSync(candidates[i])) return candidates[i];
  }
  return "";
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function startServer(root) {
  const publicDir = path.join(root, "public");
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname.indexOf("/.netlify/functions/") === 0) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, mocked: true }));
      return;
    }
    let rel = url.pathname;
    if (rel === "/" || rel === "/sales" || rel === "/sales/") rel = "/sales.html";
    rel = path.normalize(rel).replace(/^[\\/]+/, "");
    if (rel.indexOf("..") >= 0) {
      res.writeHead(400);
      res.end("bad");
      return;
    }
    const filePath = path.join(publicDir, rel);
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    let body = fs.readFileSync(filePath);
    if (path.basename(filePath) === "sales.html") {
      body = Buffer.from(
        body
          .toString("utf8")
          .replace(/<script defer src="https:\/\/cdn\.jsdelivr\.net\/npm\/jspdf@[^"]+"><\/script>/, "<!-- jspdf stub -->"),
        "utf8"
      );
    }
    const ext = path.extname(filePath);
    const mime =
      ext === ".html"
        ? "text/html; charset=utf-8"
        : ext === ".js"
          ? "text/javascript; charset=utf-8"
          : ext === ".css"
            ? "text/css; charset=utf-8"
            : "application/octet-stream";
    res.writeHead(200, { "Content-Type": mime });
    res.end(body);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port })));
}

const INIT = String.raw`
(function(){
  if (window.__mgDayRt) return;
  var s = { securePricingCalls: 0, bannedWrites: [], writes: [], hrefLog: [location.href] };
  window.__mgDayRt = s;
  var orig = window.fetch.bind(window);
  window.fetch = function(input, init){
    var url = "";
    try { url = typeof input === "string" ? input : String(input && input.url || ""); } catch(_e) {}
    function json(data, status){
      return Promise.resolve(new Response(JSON.stringify(data), { status: status||200, headers: {"Content-Type":"application/json"} }));
    }
    if (/calc-secure-pricing/.test(url)) {
      s.securePricingCalls += 1;
      return json({ ok:true, recommended:1497.74, currency:"MXN" }, 200);
    }
    if (/get-seller-business-settings/.test(url)) {
      return json({ ok:true, source:"tenant_snapshot", settings:{
        currency:"MXN", baseInstaller:142.2175, baseHelper:45, hoursPerDay:8, pricingMode:"hour",
        wcPct:0, ficaPct:0, futaPct:0, casuiPct:0, overheadMonthly:0, stdHours:160,
        profitPct:0, minimumMarginPct:0, reservePct:0, salesCommissionPct:0, workdaysEnabled:true
      }});
    }
    if (/auth-status/.test(url)) return json({ active:true, email:"rt@example.test", is_admin:true });
    return json({ ok:true, active:true, mocked:true, settings:{ currency:"MXN" } });
  };
  var settings = { currency:"MXN", baseInstaller:142.2175, baseHelper:45, hoursPerDay:8, pricingMode:"hour",
    wcPct:0, ficaPct:0, futaPct:0, casuiPct:0, overheadMonthly:0, stdHours:160, profitPct:0, minimumMarginPct:0, reservePct:0, salesCommissionPct:0, workdaysEnabled:true };
  var sales = { clientName:"Existing Quote Client", estimateStatus:"pricing_ready", price:1497.74, offeredPrice:1497.74, pricingStage:2,
    workers:[{name:"Installer 1", type:"installer", days:1, rate:""},{name:"Helper 1", type:"helper", days:1, rate:""}],
    operational_plan:[{ day_number:1, phase:"Day 1", workers:[
      { role:"Installer", worker_type:"pro", estimated_hours:8 },
      { role:"Assistant", worker_type:"helper", estimated_hours:8 }
    ]}], labor_auto_sync_from_plan:true };
  try { localStorage.setItem("mg_settings_v2", JSON.stringify(settings)); localStorage.setItem("mg_sales_v2", JSON.stringify(sales)); } catch(_e) {}
  var desc = Object.getOwnPropertyDescriptor(Node.prototype, "textContent");
  if (desc && desc.set && desc.get) {
    Object.defineProperty(Node.prototype, "textContent", {
      configurable: true,
      enumerable: desc.enumerable,
      get: function(){ return desc.get.call(this); },
      set: function(value){
        var id = this && this.id;
        if (id === "salesPrimaryPrice" || id === "salesPriceDisplay") {
          var next = value == null ? "" : String(value);
          s.writes = s.writes || [];
          s.writes.push(next);
          if (/MX\$|MXN|US\$|\bUSD\b/i.test(next)) s.bannedWrites.push(next);
        }
        return desc.set.call(this, value);
      }
    });
  }
})();
`;

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
        if (msg.error) p.reject(new Error(msg.error.message || "cdp"));
        else p.resolve(msg.result || {});
      }
    };
  }
  ready(ms) {
    if (this.ws.readyState === 1) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("CDP websocket blank/timeout")), ms || BLANK_FAIL_MS);
      this.ws.onopen = () => {
        clearTimeout(t);
        resolve();
      };
      this.ws.onerror = (err) => {
        clearTimeout(t);
        reject(err || new Error("CDP websocket error"));
      };
    });
  }
  send(method, params, timeoutMs) {
    const id = (this.id += 1);
    const ms = timeoutMs == null ? 5000 : timeoutMs;
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
    } catch (_e) {}
  }
}

async function evalPage(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, 5000);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "eval");
  return result.result ? result.result.value : undefined;
}

function banned(text) {
  return /MX\$|MXN|US\$|\bUSD\b/i.test(String(text || ""));
}
function isZero(text) {
  return /\$0\.00/.test(String(text || "")) && !banned(text);
}
function isVisual(text) {
  return /\$1,497\.74/.test(String(text || "")) && !banned(text);
}
function isMx(text) {
  return /MX\$/.test(String(text || "")) || /MXN1497|MXN1,497/.test(String(text || ""));
}

async function snap(cdp) {
  return evalPage(
    cdp,
    `(function(){
      var nodes = document.querySelectorAll('[id="salesPrimaryPrice"]');
      var all = [];
      var visible = "";
      for (var i = 0; i < nodes.length; i++) {
        var t = String(nodes[i].textContent || "").trim();
        all.push(t);
        var st = window.getComputedStyle(nodes[i]);
        var r = nodes[i].getBoundingClientRect();
        if (st.display === "none" || st.visibility === "hidden") continue;
        if (r.width <= 0 && r.height <= 0) continue;
        visible = t;
      }
      var n = document.getElementById("salesPrimaryPrice");
      var d = document.getElementById("salesPriceDisplay");
      var meta = document.getElementById("salesPrimaryMeta");
      var kpi = document.getElementById("salesKpis");
      var modal = document.getElementById("salesOpDayModal");
      var bodyText = String((document.body && document.body.innerText) || "");
      var metaText = meta ? String(meta.textContent || "").trim() : "";
      var kpiText = kpi ? String(kpi.textContent || "").replace(/\s+/g, " ").trim() : "";
      var joined = [visible, d && d.textContent, metaText, kpiText].join(" | ");
      var rt = window.__mgDayRt || {};
      return {
        href: String(location.href || ""),
        readyState: String(document.readyState || ""),
        blank: location.href === "about:blank",
        emptyBody: bodyText.trim().length < 20,
        primary: visible || (n ? String(n.textContent||"").trim() : ""),
        allPrimary: all,
        display: d ? String(d.textContent||"").trim() : "",
        meta: metaText,
        kpi: kpiText,
        twoDays: /2\.00 worker-days/.test(metaText),
        sixteenHours: /16\.00 labor-hours/.test(metaText),
        bannedVisible: /MX\$|MXN|US\$|\bUSD\b/i.test(joined),
        modalOpen: !!(modal && modal.getAttribute("aria-hidden") === "false"),
        ready: !!(document.body && document.body.classList.contains("auth-ready")),
        tenant: window.__mgSellerTenantCurrency || "",
        calls: rt.securePricingCalls || 0,
        bannedWrites: rt.bannedWrites || [],
        writes: rt.writes || [],
        bodyLen: bodyText.length
      };
    })()`
  );
}

async function click(cdp, selector) {
  return evalPage(
    cdp,
    `(function(){ var el=document.querySelector(${JSON.stringify(selector)}); if(!el) return {ok:false}; el.click(); return {ok:true}; })()`
  );
}

async function waitPred(cdp, ms, pred) {
  const end = Date.now() + ms;
  let last = null;
  while (Date.now() < end) {
    last = await snap(cdp);
    if (last && last.blank) throw new Error("BLANK_CHROME href=" + last.href + " bodyLen=" + last.bodyLen);
    if (pred(last)) return last;
    await sleep(200);
  }
  return last;
}

async function waitLoaded(cdp) {
  const end = Date.now() + 8000;
  let last = null;
  while (Date.now() < end) {
    last = await snap(cdp);
    if (last && last.blank) {
      throw new Error("BLANK_CHROME href=" + last.href + " bodyLen=" + last.bodyLen);
    }
    if (
      last &&
      /sales/.test(last.href || "") &&
      (last.readyState === "complete" || last.readyState === "interactive") &&
      !last.emptyBody
    ) {
      return last;
    }
    await sleep(200);
  }
  throw new Error(
    "BLANK_CHROME after navigate href=" +
      ((last && last.href) || "") +
      " readyState=" +
      ((last && last.readyState) || "") +
      " bodyLen=" +
      ((last && last.bodyLen) || 0)
  );
}

async function connect(debugPort) {
  const end = Date.now() + BLANK_FAIL_MS;
  let target = null;
  while (Date.now() < end) {
    try {
      const list = await fetch("http://127.0.0.1:" + debugPort + "/json/list").then((r) => r.json());
      target = (list || []).find((t) => t.type === "page") || (list || [])[0];
      if (target && target.webSocketDebuggerUrl) break;
    } catch (_e) {}
    await sleep(150);
  }
  if (!target || !target.webSocketDebuggerUrl) throw new Error("BLANK_CHROME: no page websocket after " + BLANK_FAIL_MS + "ms");
  const cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.ready(BLANK_FAIL_MS);
  return cdp;
}

async function run(root, expectRegression) {
  const chromePath = findChrome();
  if (!chromePath) return { blockedNoBrowser: true };
  const started = Date.now();
  const report = { root, expectRegression, negativeControlSha: A639BE7, chromePath };
  const { server, port } = await startServer(root);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "mg-nq-day-"));
  const dbg = 9333 + Math.floor(Math.random() * 300);
  const child = spawn(
    chromePath,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--disable-extensions",
      "--remote-allow-origins=*",
      "--user-data-dir=" + profile,
      "--remote-debugging-port=" + dbg,
      "about:blank",
    ],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
  );
  let cdp;
  const killer = setTimeout(() => {
    try {
      child.kill();
    } catch (_e) {}
  }, HARD_TIMEOUT_MS);
  try {
    const readyEnd = Date.now() + BLANK_FAIL_MS;
    while (Date.now() < readyEnd) {
      try {
        const ver = await fetch("http://127.0.0.1:" + dbg + "/json/version");
        if (ver.ok) break;
      } catch (_e) {}
      await sleep(150);
    }
    cdp = await connect(dbg);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: INIT });
    const url = "http://127.0.0.1:" + port + "/sales?portal=owner";
    await cdp.send("Page.navigate", { url: url });
    const loaded = await waitLoaded(cdp);
    let s = await waitPred(cdp, 12000, (x) => x && x.primary);
    report.existing = s && s.primary;
    const nq = await click(cdp, "#btnNewSalesQuote");
    if (!nq || !nq.ok) throw new Error("New Quote button missing");
    await sleep(300);
    const conf = await click(cdp, "#salesConfirmNewQuote");
    if (!conf || !conf.ok) throw new Error("New Quote confirm missing");
    s = await waitPred(cdp, 10000, (x) => x && isZero(x.primary));
    report.newQuote = s && s.primary;
    if (!s || !isZero(s.primary)) throw new Error("New Quote did not show $0.00: " + ((s && s.primary) || ""));
    const add = await click(cdp, "#btnAddOperationalDay");
    if (!add || !add.ok) throw new Error("Add Day missing");
    s = await waitPred(cdp, 8000, (x) => x && x.modalOpen);
    report.addDay = s && s.primary;
    if (!s || !s.modalOpen) throw new Error("Add Day modal did not open");
    const firstSave = await click(cdp, "#salesOpDayModalSave");
    if (!firstSave || !firstSave.ok) throw new Error("Save Day missing after Add");
    await sleep(400);
    const edit = await click(cdp, '#salesOperationalTimelineHost button[data-action="edit-day"]');
    if (!edit || !edit.ok) throw new Error("Edit Day missing");
    s = await waitPred(cdp, 8000, (x) => x && x.modalOpen);
    if (!s || !s.modalOpen) throw new Error("Edit Day modal did not open");
    const crew = await evalPage(
      cdp,
      `(function(){
        var rows = document.querySelectorAll("#salesOpDayModalBody .sales-operational-worker");
        var label = document.querySelector("#salesOpDayModalBody .sales-op-unit-label");
        var hour = !!(label && /h/i.test(String(label.textContent||"")));
        var val = hour ? "8" : "1";
        if (rows.length < 2) {
          var addCrew = document.querySelector("#salesOpDayModalBody [data-action='add-worker']");
          if (addCrew) addCrew.click();
        }
        rows = document.querySelectorAll("#salesOpDayModalBody .sales-operational-worker");
        for (var i = 0; i < rows.length; i++) {
          var type = rows[i].querySelector("[data-field='worker_type']");
          var units = rows[i].querySelector("[data-field='estimated_units']");
          if (type) type.value = i === 0 ? "pro" : "helper";
          if (units) {
            units.value = val;
            units.dispatchEvent(new Event("input", { bubbles: true }));
            units.dispatchEvent(new Event("change", { bubbles: true }));
          }
        }
        return { count: rows.length, val: val, hour: hour };
      })()`
    );
    report.crew = crew;
    const save = await click(cdp, "#salesOpDayModalSave");
    if (!save || !save.ok) throw new Error("Save Day missing after Edit");
    s = await waitPred(cdp, 8000, (x) => x && x.twoDays && x.sixteenHours);
    report.saveDay = s && s.primary;
    report.meta = s && s.meta;
    report.twoDays = s && s.twoDays;
    report.sixteenHours = s && s.sixteenHours;
    report.allPrimary = s && s.allPrimary;
    report.bannedWrites = s && s.bannedWrites;
    report.bannedVisible = s && s.bannedVisible;
    if (!s || !s.twoDays || !s.sixteenHours) {
      throw new Error("expected 2.00 worker-days / 16.00 labor-hours, meta=" + ((s && s.meta) || ""));
    }
    const saveCalls = (s && s.calls) || 0;
    const waitStart = Date.now();
    while (Date.now() - waitStart < WAIT_AFTER_SAVE_MS) {
      if (Date.now() - started > HARD_TIMEOUT_MS - 3000) throw new Error("hard timeout during 60s wait");
      await sleep(2000);
      s = await snap(cdp);
      if (s.blank) throw new Error("BLANK_CHROME during 60s wait href=" + s.href);
      if (!expectRegression && (s.bannedVisible || banned(s.primary) || banned(s.display) || banned(s.kpi))) {
        throw new Error("banned visible label: " + s.primary + " / " + s.kpi);
      }
    }
    report.after60s = s && s.primary;
    report.calls = s && s.calls;
    report.tenant = s && s.tenant;
    report.bannedWrites = s && s.bannedWrites;
    report.bannedVisible = s && s.bannedVisible;
    const clickOk = await evalPage(
      cdp,
      `(function(){ var el=document.getElementById("btnNewSalesQuote"); if(!el) return false; el.click(); var cancel=document.getElementById("salesCancelNewQuote"); if(cancel) cancel.click(); return true; })()`
    );
    const scrollOk = await evalPage(
      cdp,
      `(function(){ window.scrollBy(0, 240); return true; })()`
    );
    const timerOk = await evalPage(
      cdp,
      `new Promise(function(resolve){ var t=Date.now(); setTimeout(function(){ resolve(Date.now()-t >= 40); }, 50); })`
    );
    report.interactive = { clickOk: clickOk === true, scrollOk: scrollOk === true, timerOk: timerOk === true };

    if (expectRegression) {
      const texts = [report.addDay, report.saveDay, report.after60s]
        .concat(report.allPrimary || [])
        .concat(report.bannedWrites || []);
      const reproduced =
        isZero(report.newQuote) && texts.some(function (t) { return isMx(t) || banned(t); });
      report.outcome = reproduced ? "REGRESSION_DETECTED" : "DOES_NOT_REPRODUCE";
      report.ok = reproduced && report.interactive.clickOk && report.interactive.scrollOk && report.interactive.timerOk;
      if (!reproduced) {
        report.fail =
          "a639be7 did not reproduce $0.00 → MX$/MXN after Add/Edit Day: visible=" +
          report.after60s +
          " writes=" +
          JSON.stringify(report.bannedWrites);
      }
      return finish(report, started, s);
    }
    const visualOk =
      isZero(report.newQuote) &&
      isVisual(report.saveDay) &&
      isVisual(report.after60s) &&
      !report.bannedVisible &&
      !(report.bannedWrites || []).length;
    const cycle = Number(report.calls || 0) > 12 || Number(report.calls || 0) - saveCalls > 8;
    report.outcome = visualOk && !cycle && report.interactive.clickOk && report.interactive.scrollOk && report.interactive.timerOk ? "HEALTHY" : "UNHEALTHY";
    report.ok = report.outcome === "HEALTHY";
    if (!report.ok) {
      report.fail =
        "expected $0.00 → $1,497.74 with 2 worker-days/16h and no banned labels, got " +
        JSON.stringify({
          newQuote: report.newQuote,
          save: report.saveDay,
          after: report.after60s,
          meta: report.meta,
          calls: report.calls,
          bannedWrites: report.bannedWrites,
          interactive: report.interactive,
        });
    }
    return finish(report, started, s);
  } catch (err) {
    report.fail = String(err && err.message ? err.message : err);
    report.ok = false;
    report.outcome = /BLANK_CHROME/.test(report.fail) ? "BLANK_CHROME" : "UNHEALTHY";
    return finish(report, started, null);
  } finally {
    clearTimeout(killer);
    if (cdp) cdp.close();
    try {
      child.kill();
    } catch (_e) {}
    server.close();
  }
}

function finish(report, started, snap) {
  report.durationMs = Date.now() - started;
  report.final = snap;
  return report;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!findChrome()) {
    console.error("BLOCKED: no Chrome");
    process.exit(2);
  }
  const hard = setTimeout(() => {
    console.error("FAIL hard timeout " + HARD_TIMEOUT_MS + "ms");
    process.exit(1);
  }, HARD_TIMEOUT_MS);
  const report = await run(args.root, args.expectRegression);
  clearTimeout(hard);
  if (report.blockedNoBrowser) {
    console.error("BLOCKED: no Chrome");
    process.exit(2);
  }
  console.log(JSON.stringify({
    outcome: report.outcome,
    ok: report.ok,
    fail: report.fail || "",
    duration_ms: report.durationMs,
    existing: report.existing,
    newQuote: report.newQuote,
    addDay: report.addDay,
    saveDay: report.saveDay,
    after60s: report.after60s,
    meta: report.meta,
    twoDays: report.twoDays,
    sixteenHours: report.sixteenHours,
    interactive: report.interactive,
    calls: report.calls,
    tenant: report.tenant,
    root: report.root,
    expectRegression: report.expectRegression,
    allPrimary: report.allPrimary,
    bannedWrites: report.bannedWrites,
  }, null, 2));
  console.log("\n" + (report.ok ? "1" : "0") + " passed");
  process.exit(report.ok ? 0 : 1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { HARD_TIMEOUT_MS, WAIT_AFTER_SAVE_MS, A639BE7 };
