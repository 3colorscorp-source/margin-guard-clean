#!/usr/bin/env node
/**
 * MG-SUPPORT-003D.B — supervisor visibility + public estimate diagnostics
 * (mocked OpenAI and Supabase). Usage: node scripts/test-mg-support-003d.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const { classifySupportIntent } = require("../netlify/functions/_lib/mg-support/router");
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
    "router.js unchanged for 003D.B (existing families sufficient)",
    !/supervisor_visibility|public_estimate/.test(routerSrc)
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
    "quote docs distinguish configured reference vs expired vs action",
    /Public estimate page/i.test(quoteDocs) &&
      /expiration by itself does \*\*not\*\* disable the public estimate endpoint/i.test(quoteDocs)
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

  console.log("");
  console.log(passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
