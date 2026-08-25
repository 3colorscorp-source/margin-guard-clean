#!/usr/bin/env node
/**
 * MG-SUPPORT-003D.B — supervisor visibility + public estimate diagnostics
 * (mocked OpenAI and Supabase). Usage: node scripts/test-mg-support-003d.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const { classifySupportIntent, routeSupportKnowledge } = require("../netlify/functions/_lib/mg-support/router");
const { createHandler } = require("../netlify/functions/mg-support-chat");
const { determineEscalationEligibility } = require("../netlify/functions/_lib/mg-support/case-intake");
const {
  extractProjectIdentifier,
  isProjectDiagnosticQuestion,
  readProjectDiagnostic,
} = require("../netlify/functions/_lib/mg-support/project-diagnostic");
const {
  extractQuoteIdentifier,
  isQuoteDiagnosticQuestion,
  readQuoteDiagnostic,
} = require("../netlify/functions/_lib/mg-support/quote-diagnostic");
const {
  CASE_A,
  CASE_A_PERSON_UNVERIFIED,
  CASE_A_NEXT_STEP,
  CASE_B,
  CASE_C,
  CASE_D,
  CASE_E,
  CASE_F,
  isSupervisorVisibilityQuestion,
  supervisorVisibilityAnswer,
} = require("../netlify/functions/_lib/mg-support/supervisor-visibility-conclusion");

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

function fakeEvent(method, bodyObj) {
  return {
    httpMethod: method,
    headers: {},
    body: bodyObj == null ? "" : JSON.stringify(bodyObj),
  };
}

function extractProjectFacts(input) {
  const match = String(input || "").match(
    /MARGIN_GUARD_VERIFIED_PROJECT_DIAGNOSTIC_FACTS\n(\{[\s\S]*?\})\nEND_MARGIN_GUARD_VERIFIED_PROJECT_DIAGNOSTIC_FACTS/
  );
  if (!match) return null;
  return JSON.parse(match[1]);
}

function extractQuoteFacts(input) {
  const match = String(input || "").match(
    /MARGIN_GUARD_VERIFIED_QUOTE_DIAGNOSTIC_FACTS\n(\{[\s\S]*?\})\nEND_MARGIN_GUARD_VERIFIED_QUOTE_DIAGNOSTIC_FACTS/
  );
  if (!match) return null;
  return JSON.parse(match[1]);
}

function openaiOkFetch(capture) {
  return async (url, opts) => {
    if (capture) {
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
const OWN_PROJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWN_QUOTE_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const OWN_PROJECT_NAME = "Roof Replacement North";

async function main() {
  const supervisorSrc = read("netlify/functions/get-supervisor-projects.js");
  const publicEstSrc = read("netlify/functions/get-public-estimate.js");
  const updatePublicSrc = read("netlify/functions/update-public-estimate-status.js");
  const projectSrc = read("netlify/functions/_lib/mg-support/project-diagnostic.js");
  const quoteSrc = read("netlify/functions/_lib/mg-support/quote-diagnostic.js");
  const chatSrc = read("netlify/functions/mg-support-chat.js");
  const routerSrc = read("netlify/functions/_lib/mg-support/router.js");
  const createCaseSrc = read("netlify/functions/mg-support-create-case.js");
  const adminJsSrc = read("public/js/support-admin.js");
  const supportChatJs = read("public/js/mg-support-chat.js");
  const readme = read("docs/margin-guard-support/README.md");
  const projectDocs = read("docs/margin-guard-support/project-control.md");
  const quoteDocs = read("docs/margin-guard-support/quote-builder.md");

  assert(
    "canonical supervisor project statuses are signed,deposit_paid,assigned,in_progress,completed",
    /PROJECT_STATUSES = \["signed", "deposit_paid", "assigned", "in_progress", "completed"\]/.test(
      supervisorSrc
    )
  );
  assert(
    "canonical supervisor quote statuses are accepted|approved",
    /QUOTE_STATUSES_ALLOWED = new Set\(\["accepted", "approved"\]\)/.test(supervisorSrc)
  );
  assert(
    "canonical device list additionally filters by supervisor_user_id",
    /filterRowsAssignedToSupervisor/.test(supervisorSrc) &&
      /auth_mode === "device"/.test(supervisorSrc)
  );
  assert(
    "canonical public estimate GET is token-only, no status filter",
    /public_token=eq\./.test(publicEstSrc) &&
      !/quotes\?[^`"\n]*status=eq/.test(publicEstSrc)
  );
  assert(
    "canonical public estimate GET does not filter by expiration",
    !/expiration_date=/.test(publicEstSrc.split("exports.handler")[1] || publicEstSrc)
  );
  assert(
    "canonical accept/decline does not expire-gate the page write",
    /quoteAlreadyAccepted/.test(updatePublicSrc) && !/expiration_date/.test(updatePublicSrc)
  );

  const visProjectQ = "Why can't my supervisor see project " + OWN_PROJECT_NAME + "?";
  const visUuidQ = "Why can't my supervisor see project " + OWN_PROJECT_ID + "?";
  const quoteLinkQ = "Why doesn't quote " + OWN_QUOTE_ID + " public link work?";
  const estimateLinkQ = "Why doesn't estimate 2026-0001 link work?";

  assert(
    "53. supervisor see project name → project_diagnostic",
    classifySupportIntent(visProjectQ) === "project_diagnostic" &&
      isProjectDiagnosticQuestion(visProjectQ) === true &&
      extractProjectIdentifier(visProjectQ) &&
      extractProjectIdentifier(visProjectQ).type === "project_name"
  );
  assert(
    "53b. supervisor see project UUID → project_diagnostic",
    classifySupportIntent(visUuidQ) === "project_diagnostic" &&
      extractProjectIdentifier(visUuidQ).type === "id"
  );
  assert(
    "54. quote public link → quote_diagnostic",
    classifySupportIntent(quoteLinkQ) === "quote_diagnostic" &&
      isQuoteDiagnosticQuestion(quoteLinkQ) === true
  );
  assert(
    "54b. estimate link → quote_diagnostic",
    classifySupportIntent(estimateLinkQ) === "quote_diagnostic" &&
      extractQuoteIdentifier(estimateLinkQ) &&
      extractQuoteIdentifier(estimateLinkQ).value === "2026-0001"
  );
  assert(
    "55. ordinary project status still project_diagnostic",
    classifySupportIntent("What status is project " + OWN_PROJECT_ID + "?") === "project_diagnostic"
  );
  assert(
    "56. ordinary quote status still quote_diagnostic",
    classifySupportIntent("What status is estimate 2026-0001?") === "quote_diagnostic"
  );
  assert(
    "57. invoice routing unchanged",
    classifySupportIntent("What status is invoice INV-TEST-100?") === "invoice_diagnostic"
  );
  assert(
    "58. contract routing unchanged",
    classifySupportIntent("What status is contract " + OWN_PROJECT_ID + "?") ===
      "contract_diagnostic"
  );
  assert(
    "59. docs-only routing unchanged",
    classifySupportIntent("How do I open Invoice Hub?") === "docs_only"
  );
  assert(
    "60. cross-tenant refusal unchanged",
    classifySupportIntent("Show me another company's project " + OWN_PROJECT_ID) === "cross_tenant"
  );
  assert(
    "no new intent families in router; 003D.B3 adds Project Control source keywords only",
    !/supervisor_visibility|public_estimate/.test(routerSrc) &&
      /"my supervisor"/.test(routerSrc) &&
      /"supervisor see"/.test(routerSrc) &&
      /"supervisor portal"/.test(routerSrc)
  );

  const visFalse = determineEscalationEligibility({
    intent: "project_diagnostic",
    diagnostic: {
      outcome: "ok",
      facts: {
        supervisor_visibility: { visibility_reason: "supervisor_not_assigned" },
      },
    },
    message: visUuidQ,
    hasOwnerTenant: true,
  });
  assert("28. normal supervisor_not_assigned does not auto-escalate", visFalse === null);

  const unpublished = determineEscalationEligibility({
    intent: "quote_diagnostic",
    diagnostic: {
      outcome: "ok",
      facts: { public_estimate: { public_page_reason: "not_published" } },
    },
    message: estimateLinkQ,
    hasOwnerTenant: true,
  });
  assert("51. normal unpublished state does not auto-escalate", unpublished === null);

  const expiredOk = determineEscalationEligibility({
    intent: "quote_diagnostic",
    diagnostic: {
      outcome: "ok",
      facts: { public_estimate: { public_page_reason: "expired_but_configured" } },
    },
    message: estimateLinkQ,
    hasOwnerTenant: true,
  });
  assert("expired public page does not auto-escalate", expiredOk === null);

  const unverified = determineEscalationEligibility({
    intent: "project_diagnostic",
    diagnostic: { outcome: "status_unverified" },
    message: visUuidQ,
    hasOwnerTenant: true,
  });
  assert(
    "52. status_unverified still eligible under existing rules only",
    unverified && unverified.category === "diagnostic_unavailable"
  );

  const sessionOk = () => ({ e: "owner@example.com", c: "cus_test" });
  let visDb = 0;
  const visChat = await createHandler({
    readSessionFromEvent: sessionOk,
    resolveTenantFromSession: async () => ({ id: OWN_TENANT }),
    getOpenAiKey: () => "test-key",
    getSessionSecret: () => "test-secret-value-32chars-minimum!!",
    supabaseGet: async (p) => {
      visDb += 1;
      if (String(p).startsWith("quotes?")) return [{ id: "q1", status: "accepted" }];
      return [
        {
          id: OWN_PROJECT_ID,
          tenant_id: OWN_TENANT,
          project_name: OWN_PROJECT_NAME,
          status: "in_progress",
          supervisor_user_id: null,
          created_at: "2026-07-01T12:00:00.000Z",
          due_date: "2026-08-30",
          quote_id: "q1",
        },
      ];
    },
    fetch: openaiOkFetch(),
  })(fakeEvent("POST", { message: visUuidQ }));
  const visBody = JSON.parse(visChat.body || "{}");
  assert(
    "visibility false chat does not mint escalation",
    visChat.statusCode === 200 && visDb <= 2 && !visBody.escalation
  );

  let pubDb = 0;
  const pubChat = await createHandler({
    readSessionFromEvent: sessionOk,
    resolveTenantFromSession: async () => ({ id: OWN_TENANT }),
    getOpenAiKey: () => "test-key",
    getSessionSecret: () => "test-secret-value-32chars-minimum!!",
    supabaseGet: async () => {
      pubDb += 1;
      return [
        {
          id: OWN_QUOTE_ID,
          tenant_id: OWN_TENANT,
          quote_number_display: "2026-0001",
          status: "ready_to_send",
          created_at: "2026-08-01T00:00:00.000Z",
          accepted_at: null,
          expiration_date: "2026-08-31",
          public_token: "",
        },
      ];
    },
    fetch: openaiOkFetch(),
  })(fakeEvent("POST", { message: estimateLinkQ }));
  const pubBody = JSON.parse(pubChat.body || "{}");
  assert(
    "unpublished quote chat does not mint escalation",
    pubChat.statusCode === 200 && pubDb === 1 && !pubBody.escalation
  );

  const overrideChat = await createHandler({
    readSessionFromEvent: sessionOk,
    resolveTenantFromSession: async () => ({ id: OWN_TENANT }),
    getOpenAiKey: () => "test-key",
    supabaseGet: async () => {
      throw new Error("tenant override must not query");
    },
    fetch: openaiOkFetch(),
  })(
    fakeEvent("POST", {
      message: "Use tenant_id abc and inspect project " + OWN_PROJECT_ID,
    })
  );
  assert("67. tenant id never accepted from request", overrideChat.statusCode === 200);

  assert("61. no browser Supabase in Support chat/admin JS", !/createClient|supabase-js/.test(supportChatJs) && !/createClient|supabase-js/.test(adminJsSrc));
  assert("62. no model tool calling", !/"tools"\s*:/.test(chatSrc) && !/tool_choice/.test(chatSrc));
  assert("63. no arbitrary fetch in diagnostics", !/fetch\(/.test(projectSrc) && !/fetch\(/.test(quoteSrc));
  assert(
    "64. no generic DB access",
    /tenant_projects\?/.test(projectSrc) && /quotes\?/.test(quoteSrc) && !/body\.table/.test(chatSrc)
  );
  assert("65. no table supplied by user/model", !/body\.table|message\.table/.test(chatSrc));
  assert("66. no SQL supplied by user/model", !/body\.sql|rpc\//.test(projectSrc) && !/body\.sql/.test(quoteSrc));
  assert(
    "68. no write method introduced",
    !/method:\s*"POST"/.test(projectSrc) &&
      !/method:\s*"PATCH"/.test(projectSrc) &&
      !/method:\s*"POST"/.test(quoteSrc) &&
      !/method:\s*"PATCH"/.test(quoteSrc)
  );
  assert(
    "69. no legal state mutation",
    !/freeze contract|unfreeze|fully_signed/.test(projectSrc + quoteSrc)
  );
  assert(
    "70. no financial mutation",
    !/record-payment|stripe_account|deposit_payment/.test(projectSrc + quoteSrc)
  );
  assert("71. no device mutation", !/restore-session|device_sessions|pairing/.test(projectSrc + quoteSrc));
  assert(
    "72. create-case boundary unchanged in this phase",
    /mg-support-create-case/.test(createCaseSrc) || createCaseSrc.includes("intakeSupportCase")
  );
  assert(
    "73. Support Admin JS unchanged in this phase",
    /syncSelectedFromRefreshedList/.test(adminJsSrc)
  );
  assert("no assignment action", !/assign-supervisor/.test(projectSrc + chatSrc + supportChatJs));
  assert("no publish action", !/publish-public-quote/.test(quoteSrc + chatSrc + supportChatJs));
  assert("no resend action", !/send-invoice-zapier|resend/.test(projectSrc + quoteSrc));
  assert("Support does not call supervisor list endpoint", !/get-supervisor-projects/.test(projectSrc + chatSrc));
  assert("Support does not probe public estimate by token", !/get-public-estimate/.test(quoteSrc + chatSrc));
  assert(
    "README no longer claims Support cannot inspect live data",
    /limited, authenticated, read-only diagnostics/i.test(readme) &&
      !/cannot inspect\*\* a tenant’s invoices/i.test(readme) &&
      !/a diagnostic tool for one tenant/i.test(readme)
  );
  assert(
    "README does not claim arbitrary account access",
    /cannot perform arbitrary account or database access/i.test(readme)
  );
  assert("project docs cover supervisor portal visibility", /Supervisor portal visibility/i.test(projectDocs));
  assert(
    "project docs require person-in-mind identity caveat and forbid permission/admin diagnosis",
    /cannot verify that the person you have in mind is the same supervisor currently assigned/i.test(
      projectDocs
    ) &&
      /Do not diagnose permission settings, administrative settings, or device\/session state/.test(
        projectDocs
      )
  );
  assert(
    "quote docs distinguish configured reference vs expired vs action",
    /Public estimate page/i.test(quoteDocs) &&
      /expiration by itself does \*\*not\*\* disable the public estimate endpoint/i.test(quoteDocs)
  );
  assert(
    "quote docs require endpoint-probe boundary and accepted-state causality",
    /did not probe the public endpoint/i.test(quoteDocs) &&
      /because of that quote state/i.test(quoteDocs) &&
      /Do not describe the public estimate reference as expired/.test(quoteDocs)
  );

  const configSrc = read("netlify/functions/_lib/mg-support/config.js");
  assert(
    "no can_appear_in_supervisor_portal overclaim fact remains",
    !/can_appear_in_supervisor_portal/.test(projectSrc) &&
      !/can_appear_in_supervisor_portal/.test(configSrc)
  );
  assert(
    "positive supervisor reason is eligible_for_assigned_supervisor",
    /eligible_for_assigned_supervisor/.test(projectSrc) &&
      /currently assigned/i.test(configSrc)
  );
  assert(
    "guidance forbids your supervisor can see",
    /Never say your supervisor can see this project/.test(configSrc)
  );
  assert(
    "can_load_public_page removed from diagnostic and guidance",
    !/can_load_public_page/.test(quoteSrc) && !/can_load_public_page/.test(configSrc)
  );
  assert(
    "no successful-load public guidance",
    !/can_load_public_page/.test(configSrc) &&
      /Never say the link definitely works/.test(configSrc) &&
      /public estimate reference configured/i.test(configSrc)
  );
  assert(
    "no uniqueness or duplicate-token user claim in diagnostic",
    !/duplicate public_token|unique constraint/.test(quoteSrc)
  );

  const noId = extractProjectIdentifier("project 103");
  assert("malformed bare project number still rejected", noId === null);
  const noQuoteBare = extractQuoteIdentifier("quote 103");
  assert("bare integer quote still rejected", noQuoteBare === null);

  const missingProject = await readProjectDiagnostic(OWN_TENANT, {
    type: "id",
    value: OWN_PROJECT_ID,
  }, { supabaseGet: async () => [] });
  assert("not_found behavior unchanged", missingProject.outcome === "not_found");

  const amb = await readProjectDiagnostic(OWN_TENANT, {
    type: "project_name",
    value: OWN_PROJECT_NAME,
  }, {
    supabaseGet: async () => [
      { id: OWN_PROJECT_ID, tenant_id: OWN_TENANT, project_name: OWN_PROJECT_NAME, status: "signed" },
      { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", tenant_id: OWN_TENANT, project_name: OWN_PROJECT_NAME, status: "signed" },
    ],
  });
  assert("ambiguous behavior unchanged", amb.outcome === "ambiguous");

  const missingQuote = await readQuoteDiagnostic(
    OWN_TENANT,
    { type: "quote_number_display", value: "2026-0001" },
    { supabaseGet: async () => [] }
  );
  assert("quote not_found unchanged", missingQuote.outcome === "not_found");

  const smoke1Q = "Why can't my supervisor see project Master & Downstairs Bathroom?";
  const smoke1FromOwner = routeSupportKnowledge(smoke1Q, "/owner");
  const smoke1FromSales = routeSupportKnowledge(smoke1Q, "/sales");
  const smoke1Empty = routeSupportKnowledge(smoke1Q, "");
  assert(
    "26. supervisor visibility from owner page sources Project Control",
    classifySupportIntent(smoke1Q) === "project_diagnostic" &&
      smoke1FromOwner.some((m) => m.id === "project-control") &&
      smoke1FromOwner[0].title === "Project Control"
  );
  assert(
    "26b. supervisor visibility from sales page still sources Project Control",
    smoke1FromSales.some((m) => m.id === "project-control") &&
      smoke1FromSales[0].title === "Project Control"
  );
  assert(
    "26c. supervisor visibility with no page sources Project Control",
    smoke1Empty.some((m) => m.id === "project-control")
  );
  assert(
    "28. ordinary project diagnostic source unchanged",
    routeSupportKnowledge("What status is project " + OWN_PROJECT_ID + "?", "").some(
      (m) => m.id === "project-control"
    ) ||
      routeSupportKnowledge("When is project " + OWN_PROJECT_ID + " due?", "").some(
        (m) => m.id === "project-control"
      )
  );

  const smoke2Q = "Does the public estimate link work for quote 2026-0141?";
  const smoke2Mods = routeSupportKnowledge(smoke2Q, "/project-control");
  assert(
    "27. quote link response remains Quote Builder",
    classifySupportIntent(smoke2Q) === "quote_diagnostic" &&
      smoke2Mods.some((m) => m.id === "quote-builder") &&
      smoke2Mods[0].title === "Quote Builder"
  );
  assert(
    "29. ordinary quote diagnostic source unchanged",
    routeSupportKnowledge("What status is estimate 2026-0001?", "").some((m) => m.id === "quote-builder")
  );

  assert(
    "2. positive guidance says currently assigned supervisor",
    /currently assigned supervisor/i.test(configSrc) ||
      /supervisor currently assigned to this project/i.test(configSrc)
  );
  assert(
    "3. guidance says Support cannot verify person-in-mind identity match",
    /cannot verify that the person you have in mind is the same supervisor currently assigned/i.test(
      configSrc
    )
  );
  assert(
    "4. guidance forbids your supervisor can see",
    /Never say your supervisor can see this project/.test(configSrc)
  );
  assert(
    "5. no permission-setting diagnosis",
    /Never say check their permissions/.test(configSrc) &&
      /does not inspect permissions/.test(configSrc)
  );
  assert(
    "6. no administrative-settings diagnosis",
    /Never say administrative settings may be wrong/.test(configSrc)
  );
  assert(
    "7. no device diagnosis",
    /Never invent permission settings, administrative settings, device sessions/.test(configSrc)
  );

  const smoke1Capture = {};
  const smoke1Res = await createHandler({
    readSessionFromEvent: sessionOk,
    resolveTenantFromSession: async () => ({ id: OWN_TENANT }),
    getOpenAiKey: () => "test-key",
    supabaseGet: async (p) => {
      if (String(p).startsWith("quotes?")) return [{ id: "q1", status: "accepted" }];
      return [
        {
          id: OWN_PROJECT_ID,
          tenant_id: OWN_TENANT,
          project_name: "Master & Downstairs Bathroom",
          status: "in_progress",
          supervisor_user_id: "assigned-but-secret",
          created_at: "2026-07-01T12:00:00.000Z",
          due_date: "2026-08-30",
          quote_id: "q1",
        },
      ];
    },
    fetch: openaiOkFetch(smoke1Capture),
  })(
    fakeEvent("POST", {
      message: smoke1Q,
      page: "/owner",
    })
  );
  const smoke1Body = JSON.parse(smoke1Res.body || "{}");
  const smoke1Answer = String(smoke1Body.answer || "");
  assert(
    "1. live smoke supervisor question is project diagnostic with Project Control source",
    smoke1Res.statusCode === 200 &&
      Array.isArray(smoke1Body.sources) &&
      smoke1Body.sources[0] === "Project Control" &&
      smoke1Answer.includes(CASE_A) &&
      smoke1Answer.includes(CASE_A_PERSON_UNVERIFIED) &&
      smoke1Answer.includes(CASE_A_NEXT_STEP) &&
      !smoke1Capture.url
  );
  assert(
    "8. no supervisor identity in live smoke answer",
    !/assigned-but-secret/.test(smoke1Answer) &&
      !/assigned-but-secret/.test(JSON.stringify(smoke1Body)) &&
      !/supervisor_user_id/.test(smoke1Answer)
  );
  assert(
    "9-10. live smoke supervisor uses existing reads only, no write, no OpenAI",
    !/method:\s*"POST"/.test(projectSrc) && !smoke1Capture.url
  );

  const smoke2Capture = {};
  const smoke2Res = await createHandler({
    readSessionFromEvent: sessionOk,
    resolveTenantFromSession: async () => ({ id: OWN_TENANT }),
    utcToday: "2026-08-25",
    getOpenAiKey: () => "test-key",
    supabaseGet: async () => [
      {
        id: OWN_QUOTE_ID,
        tenant_id: OWN_TENANT,
        quote_number_display: "2026-0141",
        status: "accepted",
        created_at: "2026-07-01T00:00:00.000Z",
        accepted_at: "2026-07-15T00:00:00.000Z",
        expiration_date: "2026-08-01",
        public_token: "qt_secret_token_value",
        client_name: "Secret Client",
        client_email: "should-not-leak@example.com",
        total: 9999,
        deposit_required: 1000,
      },
    ],
    fetch: openaiOkFetch(smoke2Capture),
  })(fakeEvent("POST", { message: smoke2Q, page: "/owner" }));
  const smoke2Body = JSON.parse(smoke2Res.body || "{}");
  const smoke2Input = String((smoke2Capture.payload || {}).input || "");
  assert(
    "11. live smoke public-link question is quote diagnostic with Quote Builder source",
    smoke2Res.statusCode === 200 &&
      Array.isArray(smoke2Body.sources) &&
      smoke2Body.sources[0] === "Quote Builder" &&
      classifySupportIntent(smoke2Q) === "quote_diagnostic"
  );
  assert(
    "12-13. answer guidance explicitly states no endpoint probe / cannot confirm load",
    /did not probe the public endpoint/i.test(smoke2Input) &&
      /cannot confirm that the page successfully loads/i.test(smoke2Input)
  );
  assert(
    "14-16. public reference configured is separate from expiration; reference never expired",
    /Keep Public Estimate Reference as Configured separate from Quote Expiration as Passed/.test(
      smoke2Input
    ) &&
      /Never describe the public estimate reference, token, or link as expired/.test(smoke2Input) &&
      /Expiration by itself does not disable the public estimate endpoint/.test(smoke2Input)
  );
  assert(
    "17-18. accept/decline false due to accepted quote state, not expiration",
    /The quote is already accepted, so accept\/decline is no longer available/.test(smoke2Input) &&
      /Do not attribute accept\/decline unavailability to expiration/.test(smoke2Input) &&
      /expired_but_configured, that means the quote expiration date has passed/.test(smoke2Input)
  );
  assert(
    "19-20. no verified-success wording",
    /Never say the link definitely works/.test(smoke2Input) &&
      /Never say the link is set up correctly/.test(smoke2Input)
  );
  assert(
    "21-24. no token, URL, PII, or money in smoke 2 facts",
    !/qt_secret_token_value/.test(smoke2Input) &&
      !/estimate-public\.html/.test(smoke2Input) &&
      !/Secret Client/.test(smoke2Input) &&
      !/should-not-leak@example.com/.test(smoke2Input) &&
      !smoke2Input.includes("9999")
  );
  assert("25. no public network probe in quote diagnostic", !/get-public-estimate/.test(quoteSrc));
  const smoke2Facts = extractQuoteFacts(smoke2Input);
  assert(
    "smoke 2 facts keep configured reference, expiration, and quote-state action separate",
    smoke2Facts &&
      smoke2Facts.status === "accepted" &&
      smoke2Facts.public_estimate &&
      smoke2Facts.public_estimate.public_page_configured === true &&
      smoke2Facts.public_estimate.public_reference_format_valid === true &&
      smoke2Facts.public_estimate.expired === true &&
      smoke2Facts.public_estimate.response_action_allowed_by_quote_state === false &&
      !Object.prototype.hasOwnProperty.call(smoke2Facts, "can_load_public_page") &&
      !Object.prototype.hasOwnProperty.call(smoke2Facts.public_estimate, "can_load_public_page")
  );
  assert(
    "30. router classify chain unchanged",
    /if \(isQuoteDiagnosticQuestion\(message\)\) \{\s*return "quote_diagnostic";/.test(routerSrc) &&
      /if \(isProjectDiagnosticQuestion\(message\)\) \{\s*return "project_diagnostic";/.test(routerSrc)
  );

  function unsafeSupervisorSpeculation(text) {
    const t = String(text || "");
    return (
      /your supervisor can see/i.test(t) ||
      /your supervisor cannot see[\s\S]{0,80}because/i.test(t) ||
      /display(?:ing)? it/i.test(t) ||
      /permissions? issue/i.test(t) ||
      /administrative settings/i.test(t) ||
      /device\/session/i.test(t) ||
      /portal is displaying/i.test(t)
    );
  }

  assert(
    "detector treats production supervisor smoke as visibility",
    isSupervisorVisibilityQuestion(smoke1Q) === true
  );
  assert(
    "detector does not take ordinary assigned-boolean questions",
    isSupervisorVisibilityQuestion("Does project " + OWN_PROJECT_ID + " have a supervisor assigned?") ===
      false
  );

  const eligibleVis = {
    eligible_for_assigned_supervisor: true,
    lifecycle_allows_supervisor_visibility: true,
    approved_or_accepted_quote_present: true,
    supervisor_assigned: true,
    visibility_reason: "eligible_for_assigned_supervisor",
  };
  const caseA = supervisorVisibilityAnswer(
    "project_diagnostic",
    { outcome: "ok", facts: { supervisor_visibility: eligibleVis } },
    smoke1Q
  );
  assert(
    "B4-1 eligible+assigned produces deterministic assigned-supervisor conclusion",
    typeof caseA === "string" &&
      caseA.includes(CASE_A) &&
      caseA.includes(CASE_A_PERSON_UNVERIFIED) &&
      caseA.includes(CASE_A_NEXT_STEP)
  );
  assert("B4-2 conclusion does not say your supervisor can see", !/your supervisor can see/i.test(caseA));
  assert(
    "B4-3 conclusion does not say your supervisor cannot see because",
    !/your supervisor cannot see[\s\S]{0,80}because/i.test(caseA)
  );
  assert(
    "B4-4 specific person's visibility reason is not verified",
    caseA.includes(CASE_A_PERSON_UNVERIFIED)
  );
  assert("B4-5 no display-issue speculation", !unsafeSupervisorSpeculation(caseA));
  assert("B4-6 no permission speculation in conclusion", !/permission/i.test(caseA));
  assert("B4-7 no admin-settings speculation in conclusion", !/administrative/i.test(caseA));
  assert("B4-8 no device/session speculation in conclusion", !/device|session/i.test(caseA));

  const caseB = supervisorVisibilityAnswer(
    "project_diagnostic",
    {
      outcome: "ok",
      facts: {
        supervisor_visibility: {
          eligible_for_assigned_supervisor: false,
          lifecycle_allows_supervisor_visibility: true,
          approved_or_accepted_quote_present: true,
          supervisor_assigned: false,
          visibility_reason: "supervisor_not_assigned",
        },
      },
    },
    smoke1Q
  );
  assert("B4-11 unassigned produces deterministic supervisor-not-assigned explanation", caseB === CASE_B);

  const caseC = supervisorVisibilityAnswer(
    "project_diagnostic",
    {
      outcome: "ok",
      facts: {
        supervisor_visibility: {
          eligible_for_assigned_supervisor: false,
          lifecycle_allows_supervisor_visibility: false,
          approved_or_accepted_quote_present: true,
          supervisor_assigned: true,
          visibility_reason: "lifecycle_not_eligible",
        },
      },
    },
    smoke1Q
  );
  assert("B4-12 lifecycle failure produces deterministic lifecycle explanation", caseC === CASE_C);

  const caseD = supervisorVisibilityAnswer(
    "project_diagnostic",
    {
      outcome: "ok",
      facts: {
        supervisor_visibility: {
          eligible_for_assigned_supervisor: false,
          lifecycle_allows_supervisor_visibility: true,
          approved_or_accepted_quote_present: false,
          supervisor_assigned: true,
          visibility_reason: "quote_not_approved_or_accepted",
        },
      },
    },
    smoke1Q
  );
  assert("B4-13 quote eligibility failure produces deterministic quote explanation", caseD === CASE_D);

  const caseE = supervisorVisibilityAnswer(
    "project_diagnostic",
    {
      outcome: "ok",
      facts: {
        supervisor_visibility: {
          eligible_for_assigned_supervisor: false,
          lifecycle_allows_supervisor_visibility: false,
          approved_or_accepted_quote_present: false,
          supervisor_assigned: false,
          visibility_reason: "multiple_requirements_missing",
        },
      },
    },
    smoke1Q
  );
  assert(
    "B4-14 multiple failures produce bounded safe explanation",
    caseE.indexOf(CASE_E) === 0 &&
      /lifecycle eligibility is not met/.test(caseE) &&
      /accepted or approved linked quote is not present/.test(caseE) &&
      /no supervisor is assigned/.test(caseE) &&
      !unsafeSupervisorSpeculation(caseE)
  );

  const caseFFacts = supervisorVisibilityAnswer(
    "project_diagnostic",
    {
      outcome: "ok",
      facts: {
        supervisor_visibility: {
          eligible_for_assigned_supervisor: false,
          lifecycle_allows_supervisor_visibility: true,
          approved_or_accepted_quote_present: null,
          supervisor_assigned: true,
          visibility_reason: "status_unverified",
        },
      },
    },
    smoke1Q
  );
  const caseFOutcome = supervisorVisibilityAnswer(
    "project_diagnostic",
    { outcome: "status_unverified" },
    smoke1Q
  );
  assert(
    "B4-15 status_unverified stays unverified",
    caseFFacts === CASE_F && caseFOutcome === CASE_F
  );
  assert(
    "B4-16 existing support-case escalation semantics unchanged",
    visFalse === null && unverified && unverified.category === "diagnostic_unavailable"
  );

  async function liveSupervisorAnswer(message, projectRow, quoteResult) {
    const capture = {};
    const res = await createHandler({
      readSessionFromEvent: sessionOk,
      resolveTenantFromSession: async () => ({ id: OWN_TENANT }),
      getOpenAiKey: () => "test-key",
      getSessionSecret: () => "test-secret-value-32chars-minimum!!",
      supabaseGet: async (p) => {
        if (String(p).startsWith("quotes?")) {
          if (quoteResult === "throw") throw new Error("quote boom");
          return Array.isArray(quoteResult) ? quoteResult : [{ id: "q1", status: "accepted" }];
        }
        return [projectRow];
      },
      fetch: openaiOkFetch(capture),
    })(fakeEvent("POST", { message: message, page: "/owner" }));
    return { res: res, body: JSON.parse(res.body || "{}"), capture: capture };
  }

  const eligibleRow = {
    id: OWN_PROJECT_ID,
    tenant_id: OWN_TENANT,
    project_name: "Master & Downstairs Bathroom",
    status: "in_progress",
    supervisor_user_id: "assigned-but-secret",
    created_at: "2026-07-01T12:00:00.000Z",
    due_date: "2026-08-30",
    quote_id: "q1",
  };
  const liveA = await liveSupervisorAnswer(smoke1Q, eligibleRow, [{ id: "q1", status: "accepted" }]);
  assert(
    "B4 live CASE A answer is server conclusion with Project Control source",
    liveA.res.statusCode === 200 &&
      liveA.body.sources[0] === "Project Control" &&
      liveA.body.answer === caseA &&
      !liveA.capture.url &&
      !/assigned-but-secret/.test(liveA.body.answer)
  );
  assert("B4-9 no supervisor identity in live CASE A", !/assigned-but-secret/.test(liveA.body.answer));
  assert("B4-10 Source Project Control preserved", liveA.body.sources[0] === "Project Control");
  assert("B4-17 no new DB reads in conclusion module", !/supabaseGet|tenant_projects\?/.test(read("netlify/functions/_lib/mg-support/supervisor-visibility-conclusion.js")));
  assert("B4-18 no new DB tables", !/from\("[a-z_]+"\)/.test(chatSrc));
  assert(
    "B4-19 no write in conclusion or chat diagnostic branch",
    !/method:\s*"POST"/.test(read("netlify/functions/_lib/mg-support/supervisor-visibility-conclusion.js"))
  );
  assert("B4-20 no OpenAI tool calling", !/"tools"\s*:/.test(chatSrc) && !/tool_choice/.test(chatSrc));
  assert("B4-21 no extra OpenAI round trip", !liveA.capture.url && Boolean(smoke2Capture.url));

  const liveB = await liveSupervisorAnswer(smoke1Q, { ...eligibleRow, supervisor_user_id: null }, [
    { id: "q1", status: "accepted" },
  ]);
  assert("B4 live CASE B", liveB.body.answer === CASE_B && !liveB.capture.url);

  const liveC = await liveSupervisorAnswer(smoke1Q, { ...eligibleRow, status: "draft" }, [
    { id: "q1", status: "accepted" },
  ]);
  assert("B4 live CASE C", liveC.body.answer === CASE_C && !liveC.capture.url);

  const liveD = await liveSupervisorAnswer(smoke1Q, eligibleRow, [{ id: "q1", status: "ready_to_send" }]);
  assert("B4 live CASE D", liveD.body.answer === CASE_D && !liveD.capture.url);

  const liveE = await liveSupervisorAnswer(
    smoke1Q,
    { ...eligibleRow, status: "archived", supervisor_user_id: null },
    [{ id: "q1", status: "draft" }]
  );
  assert("B4 live CASE E", liveE.body.answer.indexOf(CASE_E) === 0 && !liveE.capture.url);

  const liveFQuote = await liveSupervisorAnswer(smoke1Q, eligibleRow, "throw");
  assert("B4 live CASE F quote unverified does not escalate", liveFQuote.body.answer === CASE_F && !liveFQuote.body.escalation);

  const liveFProjectCapture = {};
  const liveFProject = await createHandler({
    readSessionFromEvent: sessionOk,
    resolveTenantFromSession: async () => ({ id: OWN_TENANT }),
    getOpenAiKey: () => "test-key",
    getSessionSecret: () => "test-secret-value-32chars-minimum!!",
    supabaseGet: async () => {
      throw new Error("project boom");
    },
    fetch: openaiOkFetch(liveFProjectCapture),
  })(fakeEvent("POST", { message: smoke1Q, page: "/owner" }));
  const liveFProjectBody = JSON.parse(liveFProject.body || "{}");
  assert(
    "B4 live CASE F project unverified stays unverified and keeps escalation",
    liveFProject.statusCode === 200 &&
      liveFProjectBody.answer === CASE_F &&
      liveFProjectBody.escalation &&
      liveFProjectBody.escalation.eligible === true &&
      !liveFProjectCapture.url
  );

  const ordinaryCapture = {};
  const ordinaryRes = await createHandler({
    readSessionFromEvent: sessionOk,
    resolveTenantFromSession: async () => ({ id: OWN_TENANT }),
    getOpenAiKey: () => "test-key",
    supabaseGet: async (p) => {
      if (String(p).startsWith("quotes?")) return [{ id: "q1", status: "accepted" }];
      return [eligibleRow];
    },
    fetch: openaiOkFetch(ordinaryCapture),
  })(fakeEvent("POST", { message: "What status is project " + OWN_PROJECT_ID + "?", page: "/owner" }));
  assert(
    "ordinary project diagnostic still uses OpenAI",
    ordinaryRes.statusCode === 200 && Boolean(ordinaryCapture.url)
  );

  assert(
    "B4-22 tenant session boundary unchanged",
    /Does not trust browser tenant_id/.test(chatSrc)
  );
  assert(
    "B4-23 public estimate production-safe response semantics remain covered",
    /did not probe the public endpoint/i.test(smoke2Input) &&
      smoke2Facts.public_estimate.response_action_allowed_by_quote_state === false
  );
  assert("B4-24 public estimate source remains Quote Builder", smoke2Body.sources[0] === "Quote Builder");
  assert(
    "B4 conclusion module does not add identity lookup",
    !/supervisor_user_id|membership|device_sessions/.test(
      read("netlify/functions/_lib/mg-support/supervisor-visibility-conclusion.js")
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
