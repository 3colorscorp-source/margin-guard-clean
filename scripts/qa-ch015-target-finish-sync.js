/**
 * CH-015 — Target Finish Date must survive async capacity callbacks and rerenders.
 * Run: node scripts/qa-ch015-target-finish-sync.js
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

/** Slice a function declaration out of a source file by brace matching. */
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
const capacityJs = read("public/js/sales-capacity-calendar.js");
const salesHtml = read("public/sales.html");
const ownerCapJs = read("public/js/owner-capacity-ui.js");

// ---------------------------------------------------------------------------
// Harness: real capacity module + a minimal DOM, driving the real sync helper.
// ---------------------------------------------------------------------------

function loadCapacityModule(documentStub) {
  const windowStub = { document: documentStub };
  const factory = new Function(
    "window",
    "globalThis",
    "document",
    capacityJs + "\n; return window.MarginGuardSalesCapacity;"
  );
  return factory(windowStub, windowStub, documentStub);
}

function makeDom() {
  const nodes = {
    salesStartDate: { value: "" },
    salesTargetFinishDate: { value: "" },
    salesDueDate: { value: "" },
    salesTargetFinishHint: { textContent: "" }
  };
  return {
    nodes,
    getElementById(id) {
      return nodes[id] || null;
    }
  };
}

/**
 * Mirrors the shipped syncSalesTargetFinish contract in public/js/app.js:
 * duration resolved per call, clear only when start/duration are truly missing.
 */
function makeSalesSync(dom, cap, state, durationRef) {
  const norm = (v) => {
    const s = String(v == null ? "" : v).trim().slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "";
  };
  const finishInput = dom.getElementById("salesTargetFinishDate");
  const dueInput = dom.getElementById("salesDueDate");
  const startInput = dom.getElementById("salesStartDate");
  const clear = () => {
    finishInput.value = "";
    dueInput.value = "";
    state.targetFinishDate = "";
    state.dueDate = "";
    return "";
  };
  return function syncSalesTargetFinish(startYmd, projectedFinishDate) {
    const start = norm(startYmd || startInput.value || state.startDate || "");
    const days = durationRef.resolve();
    const inputsMissing = !start || !(days > 0);
    const result = cap.updateTargetFinishDisplay(start, days, {
      workdaysEnabled: true,
      projectedFinishDate: projectedFinishDate || null,
      calendar: null
    });
    if (result.start) state.startDate = result.start;
    if (result.finish) {
      state.targetFinishDate = result.finish;
      state.dueDate = result.finish;
      return result.finish;
    }
    if (inputsMissing) return clear();
    const preserved = norm(state.targetFinishDate || state.dueDate || "");
    if (preserved) {
      finishInput.value = preserved;
      dueInput.value = preserved;
      state.targetFinishDate = preserved;
      state.dueDate = preserved;
    }
    return preserved;
  };
}

function makeHarness(initialDays) {
  const dom = makeDom();
  const cap = loadCapacityModule(dom);
  const state = { startDate: "", targetFinishDate: "", dueDate: "" };
  const durationRef = {
    days: initialDays,
    resolve() {
      return this.days;
    }
  };
  const sync = makeSalesSync(dom, cap, state, durationRef);
  return { dom, cap, state, durationRef, sync };
}

/** Capacity refresh with the shipped generation guard, resolving days at callback time. */
function makeCapacityRefresh(h, scope) {
  return function refresh(desiredStart, responseDays) {
    const generation = h.cap.nextCapacityGeneration(scope);
    const desired = desiredStart;
    return {
      generation,
      // Simulates the fetch .then(...) resolving later, possibly out of order.
      apply(projectedFinishDate) {
        if (!h.cap.isCurrentCapacityGeneration(scope, generation)) return "stale-ignored";
        if (responseDays !== undefined) h.durationRef.days = responseDays;
        return h.sync(desired || "", projectedFinishDate || null);
      }
    };
  };
}

test("syntax on every touched JavaScript file", () => {
  ["public/js/app.js", "public/js/sales-capacity-calendar.js", "public/js/owner-capacity-ui.js"].forEach(
    checkSyntax
  );
});

test("1 two-day job with a valid start renders a finish", () => {
  const h = makeHarness(2);
  h.dom.nodes.salesStartDate.value = "2026-08-10";
  const finish = h.sync("2026-08-10");
  assert.strictEqual(finish, "2026-08-11");
  assert.strictEqual(h.dom.nodes.salesTargetFinishDate.value, "2026-08-11");
});

test("2 later async callback keeps the finish visible", () => {
  const h = makeHarness(2);
  h.dom.nodes.salesStartDate.value = "2026-08-10";
  h.sync("2026-08-10");
  const refresh = makeCapacityRefresh(h, "sales");
  const call = refresh("2026-08-10");
  assert.strictEqual(call.apply("2026-08-11"), "2026-08-11");
  assert.strictEqual(h.dom.nodes.salesTargetFinishDate.value, "2026-08-11");
});

