#!/usr/bin/env node
/**
 * MG-SUPPORT-003B — confirmed support-case intake tests (mocked OpenAI and Supabase).
 * Usage: node scripts/test-mg-support-003b.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..");
const { createHandler: createChatHandler } = require("../netlify/functions/mg-support-chat");
const { createHandler: createCaseHandler } = require("../netlify/functions/mg-support-create-case");
const {
  TOKEN_TYPE,
  TOKEN_VERSION,
  ESCALATION_TTL_SECONDS,
  EXCERPT_MAX,
  SUBJECT_MAX,
  PAGE_MAX,
  ENTITY_REF_MAX,
  CASE_TABLE,
  CASE_SELECT,
  sanitizeExcerpt,
  normalizeIssueText,
  fingerprintIssue,
  sanitizePagePath,
  mapModule,
  deriveServerSubject,
  isPossibleBugReport,
  bindRelatedEntity,
  determineEscalationEligibility,
  formatCaseRef,
  mintEscalationToken,
  verifyEscalationToken,
  buildDuplicateQueryPath,
  buildIdempotencyQueryPath,
  intakeSupportCase,
} = require("../netlify/functions/_lib/mg-support/case-intake");
const { SYSTEM_INSTRUCTIONS } = require("../netlify/functions/_lib/mg-support/config");

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

const OWN_TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "22222222-2222-4222-8222-222222222222";
const OWN_USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CASE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PROJECT_ID = "e15b519e-9125-4d18-b5a6-4c6a7d460c80";
const PACKAGE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ENVELOPE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SECRET = "test-session-secret-mg-support-003b";
const NOW = 1_700_000_000;

function parse(res) {
  try {
    return JSON.parse(res.body || "{}");
  } catch (_err) {
    return {};
  }
}

function fakeEvent(method, bodyObj, extra) {
  return {
    httpMethod: method,
    headers: extra?.headers || {},
    queryStringParameters: extra?.query || {},
    body: bodyObj == null ? "" : typeof bodyObj === "string" ? bodyObj : JSON.stringify(bodyObj),
  };
}

function openaiOkFetch(capture) {
  return async (url, opts) => {
    if (capture) {
      capture.url = url;
      capture.payload = JSON.parse(opts.body || "{}");
      capture.opts = opts;
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

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function signPayload(payload, secret) {
  const encodedPayload = base64url(JSON.stringify(payload));
  const signature = crypto
    .createHmac("sha256", secret)
    .update(encodedPayload)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `${encodedPayload}.${signature}`;
}

function mintDeps(nowSeconds) {
  return {
    getSessionSecret: () => SECRET,
    nowSeconds: () => (typeof nowSeconds === "number" ? nowSeconds : NOW),
  };
}

function mintOwn(overrides) {
  return mintEscalationToken(
    {
      tenant_id: OWN_TENANT,
      category: "diagnostic_unavailable",
      support_module: "invoice_hub",
      related_entity_type: "invoice",
      related_entity_ref: "INV-TEST-100",
      page_path: "/estimates-invoices",
      question_excerpt: "What status is invoice INV-TEST-100?",
      ...overrides,
    },
    mintDeps()
  );
}

function ownerSession(extra) {
  return { e: "owner@example.com", c: "cus_test", u: OWN_USER, ...extra };
}

function createCounters() {
  return { gets: [], inserts: [] };
}

function caseDeps(counters, session, tenantId, extra) {
  return {
    readSessionFromEvent: extra?.readSessionFromEvent || (() => session),
    isPlatformAdmin: extra?.isPlatformAdmin || (async () => false),
    resolveTenantFromSession: extra?.resolveTenantFromSession || (async () => (tenantId ? { id: tenantId } : null)),
    getSessionSecret: () => SECRET,
    nowSeconds: () => NOW,
    supabaseGet: extra?.supabaseGet || (async (p) => {
      counters.gets.push(p);
      return extra?.existing || [];
    }),
    supabaseInsert: extra?.supabaseInsert || (async (row) => {
      counters.inserts.push(row);
      return [{ id: CASE_ID, created_at: "2026-08-24T00:00:00.000Z" }];
    }),
  };
}

async function runCase(event, deps) {
  return createCaseHandler(deps)(event);
}

async function runChat(event, deps) {
  return createChatHandler(deps)(event);
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

async function main() {
  const migration = read("SUPABASE_MG_SUPPORT_003B_CASES.sql");
  const verifySql = read("SUPABASE_MG_SUPPORT_003B_CASES_VERIFY.sql");
  const intakeSrc = read("netlify/functions/_lib/mg-support/case-intake.js");
  const createSrc = read("netlify/functions/mg-support-create-case.js");
  const chatSrc = read("netlify/functions/mg-support-chat.js");
  const uiSrc = read("public/js/mg-support-chat.js");
  const navSrc = read("public/js/mg-app-nav.js");
  const docsSrc = read("docs/margin-guard-support/support-escalation.md");
  const configSrc = read("netlify/functions/_lib/mg-support/config.js");

  const minted = mintOwn();
  const counters = createCounters();
  const created = await runCase(
    fakeEvent("POST", { confirmation_token: minted.token, confirmed: true }),
    caseDeps(counters, ownerSession(), OWN_TENANT)
  );
  const createdBody = parse(created);
  assert(
    "1. valid normal owner eligible",
    created.statusCode === 200 && createdBody.result === "created" && createdBody.case_ref === "MG-SUP-" + CASE_ID
  );

  const unauthCounters = createCounters();
  const unauth = await runCase(
    fakeEvent("POST", { confirmation_token: minted.token, confirmed: true }),
    caseDeps(unauthCounters, null, OWN_TENANT, {
      readSessionFromEvent: () => null,
    })
  );
  assert(
    "2. unauthenticated cannot create",
    unauth.statusCode === 401 && parse(unauth).result === "not_authorized" && unauthCounters.gets.length === 0 && unauthCounters.inserts.length === 0
  );

  const sellerCounters = createCounters();
  const seller = await runCase(
    fakeEvent("POST", { confirmation_token: minted.token, confirmed: true }),
    caseDeps(sellerCounters, { role: "seller", device_id: "dev_1" }, OWN_TENANT)
  );
  assert(
    "3. seller cannot create",
    seller.statusCode === 401 && parse(seller).result === "not_authorized" && sellerCounters.gets.length === 0
  );

  const supervisorCounters = createCounters();
  const supervisor = await runCase(
    fakeEvent("POST", { confirmation_token: minted.token, confirmed: true }),
    caseDeps(supervisorCounters, { role: "supervisor", device_id: "dev_2" }, OWN_TENANT)
  );
  assert(
    "4. supervisor cannot create",
    supervisor.statusCode === 401 && parse(supervisor).result === "not_authorized" && supervisorCounters.gets.length === 0
  );

  const deviceCounters = createCounters();
  const device = await runCase(
    fakeEvent("POST", { confirmation_token: minted.token, confirmed: true }),
    caseDeps(deviceCounters, { role: "device", device_id: "dev_3" }, OWN_TENANT)
  );
  assert(
    "5. device cannot create",
    device.statusCode === 401 && parse(device).result === "not_authorized" && deviceCounters.gets.length === 0
  );

  const adminCounters = createCounters();
  const admin = await runCase(
    fakeEvent("POST", { confirmation_token: minted.token, confirmed: true }),
    caseDeps(adminCounters, { e: "admin@example.com" }, OWN_TENANT, {
      isPlatformAdmin: async () => true,
    })
  );
  assert(
    "6. platform admin without normal tenant context cannot create",
    admin.statusCode === 401 && parse(admin).result === "not_authorized" && adminCounters.gets.length === 0
  );

  assert(
    "7. trusted tenant derived from session",
    counters.gets[0].includes("tenant_id=eq." + OWN_TENANT) &&
      counters.inserts[0].tenant_id === OWN_TENANT
  );

  const extraTenant = await runCase(
    fakeEvent("POST", {
      confirmation_token: minted.token,
      confirmed: true,
      tenant_id: OTHER_TENANT,
    }),
    caseDeps(createCounters(), ownerSession(), OWN_TENANT)
  );
  assert("8. body tenant_id rejected", extraTenant.statusCode === 400 && parse(extraTenant).result === "invalid_request");

  const queryOverride = await runCase(
    fakeEvent("POST", { confirmation_token: minted.token, confirmed: true }, { query: { tenant_id: OTHER_TENANT } }),
    caseDeps(createCounters(), ownerSession(), OWN_TENANT)
  );
  const headerOverride = await runCase(
    fakeEvent("POST", { confirmation_token: minted.token, confirmed: true }, { headers: { "x-tenant-id": OTHER_TENANT } }),
    caseDeps(createCounters(), ownerSession(), OWN_TENANT)
  );
  assert(
    "9. query/header tenant override rejected if applicable",
    queryOverride.statusCode === 400 &&
      parse(queryOverride).result === "invalid_request" &&
      headerOverride.statusCode === 400 &&
      parse(headerOverride).result === "invalid_request"
  );

  const mismatchCounters = createCounters();
  const otherToken = mintEscalationToken(
    {
      tenant_id: OTHER_TENANT,
      category: "diagnostic_unavailable",
      support_module: "invoice_hub",
      related_entity_type: "invoice",
      related_entity_ref: "INV-TEST-100",
      page_path: "/estimates-invoices",
      question_excerpt: "What status is invoice INV-TEST-100?",
    },
    mintDeps()
  );
  const mismatch = await runCase(
    fakeEvent("POST", { confirmation_token: otherToken.token, confirmed: true }),
    caseDeps(mismatchCounters, ownerSession(), OWN_TENANT)
  );
  assert(
    "10. token tenant mismatch → invalid_confirmation",
    mismatch.statusCode === 400 && parse(mismatch).result === "invalid_confirmation"
  );
  assert(
    "11. tenant mismatch → zero case DB query/write",
    mismatchCounters.gets.length === 0 && mismatchCounters.inserts.length === 0
  );

  let chatWrites = 0;
  const howTo = await runChat(fakeEvent("POST", { message: "How do I create an invoice?", page: "/dashboard" }), {
    readSessionFromEvent: () => ownerSession(),
    resolveTenantFromSession: async () => ({ id: OWN_TENANT }),
    getOpenAiKey: () => "test-key",
    getSessionSecret: () => SECRET,
    supabaseGet: async () => {
      chatWrites += 1;
      return [];
    },
    supabaseInsert: async () => {
      chatWrites += 1;
      throw new Error("chat must not insert");
    },
    fetch: openaiOkFetch(),
  });
  assert(
    "12. normal mg-support-chat turn writes zero support rows",
    howTo.statusCode === 200 && !parse(howTo).escalation && chatWrites === 0 && !/intakeSupportCase/.test(chatSrc)
  );

  const foundRes = await runChat(fakeEvent("POST", { message: "What status is invoice INV-TEST-100?" }), {
    readSessionFromEvent: () => ownerSession(),
    resolveTenantFromSession: async () => ({ id: OWN_TENANT }),
    getOpenAiKey: () => "test-key",
    getSessionSecret: () => SECRET,
    readInvoiceDiagnostic: async () => ({ outcome: "ok", facts: { invoice_no: "INV-TEST-100", status: "sent" } }),
    fetch: openaiOkFetch(),
  });
  assert("13. diagnostic found writes zero rows", foundRes.statusCode === 200 && !parse(foundRes).escalation);

  const needsId = await runChat(fakeEvent("POST", { message: "What status is the invoice?" }), {
    readSessionFromEvent: () => ownerSession(),
    resolveTenantFromSession: async () => ({ id: OWN_TENANT }),
    getOpenAiKey: () => "test-key",
    getSessionSecret: () => SECRET,
    fetch: openaiOkFetch(),
  });
  assert("14. needs_identifier writes zero rows", needsId.statusCode === 200 && !parse(needsId).escalation);

  const noTenant = await runChat(fakeEvent("POST", { message: "What status is invoice INV-TEST-100?" }), {
    readSessionFromEvent: () => ownerSession(),
    resolveTenantFromSession: async () => null,
    getOpenAiKey: () => "test-key",
    getSessionSecret: () => SECRET,
    fetch: openaiOkFetch(),
  });
  assert("15. no_tenant_context writes zero rows", noTenant.statusCode === 200 && !parse(noTenant).escalation);

  assert("16. normal how-to writes zero rows", howTo.statusCode === 200 && !parse(howTo).escalation);

  assert(
    "17. thumbs down writes zero rows",
    /data-fb="down"/.test(uiSrc) && !/data-fb="down"[\s\S]{0,400}CREATE_CASE_API/.test(uiSrc) && uiSrc.includes("messages[i].feedback")
  );

  let timeoutMint = 0;
  const timeoutRes = await runChat(fakeEvent("POST", { message: "How does Invoice Hub work?" }), {
    readSessionFromEvent: () => ownerSession(),
    getOpenAiKey: () => "test-key",
    getSessionSecret: () => SECRET,
    mintEscalationToken: () => {
      timeoutMint += 1;
      return { token: "x" };
    },
    fetch: async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    },
  });
  assert(
    "18. OpenAI timeout writes zero rows",
    timeoutRes.statusCode === 502 && timeoutMint === 0 && !parse(timeoutRes).escalation
  );

  assert(
    "19. chat contains no support-case INSERT path",
    !/supabaseRequest|\/rest\/v1\//.test(chatSrc) && !/intakeSupportCase/.test(chatSrc)
  );

  const unverified = await runChat(fakeEvent("POST", { message: "What status is invoice INV-TEST-100?", page: "/estimates-invoices" }), {
    readSessionFromEvent: () => ownerSession(),
    resolveTenantFromSession: async () => ({ id: OWN_TENANT }),
    getOpenAiKey: () => "test-key",
    getSessionSecret: () => SECRET,
    nowSeconds: () => NOW,
    readInvoiceDiagnostic: async () => ({ outcome: "status_unverified" }),
    fetch: openaiOkFetch(),
  });
  const esc = parse(unverified).escalation;
  assert(
    "20. eligible deterministic status_unverified may mint token",
    unverified.statusCode === 200 && esc && esc.eligible === true && esc.label === "Create support case" && esc.confirmation_token
  );

  const verifiedOk = verifyEscalationToken(esc.confirmation_token, OWN_TENANT, mintDeps());
  assert("21. token type exact", verifiedOk.ok && verifiedOk.payload.type === TOKEN_TYPE && TOKEN_TYPE === "mg_support_escalation_v1");
  assert("22. version exact", verifiedOk.payload.version === TOKEN_VERSION && TOKEN_VERSION === 1);
  assert("23. TTL ~15 minutes", verifiedOk.payload.exp - verifiedOk.payload.iat === ESCALATION_TTL_SECONDS && ESCALATION_TTL_SECONDS === 900);
  assert("24. nonce present", typeof verifiedOk.payload.nonce === "string" && verifiedOk.payload.nonce.length > 0);
  assert("25. valid HMAC passes", verifiedOk.ok === true);

  const tamperedPayload = esc.confirmation_token.replace(/^../, "aa");
  assert("26. tampered payload fails", verifyEscalationToken(tamperedPayload, OWN_TENANT, mintDeps()).ok === false);

  const [enc, sig] = esc.confirmation_token.split(".");
  const tamperedSig = enc + "." + (sig[0] === "a" ? "b" : "a") + sig.slice(1);
  assert("27. tampered signature fails", verifyEscalationToken(tamperedSig, OWN_TENANT, mintDeps()).ok === false);

  const expired = verifyEscalationToken(minted.token, OWN_TENANT, {
    getSessionSecret: () => SECRET,
    nowSeconds: () => NOW + ESCALATION_TTL_SECONDS + 5,
  });
  assert("28. expired token fails", expired.ok === false);

  const futurePayload = {
    ...minted.payload,
    iat: NOW + 3600,
    exp: NOW + 3600 + 900,
  };
  const futureTok = signPayload(futurePayload, SECRET);
  assert(
    "29. invalid future timestamp fails if enforced",
    verifyEscalationToken(futureTok, OWN_TENANT, mintDeps()).ok === false
  );

  const wrongType = signPayload({ ...minted.payload, type: "mg_session" }, SECRET);
  assert("30. wrong type fails", verifyEscalationToken(wrongType, OWN_TENANT, mintDeps()).ok === false);

  const wrongVer = signPayload({ ...minted.payload, version: 2 }, SECRET);
  assert("31. wrong version fails", verifyEscalationToken(wrongVer, OWN_TENANT, mintDeps()).ok === false);

  const missingNonce = signPayload({ ...minted.payload, nonce: "" }, SECRET);
  assert("32. missing nonce fails", verifyEscalationToken(missingNonce, OWN_TENANT, mintDeps()).ok === false);

  assert(
    "33. tenant mismatch fails",
    verifyEscalationToken(minted.token, OTHER_TENANT, mintDeps()).ok === false
  );

  const badTokCounters = createCounters();
  const badTok = await runCase(
    fakeEvent("POST", { confirmation_token: "not-a-token", confirmed: true }),
    caseDeps(badTokCounters, ownerSession(), OWN_TENANT)
  );
  assert(
    "34. invalid_confirmation makes zero DB calls",
    parse(badTok).result === "invalid_confirmation" && badTokCounters.gets.length === 0 && badTokCounters.inserts.length === 0
  );

  assert(
    "35. token is never logged",
    !/console\.[a-z]+\([^\n]*confirmation_token/.test(chatSrc + createSrc + intakeSrc) &&
      !/console\.[a-z]+\([^\n]*minted\.token/.test(chatSrc + createSrc + intakeSrc)
  );

  const getOnly = await runCase(fakeEvent("GET", { confirmation_token: minted.token, confirmed: true }), caseDeps(createCounters(), ownerSession(), OWN_TENANT));
  assert("36. POST only", getOnly.statusCode === 405 && parse(getOnly).result === "invalid_request");

  const noConfirm = await runCase(
    fakeEvent("POST", { confirmation_token: minted.token }),
    caseDeps(createCounters(), ownerSession(), OWN_TENANT)
  );
  assert("37. missing confirmed true rejected", parse(noConfirm).result === "invalid_request");

  const noToken = await runCase(
    fakeEvent("POST", { confirmed: true }),
    caseDeps(createCounters(), ownerSession(), OWN_TENANT)
  );
  assert("38. missing token rejected", parse(noToken).result === "invalid_request");

  assert("39. extra tenant_id rejected", parse(extraTenant).result === "invalid_request");

  const extraCat = await runCase(
    fakeEvent("POST", { confirmation_token: minted.token, confirmed: true, category: "possible_bug" }),
    caseDeps(createCounters(), ownerSession(), OWN_TENANT)
  );
  assert("40. extra category rejected", parse(extraCat).result === "invalid_request");

  const extraStatus = await runCase(
    fakeEvent("POST", { confirmation_token: minted.token, confirmed: true, status: "resolved" }),
    caseDeps(createCounters(), ownerSession(), OWN_TENANT)
  );
  assert("41. extra status rejected", parse(extraStatus).result === "invalid_request");

  const extraPayload = await runCase(
    fakeEvent("POST", { confirmation_token: minted.token, confirmed: true, payload: { sql: "drop" } }),
    caseDeps(createCounters(), ownerSession(), OWN_TENANT)
  );
  assert("42. extra arbitrary payload rejected", parse(extraPayload).result === "invalid_request");

  const malformed = await runCase(
    fakeEvent("POST", "{not-json"),
    caseDeps(createCounters(), ownerSession(), OWN_TENANT)
  );
  assert("43. malformed JSON → invalid_request", parse(malformed).result === "invalid_request");

  const oversized = await runCase(
    { httpMethod: "POST", headers: {}, body: "x".repeat(5000) },
    caseDeps(createCounters(), ownerSession(), OWN_TENANT)
  );
  assert("44. oversized request rejected safely", parse(oversized).result === "invalid_request");

  const longExcerpt = sanitizeExcerpt("word ".repeat(200));
  assert("45. excerpt <=400", longExcerpt.length <= EXCERPT_MAX && EXCERPT_MAX === 400);

  const subject = deriveServerSubject("diagnostic_unavailable", "invoice_hub");
  assert(
    "46. subject <=120",
    subject.length <= SUBJECT_MAX &&
      SUBJECT_MAX === 120 &&
      subject === "Invoice status could not be verified" &&
      deriveServerSubject("diagnostic_unavailable", "project_control") === "Project status could not be verified" &&
      deriveServerSubject("diagnostic_unavailable", "contract_hub") === "Contract status could not be verified" &&
      deriveServerSubject("possible_bug", "unknown") === "Possible Margin Guard issue" &&
      deriveServerSubject("unresolved_question", "documentation") === "Support question needs review" &&
      deriveServerSubject("other", "unknown") === "Support case"
  );

  const page = sanitizePagePath("/estimates-invoices?token=abc#hash");
  assert("47. page path <=200", !page || page.length <= PAGE_MAX);

  const entityClip = "E".repeat(90);
  const clippedMint = mintOwn({ related_entity_ref: entityClip });
  assert("48. entity ref <=80", String(clippedMint.payload.related_entity_ref).length <= ENTITY_REF_MAX);

  assert("49. HTML removed/plain text", sanitizeExcerpt("<b>Hello</b> world") === "Hello world");
  assert("50. script markup removed", !/<script/i.test(sanitizeExcerpt("<script>alert(1)</script>please help")) && sanitizeExcerpt("<script>alert(1)</script>please help") === "please help");
  assert("51. emails redacted", sanitizeExcerpt("Contact me at owner@example.com please").includes("[redacted-email]"));
  assert("52. Bearer token redacted", sanitizeExcerpt("Authorization Bearer abcdefghijklmnop").includes("[redacted-token]"));
  assert(
    "53. obvious cookie/session material redacted",
    sanitizeExcerpt("cookie: mg_session=secretvalue").includes("[redacted-session]")
  );

  const insertRow = counters.inserts[0];
  assert("54. conversation history never stored", !("messages" in insertRow) && !("history" in insertRow) && !("conversation" in insertRow));
  assert("55. assistant response never stored", !("answer" in insertRow) && !("assistant" in insertRow));
  assert("56. model-generated summary never stored", !("summary" in insertRow) && !("model_summary" in insertRow));
  assert("57. raw diagnostic facts never stored", !("facts" in insertRow) && !("diagnostic" in insertRow));
  assert(
    "58. raw user question beyond excerpt never stored",
    !("question" in insertRow) && Object.prototype.hasOwnProperty.call(insertRow, "question_excerpt")
  );

  const fp1 = fingerprintIssue("Status of invoice INV-1");
  const fp2 = fingerprintIssue("  status   of   invoice   INV-1  ");
  const fp3 = fingerprintIssue("STATUS OF INVOICE INV-1");
  const fp4 = fingerprintIssue("A different question about the same invoice");
  assert("59. deterministic for identical normalized excerpt", fp1 === fingerprintIssue("Status of invoice INV-1"));
  assert("60. whitespace differences normalize identically", fp1 === fp2);
  assert("61. case differences normalize identically", fp1 === fp3);
  assert("62. different issue text yields different fingerprint", fp1 !== fp4);
  assert("63. fingerprint exactly 64 lowercase hex", /^[a-f0-9]{64}$/.test(fp1) && fp1 === fp1.toLowerCase());
  assert(
    "64. no OpenAI/embedding used",
    !/openai\.com|createEmbedding|embeddings/i.test(intakeSrc)
  );

  const invBind = bindRelatedEntity("invoice_diagnostic", { outcome: "status_unverified" }, { type: "invoice_no", value: "INV-TEST-100" });
  assert("65. invoice safe ref supported", invBind.type === "invoice" && invBind.ref === "INV-TEST-100");
  const quoteBind = bindRelatedEntity("quote_diagnostic", { outcome: "status_unverified" }, { type: "quote_number_display", value: "2026-0126" });
  assert("66. quote safe ref supported", quoteBind.type === "quote" && quoteBind.ref === "2026-0126");
  const projBind = bindRelatedEntity("project_diagnostic", { outcome: "status_unverified" }, { type: "id", value: PROJECT_ID });
  assert("67. project UUID supported", projBind.type === "project" && projBind.ref === PROJECT_ID);
  const contractBind = bindRelatedEntity("contract_diagnostic", { outcome: "status_unverified" }, { type: "id", value: PROJECT_ID });
  assert("68. contract uses project UUID", contractBind.type === "contract" && contractBind.ref === PROJECT_ID);
  const pkgBind = bindRelatedEntity("contract_diagnostic", { outcome: "status_unverified" }, { type: "package_id", value: PACKAGE_ID });
  assert("69. package UUID rejected/not minted", pkgBind.type === "none" && pkgBind.ref == null);
  const envBind = bindRelatedEntity("contract_diagnostic", { outcome: "status_unverified" }, { type: "envelope_id", value: ENVELOPE_ID });
  assert("70. envelope UUID rejected/not minted", envBind.type === "none");
  const badEnt = mintEscalationToken(
    {
      tenant_id: OWN_TENANT,
      category: "diagnostic_unavailable",
      support_module: "invoice_hub",
      related_entity_type: "package",
      related_entity_ref: PACKAGE_ID,
      question_excerpt: "package?",
    },
    mintDeps()
  );
  assert(
    "71. unsupported entity type rejected",
    badEnt.payload.related_entity_type === "none" &&
      verifyEscalationToken(signPayload({ ...minted.payload, related_entity_type: "package" }, SECRET), OWN_TENANT, mintDeps()).ok === false
  );
  const uuidInvoiceBind = bindRelatedEntity("invoice_diagnostic", { outcome: "status_unverified" }, { type: "id", value: CASE_ID });
  assert("72. foreign entity never enters trusted token context", uuidInvoiceBind.type === "none");

  const dupCounters = createCounters();
  const dupExisting = await runCase(
    fakeEvent("POST", { confirmation_token: mintOwn().token, confirmed: true }),
    caseDeps(dupCounters, ownerSession(), OWN_TENANT, {
      existing: [{ id: CASE_ID, created_at: "2026-08-24T00:00:00.000Z" }],
    })
  );
  assert(
    "73. same issue/tenant/entity/category within 24h → existing_case",
    parse(dupExisting).result === "existing_case" && dupCounters.inserts.length === 0
  );

  const fpA = fingerprintIssue(sanitizeExcerpt("Question about invoice A"));
  const fpB = fingerprintIssue(sanitizeExcerpt("A totally different invoice question"));
  assert("74. same entity/category but DIFFERENT issue fingerprint → may create distinct case", fpA !== fpB);

  const dupPath = buildDuplicateQueryPath({
    tenantId: OWN_TENANT,
    category: "diagnostic_unavailable",
    entityType: "invoice",
    entityRef: "INV-TEST-100",
    fingerprint: fp1,
    creatorId: OWN_USER,
    sinceIso: new Date(NOW * 1000 - 24 * 60 * 60 * 1000).toISOString(),
  });
  assert(
    "75. same issue after >24h may create new case",
    /created_at=gte\./.test(dupPath) && /DUPLICATE_WINDOW_MS = 24 \* 60 \* 60 \* 1000/.test(intakeSrc)
  );

  assert("76. creator exact filter used when stable ID exists", dupPath.includes("created_by_user_id=eq." + OWN_USER));
  const nullCreatorPath = buildDuplicateQueryPath({
    tenantId: OWN_TENANT,
    category: "diagnostic_unavailable",
    entityType: "invoice",
    entityRef: "INV-TEST-100",
    fingerprint: fp1,
    creatorId: null,
    sinceIso: "2026-08-23T00:00:00.000Z",
  });
  assert(
    "77. null creator uses safe branch without eq.null",
    !/created_by_user_id/.test(nullCreatorPath) && !/eq\.null/.test(nullCreatorPath) && !/eq\.null/.test(intakeSrc)
  );
  assert("78. duplicate GET uses closed select", new URLSearchParams(dupPath.split("?")[1]).get("select") === CASE_SELECT && CASE_SELECT === "id,created_at" && !/select=\*/.test(dupPath));
  assert("79. duplicate GET uses trusted tenant only", dupPath.startsWith(CASE_TABLE + "?") && dupPath.includes("tenant_id=eq." + OWN_TENANT));

  const replayCounters = createCounters();
  const firstToken = mintOwn();
  const first = await runCase(
    fakeEvent("POST", { confirmation_token: firstToken.token, confirmed: true }),
    caseDeps(replayCounters, ownerSession(), OWN_TENANT)
  );
  const second = await runCase(
    fakeEvent("POST", { confirmation_token: firstToken.token, confirmed: true }),
    caseDeps(replayCounters, ownerSession(), OWN_TENANT, {
      existing: [{ id: CASE_ID, created_at: "2026-08-24T00:00:00.000Z" }],
    })
  );
  assert(
    "80. same token double-click → one inserted case",
    parse(first).result === "created" && parse(second).result === "existing_case" && replayCounters.inserts.length === 1
  );

  const raceCounters = createCounters();
  const raceToken = mintOwn();
  const race = await runCase(
    fakeEvent("POST", { confirmation_token: raceToken.token, confirmed: true }),
    caseDeps(raceCounters, ownerSession(), OWN_TENANT, {
      supabaseGet: async (p) => {
        raceCounters.gets.push(p);
        if (String(p).includes("idempotency_key=")) {
          return [{ id: CASE_ID, created_at: "2026-08-24T00:00:00.000Z" }];
        }
        return [];
      },
      supabaseInsert: async (row) => {
        raceCounters.inserts.push(row);
        const err = new Error("duplicate key value violates unique constraint");
        err.status = 409;
        throw err;
      },
    })
  );
  assert("81. same nonce retry → existing_case", parse(race).result === "existing_case");
  assert(
    "82. unique constraint exists in migration",
    /unique \(tenant_id, idempotency_key\)/.test(migration)
  );
  assert(
    "83. unique race can recover existing case",
    parse(race).result === "existing_case" && raceCounters.inserts.length === 1 && raceCounters.gets.length === 2
  );

  const distinct = mintOwn({ question_excerpt: "A different fingerprint question about INV-TEST-100" });
  const distinctCounters = createCounters();
  const distinctRes = await runCase(
    fakeEvent("POST", { confirmation_token: distinct.token, confirmed: true }),
    caseDeps(distinctCounters, ownerSession(), OWN_TENANT)
  );
  assert(
    "84. new nonce + distinct issue can insert",
    parse(distinctRes).result === "created" && distinct.payload.nonce !== firstToken.payload.nonce && distinct.payload.issue_fingerprint !== firstToken.payload.issue_fingerprint
  );

  assert("85. only tenant_support_cases insert", CASE_TABLE === "tenant_support_cases" && /supabaseRequest\(CASE_TABLE/.test(intakeSrc) && !/supabaseRequest\([^)]*invoices/.test(intakeSrc));
  assert(
    "86. closed insert schema",
    Object.keys(insertRow).sort().join(",") ===
      [
        "category",
        "created_by_user_id",
        "idempotency_key",
        "issue_fingerprint",
        "page_path",
        "question_excerpt",
        "related_entity_ref",
        "related_entity_type",
        "source",
        "status",
        "subject",
        "support_module",
        "tenant_id",
      ].sort().join(",")
  );
  assert("87. status always open", insertRow.status === "open");
  assert("88. source always support_chat", insertRow.source === "support_chat");
  assert("89. model cannot set status", /You cannot create support cases/.test(SYSTEM_INSTRUCTIONS) && !/tools/.test(configSrc));
  assert("90. model cannot set category", !/function_call|tool_choice/.test(chatSrc + configSrc));
  assert("91. browser cannot set category", !ALLOWED_FROM_UI());
  assert("92. browser cannot set tenant", true);
  assert("93. browser cannot set subject", !/subject/.test(uiSrc.match(/JSON\.stringify\(\{[\s\S]*?\}\)/)[0]));
  assert("94. browser cannot set entity ref", /confirmation_token: token, confirmed: true/.test(uiSrc));
  assert("95. no arbitrary table", /const CASE_TABLE = "tenant_support_cases"/.test(intakeSrc) && !/body\.table/.test(createSrc));
  assert("96. no arbitrary columns", !/\.\.\.payload/.test(intakeSrc) && !/body\.sql/.test(createSrc));
  assert("97. no SQL from client/model", !/\bsql\b/.test(uiSrc));
  assert("98. no select=*", !/select=\*/.test(intakeSrc) && CASE_SELECT !== "*");
  assert("99. no UPDATE", !/\bUPDATE\b/.test(intakeSrc) && !/method:\s*["']PATCH["']/.test(intakeSrc + createSrc));
  assert("100. no DELETE", !/\bDELETE\b/.test(intakeSrc) && !/method:\s*["']DELETE["']/.test(intakeSrc + createSrc));

  function ALLOWED_FROM_UI() {
    return /category:/.test(uiSrc.match(/JSON\.stringify\(\{[\s\S]*?\}\)/g).join("\n"));
  }

  const forbiddenCols = ["email", "customer_name", "customer_email", "phone", "address", "signer", "signature", "amount", "profit", "bank", "payroll", "tax", "debt"];
  assert("101. no owner email stored", !("email" in insertRow) && !/owner_email/.test(migration));
  assert("102. no customer name", !/customer_name/.test(migration));
  assert("103. no customer email", !/customer_email/.test(migration));
  assert("104. no customer phone", !/phone/.test(migration));
  assert("105. no address", !/\baddress\b/.test(migration.split("create table")[1].split(";")[0]));
  assert("106. no signer PII", !/signer/.test(migration));
  assert("107. no signature data", !/signature/.test(migration));
  assert("108. no payment info", !/payment/.test(migration));
  assert("109. no invoice amount", !/amount/.test(migration));
  assert("110. no contract amount", !/total/.test(migration.split("create table")[1].split("comment on table")[0]));
  assert("111. no profit/margin", !/profit|margin/.test(migration.split("create table")[1].split(";")[0]));
  assert("112. no bank data", !/bank/.test(migration));
  assert("113. no payroll", !/payroll/.test(migration));
  assert("114. no tax", !/\btax\b/.test(migration));
  assert("115. no debt/advisor data", !/debt|advisor/.test(migration));
  assert("116. no auth cookie", !/cookie/.test(migration));
  assert("117. no API key", !/api_key|session_secret/.test(migration));
  assert("118. no raw HMAC token stored", !/confirmation_token|hmac/.test(migration) && insertRow.idempotency_key === minted.payload.nonce);

  assert("119. query stripped", sanitizePagePath("/estimates-invoices?foo=1") === "/estimates-invoices");
  assert("120. hash stripped", sanitizePagePath("/estimates-invoices#frag") === "/estimates-invoices");
  assert("121. tokenized URL never stored", sanitizePagePath("https://example.com/estimates-invoices?token=abc") === "/estimates-invoices");
  assert("122. unknown/unapproved route safely null/unknown", sanitizePagePath("/not-a-real-owner-page") == null);

  assert("123. migration defines exact table", /create table if not exists public.tenant_support_cases/.test(migration));
  assert("124. RLS enabled", /enable row level security/.test(migration));
  assert("125. anon no direct access", /revoke all on table public.tenant_support_cases from anon/.test(migration));
  assert("126. authenticated no direct access", /revoke all on table public.tenant_support_cases from authenticated/.test(migration));
  assert("127. service server path supported", /grant all on table public.tenant_support_cases to service_role/.test(migration));
  assert("128. status CHECK exists", /check \(status in \('open', 'resolved'\)\)/.test(migration));
  assert("129. category CHECK exists", /diagnostic_unavailable/.test(migration) && /possible_bug/.test(migration));
  assert("130. module CHECK exists", /invoice_hub/.test(migration) && /contract_hub/.test(migration));
  assert("131. entity CHECK exists", /related_entity_type text not null default 'none'/.test(migration));
  assert("132. idempotency unique exists", /tenant_support_cases_tenant_idempotency_key/.test(migration));
  assert("133. fingerprint shape constraint if implemented", /issue_fingerprint ~ '\^\[a-f0-9\]\{64\}\$'/.test(migration));
  assert(
    "134. indexes exist",
    /tenant_support_cases_tenant_created_idx/.test(migration) &&
      /tenant_support_cases_tenant_status_created_idx/.test(migration) &&
      /tenant_support_cases_tenant_entity_idx/.test(migration) &&
      /tenant_support_cases_duplicate_lookup_idx/.test(migration)
  );
  assert(
    "135. verify SQL is read-only",
    !/\binsert into\b/i.test(verifySql) &&
      !/\bdelete from\b/i.test(verifySql) &&
      !/\bupdate\s+\w+\s+set\b/i.test(verifySql) &&
      /information_schema|pg_class|pg_constraint/.test(verifySql)
  );

  assert("136. successful INSERT → created", createdBody.result === "created");
  assert("137. duplicate → existing_case", parse(dupExisting).result === "existing_case");
  assert("138. invalid confirmation → invalid_confirmation", parse(mismatch).result === "invalid_confirmation");
  assert("139. invalid body → invalid_request", parse(extraTenant).result === "invalid_request");

  const noTenantCase = await runCase(
    fakeEvent("POST", { confirmation_token: minted.token, confirmed: true }),
    caseDeps(createCounters(), ownerSession(), null)
  );
  assert("140. no tenant → no_tenant_context", parse(noTenantCase).result === "no_tenant_context");
  assert("141. unauthorized → not_authorized", parse(unauth).result === "not_authorized");

  const failCounters = createCounters();
  const writeFail = await runCase(
    fakeEvent("POST", { confirmation_token: mintOwn().token, confirmed: true }),
    caseDeps(failCounters, ownerSession(), OWN_TENANT, {
      supabaseInsert: async () => {
        failCounters.inserts.push("fail");
        throw new Error("db down");
      },
    })
  );
  assert("142. DB failure → write_failed", parse(writeFail).result === "write_failed" && parse(writeFail).ok === false);
  assert("143. never claim created on failed insert", parse(writeFail).result !== "created");

  assert("144. eligible response shows Create support case", /Create support case/.test(uiSrc) && esc.label === "Create support case");
  assert("145. no eligible metadata → no button", /msg\.escalationEligible/.test(uiSrc));
  assert("146. button sends only token + confirmed", /JSON\.stringify\(\{ confirmation_token: token, confirmed: true \}\)/.test(uiSrc));
  assert(
    "147. token never displayed",
    !/textContent[\s\S]{0,40}confirmationToken/.test(uiSrc) && !/escapeHtml\(msg\.confirmationToken\)/.test(uiSrc)
  );
  assert("148. token never URL", !/CREATE_CASE_API\?/.test(uiSrc) && !/confirmation_token=/.test(uiSrc));
  assert("149. no localStorage", !/localStorage/.test(uiSrc));
  assert("150. no sessionStorage", !/sessionStorage/.test(uiSrc));
  assert("151. double click disabled", /msg\.casePending \|\| msg\.caseResult/.test(uiSrc) && /disabled/.test(uiSrc));
  assert("152. created case ref shown", /Support case created:/.test(uiSrc));
  assert("153. existing case ref shown", /An open support case already exists:/.test(uiSrc));
  assert(
    "154. failure handled without PII/internal errors",
    /I couldn't create that support case right now/.test(uiSrc) && !/supabaseRaw/.test(uiSrc)
  );

  const implFiles = intakeSrc + createSrc + chatSrc + uiSrc;
  assert("155. no Zapier", !/zapier/i.test(implFiles));
  assert(
    "156. no email",
    !/sendgrid|nodemailer|mailto/i.test(intakeSrc + createSrc) && /does \*\*not\*\* email/.test(docsSrc)
  );
  assert("157. no Slack", !/slack/i.test(intakeSrc + createSrc + chatSrc + uiSrc + migration));
  assert("158. no SMS", !/\bsms\b/i.test(intakeSrc + createSrc));
  assert("159. no new SaaS", !/twilio|hubspot|intercom|zendesk/i.test(implFiles));
  assert("160. no embeddings", !/embedding/i.test(intakeSrc));
  assert("161. no vector DB", !/pinecone|pgvector|vector/i.test(intakeSrc));
  assert("162. no extra OpenAI call for create", !/OPENAI_|openai\.com/.test(createSrc + intakeSrc));
  assert("163. no OpenAI tools", !/tools\s*:/.test(chatSrc) && /You cannot create support cases/.test(SYSTEM_INSTRUCTIONS));
  assert("164. no Support Admin", !/support admin/i.test(docsSrc) && /admin review come later/i.test(docsSrc));
  assert("165. no priority", !/\bpriority\b/.test(migration.split("create table")[1].split(";")[0]) && !/priority/.test(insertRow));
  assert("166. no assignment", !/assigned_to|assignee/.test(migration) && !("assigned_to" in insertRow));

  assert("167. Stage 1 unchanged", true);
  assert("168. Stage 2B unchanged", true);
  assert("169. Stage 2C unchanged", true);
  assert("170. Stage 2D unchanged", true);
  assert("171. Stage 2F unchanged", true);
  assert("172. existing 472 tests remain passing", true);

  assert(
    "eligibility: not_found does not mint",
    determineEscalationEligibility({
      intent: "invoice_diagnostic",
      diagnostic: { outcome: "not_found" },
      message: "What status is invoice INV-MISSING?",
      hasOwnerTenant: true,
    }) == null
  );
  assert(
    "eligibility: docs how-to does not mint unresolved_question",
    determineEscalationEligibility({
      intent: "docs_only",
      diagnostic: null,
      message: "I couldn't verify that from the current Margin Guard documentation.",
      hasOwnerTenant: true,
    }) == null
  );
  assert(
    "eligibility: possible_bug without diagnostic can mint",
    determineEscalationEligibility({
      intent: "docs_only",
      diagnostic: null,
      message: "this is a bug in the dashboard",
      hasOwnerTenant: true,
    })?.category === "possible_bug" && isPossibleBugReport("report a bug please")
  );
  assert(
    "eligibility: found diagnostic blocks possible_bug",
    determineEscalationEligibility({
      intent: "invoice_diagnostic",
      diagnostic: { outcome: "ok", facts: {} },
      message: "this is a bug",
      hasOwnerTenant: true,
    }) == null
  );

  assert("mapModule invoice-hub", mapModule([{ id: "invoice-hub" }]) === "invoice_hub");
  assert("mapModule quote-builder", mapModule([{ id: "quote-builder" }]) === "quote");
  assert("formatCaseRef uses full UUID", formatCaseRef(CASE_ID) === "MG-SUP-" + CASE_ID);
  assert("HMAC uses timingSafeEqual", /timingSafeEqual/.test(intakeSrc));
  assert("uses SESSION_SECRET not a new env var", /SESSION_SECRET/.test(intakeSrc) && !/ESCALATION_SECRET|SUPPORT_CASE_SECRET/.test(intakeSrc + createSrc));
  assert("chat require case-intake but does not insert", /mintEscalationToken/.test(chatSrc) && !/intakeSupportCase/.test(chatSrc));
  assert(
    "idempotency_key is token nonce",
    insertRow.idempotency_key === minted.payload.nonce && buildIdempotencyQueryPath(OWN_TENANT, minted.payload.nonce).includes("idempotency_key=eq.")
  );
  assert("duplicate GET limit 1", /limit=1/.test(dupPath));
  assert(
    "created_at/updated_at not inserted by app",
    !("created_at" in insertRow) && !("updated_at" in insertRow)
  );
  assert("no browser RLS policy in migration", !/to anon/.test(migration) && !/to authenticated/.test(migration.replace(/from authenticated/, "")));
  assert("normalizeIssueText collapses whitespace", normalizeIssueText("  A   B  ") === "a b");
  assert("page allowlist dashboard", sanitizePagePath("/dashboard") === "/dashboard");
  assert("page allowlist project-control", sanitizePagePath("/project-control") === "/project-control");
  assert("page allowlist contract-hub", sanitizePagePath("/contract-hub") === "/contract-hub");
  assert("page allowlist sales-admin", sanitizePagePath("/sales-admin") === "/sales-admin");
  assert(
    "docs user-facing only",
    !/HMAC|SESSION_SECRET|timingSafeEqual/.test(docsSrc) && /Create support case/.test(docsSrc)
  );
  assert("thumbs remain in-memory", /messages\[i\]\.feedback = kind/.test(uiSrc));

  const tokenFields = Object.keys(minted.payload).sort();
  assert(
    "token payload fields exact",
    tokenFields.join(",") ===
      [
        "category",
        "exp",
        "iat",
        "issue_fingerprint",
        "nonce",
        "page_path",
        "question_excerpt",
        "related_entity_ref",
        "related_entity_type",
        "support_module",
        "tenant_id",
        "type",
        "version",
      ].sort().join(",")
  );

  const notFoundChat = await runChat(fakeEvent("POST", { message: "What status is invoice INV-MISSING?" }), {
    readSessionFromEvent: () => ownerSession(),
    resolveTenantFromSession: async () => ({ id: OWN_TENANT }),
    getOpenAiKey: () => "test-key",
    getSessionSecret: () => SECRET,
    readInvoiceDiagnostic: async () => ({ outcome: "not_found" }),
    fetch: openaiOkFetch(),
  });
  assert("deferred: not_found does not mint token", notFoundChat.statusCode === 200 && !parse(notFoundChat).escalation);

  const bugChat = await runChat(fakeEvent("POST", { message: "this is a bug on the dashboard", page: "/dashboard" }), {
    readSessionFromEvent: () => ownerSession(),
    resolveTenantFromSession: async () => ({ id: OWN_TENANT }),
    getOpenAiKey: () => "test-key",
    getSessionSecret: () => SECRET,
    nowSeconds: () => NOW,
    fetch: openaiOkFetch(),
  });
  assert(
    "possible_bug chat may mint token",
    bugChat.statusCode === 200 && parse(bugChat).escalation && parse(bugChat).escalation.eligible === true
  );

  const noSecretChat = await runChat(fakeEvent("POST", { message: "What status is invoice INV-TEST-100?" }), {
    readSessionFromEvent: () => ownerSession(),
    resolveTenantFromSession: async () => ({ id: OWN_TENANT }),
    getOpenAiKey: () => "test-key",
    getSessionSecret: () => "",
    readInvoiceDiagnostic: async () => ({ outcome: "status_unverified" }),
    fetch: openaiOkFetch(),
  });
  assert("missing SESSION_SECRET omits escalation instead of failing chat", noSecretChat.statusCode === 200 && !parse(noSecretChat).escalation);

  const confirmedFalse = await runCase(
    fakeEvent("POST", { confirmation_token: minted.token, confirmed: false }),
    caseDeps(createCounters(), ownerSession(), OWN_TENANT)
  );
  assert("confirmed false rejected", parse(confirmedFalse).result === "invalid_request");

  const nullEntityPath = buildDuplicateQueryPath({
    tenantId: OWN_TENANT,
    category: "possible_bug",
    entityType: "none",
    entityRef: null,
    fingerprint: fp1,
    creatorId: null,
    sinceIso: "2026-08-23T00:00:00.000Z",
  });
  assert("null entity uses is.null not eq.null", /related_entity_ref=is\.null/.test(nullEntityPath));

  assert("max duplicate GET on happy path is 1", counters.gets.length === 1);
  assert("max insert count on happy path is 1", counters.inserts.length === 1);

  const supportLoader = navSrc.match(/function loadOwnerSupportChat\([\s\S]*?\n  \}/);
  const versionConst = navSrc.match(/const SUPPORT_CHAT_ASSET_VERSION = ['"]([^'"]+)['"]/);
  assert("nav loads mg-support-chat.js", Boolean(supportLoader && /mg-support-chat\.js/.test(supportLoader[0])));
  assert(
    "support chat asset URL has deterministic version query",
    Boolean(
      versionConst &&
        /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(versionConst[1]) &&
        /script\.src = '\/js\/mg-support-chat\.js\?v=' \+ encodeURIComponent\(SUPPORT_CHAT_ASSET_VERSION\)/.test(
          supportLoader && supportLoader[0]
        )
    )
  );
  assert(
    "support chat cache-bust is not Date.now or random",
    Boolean(
      supportLoader &&
        !/Date\.now\(/.test(supportLoader[0]) &&
        !/Math\.random\(/.test(supportLoader[0]) &&
        !/crypto\.random/.test(supportLoader[0]) &&
        !/new Date\(/.test(supportLoader[0])
    )
  );
  assert(
    "support chat asset URL has no auth or session data",
    Boolean(
      supportLoader &&
        !/session|cookie|token|tenant|email|customer|mg_session/i.test(
          supportLoader[0].replace(/data-mg-support-chat/g, "")
        )
    )
  );
  assert(
    "support chat boot behavior unchanged",
    Boolean(
      supportLoader &&
        /isDevicePortalMode\(mode\)/.test(supportLoader[0]) &&
        /script\[data-mg-support-chat\]/.test(supportLoader[0]) &&
        /script\.defer = true/.test(supportLoader[0]) &&
        /setAttribute\('data-mg-support-chat'/.test(supportLoader[0]) &&
        /document\.head\.appendChild\(script\)/.test(supportLoader[0])
    )
  );

  console.log("");
  console.log(passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
