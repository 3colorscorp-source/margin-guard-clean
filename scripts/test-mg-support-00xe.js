#!/usr/bin/env node
/**
 * MG-SUPPORT-003E.1 — owner My Cases read-only self-service
 * (mocked session, Supabase, and OpenAI). Usage: node scripts/test-mg-support-00xe.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const { classifySupportIntent } = require("../netlify/functions/_lib/mg-support/router");
const { createHandler: createChatHandler } = require("../netlify/functions/mg-support-chat");
const { createHandler: createMyCasesHandler } = require("../netlify/functions/mg-support-my-cases");
const { isMyCasesQuestion } = require("../netlify/functions/_lib/mg-support/my-cases-intent");
const {
  CASE_SELECT,
  LIST_LIMIT,
  OPEN_COPY,
  IN_REVIEW_COPY,
  WAITING_COPY,
  RESOLVED_COPY,
  UNVERIFIED_COPY,
  ZERO_CASES_COPY,
  NOT_FOUND_COPY,
  parseCaseRef,
  mapStatus,
  toListItem,
  toDetail,
  parseMyCasesQuery,
  buildListPath,
  buildDetailPath,
  readMyCasesList,
  readMyCasesDetail,
  myCasesChatAnswer,
} = require("../netlify/functions/_lib/mg-support/my-cases");
const { formatCaseRef } = require("../netlify/functions/_lib/mg-support/case-intake");
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
      text: async () =>
        JSON.stringify({
          output_text: "Docs answer.",
          usage: { input_tokens: 5, output_tokens: 4 },
        }),
    };
  };
}

const OWN_TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "22222222-2222-4222-8222-222222222222";
const OPEN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RESOLVED_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const USER_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const OPEN_REF = "MG-SUP-" + OPEN_ID;
const RESOLVED_REF = "MG-SUP-" + RESOLVED_ID;
const OTHER_REF = "MG-SUP-" + OTHER_ID;
const NOW_MS = Date.parse("2026-08-28T18:00:00.000Z");

const LIST_KEYS = [
  "case_ref",
  "category_label",
  "created_at",
  "related_entity_ref",
  "related_entity_type",
  "resolved_at",
  "status",
  "status_label",
  "subject",
  "updated_at",
];
const DETAIL_KEYS = LIST_KEYS.concat([
  "customer_resolution",
  "question_excerpt",
  "status_copy",
  "support_module_label",
  "tenant_action_message",
  "tenant_action_required",
]).sort();

function sessionOk() {
  return { e: "owner@example.com", c: "cus_test" };
}

function fakeGet(query, headers) {
  return {
    httpMethod: "GET",
    headers: headers || {},
    queryStringParameters: query || {},
    body: "",
  };
}

function fakePost(bodyObj) {
  return {
    httpMethod: "POST",
    headers: {},
    body: bodyObj == null ? "" : JSON.stringify(bodyObj),
  };
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
    created_by_user_id: USER_ID,
    issue_fingerprint: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    idempotency_key: "idem-secret-should-never-return",
    ...overrides,
  };
}

function jsonHas(obj, needles) {
  const blob = JSON.stringify(obj || {});
  return needles.some((n) => blob.includes(String(n)));
}

function keysOf(obj) {
  return Object.keys(obj || {}).sort();
}

function sameKeys(obj, expected) {
  const got = keysOf(obj);
  const want = expected.slice().sort();
  return got.length === want.length && got.every((k, i) => k === want[i]);
}

function decodePath(raw) {
  try {
    return decodeURIComponent(String(raw || ""));
  } catch (_err) {
    return String(raw || "");
  }
}

function makeDb(rows) {
  const gets = [];
  const writes = { patch: 0, post: 0, insert: 0, delete: 0, other: 0 };
  return {
    gets,
    writes,
    supabaseGet: async (rawPath) => {
      const p = String(rawPath || "");
      gets.push(p);
      if (typeof rows === "function") return rows(p);
      return Array.isArray(rows) ? rows : [];
    },
    supabaseRequest: async (rawPath, opts) => {
      const method = String(opts?.method || "GET").toUpperCase();
      if (method === "PATCH") writes.patch += 1;
      if (method === "POST") writes.post += 1;
      if (method === "PUT" || method === "INSERT") writes.insert += 1;
      if (method === "DELETE") writes.delete += 1;
      if (method !== "GET") {
        writes.other += 1;
        throw new Error("unexpected write " + method);
      }
      const p = String(rawPath || "");
      gets.push(p);
      if (typeof rows === "function") return rows(p);
      return Array.isArray(rows) ? rows : [];
    },
  };
}

function myCasesDeps(db, extra) {
  return {
    readSessionFromEvent: extra && extra.session ? extra.session : sessionOk,
    assertOwnerSupportSession:
      extra && extra.assertOwnerSupportSession
        ? extra.assertOwnerSupportSession
        : async () => ({ ok: true }),
    resolveTenantFromSession:
      extra && extra.resolveTenantFromSession
        ? extra.resolveTenantFromSession
        : async () => ({ id: OWN_TENANT }),
    supabaseGet: db.supabaseGet,
    supabaseRequest: db.supabaseRequest,
    ...(extra || {}),
  };
}

async function runMyCases(query, db, extra) {
  extra = extra || {};
  const event = fakeGet(query, extra.headers);
  if (extra.body != null) {
    event.body = typeof extra.body === "string" ? extra.body : JSON.stringify(extra.body);
  }
  const res = await createMyCasesHandler(myCasesDeps(db, extra))(event);
  return { res, body: parse(res), gets: db.gets, writes: db.writes };
}

async function runChat(message, db, extra) {
  extra = extra || {};
  const capture = extra.capture || {};
  const res = await createChatHandler({
    readSessionFromEvent: extra.session || sessionOk,
    resolveTenantFromSession: extra.resolveTenant || (async () => ({ id: OWN_TENANT })),
    getOpenAiKey: extra.getOpenAiKey || (() => "test-key"),
    getSessionSecret: extra.getSessionSecret || (() => "test-secret-value-32chars-minimum!!"),
    nowMs: extra.nowMs || (() => NOW_MS),
    supabaseGet: async (p) => db.supabaseGet(p),
    supabaseRequest: db.supabaseRequest,
    fetch: extra.fetch || openaiOkFetch(capture),
    ...(extra.deps || {}),
  })(
    fakePost({
      message,
      page: extra.page || "/dashboard",
      tenant_id: extra.bodyTenant,
      business_id: extra.businessId,
    })
  );
  return { res, body: parse(res), capture, writes: db.writes, gets: db.gets };
}

function srcBlob() {
  return [
    read("netlify/functions/mg-support-my-cases.js"),
    read("netlify/functions/_lib/mg-support/my-cases.js"),
    read("netlify/functions/_lib/mg-support/my-cases-intent.js"),
  ].join("\n");
}

async function main() {
  const endpointSrc = read("netlify/functions/mg-support-my-cases.js");
  const helperSrc = read("netlify/functions/_lib/mg-support/my-cases.js");
  const intentSrc = read("netlify/functions/_lib/mg-support/my-cases-intent.js");
  const chatSrc = read("netlify/functions/mg-support-chat.js");
  const uiSrc = read("public/js/mg-support-chat.js");
  const routerSrc = read("netlify/functions/_lib/mg-support/router.js");
  const createCaseSrc = read("netlify/functions/mg-support-create-case.js");
  const adminListSrc = read("netlify/functions/mg-support-admin-list-cases.js");
  const adminUpdateSrc = read("netlify/functions/mg-support-admin-update-case.js");
  const adminHelperSrc = read("netlify/functions/_lib/mg-support/admin-cases.js");
  const resendSrc = read("netlify/functions/_lib/mg-support/invoice-resend-offer.js");
  const supervisorSrc = read("netlify/functions/_lib/mg-support/supervisor-visibility-conclusion.js");
  const deviceIntentSrc = read("netlify/functions/_lib/mg-support/device-pairing-intent.js");
  const depositIntentSrc = read("netlify/functions/_lib/mg-support/deposit-cta-intent.js");
  const e1Src = endpointSrc + "\n" + helperSrc + "\n" + intentSrc + "\n" + chatSrc + "\n" + uiSrc;

  const dUnauth = makeDb([caseRow()]);
  const unauth = await runMyCases({}, dUnauth, {
    assertOwnerSupportSession: async () => ({ ok: false }),
  });
  assert(
    "1. unauthenticated denied",
    unauth.res.statusCode === 401 &&
      unauth.body.ok === false &&
      dUnauth.gets.length === 0
  );

  const dZero = makeDb([]);
  const zero = await runMyCases({}, dZero);
  assert(
    "2. tenant zero cases",
    zero.res.statusCode === 200 &&
      zero.body.ok === true &&
      Array.isArray(zero.body.cases) &&
      zero.body.cases.length === 0
  );

  const dOpen = makeDb([caseRow()]);
  const oneOpen = await runMyCases({}, dOpen);
  assert(
    "3. one open case",
    oneOpen.res.statusCode === 200 &&
      oneOpen.body.cases.length === 1 &&
      oneOpen.body.cases[0].status === "open" &&
      oneOpen.body.cases[0].status_label === "Open" &&
      oneOpen.body.cases[0].case_ref === OPEN_REF
  );

  const dResolved = makeDb([
    caseRow({
      id: RESOLVED_ID,
      status: "resolved",
      resolved_at: "2026-08-22T12:00:00.000Z",
    }),
  ]);
  const oneResolved = await runMyCases({}, dResolved);
  assert(
    "4. one resolved case",
    oneResolved.body.cases.length === 1 &&
      oneResolved.body.cases[0].status === "resolved" &&
      oneResolved.body.cases[0].status_label === "Resolved" &&
      oneResolved.body.cases[0].case_ref === RESOLVED_REF
  );

  const newer = caseRow({
    id: RESOLVED_ID,
    created_at: "2026-08-24T12:00:00.000Z",
    status: "resolved",
  });
  const older = caseRow({ created_at: "2026-08-10T12:00:00.000Z" });
  const dOrder = makeDb([newer, older]);
  const ordered = await runMyCases({}, dOrder);
  const listPath = decodePath(dOrder.gets[0] || "");
  assert(
    "5. multiple cases newest first",
    ordered.body.cases[0].case_ref === RESOLVED_REF &&
      ordered.body.cases[1].case_ref === OPEN_REF &&
      /order=created_at\.desc/.test(listPath)
  );

  const many = [];
  for (let i = 0; i < 30; i += 1) {
    const id = "eeeeeeee-eeee-4eee-8eee-" + String(i).padStart(12, "0");
    many.push(caseRow({ id, created_at: "2026-08-" + String((i % 27) + 1).padStart(2, "0") + "T12:00:00.000Z" }));
  }
  const dMax = makeDb(many);
  const capped = await runMyCases({}, dMax);
  assert(
    "6. max list limit enforced",
    LIST_LIMIT === 25 &&
      capped.body.cases.length === 25 &&
      /limit=25/.test(decodePath(dMax.gets[0] || ""))
  );

  const dDetOpen = makeDb([caseRow()]);
  const detOpen = await runMyCases({ case_ref: OPEN_REF }, dDetOpen);
  assert(
    "7. exact canonical case ref open",
    detOpen.res.statusCode === 200 &&
      detOpen.body.ok === true &&
      detOpen.body.case.case_ref === OPEN_REF &&
      detOpen.body.case.status === "open" &&
      detOpen.body.case.status_copy === OPEN_COPY
  );

  const dDetRes = makeDb([
    caseRow({
      id: RESOLVED_ID,
      status: "resolved",
      resolved_at: "2026-08-22T12:00:00.000Z",
    }),
  ]);
  const detRes = await runMyCases({ case_ref: RESOLVED_REF }, dDetRes);
  assert(
    "8. exact canonical case ref resolved",
    detRes.body.case.case_ref === RESOLVED_REF &&
      detRes.body.case.status === "resolved" &&
      detRes.body.case.status_copy === RESOLVED_COPY
  );

  const dBad = makeDb([caseRow()]);
  const malformed = await runMyCases({ case_ref: "MG-SUP-not-a-uuid" }, dBad);
  assert(
    "9. malformed case ref",
    (malformed.res.statusCode === 400 || malformed.res.statusCode === 404) &&
      malformed.body.ok === false &&
      dBad.gets.length === 0
  );

  const dBare = makeDb([caseRow()]);
  const bare = await runMyCases({ case_ref: OPEN_ID }, dBare);
  assert(
    "10. bare UUID rejected",
    parseCaseRef(OPEN_ID) === null &&
      (bare.res.statusCode === 400 || bare.res.statusCode === 404) &&
      bare.body.ok === false &&
      dBare.gets.length === 0
  );

  const dOtherDet = makeDb([]);
  const otherDet = await runMyCases({ case_ref: OTHER_REF }, dOtherDet);
  const otherPath = decodePath(dOtherDet.gets[0] || "");
  assert(
    "11. other-tenant exact ref → not_found",
    otherDet.res.statusCode === 404 &&
      otherDet.body.result === "not_found" &&
      !/another tenant|other tenant|does not belong/i.test(JSON.stringify(otherDet.body)) &&
      otherPath.includes("tenant_id=eq." + OWN_TENANT) &&
      otherPath.includes("id=eq." + OTHER_ID)
  );

  const dMixed = makeDb([caseRow(), caseRow({ id: OTHER_ID, tenant_id: OTHER_TENANT })]);
  const mixed = await runMyCases({}, dMixed);
  assert(
    "12. other-tenant row excluded from list",
    mixed.body.cases.length === 1 &&
      mixed.body.cases[0].case_ref === OPEN_REF &&
      !jsonHas(mixed.body, [OTHER_TENANT, OTHER_ID, OTHER_REF])
  );

  const dTenantQ = makeDb([caseRow()]);
  const tenantQ = await runMyCases({ tenant_id: OTHER_TENANT }, dTenantQ);
  assert(
    "13. tenant_id query ignored/rejected",
    tenantQ.res.statusCode === 400 &&
      tenantQ.body.ok === false &&
      dTenantQ.gets.length === 0
  );

  const dBiz = makeDb([caseRow()]);
  const bizQ = await runMyCases({ business_id: OTHER_TENANT }, dBiz);
  const bizBody = await runMyCases({}, makeDb([caseRow()]), {
    resolveTenantFromSession: async (session) => {
      if (session && session.business_id) throw new Error("used business_id");
      return { id: OWN_TENANT };
    },
  });
  assert(
    "14. business_id not used",
    bizQ.res.statusCode === 400 &&
      dBiz.gets.length === 0 &&
      bizBody.body.ok === true &&
      !/business_id/.test(helperSrc + endpointSrc)
  );

  const leakOpen = oneOpen.body.cases[0];
  const leakDet = detOpen.body.case;
  assert(
    "15. no created_by_user_id returned",
    !("created_by_user_id" in leakOpen) &&
      !("created_by_user_id" in leakDet) &&
      !jsonHas(oneOpen.body, [USER_ID]) &&
      !jsonHas(detOpen.body, [USER_ID]) &&
      !/created_by_user_id/.test(CASE_SELECT)
  );
  assert(
    "16. no fingerprint returned",
    !("issue_fingerprint" in leakOpen) &&
      !("issue_fingerprint" in leakDet) &&
      !jsonHas(oneOpen.body, ["issue_fingerprint", "ffffffffffffffff"]) &&
      !/issue_fingerprint/.test(CASE_SELECT)
  );
  assert(
    "17. no idempotency key returned",
    !("idempotency_key" in leakOpen) &&
      !("idempotency_key" in leakDet) &&
      !jsonHas(oneOpen.body, ["idem-secret"]) &&
      !/idempotency_key/.test(CASE_SELECT)
  );
  assert(
    "18. no raw internal id returned",
    !("id" in leakOpen) &&
      !("id" in leakDet) &&
      leakOpen.case_ref === OPEN_REF &&
      leakDet.case_ref === OPEN_REF
  );

  assert(
    "19. customer_resolution null",
    leakDet.customer_resolution === null &&
      toDetail(caseRow()).customer_resolution === null
  );
  assert(
    "20. tenant_action_required false",
    leakDet.tenant_action_required === false &&
      toDetail(caseRow()).tenant_action_required === false
  );

  const openMap = mapStatus("open");
  const resolvedMap = mapStatus("resolved");
  const unknownMap = mapStatus("closed");
  assert("21. open → Open", openMap.status_label === "Open" && openMap.status_copy === OPEN_COPY);
  assert(
    "22. resolved → Resolved",
    resolvedMap.status_label === "Resolved" && resolvedMap.status_copy === RESOLVED_COPY
  );
  assert(
    "23. unknown state conservative",
    unknownMap.status_copy === UNVERIFIED_COPY &&
      unknownMap.status === "unverified" &&
      !/in_review|waiting_on_user|closed/.test(unknownMap.status_copy) &&
      !jsonHas(toDetail(caseRow({ status: "closed" })), ["closed"])
  );

  assert(
    "24. show my support cases routes My Cases",
    classifySupportIntent("show my support cases") === "my_cases" &&
      isMyCasesQuestion("show my support cases") === true
  );
  assert(
    "25. show my open support cases routes My Cases",
    classifySupportIntent("show my open support cases") === "my_cases"
  );
  assert(
    "26. exact canonical case routes",
    classifySupportIntent("what happened with case " + OPEN_REF) === "my_cases" &&
      classifySupportIntent("is case " + OPEN_REF + " resolved") === "my_cases" &&
      classifySupportIntent("did support resolve case " + OPEN_REF) === "my_cases"
  );
  assert(
    "27. bare case does not route",
    classifySupportIntent("case") !== "my_cases" && isMyCasesQuestion("case") === false
  );
  assert(
    "28. bare ticket does not route",
    classifySupportIntent("ticket") !== "my_cases" && isMyCasesQuestion("ticket") === false
  );
  assert(
    "29. project wording with case does not accidentally route",
    classifySupportIntent("this use case for the project") !== "my_cases" &&
      classifySupportIntent("How do I create a support case?") !== "my_cases" &&
      classifySupportIntent("What status is project " + OPEN_ID + "?") === "project_diagnostic"
  );

  const chatZero = await runChat("show my support cases", makeDb([]));
  assert(
    "30. zero cases deterministic",
    chatZero.body.ok === true &&
      chatZero.body.answer === ZERO_CASES_COPY &&
      chatZero.body.sources[0] === "My Cases" &&
      !chatZero.capture.url &&
      chatZero.body.escalation == null
  );

  const chatOpen = await runChat("what is the status of my support case", makeDb([caseRow()]));
  const chatOpenExact = await runChat("is case " + OPEN_REF + " resolved", makeDb([caseRow()]));
  assert(
    "31. known open deterministic",
    chatOpen.body.answer.indexOf(OPEN_REF) !== -1 &&
      chatOpen.body.answer.indexOf("Open") !== -1 &&
      chatOpenExact.body.answer === OPEN_COPY &&
      !chatOpen.capture.url &&
      !chatOpenExact.capture.url
  );

  const chatResolved = await runChat(
    "did support resolve case " + RESOLVED_REF,
    makeDb([
      caseRow({
        id: RESOLVED_ID,
        status: "resolved",
        resolved_at: "2026-08-22T12:00:00.000Z",
      }),
    ])
  );
  assert(
    "32. known resolved deterministic",
    chatResolved.body.answer === RESOLVED_COPY && !chatResolved.capture.url
  );

  const chatMissing = await runChat("what happened with case " + OTHER_REF, makeDb([]));
  assert(
    "33. exact not found deterministic",
    chatMissing.body.answer === NOT_FOUND_COPY && !chatMissing.capture.url
  );

  const knownCaptures = [chatZero, chatOpen, chatOpenExact, chatResolved, chatMissing];
  assert(
    "34. OpenAI calls = 0 for all known case status/list results",
    knownCaptures.every((row) => !row.capture.url && (row.capture.calls || 0) === 0)
  );

  assert(
    "35. safe fields rendered",
    /My Cases/.test(uiSrc) &&
      /appendLabeled\(btn, "Case"/.test(uiSrc) &&
      /appendLabeled\(btn, "Issue"/.test(uiSrc) &&
      /appendLabeled\(btn, "Status"/.test(uiSrc) &&
      /appendLabeled\(btn, "Created"/.test(uiSrc) &&
      /appendLabeled\(btn, "Last updated"/.test(uiSrc) &&
      ui.MY_CASES_API === "/.netlify/functions/mg-support-my-cases"
  );
  const cardFn = uiSrc.slice(uiSrc.indexOf("function renderCaseCard"), uiSrc.indexOf("function renderCaseDetail"));
  const detailFn = uiSrc.slice(uiSrc.indexOf("function renderCaseDetail"), uiSrc.indexOf("function renderCasesPanel"));
  assert(
    "36. question excerpt only in detail",
    /question_excerpt/.test(detailFn) && !/question_excerpt/.test(cardFn)
  );

  assert(
    "37. no internal UUID outside MG-SUP case_ref",
    /MG_SUPPORT_CASE_UUID_RE/.test(uiSrc) &&
      /relatedItemLabel/.test(uiSrc) &&
      ui.relatedItemLabel("project", OPEN_ID) === "Project" &&
      ui.relatedItemLabel("invoice", "INV-100") === "Invoice INV-100"
  );
  assert(
    "38. no tenant UUID",
    !/tenant_id/.test(uiSrc) && !("tenant_id" in leakOpen) && !("tenant_id" in leakDet)
  );
  assert("39. no created_by_user_id", !/created_by_user_id/.test(uiSrc + helperSrc.replace(CASE_SELECT, "")));
  assert(
    "40. no diagnostic payload",
    !/diagnostic_payload|facts_for_model|pairing_code/.test(helperSrc + endpointSrc + uiSrc)
  );
  assert(
    "41. no admin-only info",
    !/mg-support-admin-list-cases/.test(helperSrc + endpointSrc) &&
      !/assertPlatformAdminSession/.test(endpointSrc) &&
      !/internal notes|admin notes/.test(uiSrc)
  );
  assert(
    "42. no customer resolution invented for open cases",
    leakDet.customer_resolution === null &&
      /row\.status === "resolved"/.test(detailFn) &&
      /customer_resolution/.test(detailFn)
  );

  const writeList = await readMyCasesList(OWN_TENANT, {
    supabaseGet: async () => [caseRow()],
    supabaseRequest: async () => {
      throw new Error("write");
    },
  });
  const writeDet = await readMyCasesDetail(OWN_TENANT, parseCaseRef(OPEN_REF), {
    supabaseGet: async () => [caseRow()],
    supabaseRequest: async () => {
      throw new Error("write");
    },
  });
  assert("43. no INSERT", writeList.ok && writeDet.ok && !/method:\s*"INSERT"|method:\s*"POST"/.test(helperSrc));
  assert("44. no PATCH", !/method:\s*"PATCH"/.test(helperSrc + endpointSrc) && dOpen.writes.patch === 0);
  assert("45. no DELETE", !/method:\s*"DELETE"/.test(helperSrc + endpointSrc));
  assert(
    "46. no create-case call",
    !/mg-support-create-case/.test(helperSrc + endpointSrc + intentSrc) &&
      !/intakeSupportCase/.test(helperSrc + endpointSrc)
  );
  assert(
    "47. no admin-update call",
    !/mg-support-admin-update-case/.test(e1Src) && !/listAdminCases/.test(helperSrc)
  );
  assert("48. no Zapier", !/zapier/i.test(e1Src));
  assert("49. no email", !/nodemailer|sendgrid|mailto/.test(helperSrc + endpointSrc + intentSrc));

  assert(
    "50. Create support case flow unchanged",
    /data-create-case/.test(uiSrc) &&
      /submitSupportCase/.test(uiSrc) &&
      /CREATE_CASE_API/.test(uiSrc) &&
      /confirmation_token/.test(createCaseSrc) &&
      /How do I create a support case\?/.test("How do I create a support case?") &&
      classifySupportIntent("How do I create a support case?") !== "my_cases"
  );
  assert(
    "51. Support Admin unchanged",
    /assertPlatformAdminSession/.test(adminListSrc) &&
      /parseUpdateBody/.test(adminUpdateSrc) &&
      /listAdminCases/.test(adminHelperSrc)
  );
  assert(
    "52. invoice resend unchanged",
    /maybeOfferInvoiceResend/.test(chatSrc) &&
      /INVOICE_RESEND_CONFIRMATION_COPY/.test(resendSrc) &&
      /data-resend-invoice/.test(uiSrc)
  );
  assert(
    "53. supervisor visibility unchanged",
    /function supervisorVisibilityAnswer/.test(supervisorSrc) &&
      classifySupportIntent("supervisor cannot see project") === "project_diagnostic"
  );
  assert(
    "54. deposit/device D1 unchanged",
    /isDevicePairingDiagnosticQuestion/.test(deviceIntentSrc) &&
      /isDepositCtaDiagnosticQuestion/.test(depositIntentSrc) &&
      classifySupportIntent("The supervisor tablet will not pair.") === "device_pairing_diagnostic" &&
      classifySupportIntent("The deposit button is missing on public estimate 2026-0141.") ===
        "deposit_cta_diagnostic"
  );

  assert("A. list schema exact", sameKeys(leakOpen, LIST_KEYS));
  assert("A2. detail schema exact", sameKeys(leakDet, DETAIL_KEYS));
  assert(
    "B. tenant_id only from session",
    /resolveTenantFromSession/.test(endpointSrc) &&
      /queryStringParameters/.test(endpointSrc) &&
      /hasOverrideQuery/.test(endpointSrc)
  );
  assert("C. GET only endpoint", /method !== "GET"/.test(endpointSrc) && /httpMethod/.test(endpointSrc));
  const myCasesReturn = chatSrc.slice(
    chatSrc.lastIndexOf('if (intent === "my_cases")'),
    chatSrc.indexOf("const apiKey = getKey()")
  );
  assert(
    "D. chat my_cases skips OpenAI and escalation mint",
    /intent === "my_cases"/.test(chatSrc) &&
      /myCasesChatAnswer/.test(chatSrc) &&
      /sources: \["My Cases"\]/.test(myCasesReturn) &&
      !/mintEscalationIfNeeded/.test(myCasesReturn) &&
      !/escalation/.test(myCasesReturn)
  );
  assert("E. list chat omits excerpts", !/question_excerpt/.test(myCasesChatAnswer({ cases: [toListItem(caseRow())] })));
  assert(
    "F. status of my support case routes",
    classifySupportIntent("what is the status of my support case") === "my_cases"
  );
  assert("G. formatCaseRef reused", formatCaseRef(OPEN_ID) === OPEN_REF && /formatCaseRef/.test(helperSrc));
  assert("H. Cache-Control no-store", /Cache-Control": "no-store"/.test(endpointSrc.replace(/\s/g, " ")));
  assert(
    "I. UI fetches current server state",
    /cache: "no-store"/.test(uiSrc) &&
      /mgSupportCasesRefresh/.test(uiSrc) &&
      /loadMyCasesList/.test(uiSrc)
  );
  assert(
    "J. My Cases does not POST create-case",
    !/CREATE_CASE_API/.test(uiSrc.slice(uiSrc.indexOf("function loadMyCasesList"), uiSrc.indexOf("async function submitSupportCase")))
  );
  const dPost = makeDb([caseRow()]);
  const posted = await createMyCasesHandler(myCasesDeps(dPost))(fakePost({}));
  assert("K. POST rejected", posted.statusCode === 405 && dPost.gets.length === 0);
  assert("L. zero-case UI copy", ui.MY_CASES_ZERO === "You don't have any support cases yet.");
  assert("L2. waiting UI copy matches server", ui.WAITING_COPY === WAITING_COPY);
  assert(
    "M. select is closed",
    CASE_SELECT ===
      "id,tenant_id,status,category,subject,question_excerpt,support_module,related_entity_type,related_entity_ref,created_at,updated_at,resolved_at,customer_resolution,tenant_action_message"
  );
  const parsedList = parseMyCasesQuery({});
  const parsedDetail = parseMyCasesQuery({ case_ref: OPEN_REF });
  const parsedBare = parseMyCasesQuery({ case_ref: OPEN_ID });
  assert(
    "N. query modes",
    parsedList.mode === "list" && parsedDetail.mode === "detail" && parsedBare.ok === false
  );
  const listPathOwn = buildListPath(OWN_TENANT);
  const detailPathOwn = buildDetailPath(OWN_TENANT, OPEN_ID);
  assert(
    "O. tenant scoped paths",
    listPathOwn.indexOf("tenant_id=eq." + OWN_TENANT) !== -1 &&
      detailPathOwn.indexOf("tenant_id=eq." + OWN_TENANT) !== -1 &&
      detailPathOwn.indexOf("id=eq." + OPEN_ID) !== -1
  );
  assert(
    "P. chat list shape",
    /You have 1 support case:/.test(myCasesChatAnswer({ cases: [toListItem(caseRow())] })) &&
      /Open My Cases to view the details/.test(myCasesChatAnswer({ cases: [toListItem(caseRow())] }))
  );
  assert(
    "Q. invoice intent still wins",
    classifySupportIntent("What status is invoice INV-TEST-100?") === "invoice_diagnostic" &&
      classifySupportIntent("Resend invoice INV-TEST-100") === "invoice_diagnostic"
  );
  assert(
    "R. no second short identifier",
    !/short_ref|case_number/.test(helperSrc + endpointSrc)
  );

  assert(
    "S. truncated UUID rejected",
    parseCaseRef("MG-SUP-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa") === null &&
      parseCaseRef("MG-SUP-" + OPEN_ID.slice(0, 8)) === null
  );
  assert("T. prefix-only rejected", parseCaseRef("MG-SUP-") === null && parseCaseRef("MG-SUP") === null);
  const dTrunc = makeDb([caseRow()]);
  const trunc = await runMyCases({ case_ref: "MG-SUP-" + OPEN_ID.slice(0, 8) }, dTrunc);
  assert("T2. truncated ref is invalid", trunc.res.statusCode === 400 && dTrunc.gets.length === 0);

  const dOrg = makeDb([caseRow()]);
  const orgQ = await runMyCases({ organization: OTHER_TENANT }, dOrg);
  const dWs = makeDb([caseRow()]);
  const wsH = await runMyCases({}, dWs, { headers: { "x-workspace-id": OTHER_TENANT } });
  const dBody = makeDb([caseRow()]);
  const bodyT = await runMyCases({}, dBody, { body: { tenant_id: OTHER_TENANT } });
  assert(
    "U. organization/workspace/body tenant rejected",
    orgQ.res.statusCode === 400 &&
      dOrg.gets.length === 0 &&
      wsH.res.statusCode === 400 &&
      dWs.gets.length === 0 &&
      bodyT.res.statusCode === 400 &&
      dBody.gets.length === 0
  );

  const dArb = makeDb([caseRow()]);
  const arb = await Promise.all(
    ["limit", "offset", "order", "select", "filter", "status"].map((key) => {
      const q = {};
      q[key] = key === "limit" ? "50" : "open";
      return runMyCases(q, dArb);
    })
  );
  assert(
    "V. arbitrary query/filter rejected",
    arb.every((row) => row.res.statusCode === 400) && dArb.gets.length === 0
  );

  const xss = '<script>alert(1)</script><img src=x onerror=alert(1)>';
  const escaped = ui.escapeHtml(xss);
  const relatedXss = ui.relatedItemLabel("invoice", xss);
  const casesUi = uiSrc.slice(
    uiSrc.indexOf("function appendLabeled"),
    uiSrc.indexOf("async function submitSupportCase")
  );
  assert(
    "W. XSS subject/excerpt/ref render as text",
    escaped ===
      "&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;" &&
      !/<script/i.test(escaped) &&
      relatedXss === "Invoice " + xss &&
      /createTextNode/.test(casesUi) &&
      /textContent/.test(casesUi) &&
      !/innerHTML/.test(casesUi) &&
      !/\bhref\b/.test(casesUi) &&
      !/javascript:/.test(casesUi) &&
      !/insertAdjacentHTML/.test(casesUi)
  );

  assert(
    "X. create support case is not My Cases",
    classifySupportIntent("create a support case") !== "my_cases" &&
      classifySupportIntent("How do I create a support case?") !== "my_cases" &&
      classifySupportIntent("create a support case " + OPEN_REF) !== "my_cases"
  );
  assert(
    "Y. freeze routing collisions",
    classifySupportIntent("what is the status of case " + OPEN_REF) === "my_cases" &&
      classifySupportIntent("my invoice has a problem") === "invoice_diagnostic" &&
      classifySupportIntent("resend invoice INV-TEST-100") === "invoice_diagnostic" &&
      classifySupportIntent("supervisor cannot pair device") === "device_pairing_diagnostic" &&
      classifySupportIntent("deposit button missing on public estimate for quote 2026-0141") ===
        "deposit_cta_diagnostic" &&
      classifySupportIntent("supervisor cannot see project") === "project_diagnostic"
  );

  const dCookie = makeDb([caseRow()]);
  const cookieRun = await runMyCases({}, dCookie, {
    headers: { cookie: "tenant_id=" + OTHER_TENANT + "; workspace=" + OTHER_TENANT },
  });
  assert(
    "Z. non-session cookie tenant ignored",
    cookieRun.res.statusCode === 200 &&
      cookieRun.body.cases.length === 1 &&
      cookieRun.body.cases[0].case_ref === OPEN_REF
  );

  const inReview = toDetail(caseRow({ status: "in_review" }));
  const waitingWrong = toListItem(caseRow({ status: "waiting_on_user" }));
  const closed = mapStatus("closed");
  assert(
    "AA. canonical in_review is In Review; unsupported stay conservative",
    inReview.status_label === "In Review" &&
      inReview.status_copy === IN_REVIEW_COPY &&
      waitingWrong.status_label === "Unavailable" &&
      closed.status_label === "Unavailable" &&
      !/Closed/.test(closed.status_copy + waitingWrong.status_label)
  );

  console.log("");
  console.log(passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
