#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const entry = require("../public/js/owner-multi-area-entry");

const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
let passed = 0;

function ok(label, value) {
  assert.ok(value, label);
  passed += 1;
  console.log("PASS " + label);
}

function eq(label, actual, expected) {
  assert.strictEqual(actual, expected, label);
  passed += 1;
  console.log("PASS " + label);
}

function memoryStorage(seed) {
  const data = Object.assign({}, seed || {});
  return {
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
    },
    setItem(key, value) {
      data[key] = String(value);
    },
    removeItem(key) {
      delete data[key];
    }
  };
}

function sliceBetween(source, startMark, endMark) {
  const start = source.indexOf(startMark);
  const end = source.indexOf(endMark, start + startMark.length);
  assert.ok(start >= 0 && end > start, startMark);
  return source.slice(start, end);
}

async function runOwnerNewQuoteMultiAreaEntryTests() {
  const owner = read("public/owner.html");
  const app = read("public/js/app.js");
  const sales = read("public/sales.html");
  const portal = read("public/js/sales-device-portal.js");
  const helper = read("public/js/owner-multi-area-entry.js");

  ok("owner modal offers Single Quote", owner.includes('id="ownerConfirmNewQuote"') && owner.includes("Single Quote"));
  ok("owner modal offers Multi-Area Quote", owner.includes('id="ownerConfirmMultiAreaQuote"') && owner.includes("Multi-Area Quote"));
  ok("owner modal offers Cancel", owner.includes('id="ownerCancelNewQuote"') && owner.includes(">Cancel<"));
  ok("owner page does not copy Work Areas", !owner.includes("seller-operational-plan-areas.js") && !owner.includes("salesWorkAreasHost"));
  ok("owner page loads the one-time entry helper", owner.includes('src="/js/owner-multi-area-entry.js"'));
  ok("sales page loads the same entry helper", sales.includes('src="/js/owner-multi-area-entry.js"'));

  const single = sliceBetween(app, 'if ($("ownerConfirmNewQuote"))', 'if ($("ownerConfirmMultiAreaQuote"))');
  const multi = sliceBetween(app, 'if ($("ownerConfirmMultiAreaQuote"))', 'if ($("ownerCancelNewQuote"))');
  const cancel = sliceBetween(app, 'if ($("ownerCancelNewQuote"))', 'if ($("btnExportPdf"))');
  ok("Single Quote keeps the owner reset", single.includes("resetOwnerQuoteStateForNewQuote()"));
  ok("Multi-Area does not reset mg_owner_v2", !multi.includes("resetOwnerQuoteStateForNewQuote"));
  ok("Multi-Area assigns only the entry path", multi.includes("window.location.assign(entry.ENTRY_PATH)"));
  ok("Cancel only closes the modal", cancel.includes("hideOwnerNewQuoteModal()") && !cancel.includes("resetOwnerQuoteStateForNewQuote"));

  const ownerMode = sliceBetween(portal, "async function applyOwnerMode", "function ensureSellerNotice");
  const sellerMode = sliceBetween(portal, "async function applySellerMode", "function boot(");
  ok("owner auth is the only consumer", ownerMode.includes("MgOwnerMultiAreaEntry") && ownerMode.includes('quoteMode: "multi_area"'));
  ok("seller mode does not consume the signal", !sellerMode.includes("MgOwnerMultiAreaEntry"));
  ok("entry helper does not publish, price, or fetch", !/fetch\s*\(|publish-public-quote|calc-secure-pricing|send-quote/.test(helper));

  eq("entry path is the owner preview", entry.ENTRY_PATH, "/sales?portal=owner");
  const store = memoryStorage();
  const armed = entry.arm({ storage: store, now: 1000, nonce: "once" });
  eq("armed path has no extra query", armed.href, "/sales?portal=owner");
  ok("armed record has no tenant id", armed.record && !Object.prototype.hasOwnProperty.call(armed.record, "tenant_id"));

  const first = entry.consume({
    storage: store,
    portal: "owner",
    authMode: "owner",
    portalMode: "owner",
    now: 1000
  });
  eq("authorized arrival resets once", first.reset, true);
  eq("authorized arrival selects multi-area", first.quoteMode, "multi_area");
  const refresh = entry.consume({
    storage: store,
    portal: "owner",
    authMode: "owner",
    portalMode: "owner",
    now: 1000
  });
  eq("refresh does not reset again", refresh.reset, false);
  eq("refresh finds no signal", store.getItem(entry.KEY), null);

  const sellerStore = memoryStorage();
  entry.arm({ storage: sellerStore, now: 1000, nonce: "seller" });
  const seller = entry.consume({
    storage: sellerStore,
    portal: "seller",
    authMode: "device",
    portalMode: "seller-device",
    now: 1000
  });
  eq("seller does not reset", seller.reset, false);
  eq("seller does not consume the signal", seller.consumed, false);
  ok("seller leaves the signal stored", sellerStore.getItem(entry.KEY) !== null);

  const locked = memoryStorage();
  entry.arm({ storage: locked, now: 1000, nonce: "locked" });
  const anon = entry.consume({
    storage: locked,
    portal: "owner",
    authMode: "",
    portalMode: "",
    now: 1000
  });
  eq("missing owner auth does not reset", anon.reset, false);
  eq("missing owner auth does not consume", anon.consumed, false);
  ok("missing owner auth leaves the signal stored", locked.getItem(entry.KEY) !== null);

  const stale = memoryStorage();
  entry.arm({ storage: stale, now: 1000, nonce: "stale" });
  const expired = entry.consume({
    storage: stale,
    portal: "owner",
    authMode: "owner",
    portalMode: "owner",
    now: 1000 + 120001
  });
  eq("expired signal does not reset", expired.reset, false);
  eq("expired signal is removed", stale.getItem(entry.KEY), null);

  const poisoned = memoryStorage();
  poisoned.setItem(entry.KEY, JSON.stringify({ v: 1, nonce: "x", exp: 5000, tenant_id: "secret" }));
  const rejected = entry.consume({
    storage: poisoned,
    portal: "owner",
    authMode: "owner",
    portalMode: "owner",
    now: 1000
  });
  eq("tenant id in the signal does not reset", rejected.reset, false);

  return passed;
}

const EXPECTED = 29;

module.exports = { runOwnerNewQuoteMultiAreaEntryTests, EXPECTED };

if (require.main === module) {
  runOwnerNewQuoteMultiAreaEntryTests()
    .then((count) => {
      if (count !== EXPECTED) throw new Error("expected " + EXPECTED + " got " + count);
      console.log(count + " passed");
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
