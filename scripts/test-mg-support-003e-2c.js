#!/usr/bin/env node
/**
 * MG-SUPPORT-003E.2C — tenant My Cases four-state + Waiting on You + resolution
 * (mocked session, Supabase, and OpenAI). Usage: node scripts/test-mg-support-003e-2c.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const { createHandler: createChatHandler } = require("../netlify/functions/mg-support-chat");
const { createHandler: createMyCasesHandler } = require("../netlify/functions/mg-support-my-cases");
const {
  CASE_SELECT,
  OPEN_COPY,
  IN_REVIEW_COPY,
  WAITING_COPY,
  RESOLVED_COPY,
  UNVERIFIED_COPY,
  mapStatus,
  toListItem,
  toDetail,
  myCasesChatAnswer,
  parseCaseRef,
} = require("../netlify/functions/_lib/mg-support/my-cases");
const { parseUpdateBody, updateAdminCase } = require("../netlify/functions/_lib/mg-support/admin-cases");
const { createStatelessRpc } = require("./_lib/mg-support-transition-rpc-sim");
const { sanitizeExcerpt } = require("../netlify/functions/_lib/mg-support/case-intake");
const ui = require("../public/js/mg-support-chat.js");

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

function openaiOkFetch(capture) {
  return async (url, opts) => {
    if (capture) {
      capture.calls = (capture.calls || 0) + 1;
      capture.url = url;
      capture.payload = JSON.parse(opts.body || "{}");
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ output_text: "Docs answer.", usage: { input_tokens: 5, output_tokens: 4 } }),
    };
  };
}

const OWN_TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "22222222-2222-4222-8222-222222222222";
const OPEN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REVIEW_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WAIT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const RESOLVED_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const OPEN_REF = "MG-SUP-" + OPEN_ID;
const REVIEW_REF = "MG-SUP-" + REVIEW_ID;
const WAIT_REF = "MG-SUP-" + WAIT_ID;
const RESOLVED_REF = "MG-SUP-" + RESOLVED_ID;
const ACTION_MSG = "Please upload the signed page photo.";
const RESOLUTION = "We restored the missing quote line.";

function sessionOk() {
  return { e: "owner@example.com", c: "cus_test" };
}

function caseRow(overrides) {
  return {
    id: OPEN_ID,
    tenant_id: OWN_TENANT,
    status: "open",
    category: "unresolved_question",
    subject: "Support question needs review",
    question_excerpt: "Need help with an invoice status question",
    support_module: "invoice_hub",
    related_entity_type: "invoice",
    related_entity_ref: "INV-100",
    created_at: "2026-08-20T12:00:00.000Z",
    updated_at: "2026-08-21T12:00:00.000Z",
    resolved_at: null,
    customer_resolution: null,
    tenant_action_message: null,
    status_version: 1,
    created_by_user_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    issue_fingerprint: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    idempotency_key: "idem-secret-should-never-return",
    internal_note: "never expose this",
    ...overrides,
  };
}

function makeGetDb(rows) {
  return {
    supabaseGet: async () => (Array.isArray(rows) ? rows : []),
  };
}

function myCasesDeps(rows) {
  return {
    readSessionFromEvent: () => sessionOk(),
    assertOwnerSupportSession: async () => ({ ok: true }),
    resolveTenantFromSession: async () => ({ id: OWN_TENANT }),
    supabaseGet: async () => (Array.isArray(rows) ? rows : []),
  };
}

async function runChat(message, rows) {
  const capture = {};
  const handler = createChatHandler({
    readSessionFromEvent: () => sessionOk(),
    assertOwnerSupportSession: async () => ({ ok: true }),
    resolveTenantFromSession: async () => ({ id: OWN_TENANT }),
    supabaseGet: async () => (Array.isArray(rows) ? rows : []),
    fetch: openaiOkFetch(capture),
    getOpenAiKey: () => "sk-test",
    nowMs: () => Date.parse("2026-08-28T18:00:00.000Z"),
  });
  const res = await handler({
    httpMethod: "POST",
    headers: {},
    body: JSON.stringify({ message, page: "/dashboard" }),
  });
  return { res, body: parse(res), capture };
}

async function runMyCases(query, rows) {
  const handler = createMyCasesHandler(myCasesDeps(rows));
  const res = await handler({
    httpMethod: "GET",
    headers: {},
    queryStringParameters: query || {},
    body: "",
  });
  return { res, body: parse(res) };
}

function jsonHas(obj, needles) {
  const blob = JSON.stringify(obj || {});
  return needles.some((n) => blob.includes(String(n)));
}

async function main() {
  const helperSrc = read("netlify/functions/_lib/mg-support/my-cases.js");
  const endpointSrc = read("netlify/functions/mg-support-my-cases.js");
  const chatSrc = read("netlify/functions/mg-support-chat.js");
  const uiSrc = read("public/js/mg-support-chat.js");
  const cardFn = uiSrc.slice(uiSrc.indexOf("function renderCaseCard"), uiSrc.indexOf("function renderCaseDetail"));
  const detailFn = uiSrc.slice(uiSrc.indexOf("function renderCaseDetail"), uiSrc.indexOf("function renderCasesPanel"));
  const casesUi = cardFn + detailFn;

  const open = mapStatus("open");
  const review = mapStatus("in_review");
  const waiting = mapStatus("waiting_on_customer");
  const resolved = mapStatus("resolved");
  const unknown = mapStatus("pending");
  assert("1. open maps Open", open.status === "open" && open.status_label === "Open");
  assert("2. in_review maps In Review", review.status === "in_review" && review.status_label === "In Review");
  assert("3. waiting maps Waiting on You", waiting.status === "waiting_on_customer" && waiting.status_label === "Waiting on You");
  assert("4. resolved maps Resolved", resolved.status === "resolved" && resolved.status_label === "Resolved");
  assert("5. unknown remains conservative", unknown.status === "unverified" && unknown.status_copy === UNVERIFIED_COPY);

  const waitDet = toDetail(caseRow({ status: "waiting_on_customer", tenant_action_message: ACTION_MSG }));
  const openDet = toDetail(caseRow({ tenant_action_message: ACTION_MSG, customer_resolution: RESOLUTION }));
  const reviewDet = toDetail(
    caseRow({ status: "in_review", tenant_action_message: ACTION_MSG, customer_resolution: RESOLUTION })
  );
  const resolvedDet = toDetail(
    caseRow({
      status: "resolved",
      customer_resolution: RESOLUTION,
      tenant_action_message: ACTION_MSG,
      resolved_at: "2026-08-22T12:00:00.000Z",
    })
  );
  const resolvedNull = toDetail(caseRow({ status: "resolved", customer_resolution: null }));
  assert("6. waiting derives tenant_action_required true", waitDet.tenant_action_required === true);
  assert(
    "7. other states derive false",
    openDet.tenant_action_required === false &&
      reviewDet.tenant_action_required === false &&
      resolvedDet.tenant_action_required === false
  );
  assert("8. waiting message returned only while waiting", waitDet.tenant_action_message === ACTION_MSG);
  assert("9. waiting message hidden in open", openDet.tenant_action_message === null);
  assert("10. waiting message hidden in_review", reviewDet.tenant_action_message === null);
  assert("11. waiting message hidden resolved", resolvedDet.tenant_action_message === null);
  assert("12. resolved resolution visible", resolvedDet.customer_resolution === RESOLUTION);
  assert("13. resolved null resolution does not invent", resolvedNull.customer_resolution === null && resolvedNull.status_copy === RESOLVED_COPY);

  const reopened = toDetail(caseRow({ status: "open", customer_resolution: RESOLUTION }));
  const reviewAfterResolve = toDetail(caseRow({ status: "in_review", customer_resolution: RESOLUTION }));
  const waitingAfterResolve = toDetail(
    caseRow({ status: "waiting_on_customer", customer_resolution: RESOLUTION, tenant_action_message: ACTION_MSG })
  );
  assert("14. reopened open hides prior resolution", reopened.customer_resolution === null && reopened.status_label === "Open");
  assert("15. in_review after resolved hides prior resolution", reviewAfterResolve.customer_resolution === null);
  assert("16. waiting after prior resolved hides prior resolution", waitingAfterResolve.customer_resolution === null);

  const listRows = [
    caseRow(),
    caseRow({ id: REVIEW_ID, status: "in_review" }),
    caseRow({
      id: WAIT_ID,
      status: "waiting_on_customer",
      tenant_action_message: ACTION_MSG,
      customer_resolution: RESOLUTION,
    }),
    caseRow({
      id: RESOLVED_ID,
      status: "resolved",
      customer_resolution: RESOLUTION,
      resolved_at: "2026-08-22T12:00:00.000Z",
    }),
  ];
  const listed = await runMyCases({}, listRows);
  const labels = listed.body.cases.map((row) => row.status_label).sort().join(",");
  assert(
    "17. list includes all four labels",
    labels === "In Review,Open,Resolved,Waiting on You" && listed.body.cases.length === 4
  );
  assert("18. list does not leak action messages", !jsonHas(listed.body, [ACTION_MSG, "tenant_action_message"]));
  assert("19. list does not leak resolution text", !jsonHas(listed.body, [RESOLUTION, "customer_resolution"]));

  const chatOpen = await runChat("is case " + OPEN_REF + " resolved", [caseRow()]);
  const chatReview = await runChat("what happened with case " + REVIEW_REF, [
    caseRow({ id: REVIEW_ID, status: "in_review" }),
  ]);
  const chatWait = await runChat("what happened with case " + WAIT_REF, [
    caseRow({ id: WAIT_ID, status: "waiting_on_customer", tenant_action_message: ACTION_MSG }),
  ]);
  const chatResolved = await runChat("did support resolve case " + RESOLVED_REF, [
    caseRow({
      id: RESOLVED_ID,
      status: "resolved",
      customer_resolution: RESOLUTION,
      resolved_at: "2026-08-22T12:00:00.000Z",
    }),
  ]);
  const chatList = await runChat("show my support cases", listRows);
  const chatResolvedNull = await runChat("did support resolve case " + RESOLVED_REF, [
    caseRow({ id: RESOLVED_ID, status: "resolved", customer_resolution: null }),
  ]);
  const chatWaitMalformed = await runChat("what happened with case " + WAIT_REF, [
    caseRow({ id: WAIT_ID, status: "waiting_on_customer", tenant_action_message: "   " }),
  ]);

  assert("20. exact open chat 0 OpenAI", chatOpen.body.answer === OPEN_COPY && !chatOpen.capture.url);
  assert("21. exact in_review chat 0 OpenAI", chatReview.body.answer === IN_REVIEW_COPY && !chatReview.capture.url);
  assert("22. exact waiting chat 0 OpenAI", chatWait.body.answer.indexOf(WAITING_COPY) === 0 && !chatWait.capture.url);
  assert("23. exact resolved chat 0 OpenAI", chatResolved.body.answer.indexOf(RESOLVED_COPY) === 0 && !chatResolved.capture.url);
  assert(
    "24. list chat 0 OpenAI",
    chatList.body.answer.indexOf("You have 4 support cases:") === 0 &&
      chatList.body.answer.indexOf("Waiting on You") !== -1 &&
      chatList.body.answer.indexOf("In Review") !== -1 &&
      !chatList.capture.url &&
      chatList.body.sources.join(",") === "My Cases"
  );
  assert("25. waiting chat includes safe action message", chatWait.body.answer.indexOf("What we need from you: " + ACTION_MSG) !== -1);
  assert("26. resolved chat includes safe resolution", chatResolved.body.answer.indexOf("Resolution: " + RESOLUTION) !== -1);
  assert(
    "27. missing resolution does not trigger OpenAI",
    chatResolvedNull.body.answer === RESOLVED_COPY &&
      chatResolvedNull.body.answer.indexOf("Resolution:") === -1 &&
      !chatResolvedNull.capture.url
  );
  assert(
    "28. malformed waiting is conservative",
    chatWaitMalformed.body.answer === WAITING_COPY &&
      chatWaitMalformed.body.answer.indexOf("What we need from you") === -1 &&
      !chatWaitMalformed.capture.url
  );

  const xssAction = toDetail(
    caseRow({
      status: "waiting_on_customer",
      tenant_action_message: "<img src=x onerror=alert(1)> Please send photo",
    })
  );
  const xssResolution = toDetail(
    caseRow({
      status: "resolved",
      customer_resolution: "<script>alert(1)</script>We fixed it",
    })
  );
  assert(
    "29. XSS action text inert",
    xssAction.tenant_action_message === sanitizeExcerpt("<img src=x onerror=alert(1)> Please send photo") &&
      !/</.test(String(xssAction.tenant_action_message || "")) &&
      /createTextNode/.test(casesUi + uiSrc) &&
      /What we need from you/.test(detailFn)
  );
  assert(
    "30. XSS resolution inert",
    xssResolution.customer_resolution === sanitizeExcerpt("<script>alert(1)</script>We fixed it") &&
      !/<script/i.test(String(xssResolution.customer_resolution || "")) &&
      /"Resolution"/.test(detailFn)
  );

  const detWaitHttp = await runMyCases({ case_ref: WAIT_REF }, [
    caseRow({ id: WAIT_ID, status: "waiting_on_customer", tenant_action_message: ACTION_MSG }),
  ]);
  assert("31. internal id not exposed", !("id" in detWaitHttp.body.case) && !("created_by_user_id" in detWaitHttp.body.case));
  assert("32. tenant_id not exposed", !("tenant_id" in detWaitHttp.body.case) && !jsonHas(detWaitHttp.body, [OWN_TENANT]));
  assert("33. status_version not exposed", !("status_version" in detWaitHttp.body.case) && !/status_version/.test(CASE_SELECT));
  assert("34. no future internal note exposed", !("internal_note" in detWaitHttp.body.case) && !/internal_note/.test(CASE_SELECT + JSON.stringify(detWaitHttp.body)));

  const other = await runMyCases({ case_ref: WAIT_REF }, [caseRow({ id: WAIT_ID, tenant_id: OTHER_TENANT })]);
  assert("35. other-tenant ref not_found", other.res.statusCode === 404 && other.body.result === "not_found");
  const browserTenant = await createMyCasesHandler(myCasesDeps([caseRow()]))({
    httpMethod: "GET",
    headers: {},
    queryStringParameters: { tenant_id: OTHER_TENANT },
    body: "",
  });
  assert("36. browser tenant rejected", parse(browserTenant).result === "invalid_request" && browserTenant.statusCode === 400);
  assert("37. business_id absent", !/business_id/.test(helperSrc + endpointSrc));
  const posted = await createMyCasesHandler(myCasesDeps([caseRow()]))({
    httpMethod: "POST",
    headers: {},
    body: JSON.stringify({ action: "resolve", case_id: OPEN_ID }),
  });
  assert("38. My Cases GET only", posted.statusCode === 405);
  assert("39. no case mutation", !/method:\s*"PATCH"|method:\s*"POST"|method:\s*"DELETE"/.test(helperSrc + endpointSrc));
  assert("40. no outbox insert", !/tenant_support_notification_outbox/.test(helperSrc + endpointSrc + chatSrc));
  assert("41. no email", !/nodemailer|sendgrid|mailto|recipient_email/.test(helperSrc + endpointSrc));
  assert("42. no Zapier", !/zapier/i.test(helperSrc + endpointSrc + chatSrc));

  const adminDb = {
    supabaseGet: async () => [
      {
        id: OPEN_ID,
        status: "open",
        status_version: 1,
        customer_resolution: null,
        tenant_action_message: null,
        resolved_at: null,
      },
    ],
    patches: [],
    ...createStatelessRpc({ currentStatus: "open", statusVersion: 1, nowIso: () => "2026-08-28T23:00:00.000Z" }),
  };
  const marked = await updateAdminCase(parseUpdateBody({ case_id: OPEN_ID, action: "mark_in_review" }), {
    supabaseGet: adminDb.supabaseGet,
    supabaseRpc: adminDb.supabaseRpc,
    nowIso: () => "2026-08-28T23:00:00.000Z",
  });
  const tenantAfterReview = toDetail(caseRow({ status: marked.status }));
  assert("43a. Admin open → in_review tenant sees In Review", marked.status === "in_review" && tenantAfterReview.status_label === "In Review");

  const waitAdmin = {
    supabaseGet: async () => [
      {
        id: OPEN_ID,
        status: "in_review",
        status_version: 2,
        customer_resolution: RESOLUTION,
        tenant_action_message: null,
        resolved_at: null,
      },
    ],
    patches: [],
    ...createStatelessRpc({
      currentStatus: "in_review",
      statusVersion: 2,
      customerResolution: RESOLUTION,
      nowIso: () => "2026-08-28T23:01:00.000Z",
    }),
  };
  const requested = await updateAdminCase(
    parseUpdateBody({
      case_id: OPEN_ID,
      action: "request_customer_action",
      tenant_action_message: ACTION_MSG,
    }),
    {
      supabaseGet: waitAdmin.supabaseGet,
      supabaseRpc: waitAdmin.supabaseRpc,
      nowIso: () => "2026-08-28T23:01:00.000Z",
    }
  );
  const tenantWaiting = toDetail(
    caseRow({
      status: requested.status,
      tenant_action_message: requested.tenant_action_message,
      customer_resolution: RESOLUTION,
    })
  );
  assert(
    "43b. Admin waiting tenant sees Waiting on You + exact message",
    requested.status === "waiting_on_customer" &&
      tenantWaiting.status_label === "Waiting on You" &&
      tenantWaiting.tenant_action_message === ACTION_MSG &&
      tenantWaiting.customer_resolution === null
  );

  const resolveAdmin = {
    supabaseGet: async () => [
      {
        id: OPEN_ID,
        status: "waiting_on_customer",
        status_version: 3,
        customer_resolution: null,
        tenant_action_message: ACTION_MSG,
        resolved_at: null,
      },
    ],
    patches: [],
    ...createStatelessRpc({
      currentStatus: "waiting_on_customer",
      statusVersion: 3,
      tenantActionMessage: ACTION_MSG,
      nowIso: () => "2026-08-28T23:02:00.000Z",
    }),
  };
  const adminResolved = await updateAdminCase(
    parseUpdateBody({
      case_id: OPEN_ID,
      action: "resolve",
      customer_resolution: RESOLUTION,
    }),
    {
      supabaseGet: resolveAdmin.supabaseGet,
      supabaseRpc: resolveAdmin.supabaseRpc,
      nowIso: () => "2026-08-28T23:02:00.000Z",
    }
  );
  const tenantResolved = toDetail(
    caseRow({
      status: adminResolved.status,
      customer_resolution: adminResolved.customer_resolution,
      tenant_action_message: ACTION_MSG,
    })
  );
  assert(
    "43c. Admin resolve tenant sees Resolved + resolution",
    adminResolved.status === "resolved" &&
      tenantResolved.status_label === "Resolved" &&
      tenantResolved.customer_resolution === RESOLUTION
  );

  const reopenAdmin = {
    supabaseGet: async () => [
      {
        id: OPEN_ID,
        status: "resolved",
        status_version: 4,
        customer_resolution: RESOLUTION,
        tenant_action_message: null,
        resolved_at: "2026-08-28T23:02:00.000Z",
      },
    ],
    patches: [],
    ...createStatelessRpc({
      currentStatus: "resolved",
      statusVersion: 4,
      customerResolution: RESOLUTION,
      nowIso: () => "2026-08-28T23:03:00.000Z",
    }),
  };
  const adminReopened = await updateAdminCase({ case_id: OPEN_ID, action: "reopen" }, {
    supabaseGet: reopenAdmin.supabaseGet,
    supabaseRpc: reopenAdmin.supabaseRpc,
    nowIso: () => "2026-08-28T23:03:00.000Z",
  });
  const tenantReopened = toDetail(
    caseRow({
      status: adminReopened.status,
      customer_resolution: RESOLUTION,
    })
  );
  assert(
    "43d. Admin reopen tenant sees Open and hides old resolution",
    adminReopened.status === "open" &&
      reopenAdmin.rpcs[0].args.p_has_customer_resolution === false &&
      tenantReopened.status_label === "Open" &&
      tenantReopened.customer_resolution === null
  );

  assert("44. E1 open/resolved copy unchanged", open.status_copy === OPEN_COPY && resolved.status_copy === RESOLVED_COPY);
  assert("45. invoice resend still separate", /maybeOfferInvoiceResend/.test(chatSrc));
  assert("46. D1 diagnostics still separate", /device_pairing_diagnostic/.test(read("netlify/functions/_lib/mg-support/router.js")));

  const knownChats = [chatOpen, chatReview, chatWait, chatResolved, chatList, chatResolvedNull, chatWaitMalformed];
  assert("47. known chat OpenAI calls = 0", knownChats.every((row) => !row.capture.url && (row.capture.calls || 0) === 0));
  assert(
    "48. case rows not sent to OpenAI",
    knownChats.every((row) => !row.capture.payload || !jsonHas(row.capture.payload, [ACTION_MSG, RESOLUTION, "question_excerpt"]))
  );
  assert("49. no invented action", openDet.tenant_action_message === null && resolvedDet.tenant_action_message === null);
  assert("50. no invented resolution", openDet.customer_resolution === null && resolvedNull.customer_resolution === null);
  assert("51. list fields omit snapshots", !("tenant_action_required" in listed.body.cases[0]) && !("status_copy" in listed.body.cases[0]));
  assert("52. safe DOM rendering", /createTextNode/.test(uiSrc) && !/innerHTML/.test(casesUi) && !/\bhref\b/.test(casesUi));
  assert("53. waiting card uses visible text not color-only", /waiting_on_customer/.test(cardFn) && /MG_SUPPORT_WAITING_COPY/.test(cardFn) && ui.WAITING_COPY === WAITING_COPY);
  assert("54. source label is My Cases only", chatList.body.sources.length === 1 && chatList.body.sources[0] === "My Cases");
  assert("55. GET-only My Cases endpoint", /method !== "GET"/.test(endpointSrc));
  assert("56. no model tenant", !/body\.tenant_id/.test(endpointSrc + chatSrc));
  void makeGetDb;

  console.log("");
  console.log(passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
