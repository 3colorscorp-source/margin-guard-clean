/**
 * Final PR3A gates that stay outside Seller phase 1.
 * Phase 1 remains 346 assertions. No network, no git, no secrets.
 * node scripts/test-seller-operational-plan-pr3a-gates.js
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const Module = require("module");
const voice = require("../netlify/functions/_lib/voice-operational-plan");

const KITCHEN = "8f3c2a10-6b1e-4d77-9a2c-1c0e5b7a4d11";
const MASTER = "b71e90aa-2c44-4f18-8d55-66a0c9e13f20";
const QUOTE_A = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const QUOTE_B = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SETTINGS = {
  workdaysEnabled: true,
  hoursPerDay: 8,
  baseInstaller: 75,
  baseHelper: 45,
  wcPct: 0,
  ficaPct: 0,
  futaPct: 0,
  casuiPct: 0,
  stdHours: 160,
  overheadMonthly: 0,
  profitPct: 30,
  reservePct: 5,
};

function loadHelper() {
  const source = fs.readFileSync(path.join(__dirname, "../public/js/seller-operational-plan-areas.js"), "utf8");
  const sandbox = { console };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox.MgSellerOperationalPlanAreas;
}

function assignment() {
  return {
    assignment_id: "asg_fixed",
    worker_role: "Installer",
    worker_type: "pro",
    worker_count: 1,
    hours_per_worker: 8,
  };
}

function day(extra) {
  return Object.assign(
    {
      day_id: "day_1",
      day_number: 1,
      client_scope: "Set the tile.",
      internal_tasks: [{ task_id: "task_fixed", label: "Cut" }],
      worker_assignments: [assignment()],
    },
    extra || {}
  );
}

function legacyQuoteState() {
  return {
    quoteId: QUOTE_A,
    internal_operational_plan: {
      schema_version: 1,
      source: "keyboard",
      start_date: "2026-09-08",
      due_date: "2026-09-09",
      days: [day()],
    },
    operational_plan: [{ day_number: 1, phase: "Set the tile.", workers: [{ name: "Ada", type: "installer" }] }],
    workers: [{ name: "Ada", type: "installer", days: 2, hours: 16, area_id: KITCHEN }],
    messageToClient: "Tile the kitchen.",
    notes: "Keep the existing note.",
    startDate: "2026-09-08",
    dueDate: "2026-09-10",
    targetFinishDate: "2026-09-11",
    laborAreas: [{ id: KITCHEN, name: "Kitchen", scope: "Manual backsplash.", sort_order: 0 }],
    laborAreaPublic: [{ name: "Kitchen", scope: "Manual backsplash.", sort_order: 0, sell_subtotal: 810 }],
    price: "810",
    offeredPrice: 810,
    seller_plan_area_draft: {
      draftId: "draft-a",
      quoteId: QUOTE_A,
      document: { schema_version: 1, days: [day()] },
    },
  };
}

function hydrateLikePage(helper, state, response) {
  const decision = helper.decideHydration({
    currentQuoteId: String(state.quoteId || "").trim(),
    requestQuoteId: String(state.quoteId || "").trim(),
    generation: 1,
    latestGeneration: 1,
    status: response.status,
    serverDocument: response.document,
    serverQuoteId: response.quote_id,
    localDraft: state.seller_plan_area_draft,
    legacyPlan: state.operational_plan,
  });
  return helper.applyHydrationResult(state, decision);
}

function assertUntouchedCommercialState(before, after) {
  assert.deepStrictEqual(after.operational_plan, before.operational_plan);
  assert.deepStrictEqual(after.workers, before.workers);
  assert.strictEqual(after.messageToClient, before.messageToClient);
  assert.strictEqual(after.notes, before.notes);
  assert.strictEqual(after.startDate, before.startDate);
  assert.strictEqual(after.dueDate, before.dueDate);
  assert.strictEqual(after.targetFinishDate, before.targetFinishDate);
  assert.deepStrictEqual(after.laborAreas, before.laborAreas);
  assert.deepStrictEqual(after.laborAreaPublic, before.laborAreaPublic);
  assert.strictEqual(after.price, before.price);
  assert.strictEqual(after.offeredPrice, before.offeredPrice);
  assert.strictEqual(after.quoteId, before.quoteId);
}

function extractFunction(source, name) {
  const token = "function " + name;
  const start = source.indexOf(token);
  if (start < 0) throw new Error("missing function " + name);
  const brace = source.indexOf("{", start);
  let depth = 0;
  let quote = "";
  for (let i = brace; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error("unclosed function " + name);
}

function runRealNewQuoteReset(previous) {
  const sales = fs.readFileSync(path.join(__dirname, "../public/sales.html"), "utf8");
  const labor = fs.readFileSync(path.join(__dirname, "../public/js/labor-areas.js"), "utf8");
  const storage = new Map();
  let uuidCalls = 0;
  const sandbox = {
    console,
    Date,
    Math,
    JSON,
    Object,
    Array,
    String,
    Number,
    localStorage: {
      getItem(key) {
        return storage.has(key) ? storage.get(key) : null;
      },
      setItem(key, value) {
        storage.set(key, String(value));
      },
      removeItem(key) {
        storage.delete(key);
      },
    },
    sessionStorage: {
      getItem() {
        return null;
      },
      setItem() {},
      removeItem() {},
    },
    crypto: {
      randomUUID() {
        uuidCalls += 1;
        return "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
      },
    },
    document: {
      getElementById() {
        return {
          style: {},
          dataset: {},
          classList: { add() {}, remove() {}, contains() { return false; } },
          className: "",
          textContent: "",
          value: "",
          hidden: false,
        };
      },
      querySelectorAll() {
        return [];
      },
      documentElement: { dataset: {} },
      body: { classList: { contains() { return false; } } },
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(labor, sandbox);
  const source = [
    "var _securePricingCache = null;",
    "var _securePricingLastFailureFp = null;",
    "var _securePricingAbortController = null;",
    "var _securePricingShadowTimer = null;",
    "function clearTimeout() {}",
    "const SALES_KEY = 'mg_sales_v2';",
    "const SELLER_STALE_QUOTE_STORAGE_KEYS = ['mg_sales_draft', 'mg_sales_quote_draft', 'mg_current_sales_quote'];",
    "const DEFAULT_WORKERS = [{ name: 'Worker 1', type: 'installer', days: 0, rate: '' }];",
    extractFunction(sales, "createSellerDraftId"),
    extractFunction(sales, "readJson"),
    extractFunction(sales, "loadSalesState"),
    extractFunction(sales, "saveSalesState"),
    extractFunction(sales, "clearSellerStaleQuoteStorageCaches"),
    extractFunction(sales, "getOperationalPlanApi"),
    extractFunction(sales, "isLaborAutoSyncActive"),
    extractFunction(sales, "syncLaborWorkersFromOperationalPlan"),
    extractFunction(sales, "refreshSellerFromStandalone"),
    extractFunction(sales, "resetSalesQuoteStateForNewQuote"),
    "function ensureSellerBusinessSettingsReadyFromCache() {}",
    "function applySellerQuoteFieldValuesToDom() {}",
    "function bindStandaloneSellerWorkers() {}",
    "function removeSellerPublishOrphanNotice() {}",
    "function loadSettings() { return { hoursPerDay: 8, workdaysEnabled: true }; }",
    "function updateLaborSyncChrome() {}",
    "function renderSellerWorkersStandalone() {}",
    "function renderSalesOperationalPlanStandalone() {}",
    "function bindSalesOperationalPlanStandalone() {}",
    "function renderStandaloneSellerPanel() {}",
    "function isRealSellerRuntime() { return false; }",
    "function isOwnerSellerPreviewLayoutActive() { return false; }",
    "function forceRealSellerOwnerLayout() {}",
    "function forceOwnerSellerPreviewLayout() {}",
    "function isSellerPricingSettingsPending() { return false; }",
    "function scheduleSellerPricingRefreshWhenSettingsReady() {}",
    "function enforceSellerRightPanelCurrencyConsistency() {}",
    "function paintSellerAuthoritativePrimaryPricesNow() {}",
    "saveSalesState(" + JSON.stringify(previous) + ");",
    "resetSalesQuoteStateForNewQuote();",
    "globalThis.__loaded = loadSalesState();",
    "globalThis.__raw = localStorage.getItem(SALES_KEY);",
  ].join("\n");
  vm.runInContext(source, sandbox);
  return { loaded: sandbox.__loaded, raw: sandbox.__raw, uuidCalls };
}

function jsonRes(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

async function runMixedPublish() {
  const helper = loadHelper();
  let mints = 0;
  const preview = voice.normalizeDocument(
    {
      schema_version: 1,
      source: "keyboard",
      start_date: "2026-09-08",
      areas: [
        { id: KITCHEN, name: "Kitchen", scope: "Tile the backsplash.", sort_order: 0 },
        { area_ref: "area_2", name: "Master Bathroom", scope: "Waterproof.", sort_order: 1 },
      ],
      days: [
        day({
          day_id: "day_1",
          area_id: KITCHEN,
          internal_tasks: [{ task_id: "task_kitchen", label: "Cut" }],
          worker_assignments: [Object.assign(assignment(), { assignment_id: "asg_kitchen" })],
        }),
        day({
          day_id: "day_2",
          day_number: 2,
          area_ref: "area_2",
          internal_tasks: [{ task_id: "task_master", label: "Waterproof" }],
          worker_assignments: [Object.assign(assignment(), { assignment_id: "asg_master" })],
        }),
      ],
    },
    {
      settings: SETTINGS,
      hoursPerDay: 8,
      startDate: "2026-09-08",
      createId() {
        mints += 1;
        return MASTER;
      },
    }
  );
  const remembered = helper.applyPreviewResult(
    { draftId: "draft-new", quoteId: "", document: null },
    { ok: true, document: preview }
  );
  assert.strictEqual(remembered.ok, true);
  assert.strictEqual(remembered.priced, false);
  assert.strictEqual(remembered.published, false);

  const originalLoad = Module._load;
  const originalFetch = globalThis.fetch;
  const envBackup = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    URL: process.env.URL,
  };
  let pricingCalls = 0;
  const rpcBodies = [];
  const quoteInserts = [];
  process.env.SUPABASE_URL = "http://127.0.0.1:9";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "isolated-area-identity";
  process.env.URL = "https://marginguardsystem.netlify.app";
  Module._load = function patchedLoad(request, parent, isMain) {
    const n = String(request || "").replace(/\\/g, "/");
    if (n === "./_lib/tenant-device-guard" || n.endsWith("/_lib/tenant-device-guard")) {
      return {
        resolveOwnerOrSellerContext: async () => ({
          auth_mode: "owner",
          tenant: { id: TENANT_A },
          session: { e: "owner@example.com" },
        }),
      };
    }
    if (n === "./_lib/pricing-engine" || n.endsWith("/_lib/pricing-engine")) {
      const real = originalLoad.call(this, request, parent, isMain);
      return Object.assign({}, real, {
        calculateQuotePublishFinancials(input, settings) {
          pricingCalls += 1;
          return real.calculateQuotePublishFinancials(input, settings);
        },
      });
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  globalThis.fetch = async function mockFetch(url, options) {
    const target = String(url);
    if (!target.startsWith("http://127.0.0.1:9")) throw new Error("blocked non-isolated fetch: " + target);
    const method = String((options && options.method) || "GET").toUpperCase();
    const parsed = new URL(target);
    const body = options && options.body ? JSON.parse(options.body) : {};
    if (parsed.pathname === "/rest/v1/tenant_snapshots") return jsonRes(200, [{ payload: { storage: { mg_settings_v2: SETTINGS } } }]);
    if (parsed.pathname === "/rest/v1/rpc/allocate_next_quote_number") {
      return jsonRes(200, { quote_year: 2026, quote_sequence: 1, quote_number_display: "2026-001" });
    }
    if (parsed.pathname === "/rest/v1/rpc/mg_confirm_quote_operational_plan") {
      rpcBodies.push(body);
      return jsonRes(200, { ok: true, persisted: true, quote_id: body.p_quote_id });
    }
    if (parsed.pathname === "/rest/v1/quotes" && method === "POST") {
      quoteInserts.push(body);
      return jsonRes(201, [{ id: QUOTE_A, tenant_id: TENANT_A, total: body.total, public_token: body.public_token }]);
    }
    if (parsed.pathname === "/rest/v1/quotes" && method === "GET") return jsonRes(200, []);
    if (parsed.pathname === "/rest/v1/tenants" || parsed.pathname === "/rest/v1/tenant_branding" || parsed.pathname === "/rest/v1/tenant_contacts") {
      return jsonRes(200, []);
    }
    throw new Error("unexpected isolated fetch: " + method + " " + target);
  };
  try {
    for (const key of Object.keys(require.cache)) {
      if (key.replace(/\\/g, "/").includes("/netlify/functions/")) delete require.cache[key];
    }
    const publishMod = require("../netlify/functions/publish-public-quote");
    const canonical = remembered.draft.document;
    const response = await publishMod.handler({
      httpMethod: "POST",
      headers: {},
      body: JSON.stringify({
        project_name: "Kitchen and bath",
        client_name: "Ada",
        client_email: "ada@example.com",
        deposit_required: 100,
        pricing_stage: 2,
        status: "READY_TO_SEND",
        workers: [
          { name: "Installer", type: "installer", days: 1, hours: 8, area_id: KITCHEN },
          { name: "Installer", type: "installer", days: 1, hours: 8, area_id: MASTER },
        ],
        labor_areas: [
          { id: KITCHEN, name: "Kitchen", scope: "Tile the backsplash.", sort_order: 0 },
          { id: MASTER, name: "Master Bathroom", scope: "Waterproof.", sort_order: 1 },
        ],
        internal_operational_plan: canonical,
      }),
    });
    const body = JSON.parse(response.body);
    assert.strictEqual(response.statusCode, 200, body.error || response.body);
    return { mints, pricingCalls, canonical, body, rpc: rpcBodies[0], inserted: quoteInserts[0] };
  } finally {
    Module._load = originalLoad;
    globalThis.fetch = originalFetch;
    process.env.SUPABASE_URL = envBackup.SUPABASE_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = envBackup.SUPABASE_SERVICE_ROLE_KEY;
    process.env.URL = envBackup.URL;
    for (const key of Object.keys(require.cache)) {
      if (key.replace(/\\/g, "/").includes("/netlify/functions/")) delete require.cache[key];
    }
  }
}

const EXPECTED = 5;

async function runSellerOperationalPlanPr3aGateTests() {
  const helper = loadHelper();
  const salesHtml = fs.readFileSync(path.join(__dirname, "../public/sales.html"), "utf8");
  let passed = 0;
  function test(name, fn) {
    return Promise.resolve()
      .then(fn)
      .then(() => {
        passed += 1;
        console.log("ok " + name);
      });
  }

  await test("legacy quote hydration keeps the existing plan and manual areas", async () => {
    const before = legacyQuoteState();
    const serverDocument = JSON.parse(JSON.stringify(before.internal_operational_plan));
    assert.strictEqual(Object.prototype.hasOwnProperty.call(serverDocument, "areas"), false);
    const result = hydrateLikePage(helper, before, { status: 200, document: serverDocument, quote_id: QUOTE_A });
    assert.strictEqual(result.applied, true);
    assert.deepStrictEqual(result.state.internal_operational_plan, serverDocument);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(result.state.internal_operational_plan, "areas"), false);
    assertUntouchedCommercialState(before, result.state);
    assert.deepStrictEqual(result.state.seller_plan_area_draft, before.seller_plan_area_draft);
    assert.strictEqual(JSON.stringify(result.state).includes("area_ref"), false);
    assert.strictEqual(JSON.stringify(result.state).includes(MASTER), false);
    const hydrate = salesHtml.slice(
      salesHtml.indexOf("async function hydrateSellerOperationalPlanAreas"),
      salesHtml.indexOf("function bootSellerPortalLayout")
    );
    assert.strictEqual(hydrate.includes("applyHydrationResult"), true);
    assert.strictEqual(hydrate.includes("action: 'preview'"), false);
    assert.strictEqual(hydrate.includes("action: \"preview\""), false);
    assert.strictEqual(hydrate.includes("randomUUID"), false);
    assert.strictEqual(hydrate.includes("calc-secure-pricing"), false);
  });

  await test("a transient internal-plan error keeps the same quote draft", async () => {
    const before = legacyQuoteState();
    const foreign = {
      draftId: "draft-b",
      quoteId: QUOTE_B,
      document: { areas: [{ id: MASTER, name: "Master Bathroom", scope: "Other project", sort_order: 0 }] },
    };
    const result = helper.applyHydrationResult(
      before,
      helper.decideHydration({
        currentQuoteId: QUOTE_A,
        requestQuoteId: QUOTE_A,
        generation: 1,
        latestGeneration: 1,
        status: 500,
        serverDocument: foreign.document,
        serverQuoteId: QUOTE_B,
        localDraft: foreign,
        legacyPlan: [{ day_number: 9, phase: "Other quote" }],
      })
    );
    assert.strictEqual(result.applied, false);
    assert.strictEqual(result.state, before);
    assert.strictEqual(result.state.seller_plan_area_draft.quoteId, QUOTE_A);
    assert.strictEqual(JSON.stringify(result.state).includes(MASTER), false);
  });

  await test("401 and 403 do not mix another quote into the open draft", async () => {
    for (const status of [401, 403]) {
      const before = legacyQuoteState();
      const result = helper.applyHydrationResult(
        before,
        helper.decideHydration({
          currentQuoteId: QUOTE_A,
          requestQuoteId: QUOTE_A,
          generation: 1,
          latestGeneration: 1,
          status,
          serverDocument: null,
          localDraft: { quoteId: QUOTE_B, document: { areas: [{ id: MASTER }] } },
          legacyPlan: [],
        })
      );
      assert.strictEqual(result.applied, false);
      assert.strictEqual(result.state.quoteId, QUOTE_A);
      assert.deepStrictEqual(result.state.laborAreas, before.laborAreas);
      assert.strictEqual(JSON.stringify(result.state).includes(MASTER), false);
    }
  });

  await test("new quote reset drops the previous quote identity", async () => {
    const previous = {
      quoteId: QUOTE_A,
      publicToken: "token-a",
      workers: [{ name: "Ada", type: "installer", days: 4, hours: 32, area_id: KITCHEN }],
      operational_plan: [{ day_number: 1, phase: "Quote A", workers: [{ name: "Ada" }] }],
      internal_operational_plan: {
        areas: [
          { id: KITCHEN, name: "Kitchen", scope: "A", sort_order: 0 },
          { area_ref: "area_2", name: "Master Bathroom", scope: "A", sort_order: 1 },
        ],
        days: [{ area_id: KITCHEN }, { area_ref: "area_2" }],
      },
      seller_plan_area_draft: { draftId: "draft-a", quoteId: QUOTE_A, document: { areas: [{ id: KITCHEN }] } },
      laborAreas: [{ id: KITCHEN, name: "Kitchen", scope: "A", sort_order: 0 }],
      laborAreaPublic: [{ name: "Kitchen", scope: "A", sort_order: 0, sell_subtotal: 810 }],
      messageToClient: "Scope A",
      startDate: "2026-09-08",
      price: "810",
    };
    const reset = runRealNewQuoteReset(previous);
    const loaded = reset.loaded;
    const loadedJson = JSON.parse(JSON.stringify(loaded));
    assert.strictEqual(loadedJson.quoteId, "");
    assert.strictEqual(loadedJson.internal_operational_plan, null);
    assert.deepStrictEqual(loadedJson.operational_plan, []);
    assert.strictEqual(loadedJson.seller_plan_area_draft, null);
    assert.deepStrictEqual(loadedJson.laborAreas, []);
    assert.deepStrictEqual(loadedJson.laborAreaPublic, []);
    assert.deepStrictEqual(loadedJson.workers, [{ name: "Worker 1", type: "installer", days: 0, rate: "" }]);
    assert.strictEqual(reset.raw.includes(QUOTE_A), false);
    assert.strictEqual(reset.raw.includes(KITCHEN), false);
    assert.strictEqual(reset.raw.includes("area_2"), false);
    assert.strictEqual(reset.raw.includes("Ada"), false);
    assert.strictEqual(reset.raw.includes("Scope A"), false);
    assert.strictEqual(reset.uuidCalls, 0);
    assert.strictEqual(salesHtml.includes("function resetSalesQuoteStateForNewQuote"), true);
    assert.strictEqual(salesHtml.includes("function saveSalesState"), true);
    assert.strictEqual(salesHtml.includes("localStorage.setItem(SALES_KEY, JSON.stringify(state));"), true);
  });

  await test("mixed preview identity is the document publish persists", async () => {
    const out = await runMixedPublish();
    assert.strictEqual(out.mints, 1);
    assert.strictEqual(out.pricingCalls, 1);
    assert.strictEqual(out.canonical.areas[0].id, KITCHEN);
    assert.strictEqual(out.canonical.areas[1].id, MASTER);
    assert.strictEqual(out.body.internal_operational_plan.areas[0].id, KITCHEN);
    assert.strictEqual(out.body.internal_operational_plan.areas[1].id, MASTER);
    assert.deepStrictEqual(out.body.internal_operational_plan, out.rpc.p_document);
    assert.deepStrictEqual(
      out.inserted.labor_area_breakdown.areas.map((area) => area.id),
      [KITCHEN, MASTER]
    );
    assert.deepStrictEqual(
      out.body.labor_areas.map((area) => area.name),
      ["Kitchen", "Master Bathroom"]
    );
    assert.strictEqual(JSON.stringify(out.body.internal_operational_plan).includes("area_ref"), false);
    assert.strictEqual(JSON.stringify(out.rpc.p_document).includes("area_ref"), false);
    const ids = JSON.stringify(out.rpc.p_document).match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi);
    assert.deepStrictEqual(Array.from(new Set(ids)).sort(), [KITCHEN, MASTER].sort());
  });

  if (passed !== EXPECTED) {
    throw new Error("expected " + EXPECTED + " gate tests, got " + passed);
  }
  return passed;
}

module.exports = {
  EXPECTED,
  runSellerOperationalPlanPr3aGateTests,
};

if (require.main === module) {
  runSellerOperationalPlanPr3aGateTests()
    .then((count) => {
      console.log(count + " passed");
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