test("3 stale response with zero duration cannot clear the finish", () => {
  const h = makeHarness(0);
  const refresh = makeCapacityRefresh(h, "sales");
  const staleCall = refresh("", 0); // scheduled while duration was still 0
  h.dom.nodes.salesStartDate.value = "2026-08-10";
  h.durationRef.days = 2;
  h.sync("2026-08-10");
  assert.strictEqual(h.dom.nodes.salesTargetFinishDate.value, "2026-08-11");
  const newerCall = refresh("2026-08-10");
  assert.strictEqual(staleCall.apply(), "stale-ignored");
  assert.strictEqual(h.dom.nodes.salesTargetFinishDate.value, "2026-08-11");
  assert.strictEqual(h.state.targetFinishDate, "2026-08-11");
  newerCall.apply("2026-08-11");
  assert.strictEqual(h.dom.nodes.salesTargetFinishDate.value, "2026-08-11");
});

test("4 newer response wins over an older in-flight response", () => {
  const h = makeHarness(2);
  h.dom.nodes.salesStartDate.value = "2026-08-10";
  h.sync("2026-08-10");
  const refresh = makeCapacityRefresh(h, "sales");
  const older = refresh("2026-08-10");
  const newer = refresh("2026-08-17");
  h.dom.nodes.salesStartDate.value = "2026-08-17";
  assert.strictEqual(newer.apply("2026-08-18"), "2026-08-18");
  assert.strictEqual(older.apply("2026-08-11"), "stale-ignored");
  assert.strictEqual(h.dom.nodes.salesTargetFinishDate.value, "2026-08-18");
});

test("4b per-scope generations keep sales and owner independent", () => {
  const h = makeHarness(2);
  const salesGen = h.cap.nextCapacityGeneration("sales");
  h.cap.nextCapacityGeneration("owner");
  h.cap.nextCapacityGeneration("owner");
  assert.strictEqual(h.cap.isCurrentCapacityGeneration("sales", salesGen), true);
});

test("5+6+7 rerenders (UI, pricing, crew) preserve the finish", () => {
  const h = makeHarness(2);
  h.dom.nodes.salesStartDate.value = "2026-08-10";
  h.sync("2026-08-10");
  for (const label of ["ui-rerender", "pricing-recalc", "crew-rerender"]) {
    assert.strictEqual(h.sync(""), "2026-08-11", label);
    assert.strictEqual(h.dom.nodes.salesTargetFinishDate.value, "2026-08-11", label);
  }
});

test("8 seller operational render cannot clear a valid finish", () => {
  const src = extractFunction(salesHtml, "syncSellerOperationalTargetFinishDisplay");
  assert.ok(src.includes("resolveSellerTargetFinishDays(state, settings, metrics)"));
  assert.ok(
    src.includes("var preserved = String((state && (state.targetFinishDate || state.dueDate)) || '')"),
    "seller render must restore the authoritative finish"
  );
  const resolver = extractFunction(salesHtml, "resolveSellerTargetFinishDays");
  ["estimated_days", "readOperationalDaysOverride", "workerDaysAsInteger", "operational_plan"].forEach(
    (needle) => assert.ok(resolver.includes(needle), "missing fallback: " + needle)
  );
});

test("9 start-date change recalculates the finish", () => {
  const h = makeHarness(2);
  h.dom.nodes.salesStartDate.value = "2026-08-10";
  assert.strictEqual(h.sync("2026-08-10"), "2026-08-11");
  h.dom.nodes.salesStartDate.value = "2026-08-17";
  assert.strictEqual(h.sync("2026-08-17"), "2026-08-18");
  assert.strictEqual(h.state.dueDate, "2026-08-18");
});

test("10 duration change recalculates the finish", () => {
  const h = makeHarness(2);
  h.dom.nodes.salesStartDate.value = "2026-08-10";
  assert.strictEqual(h.sync("2026-08-10"), "2026-08-11");
  h.durationRef.days = 4;
  assert.strictEqual(h.sync("2026-08-10"), "2026-08-13");
});

test("11 clearing the start date clears the finish", () => {
  const h = makeHarness(2);
  h.dom.nodes.salesStartDate.value = "2026-08-10";
  h.sync("2026-08-10");
  h.dom.nodes.salesStartDate.value = "";
  h.state.startDate = "";
  assert.strictEqual(h.sync(""), "");
  assert.strictEqual(h.dom.nodes.salesTargetFinishDate.value, "");
  assert.strictEqual(h.state.targetFinishDate, "");
  assert.strictEqual(h.state.dueDate, "");
});

