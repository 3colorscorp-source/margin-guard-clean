/**
 * PR3A canonical area identity. No database, no network, no browser UUID mint.
 * node scripts/test-seller-operational-plan-area-identity.js
 *
 * Seller and Owner shields run this through scripts/test-voice-operational-plan-phase1.js.
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const Module = require("module");
const voice = require("../netlify/functions/_lib/voice-operational-plan");
const { handleQuoteInternalOperationalPlan } = require("../netlify/functions/quote-internal-operational-plan")._test;
const { assertCanonicalOperationalPlanAreas } = require("../netlify/functions/publish-public-quote")._test;

const EXPECTED = 30;
const KITCHEN = "8f3c2a10-6b1e-4d77-9a2c-1c0e5b7a4d11";
const MASTER = "b71e90aa-2c44-4f18-8d55-66a0c9e13f20";
const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const QUOTE_A = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const QUOTE_B = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
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

function normalize(doc, createId) {
  const options = { settings: SETTINGS, hoursPerDay: 8, startDate: "2026-09-08" };
  if (createId) options.createId = createId;
  return voice.normalizeDocument(doc, options);
}

function loadHelper() {
  const source = fs.readFileSync(path.join(__dirname, "../public/js/seller-operational-plan-areas.js"), "utf8");
  const sandbox = { console };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox.MgSellerOperationalPlanAreas;
}

function canonicalPlan() {
  return {
    schema_version: 1,
    source: "keyboard",
    start_date: "2026-09-08",
    areas: [
      { id: KITCHEN, name: "Kitchen", scope: "Tile the backsplash.", sort_order: 0 },
      { id: MASTER, name: "Master Bathroom", scope: "Leave open.", sort_order: 1 },
    ],
    days: [day({ day_id: "day_1", area_id: KITCHEN })],
  };
}

function publishBody(extra) {
  return Object.assign(
    {
      project_name: "Kitchen and bath",
      client_name: "Ada",
      client_email: "ada@example.com",
      workers: [{ name: "Installer", type: "installer", days: 1, hours: 8, area_id: KITCHEN }],
      labor_areas: [{ id: KITCHEN, name: "Kitchen", scope: "Tile the backsplash.", sort_order: 0 }],
      pricing_stage: 2,
      status: "READY_TO_SEND",
      deposit_required: 100,
      internal_operational_plan: canonicalPlan(),
    },
    extra || {}
  );
}

function jsonRes(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

async function runSellerOperationalPlanAreaIdentityTests() {
  let passed = 0;
  async function test(name, fn) {
    await fn();
    passed += 1;
    console.log("ok " + name);
  }

  await test("temporary preview mints one uuid", async () => {
    let calls = 0;
    const doc = normalize(
      {
        schema_version: 1,
        source: "keyboard",
        start_date: "2026-09-08",
        areas: [{ area_ref: "area_1", name: "Kitchen", scope: "Tile.", sort_order: 0 }],
        days: [day({ area_ref: "area_1" })],
      },
      function createId() {
        calls += 1;
        return KITCHEN;
      }
    );
    assert.strictEqual(calls, 1);
    assert.strictEqual(doc.areas[0].id, KITCHEN);
    assert.strictEqual(doc.days[0].area_id, KITCHEN);
    assert.strictEqual(JSON.stringify(doc).includes("area_ref"), false);
  });

  await test("mixed preview mints only the new area", async () => {
    let calls = 0;
    const doc = normalize(
      {
        schema_version: 1,
        source: "keyboard",
        start_date: "2026-09-08",
        areas: [
          { id: KITCHEN, name: "Kitchen", scope: "Tile.", sort_order: 0 },
          { area_ref: "area_2", name: "Master Bathroom", scope: "Waterproof.", sort_order: 1 },
        ],
        days: [day({ day_id: "day_1", area_id: KITCHEN }), day({ day_id: "day_2", day_number: 2, area_ref: "area_2" })],
      },
      function createId() {
        calls += 1;
        return MASTER;
      }
    );
    assert.strictEqual(calls, 1);
    assert.strictEqual(doc.areas[0].id, KITCHEN);
    assert.strictEqual(doc.areas[1].id, MASTER);
    assert.strictEqual(doc.days[0].area_id, KITCHEN);
    assert.strictEqual(doc.days[1].area_id, MASTER);
    assert.strictEqual(JSON.stringify(doc).includes("area_ref"), false);
  });

  await test("second preview does not mint", async () => {
    let calls = 0;
    const first = normalize(
      {
        schema_version: 1,
        source: "keyboard",
        start_date: "2026-09-08",
        areas: [
          { id: KITCHEN, name: "Kitchen", scope: "Tile.", sort_order: 0 },
          { area_ref: "area_2", name: "Bathroom", scope: "Tile.", sort_order: 1 },
        ],
        days: [day({ area_id: KITCHEN }), day({ day_id: "day_2", day_number: 2, area_ref: "area_2" })],
      },
      function createId() {
        calls += 1;
        return MASTER;
      }
    );
    const second = normalize(first, function createId() {
      calls += 1;
      return "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    });
    assert.strictEqual(calls, 1);
    assert.strictEqual(second.areas[0].id, KITCHEN);
    assert.strictEqual(second.areas[1].id, MASTER);
    assert.deepStrictEqual(second.areas, first.areas);
  });

  await test("equal names keep separate identities", async () => {
    let calls = 0;
    const doc = normalize(
      {
        schema_version: 1,
        source: "keyboard",
        start_date: "2026-09-08",
        areas: [
          { id: KITCHEN, name: "Bathroom", scope: "Master", sort_order: 0 },
          { area_ref: "area_2", name: "Bathroom", scope: "Kids", sort_order: 1 },
        ],
        days: [day({ area_id: KITCHEN }), day({ day_id: "day_2", day_number: 2, area_ref: "area_2" })],
      },
      function createId() {
        calls += 1;
        return MASTER;
      }
    );
    assert.strictEqual(calls, 1);
    assert.strictEqual(doc.areas[0].id, KITCHEN);
    assert.strictEqual(doc.areas[1].id, MASTER);
    assert.notStrictEqual(doc.areas[0].id, doc.areas[1].id);
  });

  const helper = loadHelper();
  const helperSource = fs.readFileSync(path.join(__dirname, "../public/js/seller-operational-plan-areas.js"), "utf8");

  await test("browser helper does not mint canonical ids", async () => {
    assert.strictEqual(helperSource.includes("randomUUID"), false);
    assert.strictEqual(helperSource.includes("calculateQuote"), false);
    assert.strictEqual(helperSource.includes("allocateSellCents"), false);
  });

  await test("failed preview keeps the confirmed document", async () => {
    const confirmed = { draftId: "draft-1", quoteId: "", document: { schema_version: 1, days: [{ day_id: "day_1" }] } };
    const failed = helper.applyPreviewResult(confirmed, { ok: false, error: "Invalid area contract." });
    assert.strictEqual(failed.ok, false);
    assert.strictEqual(failed.published, false);
    assert.strictEqual(failed.priced, false);
    assert.deepStrictEqual(failed.draft.document, confirmed.document);
  });

  await test("successful preview applies only the server document", async () => {
    const confirmed = { draftId: "draft-1", quoteId: "", document: { areas: [{ area_ref: "area_1" }] } };
    const serverDocument = canonicalPlan();
    const applied = helper.applyPreviewResult(confirmed, { ok: true, document: serverDocument });
    assert.strictEqual(applied.ok, true);
    assert.strictEqual(applied.priced, false);
    assert.strictEqual(applied.published, false);
    assert.strictEqual(applied.draft.document, serverDocument);
    assert.strictEqual(helper.containsAreaRef(applied.draft.document), false);
    const bound = helper.bindDraftToQuote(applied.draft, QUOTE_A);
    assert.strictEqual(bound.quoteId, QUOTE_A);
    assert.strictEqual(bound.document.areas[0].id, KITCHEN);
  });

  await test("publish bundle rejects a different labor uuid and an orphan worker", async () => {
    const mismatch = helper.validatePublishBundle({
      document: canonicalPlan(),
      laborAreas: [{ id: MASTER, name: "Master Bathroom", scope: "", sort_order: 0 }],
      workers: [{ area_id: KITCHEN, days: 1 }],
    });
    assert.strictEqual(mismatch.ok, false);
    const orphan = helper.validatePublishBundle({
      document: canonicalPlan(),
      laborAreas: [{ id: KITCHEN, name: "Kitchen", scope: "", sort_order: 0 }],
      workers: [{ area_id: MASTER, days: 1 }],
    });
    assert.strictEqual(orphan.code, "orphan_worker_area");
  });

  await test("hydration prefers the server document for the current quote", async () => {
    const serverDocument = canonicalPlan();
    const decision = helper.decideHydration({
      currentQuoteId: QUOTE_A,
      requestQuoteId: QUOTE_A,
      generation: 2,
      latestGeneration: 2,
      status: 200,
      serverDocument,
      serverQuoteId: QUOTE_A,
      localDraft: { quoteId: QUOTE_A, document: { areas: [{ id: MASTER }] } },
      legacyPlan: [{ day_number: 1, phase: "Old" }],
    });
    assert.strictEqual(decision.action, "apply-server");
    assert.strictEqual(decision.document.areas[0].id, KITCHEN);
  });

  await test("a late response from another quote is ignored", async () => {
    const stale = helper.decideHydration({
      currentQuoteId: QUOTE_A,
      requestQuoteId: QUOTE_B,
      generation: 1,
      latestGeneration: 2,
      status: 200,
      serverDocument: canonicalPlan(),
      serverQuoteId: QUOTE_B,
      localDraft: { quoteId: QUOTE_B, document: canonicalPlan() },
      legacyPlan: [],
    });
    assert.strictEqual(stale.action, "ignore");
  });

  await test("a foreign tenant response does not select another quote draft", async () => {
    const foreign = helper.decideHydration({
      currentQuoteId: QUOTE_A,
      requestQuoteId: QUOTE_A,
      generation: 1,
      latestGeneration: 1,
      status: 404,
      serverDocument: null,
      localDraft: { quoteId: QUOTE_B, document: canonicalPlan() },
      legacyPlan: [{ day_number: 1, phase: "Legacy" }],
    });
    assert.strictEqual(foreign.action, "reject");
    assert.strictEqual(foreign.document, undefined);
  });

  await test("missing server document uses only the draft saved for that quote", async () => {
    const same = helper.decideHydration({
      currentQuoteId: QUOTE_A,
      requestQuoteId: QUOTE_A,
      generation: 1,
      latestGeneration: 1,
      status: 200,
      serverDocument: null,
      localDraft: { quoteId: QUOTE_A, document: canonicalPlan() },
      legacyPlan: [{ day_number: 1, phase: "Legacy" }],
    });
    assert.strictEqual(same.action, "apply-local");
    const other = helper.decideHydration({
      currentQuoteId: QUOTE_A,
      requestQuoteId: QUOTE_A,
      generation: 1,
      latestGeneration: 1,
      status: 200,
      serverDocument: null,
      localDraft: { quoteId: "", document: canonicalPlan() },
      legacyPlan: [{ day_number: 1, phase: "Legacy" }],
    });
    assert.strictEqual(other.action, "legacy");
    assert.deepStrictEqual(other.plan, [{ day_number: 1, phase: "Legacy" }]);
  });

  await test("publish guard rejects area_ref before any write", async () => {
    const rejected = assertCanonicalOperationalPlanAreas(
      publishBody({
        internal_operational_plan: {
          areas: [{ area_ref: "area_1", name: "Kitchen", scope: "Tile.", sort_order: 0 }],
          days: [day({ area_ref: "area_1" })],
        },
      })
    );
    assert.strictEqual(rejected.ok, false);
    assert.strictEqual(rejected.code, "unresolved_area_ref");
  });

  await test("publish guard rejects a labor uuid that is not the plan uuid", async () => {
    const rejected = assertCanonicalOperationalPlanAreas(
      publishBody({ labor_areas: [{ id: MASTER, name: "Master Bathroom", scope: "Leave open.", sort_order: 0 }] })
    );
    assert.strictEqual(rejected.ok, false);
    assert.strictEqual(rejected.code, "labor_area_mismatch");
  });

  await test("publish guard rejects an orphan worker and an orphan day", async () => {
    const worker = assertCanonicalOperationalPlanAreas(
      publishBody({ workers: [{ name: "Installer", type: "installer", days: 1, area_id: MASTER }] })
    );
    assert.strictEqual(worker.code, "orphan_worker_area");
    const orphanDay = assertCanonicalOperationalPlanAreas(
      publishBody({
        internal_operational_plan: {
          areas: canonicalPlan().areas,
          days: [day({ area_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" })],
        },
      })
    );
    assert.strictEqual(orphanDay.code, "orphan_day_area");
  });

  await test("publish guard rejects duplicate ids and a non-uuid labor id", async () => {
    const duplicate = assertCanonicalOperationalPlanAreas(
      publishBody({
        internal_operational_plan: {
          areas: [
            { id: KITCHEN, name: "Kitchen", scope: "Tile.", sort_order: 0 },
            { id: KITCHEN, name: "Kitchen copy", scope: "Tile.", sort_order: 1 },
          ],
          days: [day({ area_id: KITCHEN })],
        },
      })
    );
    assert.strictEqual(duplicate.code, "duplicate_area_id");
    const minted = assertCanonicalOperationalPlanAreas(
      publishBody({ labor_areas: [{ id: "area_1", name: "Kitchen", scope: "Tile.", sort_order: 0 }] })
    );
    assert.strictEqual(minted.code, "invalid_area_id");
  });

  await test("legacy quotes and manual labor areas skip the new guard", async () => {
    const legacy = assertCanonicalOperationalPlanAreas({
      workers: [{ name: "Installer", type: "installer", days: 1 }],
      internal_operational_plan: { schema_version: 1, days: [day()] },
    });
    assert.strictEqual(legacy.ok, true);
    assert.strictEqual(legacy.active, false);
    const manual = assertCanonicalOperationalPlanAreas({
      workers: [{ name: "Installer", type: "installer", days: 1, area_id: KITCHEN }],
      labor_areas: [{ id: KITCHEN, name: "Kitchen", scope: "Tile.", sort_order: 0 }],
    });
    assert.strictEqual(manual.ok, true);
    assert.strictEqual(manual.active, false);
  });

  await test("an empty area is rejected from the labor payload", async () => {
    const rejected = assertCanonicalOperationalPlanAreas(
      publishBody({
        labor_areas: [
          { id: KITCHEN, name: "Kitchen", scope: "Tile.", sort_order: 0 },
          { id: MASTER, name: "Master Bathroom", scope: "Leave open.", sort_order: 1 },
        ],
      })
    );
    assert.strictEqual(rejected.code, "labor_area_mismatch");
  });

  const salesHtml = fs.readFileSync(path.join(__dirname, "../public/sales.html"), "utf8");
  await test("sales html adds no visible area-plan controls", async () => {
    const areaUi = fs.readFileSync(path.join(__dirname, "../public/js/seller-operational-plan-areas.js"), "utf8");
    assert.strictEqual(areaUi.includes("Add work area"), true);
    assert.strictEqual(areaUi.includes("Work Areas"), true);
    assert.strictEqual(areaUi.includes("Needs crew"), true);
    assert.strictEqual(areaUi.includes("randomUUID"), false);
    assert.strictEqual(salesHtml.includes('id="salesWorkAreasHost"'), true);
    assert.strictEqual(salesHtml.includes("seller-operational-plan-areas.js"), true);
    assert.strictEqual(salesHtml.includes("seller_plan_area_draft: null"), true);
    const hydrate = salesHtml.slice(
      salesHtml.indexOf("async function hydrateSellerOperationalPlanAreas"),
      salesHtml.indexOf("function bootSellerPortalLayout")
    );
    assert.strictEqual(hydrate.includes("calc-secure-pricing"), false);
    assert.strictEqual(hydrate.includes("publish-public-quote"), false);
    assert.strictEqual(hydrate.includes("/.netlify/functions/quote-internal-operational-plan?quote_id="), true);
  });

  await test("a quote with no internal row returns no document", async () => {
    const result = await handleQuoteInternalOperationalPlan(
      { httpMethod: "GET", queryStringParameters: { quote_id: QUOTE_A } },
      {
        resolveOwnerOrSellerContext: async () => ({
          auth_mode: "owner",
          tenant: { id: TENANT_A },
          membership: { id: "aaaaaaaa-aaaa-4aaa-8aaa-bbbbbbbbbbbb", role: "owner" },
        }),
        supabaseRequest: async (reqPath) => {
          const req = String(reqPath || "");
          if (req.startsWith("tenant_snapshots")) return [{ payload: { storage: { mg_settings_v2: SETTINGS } } }];
          if (req.startsWith("quote_internal_operational_plans")) return [];
          if (req.startsWith("quotes?")) {
            return [{ id: QUOTE_A, tenant_id: TENANT_A, seller_membership_id: "aaaaaaaa-aaaa-4aaa-8aaa-bbbbbbbbbbbb", status: "READY_TO_SEND" }];
          }
          return [];
        },
        evaluateQuoteEditGuard: async () => ({ edit: { is_editable: true, locked: false, warnings: [] } }),
      }
    );
    const body = JSON.parse(result.body);
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(body.document, null);
    assert.strictEqual(body.quote_id, QUOTE_A);
  });

  await test("a document returned for another quote is ignored", async () => {
    const mismatch = helper.decideHydration({
      currentQuoteId: QUOTE_A,
      requestQuoteId: QUOTE_A,
      generation: 1,
      latestGeneration: 1,
      status: 200,
      serverDocument: canonicalPlan(),
      serverQuoteId: QUOTE_B,
      localDraft: { quoteId: QUOTE_A, document: canonicalPlan() },
      legacyPlan: [],
    });
    assert.strictEqual(mismatch.action, "ignore");
    assert.strictEqual(mismatch.reason, "quote_mismatch");
  });

  await test("401 does not hydrate another quote draft", async () => {
    const denied = helper.decideHydration({
      currentQuoteId: QUOTE_A,
      requestQuoteId: QUOTE_A,
      generation: 1,
      latestGeneration: 1,
      status: 401,
      serverDocument: null,
      localDraft: { quoteId: QUOTE_B, document: canonicalPlan() },
      legacyPlan: [{ day_number: 1, phase: "Legacy" }],
    });
    assert.strictEqual(denied.action, "reject");
    assert.strictEqual(denied.document, undefined);
  });

  await test("new quote drops the previous area draft", async () => {
    const start = salesHtml.indexOf("function resetSalesQuoteStateForNewQuote");
    const freshStart = salesHtml.indexOf("const fresh = {", start);
    const freshEnd = salesHtml.indexOf("saveSalesState(fresh)", freshStart);
    const reset = salesHtml.slice(freshStart, freshEnd);
    assert.strictEqual(reset.includes("seller_plan_area_draft: null"), true);
    assert.strictEqual(reset.includes("internal_operational_plan: null"), true);
    assert.strictEqual(reset.includes("laborAreas:"), false);
    assert.strictEqual(reset.includes("laborAreaPublic"), false);
  });

  await test("failed preview leaves an unbound draft unchanged", async () => {
    const unbound = { draftId: "draft-9", quoteId: "", document: canonicalPlan() };
    const failed = helper.applyPreviewResult(unbound, { ok: false });
    assert.strictEqual(failed.draft.quoteId, "");
    assert.strictEqual(failed.draft.document.areas[0].id, KITCHEN);
    assert.strictEqual(failed.published, false);
  });

  await test("an area with no days stays out of the labor bundle", async () => {
    const bundle = helper.validatePublishBundle({
      document: canonicalPlan(),
      laborAreas: [{ id: KITCHEN, name: "Kitchen", scope: "Tile the backsplash.", sort_order: 0 }],
      workers: [{ area_id: KITCHEN, days: 1, hours: 8 }],
    });
    assert.strictEqual(bundle.ok, true);
    assert.strictEqual(canonicalPlan().areas.some((area) => area.id === MASTER), true);
  });

  await test("canonical apply never prices or publishes", async () => {
    const applied = helper.applyCanonicalDocument(
      { draftId: "draft-1", quoteId: "", document: null },
      canonicalPlan()
    );
    assert.strictEqual(applied.priced, false);
    assert.strictEqual(applied.published, false);
    assert.strictEqual(helper.sameIdentity(applied.draft.document, canonicalPlan()), true);
  });

  await test("a cross-tenant internal plan read is not found", async () => {
    const result = await handleQuoteInternalOperationalPlan(
      { httpMethod: "GET", queryStringParameters: { quote_id: QUOTE_B } },
      {
        resolveOwnerOrSellerContext: async () => ({
          auth_mode: "owner",
          tenant: { id: TENANT_A },
          membership: { id: "aaaaaaaa-aaaa-4aaa-8aaa-bbbbbbbbbbbb", role: "owner" },
        }),
        supabaseRequest: async (reqPath) => {
          const req = String(reqPath || "");
          if (req.startsWith("quotes?")) return [];
          return [];
        },
        evaluateQuoteEditGuard: async () => ({ edit: { is_editable: true, locked: false, warnings: [] } }),
      }
    );
    assert.strictEqual(result.statusCode, 404);
  });

  await runPublishHandlerTests(test);
  assert.strictEqual(passed, EXPECTED);
  return passed;
}

async function runPublishHandlerTests(test) {
  const originalLoad = Module._load;
  const originalFetch = globalThis.fetch;
  const envBackup = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    URL: process.env.URL,
  };
  let pricingCalls = 0;
  let allocateCalls = 0;
  let insertCalls = 0;
  let rpcBodies = [];
  let deleteCalls = 0;
  let rpcShouldFail = false;
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
    if (parsed.pathname === "/rest/v1/tenant_snapshots") {
      return jsonRes(200, [{ payload: { storage: { mg_settings_v2: SETTINGS } } }]);
    }
    if (parsed.pathname === "/rest/v1/rpc/allocate_next_quote_number") {
      allocateCalls += 1;
      return jsonRes(200, { quote_year: 2026, quote_sequence: 1, quote_number_display: "2026-001" });
    }
    if (parsed.pathname === "/rest/v1/rpc/mg_confirm_quote_operational_plan") {
      rpcBodies.push(body);
      if (rpcShouldFail) {
        return { ok: false, status: 500, text: async () => "p_operational_plan must be a JSON array" };
      }
      return jsonRes(200, { ok: true, persisted: true, quote_id: body.p_quote_id });
    }
    if (parsed.pathname === "/rest/v1/quotes" && method === "POST") {
      insertCalls += 1;
      return jsonRes(201, [{ id: QUOTE_A, tenant_id: TENANT_A, total: body.total, public_token: body.public_token }]);
    }
    if (parsed.pathname === "/rest/v1/quotes" && method === "DELETE") {
      deleteCalls += 1;
      return jsonRes(200, [{ id: QUOTE_A, tenant_id: TENANT_A }]);
    }
    if (parsed.pathname === "/rest/v1/quotes" && method === "GET") return jsonRes(200, []);
    if (parsed.pathname === "/rest/v1/tenants" || parsed.pathname === "/rest/v1/tenant_branding" || parsed.pathname === "/rest/v1/tenant_contacts") {
      return jsonRes(200, []);
    }
    throw new Error("unexpected isolated fetch: " + method + " " + target);
  };

  function resetCounters() {
    pricingCalls = 0;
    allocateCalls = 0;
    insertCalls = 0;
    rpcBodies = [];
    deleteCalls = 0;
    rpcShouldFail = false;
  }

  try {
    for (const key of Object.keys(require.cache)) {
      if (key.replace(/\\/g, "/").includes("/netlify/functions/")) delete require.cache[key];
    }
    const publishMod = require("../netlify/functions/publish-public-quote");

    await test("area_ref publish does not price, number, insert, or confirm", async () => {
      resetCounters();
      const response = await publishMod.handler({
        httpMethod: "POST",
        headers: {},
        body: JSON.stringify(
          publishBody({
            internal_operational_plan: {
              areas: [{ area_ref: "area_1", name: "Kitchen", scope: "Tile.", sort_order: 0 }],
              days: [day({ area_ref: "area_1" })],
            },
          })
        ),
      });
      const body = JSON.parse(response.body);
      assert.strictEqual(response.statusCode, 400);
      assert.strictEqual(body.code, "unresolved_area_ref");
      assert.strictEqual(pricingCalls, 0);
      assert.strictEqual(allocateCalls, 0);
      assert.strictEqual(insertCalls, 0);
      assert.strictEqual(rpcBodies.length, 0);
    });

    await test("canonical publish prices once and returns the persisted document", async () => {
      resetCounters();
      const response = await publishMod.handler({
        httpMethod: "POST",
        headers: {},
        body: JSON.stringify(publishBody()),
      });
      const body = JSON.parse(response.body);
      assert.strictEqual(response.statusCode, 200, body.error || response.body);
      assert.strictEqual(pricingCalls, 1);
      assert.strictEqual(insertCalls, 1);
      assert.strictEqual(rpcBodies.length, 1);
      const persisted = rpcBodies[0].p_document;
      assert.deepStrictEqual(body.internal_operational_plan, persisted);
      assert.strictEqual(persisted.areas[0].id, KITCHEN);
      assert.strictEqual(persisted.areas[1].id, MASTER);
      assert.strictEqual(JSON.stringify(persisted).includes("area_ref"), false);
      assert.strictEqual(persisted.areas.some((area) => area.id === MASTER), true);
      assert.strictEqual(body.labor_areas.some((area) => area.name === "Master Bathroom"), false);
      const cents = Math.round(Number(body.financials.total) * 100);
      const subtotalCents = body.labor_areas.reduce((sum, area) => sum + Math.round(Number(area.sell_subtotal) * 100), 0);
      assert.strictEqual(subtotalCents, cents);
      assert.strictEqual(body.labor_areas.length, 1);
    });

    await test("internal plan failure rolls back the new quote", async () => {
      resetCounters();
      rpcShouldFail = true;
      const response = await publishMod.handler({
        httpMethod: "POST",
        headers: {},
        body: JSON.stringify(publishBody()),
      });
      const body = JSON.parse(response.body);
      assert.strictEqual(response.statusCode, 503);
      assert.strictEqual(body.ok, false);
      assert.strictEqual(deleteCalls, 1);
      assert.strictEqual(body.public_url, undefined);
      assert.strictEqual(body.internal_operational_plan, undefined);
    });
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

module.exports = {
  EXPECTED,
  runSellerOperationalPlanAreaIdentityTests,
};

if (require.main === module) {
  runSellerOperationalPlanAreaIdentityTests()
    .then((count) => {
      console.log(count + " passed");
      if (count !== EXPECTED) process.exit(1);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
