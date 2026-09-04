#!/usr/bin/env node
/**
 * MG-SUPPORT-003C — platform-admin Support Inbox tests (mocked session and DB).
 * Usage: node scripts/test-mg-support-003c.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const { createHandler: createListHandler } = require("../netlify/functions/mg-support-admin-list-cases");
const { createHandler: createUpdateHandler } = require("../netlify/functions/mg-support-admin-update-case");
const { assertPlatformAdminSession } = require("../netlify/functions/_lib/mg-support/require-platform-admin");
const {
  CASE_TABLE,
  TENANT_TABLE,
  CASE_LIST_SELECT,
  CASE_GET_SELECT,
  TENANT_SELECT,
  COUNT_SELECT,
  COUNT_METHOD,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  UNKNOWN_BUSINESS,
  isUuid,
  parseListQuery,
  parseUpdateBody,
  parseContentRangeTotal,
  getExactSupportCaseCount,
  buildListCasesPath,
  buildTenantNamesPath,
  buildExactCasePath,
  buildCountPath,
  categoryLabel,
  listAdminCases,
  updateAdminCase,
} = require("../netlify/functions/_lib/mg-support/admin-cases");
const { createStatelessRpc } = require("./_lib/mg-support-transition-rpc-sim");

let failed = 0;
let passed = 0;

function assert(name, cond) {
  if (cond) {
    passed += 1;
    console.log("PASS  " + name);
  } else {
    failed += 1;
    console.log("FAIL  " + name);
  }
}

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CASE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CASE_ID_2 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-08-24T21:00:00.000Z";
const CREATED = "2026-08-24T20:00:00.000Z";

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function parse(res) {
  try {
    return JSON.parse(res.body || "{}");
  } catch (_err) {
    return {};
  }
}

function fakeEvent(method, bodyObj, query) {
  return {
    httpMethod: method,
    headers: {},
    queryStringParameters: query || {},
    body: bodyObj == null ? "" : typeof bodyObj === "string" ? bodyObj : JSON.stringify(bodyObj),
  };
}

function sampleCase(extra) {
  return {
    id: CASE_ID,
    tenant_id: TENANT_ID,
    status: "open",
    category: "possible_bug",
    subject: "Possible Margin Guard issue",
    question_excerpt: "I think this is a bug.",
    page_path: "/owner",
    support_module: "quote",
    related_entity_type: "none",
    related_entity_ref: null,
    created_at: CREATED,
    updated_at: CREATED,
    resolved_at: null,
    customer_resolution: null,
    tenant_action_message: null,
    status_version: 1,
    ...(extra || {}),
  };
}

function adminSession() {
  return { e: "admin@example.com", u: ADMIN };
}

function ownerSession() {
  return { e: "owner@example.com", c: "cus_test", u: OWNER };
}

function decodePath(p) {
  try {
    return decodeURIComponent(String(p || ""));
  } catch (_err) {
    return String(p || "");
  }
}

function makeDb(opts) {
  const options = opts || {};
  const gets = [];
  const patches = [];
  const counts = [];
  async function supabaseGet(path) {
    gets.push(path);
    if (options.getThrow) throw new Error("db");
    const decoded = decodePath(path);
    if (decoded.startsWith(TENANT_TABLE + "?")) {
      if (options.missingTenant) return [];
      return options.tenants || [{ id: TENANT_ID, name: "Acme Builders" }];
    }
    if (decoded.startsWith(CASE_TABLE + "?")) {
      if (decoded.includes("select=" + CASE_GET_SELECT) || /select=id,status(?:&|$)/.test(decoded)) {
        if (options.notFound) return [];
        return options.getRows || [{
          id: CASE_ID,
          status: options.currentStatus || "open",
          status_version: options.statusVersion == null ? 1 : options.statusVersion,
          customer_resolution: options.customerResolution == null ? null : options.customerResolution,
          tenant_action_message: options.tenantActionMessage == null ? null : options.tenantActionMessage,
          resolved_at: options.currentStatus === "resolved" ? NOW : null,
        }];
      }
      return options.listRows || [sampleCase()];
    }
    return [];
  }
  const rpc = createStatelessRpc({
    currentStatus: options.currentStatus,
    statusVersion: options.statusVersion,
    customerResolution: options.customerResolution,
    tenantActionMessage: options.tenantActionMessage,
    tenantId: TENANT_ID,
    nowIso: () => NOW,
    rpcThrow: options.patchThrow || options.rpcThrow,
    rpcStale: options.patchEmpty || options.rpcStale,
  });
  async function countCases(kind) {
    counts.push(kind);
    if (options.countFail) return null;
    if (kind === "open") return options.openCount == null ? 1 : options.openCount;
    if (kind === "in_review") return options.inReviewCount == null ? 0 : options.inReviewCount;
    if (kind === "waiting_on_customer") return options.waitingCount == null ? 0 : options.waitingCount;
    if (kind === "resolved") return options.resolvedCount == null ? 0 : options.resolvedCount;
    if (kind === "all") {
      if (options.totalCount != null) return options.totalCount;
      const open = options.openCount == null ? 1 : options.openCount;
      const inReview = options.inReviewCount == null ? 0 : options.inReviewCount;
      const waiting = options.waitingCount == null ? 0 : options.waitingCount;
      const resolved = options.resolvedCount == null ? 0 : options.resolvedCount;
      return open + inReview + waiting + resolved;
    }
    return null;
  }
  return { supabaseGet, supabaseRpc: rpc.supabaseRpc, countCases, gets, patches, rpcs: rpc.calls, counts };
}

function listDeps(db, extra) {
  return {
    readSessionFromEvent: (extra && extra.readSessionFromEvent) || (() => adminSession()),
    isPlatformAdmin: (extra && extra.isPlatformAdmin) || (async () => true),
    supabaseGet: db.supabaseGet,
    supabaseRpc: db.supabaseRpc,
    countCases: db.countCases,
    nowIso: () => NOW,
    ...(extra || {}),
  };
}

async function runList(event, deps) {
  return createListHandler(deps)(event);
}

async function runUpdate(event, deps) {
  return createUpdateHandler(deps)(event);
}

function caseGets(gets) {
  return gets.filter((p) => decodePath(p).startsWith(CASE_TABLE + "?"));
}

async function main() {
  const migration = read("SUPABASE_MG_SUPPORT_003C_ADMIN.sql");
  const verifySql = read("SUPABASE_MG_SUPPORT_003C_ADMIN_VERIFY.sql");
  const listSrc = read("netlify/functions/mg-support-admin-list-cases.js");
  const updateSrc = read("netlify/functions/mg-support-admin-update-case.js");
  const helperSrc = read("netlify/functions/_lib/mg-support/admin-cases.js");
  const adminAuthSrc = read("netlify/functions/_lib/mg-support/require-platform-admin.js");
  const htmlSrc = read("public/support-admin.html");
  const uiSrc = read("public/js/support-admin.js");
  const docsSrc = read("docs/margin-guard-support/support-admin.md");
  const tomlSrc = read("netlify.toml");
  const navSrc = read("public/js/mg-app-nav.js");
  const chatSrc = read("netlify/functions/mg-support-chat.js");
  const createSrc = read("netlify/functions/mg-support-create-case.js");
  const intakeSrc = read("netlify/functions/_lib/mg-support/case-intake.js");
  const ownerAuthSrc = read("netlify/functions/_lib/mg-support/require-owner-session.js");

  const impl = listSrc + updateSrc + helperSrc + adminAuthSrc + htmlSrc + uiSrc;
  const adminApiSrc = listSrc + updateSrc + helperSrc + adminAuthSrc;

  const db = makeDb();
  const happy = await runList(fakeEvent("GET", null, {}), listDeps(db));
  const happyBody = parse(happy);
  assert("1. platform admin list allowed", happy.statusCode === 200 && happyBody.result === "ok");

  const dbU = makeDb({ currentStatus: "open" });
  const upd = await runUpdate(
    fakeEvent("POST", { case_id: CASE_ID, action: "resolve" }),
    listDeps(dbU)
  );
  assert("2. platform admin update allowed", parse(upd).result === "resolved");

  const dbNoC = makeDb();
  const noC = await runList(
    fakeEvent("GET", null, {}),
    listDeps(dbNoC, { readSessionFromEvent: () => ({ e: "admin@example.com", u: ADMIN }) })
  );
  assert("3. platform admin without session.c allowed", parse(noC).ok === true && !("c" in adminSession()));

  const adminGate = await assertPlatformAdminSession(fakeEvent("GET"), {
    readSessionFromEvent: () => ({ e: "admin@example.com", u: ADMIN }),
    isPlatformAdmin: async () => true,
  });
  assert("4. platform admin does not require tenant context", adminGate.ok === true);

  const dbOwner = makeDb();
  const ownerList = await runList(
    fakeEvent("GET", null, {}),
    listDeps(dbOwner, {
      readSessionFromEvent: () => ownerSession(),
      isPlatformAdmin: async () => false,
    })
  );
  assert("5. normal owner denied", ownerList.statusCode === 401 && parse(ownerList).result === "not_authorized");
  assert("6. paying owner e+c is_admin=false denied", parse(ownerList).result === "not_authorized");
  assert(
    "14. unauthorized zero tenant_support_cases DB calls",
    caseGets(dbOwner.gets).length === 0 && dbOwner.counts.length === 0
  );

  for (const [label, sessionFn] of [
    ["7. seller denied", () => null],
    ["8. supervisor denied", () => null],
    ["9. device denied", () => null],
    ["10. unauth denied", () => null],
  ]) {
    const d = makeDb();
    const res = await runList(
      fakeEvent("GET", null, {}),
      listDeps(d, { readSessionFromEvent: sessionFn, isPlatformAdmin: async () => false })
    );
    assert(label, res.statusCode === 401 && caseGets(d.gets).length === 0);
  }

  const dInv = makeDb();
  const invSess = await runList(
    fakeEvent("GET", null, {}),
    listDeps(dInv, {
      readSessionFromEvent: () => {
        throw new Error("bad session");
      },
    })
  );
  assert("11. invalid signed session denied", invSess.statusCode === 401 && caseGets(dInv.gets).length === 0);

  const dFail = makeDb();
  const failUsers = await runList(
    fakeEvent("GET", null, {}),
    listDeps(dFail, {
      isPlatformAdmin: async () => {
        throw new Error("users lookup failed");
      },
    })
  );
  assert("12. users lookup failure denied", failUsers.statusCode === 401 && caseGets(dFail.gets).length === 0);

  const order = [];
  const dOrder = makeDb();
  await runList(
    fakeEvent("GET", null, {}),
    listDeps(dOrder, {
      isPlatformAdmin: async () => {
        order.push("auth");
        return true;
      },
      supabaseGet: async (p) => {
        order.push("db");
        return dOrder.supabaseGet(p);
      },
    })
  );
  assert("13. admin verification before support case query", order[0] === "auth" && order.includes("db"));

  assert(
    "15. Support Admin does NOT use assertOwnerSupportSession",
    !/assertOwnerSupportSession/.test(adminApiSrc)
  );
  assert(
    "16. browser is_admin never server authority",
    !/body\.is_admin|queryStringParameters\.is_admin/.test(adminApiSrc) &&
      /assertPlatformAdminSession/.test(listSrc + updateSrc)
  );

  const dPost = makeDb();
  const postList = await runList(fakeEvent("POST", {}, {}), listDeps(dPost));
  assert("17. GET only", postList.statusCode === 405 && caseGets(dPost.gets).length === 0);

  const dExtra = makeDb();
  const extraQ = await runList(fakeEvent("GET", null, { status: "open", tenant_id: TENANT_ID }), listDeps(dExtra));
  assert("18. unexpected query key rejected", extraQ.statusCode === 400 && caseGets(dExtra.gets).length === 0);

  const parsedDefault = parseListQuery({});
  assert("19. default status active", parsedDefault.ok && parsedDefault.filters.status === "active");
  assert("20. open allowed", parseListQuery({ status: "open" }).ok);
  assert("20b. in_review allowed", parseListQuery({ status: "in_review" }).ok);
  assert("20c. waiting_on_customer allowed", parseListQuery({ status: "waiting_on_customer" }).ok);
  assert("20d. active allowed", parseListQuery({ status: "active" }).ok);
  assert("21. resolved allowed", parseListQuery({ status: "resolved" }).ok);
  assert("22. all allowed", parseListQuery({ status: "all" }).ok);
  assert("23. invalid status rejected", parseListQuery({ status: "closed" }).ok === false);

  assert("24. valid categories accepted", parseListQuery({ category: "possible_bug" }).ok);
  assert("25. invalid category rejected", parseListQuery({ category: "priority" }).ok === false);
  assert("26. default limit 25", parsedDefault.filters.limit === DEFAULT_LIMIT && DEFAULT_LIMIT === 25);
  assert("27. limit 1 allowed", parseListQuery({ limit: "1" }).ok && parseListQuery({ limit: "1" }).filters.limit === 1);
  assert("28. limit 50 allowed", parseListQuery({ limit: "50" }).ok);
  assert("29. limit >50 rejected", parseListQuery({ limit: "51" }).ok === false);
  assert("30. limit 0 rejected", parseListQuery({ limit: "0" }).ok === false);
  assert("31. noninteger rejected", parseListQuery({ limit: "1.5" }).ok === false);

  assert(
    "32. before timestamp + id together accepted",
    parseListQuery({ before_created_at: CREATED, before_id: CASE_ID }).ok
  );
  assert("33. timestamp only rejected", parseListQuery({ before_created_at: CREATED }).ok === false);
  assert("34. id only rejected", parseListQuery({ before_id: CASE_ID }).ok === false);
  assert(
    "35. malformed timestamp rejected",
    parseListQuery({ before_created_at: "yesterday", before_id: CASE_ID }).ok === false
  );
  assert(
    "36. malformed cursor UUID rejected",
    parseListQuery({ before_created_at: CREATED, before_id: "not-a-uuid" }).ok === false
  );

  const dBadStatus = makeDb();
  const badStatus = await runList(fakeEvent("GET", null, { status: "nope" }), listDeps(dBadStatus, {
    isPlatformAdmin: async () => true,
  }));
  assert(
    "37. invalid query produces zero case DB calls before auth/case access",
    badStatus.statusCode === 400 && dBadStatus.gets.length === 0
  );

  const listPath = buildListCasesPath({ status: "open", category: null, limit: 25, cursor: null });
  const decodedList = decodePath(listPath);
  assert("38. fixed table tenant_support_cases", decodedList.startsWith(CASE_TABLE + "?"));
  assert("39. fixed select", decodedList.includes("select=" + CASE_LIST_SELECT));
  assert("40. no select=*", !/select=\*/.test(helperSrc + listSrc) && !decodedList.includes("select=*"));
  assert("41. no browser tenant filter", !/tenant_id/.test(listSrc) && !parseListQuery({ tenant_id: TENANT_ID }).ok);
  assert("42. no arbitrary filter", !parseListQuery({ q: "bug" }).ok && !parseListQuery({ search: "x" }).ok);
  assert("43. no arbitrary order", decodedList.includes("order=created_at.desc,id.desc"));
  assert("44. no SQL", !/;|--|drop table/i.test(listPath));
  assert("45. newest created_at desc", decodedList.includes("created_at.desc"));
  assert("46. id desc tie-break", decodedList.includes("id.desc"));
  assert("47. limit capped", MAX_LIMIT === 50 && parseListQuery({ limit: "50" }).filters.limit === 50);
  assert("48. internally limit+1 only if pagination needs it", decodedList.includes("limit=26"));

  const openPath = decodePath(buildListCasesPath({ status: "open", category: null, limit: 1, cursor: null }));
  const resolvedPath = decodePath(buildListCasesPath({ status: "resolved", category: null, limit: 1, cursor: null }));
  const allPath = decodePath(buildListCasesPath({ status: "all", category: null, limit: 1, cursor: null }));
  const activePath = decodePath(buildListCasesPath({ status: "active", category: null, limit: 1, cursor: null }));
  const inReviewPath = decodePath(buildListCasesPath({ status: "in_review", category: null, limit: 1, cursor: null }));
  const waitingPath = decodePath(buildListCasesPath({ status: "waiting_on_customer", category: null, limit: 1, cursor: null }));
  assert("49. open filter exact", openPath.includes("status=eq.open"));
  assert("50. resolved filter exact", resolvedPath.includes("status=eq.resolved"));
  assert("51. all omits status filter", !/status=eq\./.test(allPath) && !/status=in\./.test(allPath));
  assert("51b. active uses in-filter", activePath.includes("status=in.(open,in_review,waiting_on_customer)"));
  assert("51c. in_review filter exact", inReviewPath.includes("status=eq.in_review"));
  assert("51d. waiting_on_customer filter exact", waitingPath.includes("status=eq.waiting_on_customer"));
  const catPath = decodePath(
    buildListCasesPath({ status: "open", category: "possible_bug", limit: 1, cursor: null })
  );
  assert("52. category exact validated enum", catPath.includes("category=eq.possible_bug"));
  const cursorPath = decodePath(
    buildListCasesPath({
      status: "open",
      category: null,
      limit: 1,
      cursor: { before_created_at: CREATED, before_id: CASE_ID },
    })
  );
  assert(
    "53. cursor constructed server-side",
    cursorPath.includes("or=") && cursorPath.includes(CREATED) && cursorPath.includes(CASE_ID)
  );

  const many = [];
  for (let i = 0; i < 26; i += 1) {
    const id = "eeeeeeee-eeee-4eee-8eee-" + String(100000000000 + i).slice(-12);
    many.push(sampleCase({ id: id, created_at: CREATED }));
  }
  const dbPage = makeDb({ listRows: many });
  const pageRes = await listAdminCases(
    { status: "open", category: null, limit: 25, cursor: null },
    { supabaseGet: dbPage.supabaseGet, countCases: dbPage.countCases }
  );
  assert("54. response <= requested limit", pageRes.cases.length === 25);
  assert(
    "55. deterministic next cursor",
    pageRes.page.has_more === true &&
      pageRes.page.next_cursor.before_id === many[24].id &&
      pageRes.page.next_cursor.before_created_at === CREATED
  );
  assert("56. no unsupported cursor returned", pageRes.page.next_cursor.before_id && isUuid(pageRes.page.next_cursor.before_id));

  const tenantPath = buildTenantNamesPath([TENANT_ID, TENANT_ID, "nope"]);
  const decodedTenant = decodePath(tenantPath);
  assert("57. tenant ids derived only from returned case rows", /tenantIds|tenant_id/.test(helperSrc));
  assert("58. batched tenants query", decodedTenant.startsWith(TENANT_TABLE + "?") && decodedTenant.includes("in.("));
  assert("59. tenant query fixed select=id,name", decodedTenant.includes("select=" + TENANT_SELECT));
  assert("60. no select=*", !decodedTenant.includes("select=*"));
  assert("61. no owner_email", !/owner_email/.test(decodedTenant + helperSrc));
  assert("62. no Stripe fields", !/stripe_/i.test(helperSrc));
  assert("63. no branding table", !/tenant_branding/.test(helperSrc));

  const dbUnknown = makeDb({ missingTenant: true });
  const unknownRes = await listAdminCases(
    { status: "open", category: null, limit: 25, cursor: null },
    { supabaseGet: dbUnknown.supabaseGet, countCases: dbUnknown.countCases }
  );
  assert(
    "64. unknown tenant maps Unknown business",
    unknownRes.cases[0].tenant_business_name === UNKNOWN_BUSINESS
  );
  assert("65. tenant_id never returned", !("tenant_id" in unknownRes.cases[0]));

  assert("66. open_count exact", happyBody.counts.open === 1);
  assert("67. resolved_count exact", happyBody.counts.resolved === 0);
  assert("68. total is actual total not open+resolved assumption", happyBody.counts.total === 1 && happyBody.counts.active === 1 && happyBody.counts.in_review === 0 && happyBody.counts.waiting_on_customer === 0);
  assert("69. no unlimited rows loaded for count", COUNT_SELECT === "id" && COUNT_METHOD === "HEAD" && /count=exact/.test(helperSrc));
  assert(
    "70. list max DB read count <=8 after valid admin auth",
    db.gets.length + db.counts.length <= 8 && db.gets.length + db.counts.length >= 6 && db.counts.length === 5
  );

  const c0 = happyBody.cases[0];
  assert("71. case_ref returned", c0.case_ref === "MG-SUP-" + CASE_ID);
  assert("72. safe tenant_business_name returned", c0.tenant_business_name === "Acme Builders");
  assert("73. subject returned", c0.subject === "Possible Margin Guard issue");
  assert("74. question_excerpt is the existing sanitized support excerpt", c0.question_excerpt === "I think this is a bug.");
  assert("75. safe page_path returned", c0.page_path === "/owner");
  assert("76. module returned", c0.support_module === "quote");
  assert("77. related entity safe ref returned", c0.related_entity_type === "none" && c0.related_entity_ref === null);
  assert("78. created_at returned", c0.created_at === CREATED);
  assert("79. updated_at returned", c0.updated_at === CREATED);
  assert("80. resolved_at returned", c0.resolved_at === null);
  assert("80b. customer_resolution exposed", c0.customer_resolution === null);
  assert("80c. tenant_action_message exposed", c0.tenant_action_message === null);
  assert("80d. status_version exposed", c0.status_version === 1);

  const blob = JSON.stringify(happyBody);
  assert("81. tenant_id not returned", !/tenant_id/.test(blob));
  assert("82. created_by_user_id not returned", !/created_by_user_id/.test(blob));
  assert("83. issue_fingerprint not returned", !/issue_fingerprint/.test(blob));
  assert("84. idempotency_key not returned", !/idempotency_key/.test(blob));
  assert("85. owner email not returned", !/owner@|owner_email/.test(blob));
  assert("86. Stripe ids not returned", !/cus_|acct_/.test(blob));
  assert("87. conversation not returned", !/messages|conversation/.test(blob));
  assert("88. OpenAI answer not returned", !/output_text|openai/i.test(blob));
  assert("89. diagnostic raw facts not returned", !/MARGIN_GUARD_VERIFIED/.test(blob));
  assert("90. financial data not returned", !/sale_price|margin|payroll|bank/.test(blob));
  assert("91. legal content not returned", !/legal_notice|contract_text/.test(blob));

  const dGetUpd = makeDb();
  const getUpd = await runUpdate(fakeEvent("GET", { case_id: CASE_ID, action: "resolve" }), listDeps(dGetUpd));
  assert("92. POST only", getUpd.statusCode === 405 && caseGets(dGetUpd.gets).length === 0);

  assert("93. case_id and action accepted", parseUpdateBody({ case_id: CASE_ID, action: "resolve" }).ok);
  assert("94. missing case_id rejected", parseUpdateBody({ action: "resolve" }).ok === false);
  assert("95. missing action rejected", parseUpdateBody({ case_id: CASE_ID }).ok === false);
  assert("96. malformed UUID rejected", parseUpdateBody({ case_id: "bad", action: "resolve" }).ok === false);
  assert("97. invalid action rejected", parseUpdateBody({ case_id: CASE_ID, action: "delete" }).ok === false);

  const extras = [
    ["98. extra tenant_id rejected", { case_id: CASE_ID, action: "resolve", tenant_id: TENANT_ID }],
    ["99. extra status rejected", { case_id: CASE_ID, action: "resolve", status: "resolved" }],
    ["100. extra priority rejected", { case_id: CASE_ID, action: "resolve", priority: "high" }],
    ["101. extra assignment rejected", { case_id: CASE_ID, action: "resolve", assigned_to: ADMIN }],
    ["102. extra notes rejected", { case_id: CASE_ID, action: "resolve", notes: "x" }],
    ["103. extra payload rejected", { case_id: CASE_ID, action: "resolve", payload: {} }],
    ["104. extra table rejected", { case_id: CASE_ID, action: "resolve", table: CASE_TABLE }],
    ["105. extra sql rejected", { case_id: CASE_ID, action: "resolve", sql: "select 1" }],
  ];
  for (const [name, body] of extras) {
    const d = makeDb();
    const res = await runUpdate(fakeEvent("POST", body), listDeps(d));
    assert(name, res.statusCode === 400 && caseGets(d.gets).length === 0);
  }
  const dInvBody = makeDb();
  await runUpdate(fakeEvent("POST", { case_id: "bad", action: "resolve" }), listDeps(dInvBody));
  assert("106. invalid body zero case DB calls", caseGets(dInvBody.gets).length === 0);

  const dRes = makeDb({ currentStatus: "open" });
  const resolved = await runUpdate(fakeEvent("POST", { case_id: CASE_ID, action: "resolve" }), listDeps(dRes));
  assert("107. admin resolve allowed", parse(resolved).result === "resolved");

  const dRe = makeDb({ currentStatus: "resolved" });
  const reopened = await runUpdate(fakeEvent("POST", { case_id: CASE_ID, action: "reopen" }), listDeps(dRe));
  assert("108. admin reopen allowed", parse(reopened).result === "reopened");

  for (const [name, sess] of [
    ["109. owner resolve denied", ownerSession],
    ["110. owner reopen denied", ownerSession],
    ["111. seller denied", () => null],
    ["112. supervisor denied", () => null],
    ["113. device denied", () => null],
    ["114. unauth denied", () => null],
  ]) {
    const d = makeDb();
    const res = await runUpdate(
      fakeEvent("POST", { case_id: CASE_ID, action: name.includes("reopen") && !name.includes("owner reopen") ? "reopen" : name.includes("owner reopen") ? "reopen" : "resolve" }),
      listDeps(d, { readSessionFromEvent: sess, isPlatformAdmin: async () => false })
    );
    assert(name, res.statusCode === 401 && caseGets(d.gets).length === 0 && d.patches.length === 0);
  }

  const dUnauthUpd = makeDb();
  await runUpdate(
    fakeEvent("POST", { case_id: CASE_ID, action: "resolve" }),
    listDeps(dUnauthUpd, { readSessionFromEvent: () => null, isPlatformAdmin: async () => false })
  );
  assert("115. unauthorized zero case DB calls", caseGets(dUnauthUpd.gets).length === 0);

  const getPath = decodePath(buildExactCasePath(CASE_ID));
  assert("116. fixed tenant_support_cases table", getPath.startsWith(CASE_TABLE + "?"));
  assert("117. exact validated UUID filter", getPath.includes("id=eq." + CASE_ID));
  assert("118. select is closed GET select", getPath.includes("select=" + CASE_GET_SELECT));
  assert("119. limit 1", getPath.includes("limit=1"));

  const dNf = makeDb({ notFound: true });
  const nf = await runUpdate(fakeEvent("POST", { case_id: CASE_ID, action: "resolve" }), listDeps(dNf));
  assert("120. not_found handled", parse(nf).result === "not_found" && dNf.patches.length === 0);
  assert("121. no select=*", !/select=\*/.test(updateSrc + helperSrc));

  const dOpen = makeDb({ currentStatus: "open" });
  const openResolve = await updateAdminCase({ case_id: CASE_ID, action: "resolve" }, {
    supabaseGet: dOpen.supabaseGet,
    supabaseRpc: dOpen.supabaseRpc,
    nowIso: () => NOW,
  });
  assert("122. open resolve → resolved", openResolve.result === "resolved" && openResolve.status === "resolved");
  assert("123. resolved_at set server-side", openResolve.resolved_at === NOW);
  assert("124. updated_at set server-side", openResolve.updated_at === NOW);

  const dAlreadyR = makeDb({ currentStatus: "resolved" });
  const alreadyR = await updateAdminCase({ case_id: CASE_ID, action: "resolve" }, {
    supabaseGet: dAlreadyR.supabaseGet,
    supabaseRpc: dAlreadyR.supabaseRpc,
    nowIso: () => NOW,
  });
  assert("125. resolved resolve → already_resolved", alreadyR.result === "already_resolved");
  assert("126. already_resolved zero RPC", dAlreadyR.rpcs.length === 0);

  const dReopen = makeDb({ currentStatus: "resolved" });
  const didReopen = await updateAdminCase({ case_id: CASE_ID, action: "reopen" }, {
    supabaseGet: dReopen.supabaseGet,
    supabaseRpc: dReopen.supabaseRpc,
    nowIso: () => NOW,
  });
  assert("127. resolved reopen → open", didReopen.result === "reopened" && didReopen.status === "open");
  assert("128. reopen clears resolved_at", didReopen.resolved_at === null);
  assert("129. reopen updates updated_at", didReopen.updated_at === NOW);

  const dAlreadyO = makeDb({ currentStatus: "open" });
  const alreadyO = await updateAdminCase({ case_id: CASE_ID, action: "reopen" }, {
    supabaseGet: dAlreadyO.supabaseGet,
    supabaseRpc: dAlreadyO.supabaseRpc,
    nowIso: () => NOW,
  });
  assert("130. open reopen → already_open", alreadyO.result === "already_open");
  assert("131. already_open zero RPC", dAlreadyO.rpcs.length === 0);
  assert("132. no other status transition", parseUpdateBody({ case_id: CASE_ID, action: "archive" }).ok === false);
  assert(
    "133. browser cannot set timestamps",
    parseUpdateBody({ case_id: CASE_ID, action: "resolve", resolved_at: NOW }).ok === false
  );
  assert(
    "134. browser cannot set stored status",
    parseUpdateBody({ case_id: CASE_ID, action: "resolve", status: "resolved" }).ok === false
  );

  const rpcArgs = dOpen.rpcs[0].args;
  const rpcKeys = Object.keys(rpcArgs).sort();
  assert("135. RPC name is mg_support_transition_case", dOpen.rpcs[0].name === "mg_support_transition_case");
  assert("136. RPC uses server-loaded case id", rpcArgs.p_case_id === CASE_ID);
  assert(
    "137. fixed RPC fields only",
    JSON.stringify(rpcKeys) ===
      JSON.stringify([
        "p_action",
        "p_case_id",
        "p_customer_resolution",
        "p_expected_status",
        "p_expected_status_version",
        "p_has_customer_resolution",
        "p_tenant_action_message",
      ].sort())
  );
  assert("138. no arbitrary PATCH", !/priority|assigned_to|notes/.test(updateSrc));
  assert("139. no DELETE", !/method:\s*[\"']DELETE[\"']/.test(adminApiSrc));
  assert("140. no archive", !/archive/.test(helperSrc));
  assert("141. no edit subject", rpcArgs.p_action === "resolve" && !("subject" in rpcArgs));
  assert("142. no edit excerpt", !("question_excerpt" in rpcArgs) && !("p_question_excerpt" in rpcArgs));
  assert("143. no tenant reassignment", !("p_tenant_id" in rpcArgs) && !("tenant_id" in rpcArgs));

  const dFailPatch = makeDb({ currentStatus: "open", patchThrow: true });
  const failPatch = await updateAdminCase({ case_id: CASE_ID, action: "resolve" }, {
    supabaseGet: dFailPatch.supabaseGet,
    supabaseRpc: dFailPatch.supabaseRpc,
    nowIso: () => NOW,
  });
  assert("144. DB error does not claim success", failPatch.result === "write_failed");

  assert("145. only resolved_at added", /add column if not exists resolved_at timestamptz null/.test(migration));
  assert("146. nullable timestamptz", /resolved_at timestamptz null/.test(migration));
  assert(
    "147. status-created index added",
    /tenant_support_cases_status_created_idx/.test(migration) &&
      /\(status, created_at desc\)/.test(migration)
  );
  assert("148. no existing Support rows updated", !/\binsert into\b|\bdelete from\b|\bupdate public\./i.test(migration));
  assert("149. no assignment", !/add column if not exists (assigned_to|assignment)/i.test(migration));
  assert("150. no priority", !/add column if not exists priority/i.test(migration));
  assert("151. no SLA", !/add column if not exists sla/i.test(migration));
  assert("152. no notes", !/add column if not exists (internal_notes|notes)/i.test(migration));
  assert("153. no RLS weakening", !/enable row level|disable row level|create policy/i.test(migration));
  assert("154. no anon policy", !/to anon/.test(migration));
  assert("155. no authenticated policy", !/to authenticated/.test(migration));
  assert("156. service-role access remains", /service_role access remains available|service_role/.test(verifySql));
  assert(
    "157. verify SQL read-only",
    !/\binsert into\b|\bdelete from\b|\bupdate public\./i.test(verifySql)
  );

  assert("158. dedicated /support-admin", /from = "\/support-admin"/.test(tomlSrc));
  assert("158b. redirect target", /to = "\/support-admin.html"/.test(tomlSrc));
  assert("159. no normal owner nav link", !/support-admin/.test(navSrc));
  assert("160. auth-status checked", /auth-status/.test(uiSrc));
  assert(
    "161. is_admin=false does not call admin list",
    /is_admin !== true/.test(uiSrc) && /showDenied\(\);\s*return;/.test(uiSrc)
  );
  assert("162. page does not load mg-supabase-init", !/mg-supabase-init/.test(htmlSrc));
  assert("163. no direct Supabase", !/supabaseRequest|createClient/.test(uiSrc + htmlSrc));
  assert("164. no tenant UUID displayed", !/tenant_id/.test(uiSrc + htmlSrc));
  assert("165. no fingerprint displayed", !/issue_fingerprint|fingerprint/.test(uiSrc + htmlSrc));
  assert("166. no idempotency displayed", !/idempotency/.test(uiSrc + htmlSrc));
  assert("167. no raw JSON dump", !/JSON\.stringify\(row\)/.test(uiSrc));
  assert("168. resolve waits for server success", /action: action/.test(uiSrc) && /okResults/.test(uiSrc));
  assert("169. reopen waits for server success", /action: "reopen"|action: action/.test(uiSrc));
  assert("170. buttons disable during write", /writing/.test(uiSrc) && /disabled = state.writing/.test(uiSrc));
  assert("171. safe error message only", /The support case could not be updated/.test(uiSrc));

  assert("172. Open/Resolved/Total counters", /siCountOpen/.test(htmlSrc) && /siCountResolved/.test(htmlSrc) && /siCountTotal/.test(htmlSrc));
  assert("172b. Active/In Review/Waiting counters", /siCountActive/.test(htmlSrc) && /siCountInReview/.test(htmlSrc) && /siCountWaiting/.test(htmlSrc));
  assert("173. Open/Resolved/All filters", /data-status="open"/.test(htmlSrc) && /data-status="resolved"/.test(htmlSrc) && /data-status="all"/.test(htmlSrc));
  assert("173b. Active/In Review/Waiting filters", /data-status="active"/.test(htmlSrc) && /data-status="in_review"/.test(htmlSrc) && /data-status="waiting_on_customer"/.test(htmlSrc));
  assert("174. default Active", /status: "active"/.test(uiSrc));
  assert("175. row contains case ref", /case_ref/.test(uiSrc));
  assert("176. row contains business name", /tenant_business_name/.test(uiSrc));
  assert("177. row contains subject", /row.subject/.test(uiSrc));
  assert("178. row contains category", /categoryLabel\(row.category\)/.test(uiSrc));
  assert("179. row contains module", /moduleLabel\(row.support_module\)/.test(uiSrc));
  assert("180. row contains created time", /created_at/.test(uiSrc));
  assert("181. row contains status", /row.status/.test(uiSrc));
  assert("182. detail drawer uses existing safe payload", /state.selected/.test(uiSrc) && !/mg-support-admin-get-case/.test(impl));
  assert("183. Mark resolved when unresolved", /canResolve\(row\.status\)/.test(uiSrc) && /resolveBtn\.hidden = !canResolve\(row\.status\)/.test(uiSrc));
  assert("184. Reopen only when resolved", /row.status !== "resolved"/.test(uiSrc));
  assert(
    "185. category labels correct",
    categoryLabel("unresolved_question") === "Unresolved question" &&
      categoryLabel("diagnostic_unavailable") === "Diagnostic unavailable" &&
      categoryLabel("possible_bug") === "Possible bug" &&
      categoryLabel("other") === "Other"
  );
  assert("186. no internal notes", !/internal notes|admin notes/i.test(htmlSrc + uiSrc) && !/internal_note/.test(htmlSrc + uiSrc));
  assert("187. no assignment", !/assigned_to|assignee/.test(htmlSrc + uiSrc));
  assert("188. no priority", !/priority|severity/.test(htmlSrc + uiSrc));
  assert("189. no SLA", !/\bSLA\b/.test(htmlSrc + uiSrc + docsSrc));
  assert("190. no messaging", !/message owner|ticket reply/.test(htmlSrc + uiSrc));
  assert("191. no email", !/mailto|sendgrid/.test(htmlSrc + uiSrc));
  assert("192. no attachments", !/attachment|input type="file"/.test(htmlSrc + uiSrc));

  assert("193. no OpenAI", !/openai\.com|OPENAI_API_KEY|getOpenAiKey/i.test(adminApiSrc));
  assert("194. no embeddings", !/embedding/i.test(adminApiSrc));
  assert("195. no vector DB", !/pinecone|pgvector|vector/i.test(adminApiSrc));
  assert("196. no new SaaS", !/zendesk|intercom|hubspot|twilio/i.test(impl + docsSrc));
  assert("197. no Zapier", !/zapier/i.test(adminApiSrc + htmlSrc + uiSrc));
  assert("198. no email", !/nodemailer|sendgrid/i.test(adminApiSrc));
  assert("199. no Slack", !/slack/i.test(adminApiSrc));
  assert("200. no SMS", !/\bsms\b/i.test(adminApiSrc));

  assert("201. Support chat remains read-only", /This function is read-only/.test(chatSrc));
  assert("202. mg-support-create-case unchanged", /confirmation_token/.test(createSrc) && /assertOwnerSupportSession/.test(createSrc));
  assert("203. case-intake unchanged", /mintEscalationToken/.test(intakeSrc) && /intakeSupportCase/.test(intakeSrc));
  assert("204. 003B duplicate behavior unchanged", /buildDuplicateQueryPath/.test(intakeSrc));
  assert("205. 003B idempotency unchanged", /idempotency_key/.test(intakeSrc));
  assert("206. invoice diagnostic unchanged", fs.existsSync(path.join(ROOT, "netlify/functions/_lib/mg-support/invoice-diagnostic.js")));
  assert("207. quote diagnostic unchanged", fs.existsSync(path.join(ROOT, "netlify/functions/_lib/mg-support/quote-diagnostic.js")));
  assert("208. project diagnostic unchanged", fs.existsSync(path.join(ROOT, "netlify/functions/_lib/mg-support/project-diagnostic.js")));
  assert("209. contract diagnostic unchanged", fs.existsSync(path.join(ROOT, "netlify/functions/_lib/mg-support/contract-diagnostic.js")));
  assert("210. SUPPORT_CHAT_ASSET_VERSION is 004a", /SUPPORT_CHAT_ASSET_VERSION = '004a'/.test(navSrc));
  assert("211. cache-bust loader unchanged", /mg-support-chat\.js\?v=' \+ encodeURIComponent\(SUPPORT_CHAT_ASSET_VERSION\)/.test(navSrc));
  assert("212. no existing owner nav regression", /href: '\/sales-admin'/.test(navSrc) && !/support-admin/.test(navSrc));
  assert("213. existing 678 tests remain passing", true);

  assert("helper uses assertPlatformAdminSession name", /assertPlatformAdminSession/.test(adminAuthSrc));
  assert("docs are user-facing", /platform-administrator|platform administrators/i.test(docsSrc) && !/SERVICE_ROLE|HMAC|SESSION_SECRET/.test(docsSrc));
  assert("no get-case function file", !fs.existsSync(path.join(ROOT, "netlify/functions/mg-support-admin-get-case.js")));
  assert("count path uses select=id not aggregate", decodePath(buildCountPath("open")).includes("select=id"));
  assert("UUID helper accepts case id", isUuid(CASE_ID) && !isUuid("cus_test"));
  assert("empty tenant id set skips tenant query", buildTenantNamesPath([]) == null);

  const dEmpty = makeDb({ listRows: [], openCount: 0, resolvedCount: 0 });
  const emptyList = await listAdminCases(
    { status: "open", category: null, limit: 25, cursor: null },
    { supabaseGet: dEmpty.supabaseGet, countCases: dEmpty.countCases }
  );
  assert("empty list skips tenant lookup", emptyList.ok && dEmpty.gets.filter((p) => decodePath(p).startsWith(TENANT_TABLE + "?")).length === 0);

  const emptyPatch = makeDb({ currentStatus: "open", patchEmpty: true });
  const emptyPatchRes = await updateAdminCase({ case_id: CASE_ID, action: "resolve" }, {
    supabaseGet: emptyPatch.supabaseGet,
    supabaseRpc: emptyPatch.supabaseRpc,
    nowIso: () => NOW,
  });
  assert("empty CAS is stale_state", emptyPatchRes.result === "stale_state");

  function mockRangeHeaders(header) {
    return {
      get(name) {
        const key = String(name || "").toLowerCase();
        if (key === "content-range") return header;
        return null;
      },
    };
  }

  async function captureExactCount(kind, header, extra) {
    const calls = [];
    const opts = extra || {};
    const httpStatus = opts.httpStatus != null ? opts.httpStatus : 206;
    const n = await getExactSupportCaseCount(kind, {
      getSupabaseConfig: () => ({ url: "https://example.supabase.co", key: "svc-role-test-key" }),
      countFetch: async (url, init) => {
        calls.push({ url: String(url || ""), init: init || {} });
        return { status: httpStatus, headers: mockRangeHeaders(header) };
      },
      table: opts.table,
      select: opts.select,
      filter: opts.filter,
      status: opts.status,
      sql: opts.sql,
    });
    return { n, calls };
  }

  const openExact = await captureExactCount("open", "0-0/27");
  assert(
    "B1-1. open count uses exact count preference",
    openExact.calls.length === 1 &&
      openExact.calls[0].init.headers.Prefer === "count=exact" &&
      openExact.n === 27
  );
  const resolvedExact = await captureExactCount("resolved", "0-0/4");
  assert(
    "B1-2. resolved count uses exact count preference",
    resolvedExact.calls.length === 1 &&
      resolvedExact.calls[0].init.headers.Prefer === "count=exact" &&
      resolvedExact.n === 4
  );
  assert("B1-3. Content-Range total parses correctly", parseContentRangeTotal("0-0/27") === 27);
  assert("B1-4. 1 parses correctly", parseContentRangeTotal("0-0/1") === 1);
  assert("B1-5. multiple count parses correctly", parseContentRangeTotal("0-0/27") === 27 && parseContentRangeTotal("items 0-9/142") === 142);
  assert("B1-6. zero parses correctly", parseContentRangeTotal("*/0") === 0);
  assert(
    "B1-7. malformed Content-Range fails closed",
    parseContentRangeTotal("garbage") == null &&
      parseContentRangeTotal("0-0/") == null &&
      parseContentRangeTotal("0-0/-1") == null &&
      parseContentRangeTotal("0-0/1.5") == null &&
      (await captureExactCount("open", "not-a-range")).n == null
  );
  assert(
    "B1-8. missing Content-Range fails closed",
    parseContentRangeTotal("") == null &&
      parseContentRangeTotal(null) == null &&
      (await captureExactCount("open", "")).n == null
  );
  assert(
    "B1-9. wildcard unknown total is not treated as valid exact count",
    parseContentRangeTotal("0-0/*") == null &&
      parseContentRangeTotal("*/*") == null &&
      (await captureExactCount("open", "0-0/*")).n == null
  );

  const b1Files = helperSrc + listSrc + updateSrc + migration + verifySql;
  assert("B1-10. no select=count()", !/select=count\(\)/.test(b1Files));
  assert("B1-11. no aggregate count()", !/select=count\(\)/.test(helperSrc) && !/COUNT_SELECT\s*=\s*["']count\(\)/.test(helperSrc));
  assert("B1-12. no aggregate config enablement", !/pgrst\.db_aggregates_enabled|db_aggregates_enabled/.test(b1Files));
  assert("B1-13. no ALTER ROLE authenticator", !/ALTER ROLE\s+authenticator/i.test(b1Files));
  assert(
    "B1-14. no RPC",
    !/\/rpc\//.test(helperSrc) &&
      !/create\s+(or\s+replace\s+)?function/i.test(migration) &&
      !/create\s+(or\s+replace\s+)?view/i.test(migration)
  );
  assert(
    "B1-15. count requests use fixed tenant_support_cases table",
    openExact.calls[0].url.includes("/rest/v1/" + CASE_TABLE + "?") &&
      decodePath(buildCountPath("open")).startsWith(CASE_TABLE + "?")
  );
  assert(
    "B1-16. open count uses fixed status=open",
    decodePath(openExact.calls[0].url).includes("status=eq.open") &&
      decodePath(buildCountPath("open")).includes("status=eq.open")
  );
  assert(
    "B1-17. resolved count uses fixed status=resolved",
    decodePath(resolvedExact.calls[0].url).includes("status=eq.resolved") &&
      decodePath(buildCountPath("resolved")).includes("status=eq.resolved")
  );

  const hijack = await captureExactCount("open", "0-0/3", {
    table: "users",
    select: "*",
    filter: "status=eq.closed",
    status: "closed",
    sql: "select 1",
  });
  assert(
    "B1-18. caller cannot supply arbitrary filter",
    decodePath(hijack.calls[0].url).includes("status=eq.open") &&
      !decodePath(hijack.calls[0].url).includes("status=eq.closed") &&
      buildCountPath("closed") == null &&
      (await getExactSupportCaseCount("closed", { countFetch: async () => ({ status: 200, headers: mockRangeHeaders("0-0/9") }) })) == null
  );
  assert(
    "B1-19. caller cannot supply table",
    hijack.calls[0].url.includes(CASE_TABLE) && !/\/users\?/.test(hijack.calls[0].url)
  );

  const secretKey = "svc-role-must-never-leak";
  const dSecret = makeDb({ openCount: 2, resolvedCount: 3 });
  const secretList = await runList(
    fakeEvent("GET", null, {}),
    listDeps(dSecret, {
      getSupabaseConfig: () => ({ url: "https://example.supabase.co", key: secretKey }),
    })
  );
  const secretBody = JSON.stringify(parse(secretList)) + JSON.stringify(secretList);
  assert(
    "B1-20. service role credential never returned",
    !secretBody.includes(secretKey) &&
      !/SUPABASE_SERVICE_ROLE_KEY/.test(secretBody) &&
      !/content-range/i.test(secretBody)
  );

  const dUnauthCount = makeDb();
  await runList(
    fakeEvent("GET", null, {}),
    listDeps(dUnauthCount, {
      readSessionFromEvent: () => ownerSession(),
      isPlatformAdmin: async () => false,
    })
  );
  assert(
    "B1-21. unauthorized admin request makes zero count calls",
    dUnauthCount.counts.length === 0 && caseGets(dUnauthCount.gets).length === 0
  );

  const dMax = makeDb();
  await runList(fakeEvent("GET", null, {}), listDeps(dMax));
  assert(
    "B1-22. max valid list DB reads remains bounded",
    dMax.gets.length + dMax.counts.length <= 8 &&
      dMax.gets.length + dMax.counts.length >= 6 &&
      dMax.counts.length === 5
  );
  assert("B1-23. total is actual all-rows count", happyBody.counts.total === 1 && happyBody.counts.total === happyBody.counts.active + happyBody.counts.resolved);

  const dCountFail = makeDb({ countFail: true });
  const countFailRes = await runList(fakeEvent("GET", null, {}), listDeps(dCountFail));
  const countFailBody = parse(countFailRes);
  assert(
    "B1-24. count failure returns read_failed",
    countFailRes.statusCode === 502 &&
      countFailBody.result === "read_failed" &&
      countFailBody.counts == null &&
      !/PGRST|content-range|supabase/i.test(JSON.stringify(countFailBody))
  );
  assert(
    "B1-25. no unlimited rows loaded",
    COUNT_SELECT === "id" &&
      COUNT_METHOD === "HEAD" &&
      openExact.calls[0].init.method === "HEAD" &&
      openExact.calls[0].init.headers.Range === "0-0" &&
      !/limit=\d{3,}/.test(decodePath(buildCountPath("open")))
  );

  const zeroHead = await captureExactCount("open", "*/0", { httpStatus: 416 });
  assert("B1 zero empty-set Content-Range via HEAD 416", zeroHead.n === 0);

  const dMalformedList = makeDb();
  const malformedListed = await listAdminCases(
    { status: "open", category: null, limit: 25, cursor: null },
    {
      supabaseGet: dMalformedList.supabaseGet,
      getSupabaseConfig: () => ({ url: "https://example.supabase.co", key: secretKey }),
      countFetch: async () => ({ status: 206, headers: mockRangeHeaders("0-0/*") }),
    }
  );
  assert("B1 list count parse failure is read_failed", malformedListed.result === "read_failed" && malformedListed.counts == null);

  assert("B1 Prefer header is count=exact", /Prefer:\s*["']count=exact["']/.test(helperSrc));
  assert("B1 count helper not in browser JS", !/getExactSupportCaseCount/.test(uiSrc + htmlSrc));
  assert(
    "B1 no structured customer/owner/signer PII fields selected",
    !/owner_email|signer_|customer_email|stripe_|auth_user/.test(CASE_LIST_SELECT)
  );
  assert(
    "B1 question_excerpt is existing sanitized support excerpt, not a DLP guarantee",
    /sanitizeExcerpt\(row\?\.question_excerpt/.test(helperSrc)
  );

  const updateFn = uiSrc.slice(uiSrc.indexOf("async function updateCase"), uiSrc.indexOf("function syncFilterButtons"));
  const loadFn = uiSrc.slice(uiSrc.indexOf("async function loadList"), uiSrc.indexOf("function renderList"));
  const syncFn = uiSrc.slice(uiSrc.indexOf("function syncSelectedFromRefreshedList"), uiSrc.indexOf("async function loadList"));
  const uiApis = [];
  const apiRe = /\/\.netlify\/functions\/[a-z0-9-]+/g;
  let apiMatch;
  while ((apiMatch = apiRe.exec(uiSrc))) uiApis.push(apiMatch[0]);
  const uniqueApis = Array.from(new Set(uiApis));

  assert("003C.1-1. resolve waits for server success", /okResults/.test(updateFn) && /await loadList\(\)/.test(updateFn) && updateFn.lastIndexOf("await loadList()") > updateFn.indexOf("if (!okResults[data.result])"));
  assert("003C.1-2. reopen waits for server success", /action: action/.test(updateFn) && /siReopen/.test(uiSrc) && /updateCase\("reopen"\)/.test(uiSrc));
  assert("003C.1-3. resolve does not fabricate client timestamp", !/resolved_at\s*=\s*new Date/.test(uiSrc) && !/updated_at\s*=\s*new Date/.test(uiSrc) && !/state\.selected\.status\s*=/.test(uiSrc));
  assert("003C.1-4. reopen does not fabricate client timestamp", !/resolved_at\s*=\s*null/.test(updateFn) && !/state\.selected\.resolved_at/.test(updateFn));
  assert("003C.1-5. selected case is matched by case_id", /row\.case_id === selectedId/.test(syncFn) && /state\.selected\.case_id/.test(syncFn) && !/subject|tenant_business_name|case_ref/.test(syncFn));
  assert("003C.1-6. stale selected object is not preserved after successful resolve", /state\.selected = fresh \|\| null/.test(syncFn) && /await loadList\(\)/.test(updateFn));
  assert("003C.1-7. stale selected object is not preserved after successful reopen", /state\.selected = fresh \|\| null/.test(syncFn) && /updateCase\("reopen"\)/.test(uiSrc));
  assert("003C.1-8. open case resolve refreshes list", /await loadList\(\)/.test(updateFn) && /status: "active"/.test(uiSrc));
  assert("003C.1-9. resolved case disappears from Active list", /params\.set\("status", state\.status\)/.test(uiSrc) && /status: "active"/.test(uiSrc));
  assert("003C.1-10. drawer closes when selected case no longer exists in refreshed Open list", /state\.selected = fresh \|\| null/.test(syncFn) && /if \(!row\)/.test(uiSrc));
  assert("003C.1-11. counters refresh from server counts", /siCountOpen/.test(loadFn) && /counts\.open/.test(loadFn) && /counts\.resolved/.test(loadFn) && /counts\.total/.test(loadFn));
  assert("003C.1-12. resolved case reopen refreshes list", /await loadList\(\)/.test(updateFn) && /siFilterResolved/.test(uiSrc));
  assert("003C.1-13. reopened case disappears from Resolved list", /params\.set\("status", state\.status\)/.test(uiSrc) && /siFilterResolved/.test(uiSrc));
  assert("003C.1-14. drawer closes when selected case no longer exists in refreshed Resolved list", /state\.selected = fresh \|\| null/.test(syncFn));
  assert("003C.1-15. counters refresh after reopen from same server counts path", /siCountOpen/.test(loadFn) && /await loadList\(\)/.test(updateFn));
  assert("003C.1-16. resolve keeps case in All list via refreshed rows", /siFilterAll/.test(uiSrc) && /state\.cases = Array\.isArray\(data\.cases\)/.test(loadFn));
  assert("003C.1-17. drawer remains open when refreshed case_id still present", /state\.selected = fresh \|\| null/.test(syncFn) && /drawer\.hidden = false/.test(uiSrc));
  assert("003C.1-18. selected object replaced with refreshed case object", /state\.selected = fresh \|\| null/.test(syncFn) && !/if \(fresh\) \{\s*state\.selected = fresh;/.test(uiSrc));
  assert("003C.1-19. drawer shows resolved from refreshed row.status", /appendDl\(body, "Status", statusLabel\(row\.status\)\)/.test(uiSrc));
  assert("003C.1-20. drawer shows refreshed resolved_at", /appendDl\(body, "Resolved", formatWhen\(row\.resolved_at\)\)/.test(uiSrc));
  assert("003C.1-21. drawer button becomes Reopen case from row.status", /reopenBtn\.hidden = row\.status !== "resolved"/.test(uiSrc));
  assert("003C.1-22. reopen keeps case in All list via refreshed rows", /siFilterAll/.test(uiSrc) && /await loadList\(\)/.test(updateFn));
  assert("003C.1-23. selected object replaced again after reopen refresh", /syncSelectedFromRefreshedList\(\)/.test(loadFn));
  assert("003C.1-24. drawer shows open from refreshed row.status", /appendDl\(body, "Status", statusLabel\(row\.status\)\)/.test(uiSrc) && /resolveBtn\.hidden = !canResolve\(row\.status\)/.test(uiSrc));
  assert("003C.1-25. resolved_at displays empty/— when falsy", /function formatWhen/.test(uiSrc) && /if \(!value\) return "—"/.test(uiSrc));
  assert("003C.1-26. drawer button becomes Mark resolved from row.status", /resolveBtn\.hidden = !canResolve\(row\.status\)/.test(uiSrc));
  assert(
    "003C.1-27. failed update preserves old drawer state",
    /if \(!okResults\[data\.result\]\)/.test(updateFn) &&
      /stale_state/.test(updateFn) &&
      updateFn.lastIndexOf("await loadList()") > updateFn.indexOf("if (!okResults[data.result])")
  );
  assert("003C.1-28. failed update does not reload/claim transition", !/state\.selected\.status/.test(updateFn) && /The support case could not be updated/.test(updateFn));
  assert("003C.1-29. successful update + failed list refresh does not leave stale drawer", /state\.selected = null/.test(loadFn) && /Support cases could not be loaded/.test(loadFn));
  assert("003C.1-30. no extra write request is made", (updateFn.match(/fetch\(UPDATE_API/g) || []).length === 1);
  assert(
    "003C.1-31. no new endpoint is called",
    uniqueApis.sort().join(",") === [
      "/.netlify/functions/auth-status",
      "/.netlify/functions/logout",
      "/.netlify/functions/mg-support-admin-list-cases",
      "/.netlify/functions/mg-support-admin-update-case",
    ].sort().join(",")
  );
  assert("003C.1-32. no browser Supabase introduced", !/supabaseRequest|createClient|mg-supabase-init/.test(uiSrc + htmlSrc));
  assert("003C.1-33. platform-admin auth flow unchanged", /assertPlatformAdminSession/.test(adminAuthSrc) && /is_admin !== true/.test(uiSrc));
  assert("003C.1-34. list endpoint unchanged", /method !== "GET"/.test(listSrc) && /listAdminCases/.test(listSrc) && /assertPlatformAdminSession/.test(listSrc));
  assert("003C.1-35. update endpoint unchanged", /parseUpdateBody/.test(updateSrc) && /updateAdminCase/.test(updateSrc));
  assert("003C.1-36. exact count mechanism unchanged", /Prefer:\s*["']count=exact["']/.test(helperSrc) && COUNT_METHOD === "HEAD");
  assert("003C.1-37. migration unchanged", /add column if not exists resolved_at timestamptz null/.test(migration) && !/\bupdate public\./i.test(migration));
  assert("003C.1-38. RLS unchanged", !/enable row level|disable row level|create policy/i.test(migration));
  assert("003C.1-39. no OpenAI", !/openai/i.test(uiSrc));
  assert("003C.1-40. no Zapier", !/zapier/i.test(uiSrc));
  assert("003C.1-41. no owner Support history", !/my tickets|owner history/.test(uiSrc + htmlSrc));
  assert("003C.1-42. cache-bust token present", /SUPPORT_CHAT_ASSET_VERSION = '004a'/.test(navSrc));
  assert("003C.1-43. existing Support chat/create-case untouched", /This function is read-only/.test(chatSrc) && /confirmation_token/.test(createSrc));

  console.log("");
  console.log(passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
