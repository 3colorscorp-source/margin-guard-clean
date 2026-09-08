/**
 * Hours→days publish parity for Enviar estimate.
 * Isolated: no Netlify, Zapier, or live quote writes.
 * Run: node scripts/test-seller-hours-publish-parity.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const Module = require("module");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function checkSyntax(rel) {
  const r = spawnSync(process.execPath, ["--check", path.join(ROOT, rel)], {
    encoding: "utf8",
  });
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || rel);
}

let passed = 0;
function ok(label, cond) {
  assert.ok(cond, label);
  passed += 1;
  console.log("PASS " + label);
}

function eq(label, a, b) {
  assert.strictEqual(a, b, label + " expected " + b + " got " + a);
  passed += 1;
  console.log("PASS " + label);
}

const {
  calculateQuotePublishFinancials,
  sanitizeWorkersForTenantPricing,
} = require("../netlify/functions/_lib/pricing-engine");
const publishTest = require("../netlify/functions/publish-public-quote")._test;
const calcTest = require("../netlify/functions/calc-secure-pricing")._test;

const publishSrc = read("netlify/functions/publish-public-quote.js");
const calcSrc = read("netlify/functions/calc-secure-pricing.js");
const salesSrc = read("public/sales.html");
const zapierSrc = read("netlify/functions/send-quote-zapier.js");
const feedbackSrc = read("public/js/quote-send-feedback.js");

const SETTINGS = {
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

function financialsFor(workers, settings) {
  const normalized = publishTest.normalizeWorkersLaborDays(workers, settings);
  const sanitized = sanitizeWorkersForTenantPricing(normalized);
  return calculateQuotePublishFinancials(
    {
      workers: sanitized,
      price: "",
      _manualPriceTouched: false,
      _sliderTouched: false,
      pricing_stage: 2,
    },
    settings
  );
}

checkSyntax("netlify/functions/publish-public-quote.js");
checkSyntax("netlify/functions/calc-secure-pricing.js");
checkSyntax("public/js/quote-send-feedback.js");
ok("syntax publish/calc/feedback", true);
ok(
  "publish uses session membership only for p_membership_id",
  /membershipIdForRpc\(ctx\.membership && ctx\.membership\.id\)/.test(publishSrc)
);
ok("publish does not look up profiles.id as a typed uuid stand-in", !/resolveMembershipIdForRpc/.test(publishSrc));
const storeSrc = read("netlify/functions/_lib/quote-internal-operational-plan-store.js");
const adminSrc = read("netlify/functions/_lib/supabase-admin.js");
ok("confirm RPC is the only supabaseRequest that sets prefer false", /prefer:\s*false/.test(storeSrc));
ok("supabase-admin does not skip Prefer for every rpc path", !/startsWith\(["']rpc\//.test(adminSrc));
ok("supabase-admin still defaults Prefer return=representation", /return=representation/.test(adminSrc));

eq(
  "hoursPerDay 8 fallback when missing",
  publishTest.resolveHoursPerDayForLabor({}),
  8
);
eq(
  "hoursPerDay 8 fallback when zero",
  publishTest.resolveHoursPerDayForLabor({ hoursPerDay: 0 }),
  8
);
eq(
  "hoursPerDay 8 fallback when invalid",
  publishTest.resolveHoursPerDayForLabor({ hoursPerDay: "nope" }),
  8
);
eq(
  "hoursPerDay 8 fallback when negative",
  publishTest.resolveHoursPerDayForLabor({ hoursPerDay: -4 }),
  8
);
eq(
  "hoursPerDay keeps valid 8",
  publishTest.resolveHoursPerDayForLabor({ hoursPerDay: 8 }),
  8
);
eq(
  "calc and publish share hoursPerDay fallback",
  calcTest.resolveHoursPerDayForLabor({ hoursPerDay: 0 }),
  publishTest.resolveHoursPerDayForLabor({ hoursPerDay: 0 })
);

const hoursOnly = [{ name: "Pro 1", type: "installer", days: 0, hours: 40 }];
const pubHours = publishTest.normalizeWorkersLaborDays(hoursOnly, SETTINGS);
const calcHours = calcTest.normalizeWorkersLaborDays(hoursOnly, SETTINGS);
eq("publish hours 40 / 8 = 5 days", pubHours[0].days, 5);
eq("calc hours 40 / 8 = 5 days", calcHours[0].days, 5);
ok("publish accepts hours-only after normalize", publishTest.validateWorkersForPricing(pubHours).ok);
ok("calc accepts hours-only after normalize", calcTest.validateWorkersForPricing(calcHours).ok);

const pubFin = financialsFor(hoursOnly, SETTINGS);
const calcFin = calculateQuotePublishFinancials(
  {
    workers: sanitizeWorkersForTenantPricing(calcHours),
    price: "",
    _manualPriceTouched: false,
    _sliderTouched: false,
    pricing_stage: 2,
  },
  SETTINGS
);
eq("hours-only publish total matches calc total", pubFin.total, calcFin.total);
eq("hours-only recommended matches", pubFin.recommended_price, calcFin.recommended_price);
eq("hours-only minimum matches", pubFin.minimum_price, calcFin.minimum_price);

const fiveDay = [{ name: "Pro 1", type: "installer", days: 5, hours: 99 }];
const pubDays = publishTest.normalizeWorkersLaborDays(fiveDay, SETTINGS);
eq("days > 0 is preserved (hours ignored)", pubDays[0].days, 5);
ok("days > 0 still valid", publishTest.validateWorkersForPricing(pubDays).ok);
eq(
  "days-only totals match 5-day hours-normalized totals",
  financialsFor(fiveDay, SETTINGS).total,
  pubFin.total
);

const zeroLabor = [{ name: "Pro 1", type: "installer", days: 0, hours: 0 }];
const pubZero = publishTest.normalizeWorkersLaborDays(zeroLabor, SETTINGS);
eq("zero labor stays 0 days", pubZero[0].days, 0);
ok("zero labor fails validate", !publishTest.validateWorkersForPricing(pubZero).ok);
ok(
  "zero labor error mentions days greater than zero",
  /days greater than zero/i.test(publishTest.validateWorkersForPricing(pubZero).error)
);

const idxNorm = publishSrc.indexOf("normalizeWorkersLaborDays(pricingIn.workers");
const idxVal = publishSrc.indexOf("validateWorkersForPricing(workersNormalized)");
const idxInsert = publishSrc.indexOf("async function tryInsertAll");
ok("normalize before validate", idxNorm > 0 && idxNorm < idxVal);
ok("validate before INSERT helper", idxVal > 0 && idxVal < idxInsert);
ok("400 returned on failed worker check", /return json\(400, \{ error: wCheck\.error \}\)/.test(publishSrc));

const nanNorm = publishTest.normalizeWorkersLaborDays(
  [{ type: "installer", days: "x", hours: "y" }],
  { hoursPerDay: "bad" }
);
eq("invalid numbers do not become NaN days", nanNorm[0].days, 0);
ok("invalid numbers do not inflate", Number.isFinite(nanNorm[0].days) && nanNorm[0].days === 0);

const tinyHpd = publishTest.normalizeWorkersLaborDays(hoursOnly, { hoursPerDay: 0.25 });
eq("sub-1 hoursPerDay does not inflate 40h into 160 days", tinyHpd[0].days, 5);

ok(
  "owner preview still uses /sales?portal=owner",
  /get\('portal'\) === 'owner'/.test(salesSrc) && /function isOwnerNavSalesPreview/.test(salesSrc)
);
ok(
  "seller device still uses /sales?portal=seller",
  /get\('portal'\) === 'seller'/.test(salesSrc) && /function isSellerPortalUrlActive/.test(salesSrc)
);
ok(
  "owner and seller share runSellerSend on sales.html",
  /async function runSellerSend/.test(salesSrc)
);

const secondFill = salesSrc.indexOf("await fillSendModal();", salesSrc.indexOf("Creating public quote link"));
const resolveAfter = salesSrc.indexOf("resolveSellerPublishWorkers(stateFresh, settings)", secondFill);
const metricsAfter = salesSrc.indexOf("buildSalesUIMetrics(stateFresh, settings)", resolveAfter);
const laborGate = salesSrc.indexOf("sellerHasEffectiveLaborForPublish(stateFresh, settings)", metricsAfter);
const publishBody = salesSrc.indexOf("buildPublishPublicQuoteBody({", laborGate);
ok("second fillSendModal still present", secondFill > 0);
ok("resolveSellerPublishWorkers runs after second fillSendModal", resolveAfter > secondFill);
ok("metrics recalculated after worker resolve", metricsAfter > resolveAfter);
ok("sellerHasEffectiveLaborForPublish after resolve", laborGate > metricsAfter);
ok("publishBody after labor gate", publishBody > laborGate);
ok(
  "hours-only workers count as effective labor",
  /qtyHours \+= h/.test(salesSrc) && /qtyDays > 0 \|\| qtyHours > 0/.test(salesSrc)
);
ok(
  "missing labor shows clear send error before POST",
  /Add labor days or hours before sending this estimate/.test(salesSrc)
);
ok(
  "labor gate skipped when reusing published snapshot",
  /reusePublishedSnapshot/.test(salesSrc) &&
    /!reusePublishedSnapshot &&/.test(salesSrc)
);
ok(
  "snapshot reuse skips publish POST",
  /reusePublishedSnapshot/.test(salesSrc) &&
    salesSrc.indexOf("if (reusePublishedSnapshot)", laborGate) > 0 &&
    salesSrc.indexOf("fetch('/.netlify/functions/publish-public-quote'", laborGate) >
      salesSrc.indexOf("if (reusePublishedSnapshot)", laborGate)
);

const statusIdx = zapierSrc.indexOf("assertQuoteSendableStatus(quote)");
const webhookFetchIdx = zapierSrc.indexOf("fetch(webhookUrl");
ok("send-quote-zapier status gate exists", statusIdx > 0);
ok("unsendable quote is blocked before Zapier fetch", statusIdx < webhookFetchIdx);
ok(
  "blocked statuses include accepted/archived",
  /archived/.test(zapierSrc) && /accepted/.test(zapierSrc)
);

const fbCtx = { window: null, globalThis: null };
fbCtx.window = fbCtx;
fbCtx.globalThis = fbCtx;
vm.runInNewContext(feedbackSrc, fbCtx);
const friendly = fbCtx.__MG_QUOTE_SEND_FEEDBACK__.friendlySendFailureMessage;
ok("friendlySendFailureMessage exported", typeof friendly === "function");
eq(
  "maps workers days error",
  friendly(new Error("workers must include at least one line with days greater than zero.")),
  "Add labor days or hours before sending this estimate."
);
eq(
  "maps below-minimum error",
  friendly(new Error("Offered price cannot be below the minimum allowed (1000.00).")),
  "The quote price is below the minimum allowed. Refresh the page and try again."
);
eq(
  "maps quote_not_sendable code",
  friendly(new Error("quote_not_sendable")),
  "This quote cannot be sent in its current status."
);
eq(
  "maps current-status message",
  friendly(new Error("Quote cannot be sent in its current status.")),
  "This quote cannot be sent in its current status."
);
eq(
  "maps persist failure to an actionable message",
  friendly(new Error("The operational plan could not be saved, so the quote was not sent. Please try again.")),
  "The operational plan could not be saved, so the quote was not sent. Please try again."
);
eq(
  "maps second-retry PostgREST dump without persist copy",
  friendly(
    new Error(
      "Supabase HTTP 404: Could not find the function public.mg_confirm_quote_operational_plan(p_tenant_id, p_quote_id, p_document, p_schema_version, p_operational_plan, p_estimated_days, p_estimated_hours, p_start_date, p_due_date) in the schema cache | PGRST202"
    )
  ),
  "The operational plan could not be saved, so the quote was not sent. Please try again."
);
const documentInvalidErr = new Error("hours_per_worker must be greater than 0 and at most 24.");
documentInvalidErr.code = "document_invalid";
eq(
  "maps document_invalid code from second-retry 400",
  friendly(documentInvalidErr),
  "The operational plan could not be saved, so the quote was not sent. Please try again."
);
let thrownPublish = null;
try {
  fbCtx.__MG_QUOTE_SEND_FEEDBACK__.throwFromPublishResponse(
    {
      error:
        "Supabase HTTP 404: Could not find the function public.mg_confirm_quote_operational_plan(p_tenant_id, p_quote_id, p_document, p_schema_version, p_operational_plan) in the schema cache | PGRST202",
      code: "internal_plan_persist_failed",
    },
    "",
    { status: 503 }
  );
} catch (err) {
  thrownPublish = err;
}
eq("throwFromPublishResponse preserves persist code", thrownPublish && thrownPublish.code, "internal_plan_persist_failed");
eq(
  "maps second-retry thrown persist code",
  friendly(thrownPublish),
  "The operational plan could not be saved, so the quote was not sent. Please try again."
);
eq(
  "maps storage-missing without leaking SQL names",
  friendly(new Error("Operational plan storage is not ready, so the quote was not sent. Contact support if this continues.")),
  "Operational plan storage is not ready, so the quote was not sent. Contact support if this continues."
);
ok(
  "unmapped errors stay generic without leaking bodies",
  friendly(new Error("supabase service_role xyz")) === "Something went wrong. Please try again."
);

ok(
  "test file has no live customer email",
  !/rmauci@outlook\.com/i.test(read("scripts/test-seller-hours-publish-parity.js"))
);

const FAKE_SUPABASE = "http://127.0.0.1:9";
const FAKE_TENANT_ID = "11111111-1111-4111-8111-111111111111";
const FAKE_QUOTE_ID = "22222222-2222-4222-8222-222222222222";
let publishHandlerCalls = 0;
let calcHandlerCalls = 0;

function jsonRes(status, data) {
  const text = JSON.stringify(data);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
  };
}

function bustNetlifyFunctionsCache() {
  for (const key of Object.keys(require.cache)) {
    if (key.replace(/\\/g, "/").includes("/netlify/functions/")) {
      delete require.cache[key];
    }
  }
}

function isTenantDeviceGuardRequest(request) {
  const n = String(request || "").replace(/\\/g, "/");
  return n === "./_lib/tenant-device-guard" || n.endsWith("/_lib/tenant-device-guard");
}

async function runIsolatedPublishHandlerTests() {
  const originalLoad = Module._load;
  const originalFetch = globalThis.fetch;
  const envBackup = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    URL: process.env.URL,
  };
  const insertCalls = [];
  const fetchLog = [];

  process.env.SUPABASE_URL = FAKE_SUPABASE;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "isolated-test-service-role";
  process.env.URL = FAKE_SUPABASE;

  async function mockFetch(url, options) {
    const u = String(url);
    const method = String((options && options.method) || "GET").toUpperCase();
    fetchLog.push({
      method,
      url: u,
      prefer: options && options.headers && options.headers.Prefer,
    });
    if (/netlify|zapier|outlook\.com/i.test(u) || !u.startsWith(FAKE_SUPABASE)) {
      throw new Error("blocked non-isolated fetch: " + u);
    }
    const parsed = new URL(u);
    const pathname = parsed.pathname;

    if (pathname === "/rest/v1/tenant_snapshots") {
      return jsonRes(200, [{ payload: { storage: { mg_settings_v2: { ...SETTINGS } } } }]);
    }
    if (pathname === "/rest/v1/rpc/allocate_next_quote_number") {
      return jsonRes(200, {
        quote_year: 2026,
        quote_sequence: 1,
        quote_number_display: "2026-001",
      });
    }
    if (pathname === "/rest/v1/tenants" || pathname === "/rest/v1/tenant_branding") {
      return jsonRes(200, []);
    }
    if (pathname === "/rest/v1/quotes" && method === "GET") {
      return jsonRes(200, []);
    }
    if (pathname === "/rest/v1/quotes" && method === "POST") {
      const payload = JSON.parse((options && options.body) || "{}");
      insertCalls.push(payload);
      return jsonRes(201, [
        {
          id: FAKE_QUOTE_ID,
          tenant_id: FAKE_TENANT_ID,
          total: payload.total,
        },
      ]);
    }
    if (pathname === "/rest/v1/tenant_contacts") {
      return jsonRes(200, []);
    }
    throw new Error("unexpected isolated fetch: " + method + " " + u);
  }

  Module._load = function patchedLoad(request, parent, isMain) {
    if (isTenantDeviceGuardRequest(request)) {
      return {
        resolveOwnerOrSellerContext: async () => ({
          auth_mode: "owner",
          tenant: { id: FAKE_TENANT_ID },
          session: { e: "owner@test.example" },
        }),
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  globalThis.fetch = mockFetch;

  try {
    bustNetlifyFunctionsCache();
    const publishMod = require("../netlify/functions/publish-public-quote");
    const calcMod = require("../netlify/functions/calc-secure-pricing");
    assert.strictEqual(typeof publishMod.handler, "function");
    assert.strictEqual(typeof calcMod.handler, "function");

    async function invokePublish(body) {
      publishHandlerCalls += 1;
      return publishMod.handler({
        httpMethod: "POST",
        headers: {},
        body: JSON.stringify(body),
      });
    }

    async function invokeCalc(body) {
      calcHandlerCalls += 1;
      return calcMod.handler({
        httpMethod: "POST",
        headers: {},
        body: JSON.stringify(body),
      });
    }

    function parseHandler(res) {
      return {
        status: res.statusCode,
        body: JSON.parse(res.body || "{}"),
      };
    }

    const hoursOnlyBody = {
      workers: [{ name: "Pro 1", type: "installer", days: 0, hours: 40 }],
      pricing_stage: 2,
      project_name: "Isolated Handler Job",
      client_name: "Test Client",
      client_email: "client@test.example",
    };

    insertCalls.length = 0;
    const hoursPublish = parseHandler(await invokePublish(hoursOnlyBody));
    const hoursCalc = parseHandler(await invokeCalc(hoursOnlyBody));
    eq("handler hours-only status 200", hoursPublish.status, 200);
    ok("handler hours-only attempted INSERT", insertCalls.length === 1);
    eq("handler hours-only INSERT total", insertCalls[0].total, pubFin.total);
    eq("handler hours-only total matches calc handler", hoursPublish.body.financials.total, hoursCalc.body.pricing.total);
    eq(
      "handler hours-only minimum matches calc handler",
      hoursPublish.body.financials.minimum_price,
      hoursCalc.body.pricing.minimum_price
    );
    eq("handler hours-only total matches unit financials", hoursPublish.body.financials.total, pubFin.total);
    eq("handler hours-only minimum matches unit financials", hoursPublish.body.financials.minimum_price, pubFin.minimum_price);

    insertCalls.length = 0;
    const emptyFetchMark = fetchLog.length;
    const emptyBody = {
      ...hoursOnlyBody,
      workers: [{ name: "Pro 1", type: "installer", days: 0, hours: 0 }],
    };
    const emptyPublish = parseHandler(await invokePublish(emptyBody));
    const emptyFetches = fetchLog.slice(emptyFetchMark);
    eq("handler empty labor status 400", emptyPublish.status, 400);
    ok(
      "handler empty labor INSERT never called",
      insertCalls.length === 0 &&
        emptyFetches.every(
          (row) => !(row.method === "POST" && new URL(row.url).pathname === "/rest/v1/quotes")
        )
    );
    ok(
      "handler empty labor error is workers days",
      /days greater than zero/i.test(String(emptyPublish.body.error || ""))
    );

    insertCalls.length = 0;
    const spoofBody = { ...hoursOnlyBody, hours_per_day: 100 };
    const cheapIfBodyHpdTrusted = calculateQuotePublishFinancials(
      {
        workers: sanitizeWorkersForTenantPricing(
          publishTest.normalizeWorkersLaborDays(hoursOnly, { hoursPerDay: 100 })
        ),
        price: "",
        _manualPriceTouched: false,
        _sliderTouched: false,
        pricing_stage: 2,
      },
      SETTINGS
    );
    const spoofPublish = parseHandler(await invokePublish(spoofBody));
    const spoofCalc = parseHandler(await invokeCalc(spoofBody));
    ok(
      "body hours_per_day 100 would cheapen if used for hours→days while engine keeps tenant 8",
      cheapIfBodyHpdTrusted.total < pubFin.total
    );
    eq("handler spoof status 200", spoofPublish.status, 200);
    ok("handler spoof attempted INSERT", insertCalls.length === 1);
    eq("handler spoof still uses 8h → 5-day total", spoofPublish.body.financials.total, pubFin.total);
    eq("handler spoof INSERT total not reduced", insertCalls[0].total, pubFin.total);
    eq("handler spoof total matches calc handler", spoofPublish.body.financials.total, spoofCalc.body.pricing.total);

    insertCalls.length = 0;
    const daysBody = {
      ...hoursOnlyBody,
      workers: [{ name: "Pro 1", type: "installer", days: 5, hours: 0 }],
    };
    const daysPublish = parseHandler(await invokePublish(daysBody));
    const daysCalc = parseHandler(await invokeCalc(daysBody));
    eq("handler days-authority status 200", daysPublish.status, 200);
    ok("handler days-authority attempted INSERT", insertCalls.length === 1);
    eq("handler days 5 keeps prior 5-day total", daysPublish.body.financials.total, pubFin.total);
    eq("handler days-authority INSERT total", insertCalls[0].total, pubFin.total);
    eq("handler days-authority matches calc handler", daysPublish.body.financials.total, daysCalc.body.pricing.total);

    ok(
      "isolated fetch never left fake supabase",
      fetchLog.length > 0 && fetchLog.every((row) => row.url.startsWith(FAKE_SUPABASE))
    );
    const allocatePrefer = fetchLog.find((row) => /rpc\/allocate_next_quote_number/.test(row.url));
    const insertPrefer = fetchLog.find((row) => /\/quotes$/.test(String(row.url).split("?")[0]) && row.method === "POST");
    eq(
      "allocate_next_quote_number still sends Prefer return=representation",
      allocatePrefer && allocatePrefer.prefer,
      "return=representation"
    );
    eq(
      "quotes INSERT still sends Prefer return=representation",
      insertPrefer && insertPrefer.prefer,
      "return=representation"
    );
  } finally {
    Module._load = originalLoad;
    globalThis.fetch = originalFetch;
    if (envBackup.SUPABASE_URL === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = envBackup.SUPABASE_URL;
    if (envBackup.SUPABASE_SERVICE_ROLE_KEY === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = envBackup.SUPABASE_SERVICE_ROLE_KEY;
    if (envBackup.URL === undefined) delete process.env.URL;
    else process.env.URL = envBackup.URL;
    bustNetlifyFunctionsCache();
  }
}

(async function main() {
  await runIsolatedPublishHandlerTests();
  eq("publish exports.handler invocation count", publishHandlerCalls, 4);
  eq("calc-secure-pricing exports.handler invocation count", calcHandlerCalls, 3);
  console.log("\nseller hours publish parity:", passed, "passed");
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
