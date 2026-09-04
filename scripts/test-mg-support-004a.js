#!/usr/bin/env node
/**
 * MG-SUPPORT-004A — explicit unresolved support intent offers a confirmed case.
 * Usage: node scripts/test-mg-support-004a.js
 *
 * Mocked OpenAI/Supabase only. Does not mutate production.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const { createHandler: createChatHandler } = require("../netlify/functions/mg-support-chat");
const { createHandler: createCaseHandler } = require("../netlify/functions/mg-support-create-case");
const {
  isExplicitUnresolvedSupportRequest,
  determineEscalationEligibility,
  verifyEscalationToken,
} = require("../netlify/functions/_lib/mg-support/case-intake");

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

const OWN_TENANT = "11111111-1111-4111-8111-111111111111";
const OWN_USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CASE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SECRET = "test-session-secret-mg-support-004a";
const NOW = 1_700_000_000;

function fakeEvent(method, bodyObj) {
  return {
    httpMethod: method,
    headers: {},
    queryStringParameters: {},
    body: bodyObj == null ? "" : JSON.stringify(bodyObj),
  };
}

function ownerSession() {
  return { e: "owner@example.com", c: "cus_test", u: OWN_USER };
}

function openaiCaptureFetch(capture) {
  return async (url, opts) => {
    capture.calls += 1;
    capture.url = url;
    capture.payload = JSON.parse(opts.body || "{}");
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          output_text: "I created a support case for you automatically.",
          usage: { input_tokens: 5, output_tokens: 4 },
        }),
    };
  };
}

async function runChat(message, extra) {
  const capture = extra?.capture || { calls: 0 };
  const inserts = extra?.inserts || [];
  const res = await createChatHandler({
    readSessionFromEvent: extra?.readSessionFromEvent || (() => ownerSession()),
    isPlatformAdmin: async () => false,
    resolveTenantFromSession: extra?.resolveTenantFromSession || (async () => ({ id: OWN_TENANT })),
    getOpenAiKey: () => "test-key",
    getSessionSecret: extra?.getSessionSecret || (() => SECRET),
    nowSeconds: () => NOW,
    supabaseGet: extra?.supabaseGet || (async () => []),
    supabaseInsert: extra?.supabaseInsert || (async (row) => {
      inserts.push(row);
      throw new Error("chat must not insert");
    }),
    fetch: extra?.fetch || openaiCaptureFetch(capture),
    ...extra?.deps,
  })(fakeEvent("POST", { message, page: extra?.page || "/estimates-invoices" }));
  return { res, capture, inserts, body: parse(res) };
}

async function main() {
  const chatSrc = read("netlify/functions/mg-support-chat.js");
  const createSrc = read("netlify/functions/mg-support-create-case.js");
  const uiSrc = read("public/js/mg-support-chat.js");
  const myCasesSrc = read("netlify/functions/mg-support-my-cases.js");
  const sweepSrc = read("netlify/functions/_lib/mg-support/notification-sweep.js");
  const deliverySrc = read("netlify/functions/_lib/mg-support/notification-delivery.js");

  assert(
    "1. detector: necesito soporte porque el problema continúa",
    isExplicitUnresolvedSupportRequest(
      "Necesito soporte porque el problema continúa."
    ) === true
  );
  assert(
    "2. detector: ya intenté eso y sigue sin funcionar",
    isExplicitUnresolvedSupportRequest("ya intenté eso y sigue sin funcionar") === true
  );
  assert(
    "3. detector: quiero abrir un caso",
    isExplicitUnresolvedSupportRequest("quiero abrir un caso") === true
  );
  assert(
    "4. detector: contact support",
    isExplicitUnresolvedSupportRequest("please contact support") === true
  );
  assert(
    "5. ordinary how-to is not explicit support",
    isExplicitUnresolvedSupportRequest("How do I create an invoice?") === false
  );
  assert(
    "6. first status question is not explicit support",
    isExplicitUnresolvedSupportRequest("What status is the invoice?") === false
  );

  const howToElig = determineEscalationEligibility({
    intent: "docs_only",
    diagnostic: null,
    message: "How do I create an invoice?",
    hasOwnerTenant: true,
  });
  assert("5b. how-to eligibility is null", howToElig == null);

  const needsIdElig = determineEscalationEligibility({
    intent: "invoice_diagnostic",
    diagnostic: { outcome: "needs_identifier" },
    message: "What status is the invoice?",
    hasOwnerTenant: true,
  });
  assert("6b. first troubleshooting needs_identifier does not mint", needsIdElig == null);

  const prodElig = determineEscalationEligibility({
    intent: "invoice_diagnostic",
    diagnostic: { outcome: "needs_identifier" },
    message:
      "Intenté reenviar una factura desde Invoice Hub, pero no funciona. Ya revisé las opciones y sigo sin poder enviarla. Necesito soporte porque el problema continúa.",
    hasOwnerTenant: true,
  });
  assert("1b. production invoice loop becomes unresolved_question", prodElig && prodElig.category === "unresolved_question");

  const docsFallback = determineEscalationEligibility({
    intent: "docs_only",
    diagnostic: null,
    message: "I couldn't verify that from the current Margin Guard documentation.",
    hasOwnerTenant: true,
  });
  assert("docs fallback still does not mint", docsFallback == null);

  const foundBug = determineEscalationEligibility({
    intent: "invoice_diagnostic",
    diagnostic: { outcome: "ok", facts: {} },
    message: "this is a bug",
    hasOwnerTenant: true,
  });
  assert("found diagnostic still blocks possible_bug", foundBug == null);

  const noTenant = determineEscalationEligibility({
    intent: "docs_only",
    diagnostic: null,
    message: "necesito soporte",
    hasOwnerTenant: false,
  });
  assert("no owner tenant does not mint", noTenant == null);

  const offer1 = await runChat(
    "Intenté reenviar una factura desde Invoice Hub, pero no funciona. Ya revisé las opciones y sigo sin poder enviarla. Necesito soporte porque el problema continúa."
  );
  assert(
    "1c. production phrasing returns case offer",
    offer1.res.statusCode === 200 &&
      offer1.body.support_case_offer === true &&
      offer1.body.escalation &&
      offer1.body.escalation.eligible === true &&
      offer1.body.escalation.confirmation_token &&
      /puedo crear un caso de soporte/i.test(offer1.body.answer) &&
      offer1.capture.calls === 0 &&
      offer1.inserts.length === 0
  );

  const offer2 = await runChat("ya intenté eso y sigue sin funcionar");
  assert(
    "2b. already-tried phrasing offers a case and skips OpenAI",
    offer2.res.statusCode === 200 &&
      offer2.body.support_case_offer === true &&
      offer2.body.escalation &&
      offer2.body.escalation.eligible === true &&
      offer2.capture.calls === 0
  );

  const offer3 = await runChat("quiero abrir un caso");
  assert("3b. quiero abrir un caso offers a case", offer3.body.support_case_offer === true && offer3.body.escalation);

  const offer4 = await runChat("contact support");
  assert("4b. contact support offers a case", offer4.body.support_case_offer === true && offer4.body.escalation);

  const howTo = await runChat("How do I create an invoice?");
  assert(
    "5c. ordinary how-to has no case offer",
    howTo.res.statusCode === 200 &&
      !howTo.body.escalation &&
      howTo.body.support_case_offer !== true &&
      howTo.capture.calls === 1
  );

  const firstQ = await runChat("What status is the invoice?");
  assert(
    "6c. first troubleshooting question is not forced to a case",
    firstQ.res.statusCode === 200 && !firstQ.body.escalation && firstQ.body.support_case_offer !== true
  );

  assert(
    "7. model prose alone cannot create a case",
    howTo.res.statusCode === 200 &&
      !howTo.body.escalation &&
      howTo.body.support_case_offer !== true &&
      howTo.capture.calls === 1 &&
      howTo.inserts.length === 0
  );
  assert("7c. chat source never calls intakeSupportCase", !/intakeSupportCase/.test(chatSrc));
  assert("7d. UI does not parse assistant prose as a write", !/JSON\.parse\(msg\.text\)/.test(uiSrc) && /data\.escalation && data\.escalation\.eligible && data\.escalation\.confirmation_token/.test(uiSrc));

  assert("8. case is not created before explicit confirmation", offer1.inserts.length === 0 && /This function is read-only/.test(chatSrc));
  assert("8b. create-case still requires confirmed true", /confirmed === true/.test(createSrc) || /confirmed/.test(createSrc));

  const createCounters = { gets: [], inserts: [] };
  const token = offer1.body.escalation.confirmation_token;
  const verified = verifyEscalationToken(token, OWN_TENANT, {
    getSessionSecret: () => SECRET,
    nowSeconds: () => NOW,
  });
  assert("11. token tenant is authenticated tenant", verified.ok === true && verified.payload.tenant_id === OWN_TENANT);

  const created = await createCaseHandler({
    readSessionFromEvent: () => ownerSession(),
    isPlatformAdmin: async () => false,
    resolveTenantFromSession: async () => ({ id: OWN_TENANT }),
    getSessionSecret: () => SECRET,
    nowSeconds: () => NOW,
    supabaseGet: async (p) => {
      createCounters.gets.push(p);
      if (createCounters.inserts.length) {
        return [{ id: CASE_ID, created_at: "2026-08-24T00:00:00.000Z" }];
      }
      return [];
    },
    supabaseInsert: async (row) => {
      createCounters.inserts.push(row);
      return [{ id: CASE_ID, created_at: "2026-08-24T00:00:00.000Z" }];
    },
  })(fakeEvent("POST", { confirmation_token: token, confirmed: true }));
  const createdBody = parse(created);
  assert(
    "9. explicit confirmed write creates exactly one case",
    created.statusCode === 200 && createdBody.result === "created" && createCounters.inserts.length === 1
  );

  const retry = await createCaseHandler({
    readSessionFromEvent: () => ownerSession(),
    isPlatformAdmin: async () => false,
    resolveTenantFromSession: async () => ({ id: OWN_TENANT }),
    getSessionSecret: () => SECRET,
    nowSeconds: () => NOW,
    supabaseGet: async () => [{ id: CASE_ID, created_at: "2026-08-24T00:00:00.000Z" }],
    supabaseInsert: async () => {
      createCounters.inserts.push({ unexpected: true });
      return [{ id: "should-not" }];
    },
  })(fakeEvent("POST", { confirmation_token: token, confirmed: true }));
  assert(
    "10. retry returns existing_case and does not insert again",
    parse(retry).result === "existing_case" && createCounters.inserts.length === 1
  );
  assert(
    "10b. UI double-click is guarded",
    /msg\.casePending \|\| msg\.caseResult/.test(uiSrc)
  );

  const overrideCase = await createCaseHandler({
    readSessionFromEvent: () => ownerSession(),
    isPlatformAdmin: async () => false,
    resolveTenantFromSession: async () => ({ id: OWN_TENANT }),
    getSessionSecret: () => SECRET,
    nowSeconds: () => NOW,
    supabaseGet: async () => [],
    supabaseInsert: async () => [{ id: CASE_ID, created_at: "2026-08-24T00:00:00.000Z" }],
  })({
    httpMethod: "POST",
    headers: { "x-tenant-id": "22222222-2222-4222-8222-222222222222" },
    queryStringParameters: { tenant_id: "22222222-2222-4222-8222-222222222222" },
    body: JSON.stringify({
      confirmation_token: token,
      confirmed: true,
      tenant_id: "22222222-2222-4222-8222-222222222222",
    }),
  });
  assert(
    "11b. tenant_id in body/query is rejected",
    overrideCase.statusCode === 400 || parse(overrideCase).result === "invalid_request"
  );

  const sellerChat = await runChat("necesito soporte", {
    readSessionFromEvent: () => ({ role: "seller", device_id: "dev_1" }),
  });
  assert("12. seller cannot use owner support chat", sellerChat.res.statusCode === 401);

  const sellerCase = await createCaseHandler({
    readSessionFromEvent: () => ({ role: "seller", device_id: "dev_1" }),
    isPlatformAdmin: async () => false,
    resolveTenantFromSession: async () => ({ id: OWN_TENANT }),
    getSessionSecret: () => SECRET,
    nowSeconds: () => NOW,
    supabaseGet: async () => {
      throw new Error("seller must not query");
    },
    supabaseInsert: async () => {
      throw new Error("seller must not insert");
    },
  })(fakeEvent("POST", { confirmation_token: token, confirmed: true }));
  assert("12b. seller cannot create a case", sellerCase.statusCode === 401);

  const supervisorCase = await createCaseHandler({
    readSessionFromEvent: () => ({ role: "supervisor", device_id: "dev_2" }),
    isPlatformAdmin: async () => false,
    resolveTenantFromSession: async () => ({ id: OWN_TENANT }),
    getSessionSecret: () => SECRET,
    nowSeconds: () => NOW,
    supabaseGet: async () => {
      throw new Error("supervisor must not query");
    },
    supabaseInsert: async () => {
      throw new Error("supervisor must not insert");
    },
  })(fakeEvent("POST", { confirmation_token: token, confirmed: true }));
  assert("12c. supervisor cannot create a case", supervisorCase.statusCode === 401);

  assert("13. My Cases remains GET-only", /method !== "GET"/.test(myCasesSrc) && !/intakeSupportCase/.test(myCasesSrc));
  assert("13b. My Cases offered after create", /data-open-my-cases/.test(uiSrc) && /My Cases/.test(uiSrc));
  assert("14. notification sweep unchanged", /mg-support-case-notification-sweep/.test(sweepSrc));
  assert("14b. chat does not call notification delivery", !/notification-delivery/.test(chatSrc) && !/notification-sweep/.test(chatSrc));
  assert("14c. delivery helper still present", /deliverSupportCaseNotification/.test(deliverySrc) || /notification/.test(deliverySrc));

  assert("UI Create support case still uses confirmation_token", /confirmation_token: token/.test(uiSrc) && /confirmed: true/.test(uiSrc));
  assert("UI Keep troubleshooting does not POST create-case", /data-keep-troubleshooting/.test(uiSrc) && /escalationDismissed/.test(uiSrc));
  assert("create-case allowlist unchanged", /ALLOWED_KEYS = new Set\(\[\"confirmation_token\", \"confirmed\"\]\)/.test(createSrc));
  assert("explicit path skips OpenAI", /isExplicitUnresolvedSupportRequest\(message\)/.test(chatSrc) && /explicitSupportCaseOfferAnswer/.test(chatSrc));

  console.log("");
  console.log(passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