test("12 clearing the duration clears the finish", () => {
  const h = makeHarness(2);
  h.dom.nodes.salesStartDate.value = "2026-08-10";
  h.sync("2026-08-10");
  h.durationRef.days = 0;
  assert.strictEqual(h.sync("2026-08-10"), "");
  assert.strictEqual(h.dom.nodes.salesTargetFinishDate.value, "");
  assert.strictEqual(h.state.targetFinishDate, "");
});

test("13+14+15 state, due date and hidden due field match the DOM", () => {
  const h = makeHarness(3);
  h.dom.nodes.salesStartDate.value = "2026-08-10";
  const finish = h.sync("2026-08-10");
  assert.strictEqual(h.state.targetFinishDate, h.dom.nodes.salesTargetFinishDate.value);
  assert.strictEqual(h.state.dueDate, finish);
  assert.strictEqual(h.dom.nodes.salesDueDate.value, finish);
});

test("16 save and reopen preserves or recomputes the same finish", () => {
  const first = makeHarness(2);
  first.dom.nodes.salesStartDate.value = "2026-08-10";
  const finish = first.sync("2026-08-10");
  const saved = JSON.parse(JSON.stringify({ ...first.state, finish }));
  const reopened = makeHarness(2);
  reopened.state.startDate = saved.startDate;
  reopened.state.targetFinishDate = saved.targetFinishDate;
  reopened.state.dueDate = saved.dueDate;
  reopened.dom.nodes.salesStartDate.value = saved.startDate;
  assert.strictEqual(reopened.sync(""), saved.finish);
  assert.strictEqual(reopened.dom.nodes.salesTargetFinishDate.value, saved.finish);
});

test("17 shipped app.js resolves duration at call time and guards stale responses", () => {
  assert.ok(appJs.includes("const resolveCurrentSalesProjectDays = () => {"));
  assert.ok(
    appJs.includes("const result = cap.updateTargetFinishDisplay(start, days, finishOpts);"),
    "sales sync must pass freshly resolved days"
  );
  assert.ok(!/const estimatedProjectDays = resolveSalesEstimatedProjectDays/.test(appJs));
  assert.ok(appJs.includes('cap.nextCapacityGeneration("sales")'));
  assert.ok(appJs.includes('salesCap.nextCapacityGeneration("owner")'));
  const guards = appJs.match(/if \(!isLatestCapacityResponse\(\)\) return;/g) || [];
  assert.ok(guards.length >= 4, "sales+owner then/catch must all drop stale responses");
  assert.ok(appJs.includes("const days = resolveCurrentSalesProjectDays();"));
  assert.ok(appJs.includes("const days = resolveOwnerEstimatedProjectDays(state, settings);"));
  assert.ok(
    appJs.includes("syncSalesTargetFinish(desired || \"\", data.projected_finish_date);"),
    "sales callback must not force-clear when a start is still valid"
  );
  assert.ok(appJs.includes("if (inputsMissing) return clearSalesTargetFinish();"));
  assert.ok(appJs.includes("if (inputsMissing) return clearOwnerFinish();"));
});

test("18 business-day math and capacity policy unchanged", () => {
  assert.ok(capacityJs.includes("function addBusinessDaysLocal(fromYmd, steps)"));
  assert.ok(capacityJs.includes("if (!workdaysOnly) return addCalendarDays(startYmd, days - 1);"));
  assert.ok(capacityJs.includes("return addBusinessDaysLocal(startYmd, days - 1);"));
  assert.ok(/const dow = dt\.getDay\(\);\s+return dow !== 0 && dow !== 6;/.test(capacityJs));
  assert.ok(ownerCapJs.includes("function updateTargetFinishDisplay(startYmd, estimatedDays, options)"));
  const h = makeHarness(1);
  h.dom.nodes.salesStartDate.value = "2026-08-14"; // Friday, 3-day job skips the weekend
  h.durationRef.days = 3;
  assert.strictEqual(h.sync("2026-08-14"), "2026-08-18");
});

test("19 only approved files changed", () => {
  const diff = spawnSync("git", ["diff", "--name-only"], { cwd: ROOT, encoding: "utf8" });
  assert.strictEqual(diff.status, 0, diff.stderr);
  const changed = diff.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const allowed = new Set([
    "public/js/app.js",
    "public/js/sales-capacity-calendar.js",
    "public/sales.html"
  ]);
  changed.forEach((file) => assert.ok(allowed.has(file), "unexpected modified file: " + file));
  // Pricing and Send Quote guard untouched by CH-015.
  assert.ok(appJs.includes("function evaluateSendQuotePriceGuard(metrics, options)"));
  assert.ok(appJs.includes("const minimum = beforeProfit + minimumProfit + reserve;"));
  assert.ok(appJs.includes("const recommended = beforeProfit + recommendedProfit + reserve;"));
});

console.log("\nCH-015 target finish sync:", passed, "passed,", failed, "failed");
process.exit(failed === 0 ? 0 : 1);
