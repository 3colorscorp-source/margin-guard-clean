#!/usr/bin/env node
/**
 * MG-SUPPORT-003E.2B — platform-admin case lifecycle (mocked session and DB).
 * Usage: node scripts/test-mg-support-003e-2b.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const { createHandler: createListHandler } = require("../netlify/functions/mg-support-admin-list-cases");
const { createHandler: createUpdateHandler } = require("../netlify/functions/mg-support-admin-update-case");
const {
  CASE_TABLE,
  CASE_GET_SELECT,
  parseUpdateBody,
  parseListQuery,
  buildListCasesPath,
  buildCountPath,
  updateAdminCase,
  VISIBLE_TEXT_MAX,
  TRANSITION_RPC,
} = require("../netlify/functions/_lib/mg-support/admin-cases");
const {
  createStatelessRpc,
  createTransactionalStore,
} = require("./_lib/mg-support-transition-rpc-sim");

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
const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-08-28T23:30:00.000Z";

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
    const decoded = decodePath(path);
    if (decoded.startsWith(CASE_TABLE + "?") && decoded.includes("select=" + CASE_GET_SELECT)) {
      if (options.notFound) return [];
      return [
        {
          id: CASE_ID,
          status: options.currentStatus || "open",
          status_version: options.statusVersion == null ? 1 : options.statusVersion,
          customer_resolution: options.customerResolution == null ? null : options.customerResolution,
          tenant_action_message: options.tenantActionMessage == null ? null : options.tenantActionMessage,
          resolved_at: options.resolvedAt == null ? (options.currentStatus === "resolved" ? NOW : null) : options.resolvedAt,
        },
      ];
    }
    if (decoded.startsWith(CASE_TABLE + "?")) {
      return [
        {
          id: CASE_ID,
          tenant_id: TENANT_ID,
          status: options.currentStatus || "open",
          category: "possible_bug",
          subject: "Possible Margin Guard issue",
          question_excerpt: "I think this is a bug.",
          page_path: "/owner",
          support_module: "quote",
          related_entity_type: "none",
          related_entity_ref: null,
          created_at: NOW,
          updated_at: NOW,
          resolved_at: null,
          customer_resolution: null,
          tenant_action_message: null,
          status_version: 1,
        },
      ];
    }
    if (decoded.startsWith("tenants?")) {
      return [{ id: TENANT_ID, name: "Acme Builders" }];
    }
    return [];
  }
  const rpc = createStatelessRpc({
    currentStatus: options.currentStatus,
    statusVersion: options.statusVersion,
    customerResolution: options.customerResolution,
    tenantActionMessage: options.tenantActionMessage,
    resolvedAt: options.resolvedAt == null ? (options.currentStatus === "resolved" ? NOW : null) : options.resolvedAt,
    tenantId: TENANT_ID,
    nowIso: () => NOW,
    rpcThrow: options.patchThrow || options.rpcThrow,
    rpcStale: options.patchEmpty || options.rpcStale,
  });
  async function countCases(kind) {
    counts.push(kind);
    if (kind === "open") return options.openCount == null ? 1 : options.openCount;
    if (kind === "in_review") return options.inReviewCount == null ? 2 : options.inReviewCount;
    if (kind === "waiting_on_customer") return options.waitingCount == null ? 3 : options.waitingCount;
    if (kind === "resolved") return options.resolvedCount == null ? 4 : options.resolvedCount;
    if (kind === "all") return options.totalCount == null ? 10 : options.totalCount;
    return null;
  }
  return {
    supabaseGet,
    supabaseRpc: rpc.supabaseRpc,
    countCases,
    gets,
    patches,
    rpcs: rpc.calls,
    counts,
  };
}

function deps(db, extra) {
  return {
    readSessionFromEvent: (extra && extra.readSessionFromEvent) || (() => ({ e: "admin@example.com", u: ADMIN })),
    isPlatformAdmin: (extra && extra.isPlatformAdmin) || (async () => true),
    supabaseGet: db.supabaseGet,
    supabaseRpc: db.supabaseRpc,
    countCases: db.countCases,
    nowIso: () => NOW,
    ...(extra || {}),
  };
}

async function runUpdate(event, d, extra) {
  return createUpdateHandler(deps(d, extra))(event);
}

async function runAction(action, status, extraBody, dbOpts) {
  const db = makeDb({ currentStatus: status, ...(dbOpts || {}) });
  const body = { case_id: CASE_ID, action, ...(extraBody || {}) };
  const res = await updateAdminCase(parseUpdateBody(body), {
    supabaseGet: db.supabaseGet,
    supabaseRpc: db.supabaseRpc,
    nowIso: () => NOW,
  });
  return { res, db, body };
}

async function main() {
  const helperSrc = read("netlify/functions/_lib/mg-support/admin-cases.js");
  const updateSrc = read("netlify/functions/mg-support-admin-update-case.js");
  const listSrc = read("netlify/functions/mg-support-admin-list-cases.js");
  const htmlSrc = read("public/support-admin.html");
  const uiSrc = read("public/js/support-admin.js");
  const myCasesSrc = read("netlify/functions/_lib/mg-support/my-cases.js");
  const myCasesEndpoint = read("netlify/functions/mg-support-my-cases.js");
  const chatSrc = read("netlify/functions/mg-support-chat.js");
  const adminApiSrc = listSrc + updateSrc + helperSrc;

  const dList = makeDb();
  const listed = await createListHandler(deps(dList))(fakeEvent("GET", null, {}));
  const listedBody = parse(listed);
  assert("1. default list is active", listedBody.filters.status === "active" && parseListQuery({}).filters.status === "active");
  assert(
    "2. KPIs include in_review/waiting and actual total",
    listedBody.counts.open === 1 &&
      listedBody.counts.in_review === 2 &&
      listedBody.counts.waiting_on_customer === 3 &&
      listedBody.counts.resolved === 4 &&
      listedBody.counts.active === 6 &&
      listedBody.counts.total === 10 &&
      listedBody.counts.total !== listedBody.counts.open + listedBody.counts.resolved
  );
  assert("3. all-rows total count path omits status", decodePath(buildCountPath("all")).startsWith(CASE_TABLE + "?") && !/status=/.test(decodePath(buildCountPath("all"))));
  assert(
    "4. active list filter keeps in_review and waiting",
    decodePath(buildListCasesPath({ status: "active", category: null, limit: 25, cursor: null })).includes(
      "status=in.(open,in_review,waiting_on_customer)"
    )
  );

  const openReview = await runAction("mark_in_review", "open");
  assert("5. open → in_review", openReview.res.result === "in_review" && openReview.res.status === "in_review");
  assert("6. in_review clears action message and resolved_at", openReview.res.tenant_action_message === null && openReview.res.resolved_at === null);
  assert("7. in_review increments status_version once", openReview.res.status_version === 2 && openReview.db.rpcs.length === 1);
  assert("8. in_review does not patch customer_resolution", openReview.db.rpcs[0].args.p_has_customer_resolution === false);

  const waitingReview = await runAction("mark_in_review", "waiting_on_customer", null, { tenantActionMessage: "Please send the photo." });
  assert("9. waiting → in_review", waitingReview.res.result === "in_review");
  assert("10. leaving waiting clears tenant_action_message", waitingReview.res.tenant_action_message === null);

  const resolvedReview = await runAction("mark_in_review", "resolved", null, { customerResolution: "Fixed on our side." });
  assert("11. resolved → in_review", resolvedReview.res.result === "in_review");
  assert("12. in_review preserves customer_resolution", resolvedReview.res.customer_resolution === "Fixed on our side." && resolvedReview.db.rpcs[0].args.p_has_customer_resolution === false);

  const alreadyReview = await runAction("mark_in_review", "in_review", null, { statusVersion: 4 });
  assert("13. same-state in_review is already_in_review", alreadyReview.res.result === "already_in_review" && alreadyReview.db.rpcs.length === 0);
  assert("14. no-op does not increment", alreadyReview.res.status_version === 4);

  const openWait = await runAction("request_customer_action", "open", { tenant_action_message: "Upload the signed page." });
  assert("15. open → waiting", openWait.res.result === "waiting_on_customer" && openWait.res.status === "waiting_on_customer");
  assert("16. waiting stores sanitized message", openWait.res.tenant_action_message === "Upload the signed page.");
  assert("17. waiting increments version", openWait.res.status_version === 2);

  const reviewWait = await runAction("request_customer_action", "in_review", { tenant_action_message: "Reply with the invoice number." });
  assert("18. in_review → waiting", reviewWait.res.result === "waiting_on_customer");

  assert("19. waiting requires message key", parseUpdateBody({ case_id: CASE_ID, action: "request_customer_action" }).ok === false);
  assert("20. waiting rejects blank message", parseUpdateBody({ case_id: CASE_ID, action: "request_customer_action", tenant_action_message: "   " }).ok === false);
  const sanitized = parseUpdateBody({
    case_id: CASE_ID,
    action: "request_customer_action",
    tenant_action_message: "Email me at owner@example.com please.",
  });
  assert("21. waiting message sanitizes email", sanitized.ok && sanitized.tenant_action_message.includes("[redacted-email]"));
  assert("22. waiting message max 400", parseUpdateBody({ case_id: CASE_ID, action: "request_customer_action", tenant_action_message: "x".repeat(401) }).ok === false);
  assert("23. waiting message 400 allowed", parseUpdateBody({ case_id: CASE_ID, action: "request_customer_action", tenant_action_message: "x".repeat(VISIBLE_TEXT_MAX) }).ok);

  const alreadyWait = await runAction("request_customer_action", "waiting_on_customer", { tenant_action_message: "Another note." }, { tenantActionMessage: "Existing." });
  assert("24. same-state waiting is already_waiting_on_customer", alreadyWait.res.result === "already_waiting_on_customer" && alreadyWait.db.rpcs.length === 0);

  const openResolve = await runAction("resolve", "open");
  assert("25. open → resolved", openResolve.res.result === "resolved" && openResolve.res.status === "resolved");
  const reviewResolve = await runAction("resolve", "in_review");
  assert("26. in_review → resolved", reviewResolve.res.result === "resolved");
  const waitingResolve = await runAction("resolve", "waiting_on_customer", null, { tenantActionMessage: "Need photo." });
  assert("27. waiting → resolved", waitingResolve.res.result === "resolved");
  assert("28. resolve clears waiting message", waitingResolve.res.tenant_action_message === null);
  assert("29. resolve sets resolved_at", waitingResolve.res.resolved_at === NOW);
  assert("30. resolve increments version", waitingResolve.res.status_version === 2);

  const withResolution = parseUpdateBody({
    case_id: CASE_ID,
    action: "resolve",
    customer_resolution: "We restored the quote. Email skip@x.com",
  });
  const dResText = makeDb({ currentStatus: "open" });
  const resolvedText = await updateAdminCase(withResolution, {
    supabaseGet: dResText.supabaseGet,
    supabaseRpc: dResText.supabaseRpc,
    nowIso: () => NOW,
  });
  assert("31. resolution sanitization", withResolution.ok && withResolution.customer_resolution.includes("[redacted-email]"));
  assert("32. resolve stores sanitized resolution", resolvedText.result === "resolved" && String(dResText.rpcs[0].args.p_customer_resolution).includes("[redacted-email]"));
  assert("33. resolution max length", parseUpdateBody({ case_id: CASE_ID, action: "resolve", customer_resolution: "y".repeat(401) }).ok === false);
  assert("34. resolve without resolution omits column", openResolve.db.rpcs[0].args.p_has_customer_resolution === false);

  const dReopen = makeDb({ currentStatus: "resolved", customerResolution: "Last known fix.", statusVersion: 3 });
  const reopened = await updateAdminCase(
    { case_id: CASE_ID, action: "reopen" },
    { supabaseGet: dReopen.supabaseGet, supabaseRpc: dReopen.supabaseRpc, nowIso: () => NOW }
  );
  assert("35. resolved → reopen/open", reopened.result === "reopened" && reopened.status === "open");
  assert("36. reopen clears resolved_at and waiting message", reopened.resolved_at === null && reopened.tenant_action_message === null);
  assert("37. reopen preserves customer_resolution", dReopen.rpcs[0].args.p_has_customer_resolution === false && reopened.customer_resolution === "Last known fix.");
  assert("38. reopen increments version", reopened.status_version === 4);

  const dReturn = makeDb({ currentStatus: "in_review", tenantActionMessage: "old", statusVersion: 5 });
  const returned = await updateAdminCase(
    { case_id: CASE_ID, action: "return_to_open" },
    { supabaseGet: dReturn.supabaseGet, supabaseRpc: dReturn.supabaseRpc, nowIso: () => NOW }
  );
  assert("39. in_review → return_to_open", returned.result === "returned_to_open" && returned.status === "open");
  assert("40. return_to_open clears waiting message and resolved_at", returned.tenant_action_message === null && returned.resolved_at === null);
  assert("41. return_to_open increments version", returned.status_version === 6);

  const invalidWaitResolveReopen = await runAction("reopen", "waiting_on_customer");
  assert("42. invalid transition denied", invalidWaitResolveReopen.res.result === "invalid_transition" && invalidWaitResolveReopen.db.rpcs.length === 0);
  const invalidReturn = await runAction("return_to_open", "waiting_on_customer");
  assert("43. return_to_open from waiting denied", invalidReturn.res.result === "invalid_transition");
  const invalidResolvedWait = await runAction("request_customer_action", "resolved", { tenant_action_message: "Please act." });
  assert("44. request action from resolved denied", invalidResolvedWait.res.result === "invalid_transition");

  assert("45. raw status rejected", parseUpdateBody({ case_id: CASE_ID, action: "resolve", status: "in_review" }).ok === false);
  assert("46. tenant_id rejected", parseUpdateBody({ case_id: CASE_ID, action: "resolve", tenant_id: TENANT_ID }).ok === false);
  assert("47. recipient rejected", parseUpdateBody({ case_id: CASE_ID, action: "resolve", recipient_email: "a@b.com" }).ok === false);
  assert("48. owner_email rejected", parseUpdateBody({ case_id: CASE_ID, action: "resolve", owner_email: "a@b.com" }).ok === false);

  const dOwner = makeDb();
  const ownerRes = await runUpdate(
    fakeEvent("POST", { case_id: CASE_ID, action: "mark_in_review" }),
    dOwner,
    {
      readSessionFromEvent: () => ({ e: "owner@example.com", c: "cus_test", u: OWNER }),
      isPlatformAdmin: async () => false,
    }
  );
  const ownerParsed = parse(ownerRes);
  assert("49. non-admin denied", ownerRes.statusCode === 401 && ownerParsed.result === "not_authorized" && dOwner.rpcs.length === 0);

  const alreadyOpen = await runAction("reopen", "open");
  assert("50. same-state reopen is already_open", alreadyOpen.res.result === "already_open" && alreadyOpen.db.rpcs.length === 0);
  const alreadyResolved = await runAction("resolve", "resolved");
  assert("51. same-state resolve is already_resolved", alreadyResolved.res.result === "already_resolved" && alreadyResolved.db.rpcs.length === 0);
  const alreadyReturn = await runAction("return_to_open", "open");
  assert("52. same-state return_to_open is already_open", alreadyReturn.res.result === "already_open" && alreadyReturn.db.rpcs.length === 0);

  assert("53. no OpenAI", !/openai\.com|OPENAI_API_KEY|getOpenAiKey/i.test(adminApiSrc));
  assert("54. no email", !/nodemailer|sendgrid|mailto|recipient_email|owner_email/i.test(adminApiSrc));
  assert("55. no Zapier", !/zapier/i.test(adminApiSrc + htmlSrc + uiSrc));
  assert("56. no outbox insert", !/tenant_support_notification_outbox/.test(adminApiSrc));
  assert("57. no tenant write endpoint change", !/method:\s*"PATCH"/.test(myCasesSrc + myCasesEndpoint) && /method !== "GET"/.test(myCasesEndpoint));
  assert("58. My Cases remains GET-only tenant read", /UNVERIFIED_COPY/.test(myCasesSrc) && /method !== "GET"/.test(myCasesEndpoint) && !/mark_in_review/.test(myCasesSrc + myCasesEndpoint));
  assert("59. chat not taught new statuses", !/waiting_on_customer|mark_in_review/.test(chatSrc));
  assert("60. UI requires action textarea", /siActionMessageInput/.test(htmlSrc + uiSrc) && /textarea/.test(htmlSrc));
  assert("61. UI shows tenant-visible resolution field", /This text will be visible to the tenant/.test(htmlSrc) && /siResolutionInput/.test(htmlSrc + uiSrc));
  assert("62. snapshot uses textContent", /siActionMessageText/.test(uiSrc) && /textContent/.test(uiSrc));
  assert("63. UI actions by state", /canMarkInReview/.test(uiSrc) && /canRequestAction/.test(uiSrc) && /return_to_open/.test(uiSrc));
  assert("64. no internal_note", !/internal_note/.test(adminApiSrc + htmlSrc + uiSrc));
  assert("65. no tenant_action_required column write", !/tenant_action_required/.test(helperSrc));
  assert("66. browser cannot set status_version", parseUpdateBody({ case_id: CASE_ID, action: "resolve", status_version: 9 }).ok === false);

  assert(
    "67. RPC compare-and-swap uses loaded status+version",
    helperSrc.includes('p_expected_status: current') &&
      helperSrc.includes("p_expected_status_version: version") &&
      /TRANSITION_RPC = "mg_support_transition_case"/.test(helperSrc) &&
      TRANSITION_RPC === "mg_support_transition_case"
  );

  function makeCasDb(initial, freezeGets) {
    const start = {
      id: CASE_ID,
      tenant_id: TENANT_ID,
      status: initial.status || "open",
      status_version: initial.statusVersion == null ? 1 : initial.statusVersion,
      customer_resolution: initial.customerResolution == null ? null : initial.customerResolution,
      tenant_action_message: initial.tenantActionMessage == null ? null : initial.tenantActionMessage,
      resolved_at: initial.resolvedAt == null ? null : initial.resolvedAt,
    };
    const snapshot = { ...start };
    let getCount = 0;
    const store = createTransactionalStore(start, { nowIso: () => NOW });
    async function supabaseGet() {
      getCount += 1;
      const row = freezeGets && getCount <= freezeGets ? snapshot : store.getStored();
      return [
        {
          id: row.id,
          status: row.status,
          status_version: row.status_version,
          customer_resolution: row.customer_resolution,
          tenant_action_message: row.tenant_action_message,
          resolved_at: row.resolved_at,
        },
      ];
    }
    return {
      supabaseGet,
      supabaseRpc: store.supabaseRpc,
      rpcs: store.calls,
      patches: store.patches,
      getStored: store.getStored,
    };
  }

  const raceDb = makeCasDb({ status: "open", statusVersion: 1, tenantActionMessage: "old" }, 2);
  const raceFirst = await updateAdminCase(
    { case_id: CASE_ID, action: "mark_in_review" },
    { supabaseGet: raceDb.supabaseGet, supabaseRpc: raceDb.supabaseRpc, nowIso: () => NOW }
  );
  const raceSecond = await updateAdminCase(
    parseUpdateBody({ case_id: CASE_ID, action: "request_customer_action", tenant_action_message: "Please send the photo." }),
    { supabaseGet: raceDb.supabaseGet, supabaseRpc: raceDb.supabaseRpc, nowIso: () => NOW }
  );
  assert("68. concurrent first request succeeds", raceFirst.result === "in_review" && raceFirst.status_version === 2);
  assert("69. concurrent second request is stale_state", raceSecond.result === "stale_state" && raceSecond.ok === false);
  assert("70. version increments exactly once under race", raceDb.getStored().status_version === 2 && raceDb.rpcs.length === 2);
  assert(
    "71. competing action does not overwrite newer status/message",
    raceDb.getStored().status === "in_review" &&
      raceDb.getStored().tenant_action_message === null &&
      raceSecond.status === "in_review"
  );

  const clickDb = makeCasDb({ status: "open", statusVersion: 3 }, 0);
  const click1 = await updateAdminCase(
    { case_id: CASE_ID, action: "mark_in_review" },
    { supabaseGet: clickDb.supabaseGet, supabaseRpc: clickDb.supabaseRpc, nowIso: () => NOW }
  );
  const click2 = await updateAdminCase(
    { case_id: CASE_ID, action: "mark_in_review" },
    { supabaseGet: clickDb.supabaseGet, supabaseRpc: clickDb.supabaseRpc, nowIso: () => NOW }
  );
  assert(
    "72. sequential double-click is already_in_review",
    click1.result === "in_review" &&
      click2.result === "already_in_review" &&
      clickDb.rpcs.length === 1 &&
      clickDb.getStored().status_version === 4
  );

  const sameRace = makeCasDb({ status: "open", statusVersion: 1 }, 2);
  const same1 = await updateAdminCase(
    { case_id: CASE_ID, action: "resolve" },
    { supabaseGet: sameRace.supabaseGet, supabaseRpc: sameRace.supabaseRpc, nowIso: () => NOW }
  );
  const same2 = await updateAdminCase(
    { case_id: CASE_ID, action: "resolve", has_customer_resolution: true, customer_resolution: "Should not win." },
    { supabaseGet: sameRace.supabaseGet, supabaseRpc: sameRace.supabaseRpc, nowIso: () => NOW }
  );
  assert(
    "73. concurrent same-action second is stale and does not write resolution",
    same1.result === "resolved" &&
      same2.result === "stale_state" &&
      sameRace.getStored().status_version === 2 &&
      sameRace.rpcs[0].args.p_has_customer_resolution !== true &&
      sameRace.getStored().customer_resolution == null
  );

  const dBlankWait = makeDb({ currentStatus: "open" });
  const noWait = await updateAdminCase(
    { case_id: CASE_ID, action: "request_customer_action", tenant_action_message: "   " },
    { supabaseGet: dBlankWait.supabaseGet, supabaseRpc: dBlankWait.supabaseRpc, nowIso: () => NOW }
  );
  assert("74. waiting without valid message is zero RPC", noWait.result === "invalid_request" && dBlankWait.rpcs.length === 0);

  const staleHttpDb = makeCasDb({ status: "open", statusVersion: 1 }, 2);
  await updateAdminCase(
    { case_id: CASE_ID, action: "mark_in_review" },
    { supabaseGet: staleHttpDb.supabaseGet, supabaseRpc: staleHttpDb.supabaseRpc, nowIso: () => NOW }
  );
  const staleHttp = await runUpdate(
    fakeEvent("POST", { case_id: CASE_ID, action: "resolve", customer_resolution: "Lost update?" }),
    staleHttpDb
  );
  const staleHttpBody = parse(staleHttp);
  assert(
    "75. stale_state HTTP is 409 and does not claim success",
    staleHttp.statusCode === 409 &&
      staleHttpBody.result === "stale_state" &&
      staleHttpBody.ok === false &&
      staleHttpDb.getStored().status === "in_review" &&
      staleHttpDb.getStored().customer_resolution == null
  );

  console.log("");
  console.log(passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
