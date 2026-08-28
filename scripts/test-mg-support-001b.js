#!/usr/bin/env node
/**
 * MG-SUPPORT-001B — lightweight mocked tests (no live OpenAI, no SQL).
 * Usage: node scripts/test-mg-support-001b.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const { routeSupportKnowledge } = require("../netlify/functions/_lib/mg-support/router");
const { resolveKnowledgeDir, loadKnowledgeFile } = require("../netlify/functions/_lib/mg-support/loader");
const {
  MAX_MESSAGE_CHARS,
  MAX_OUTPUT_TOKENS,
  OPENAI_MODEL,
  OPENAI_RESPONSES_URL,
  SYSTEM_INSTRUCTIONS,
  CROSS_TENANT_GUIDANCE,
  QUOTE_NEEDS_IDENTIFIER_GUIDANCE,
} = require("../netlify/functions/_lib/mg-support/config");
const {
  createHandler,
  extractOutputText,
} = require("../netlify/functions/mg-support-chat");
const { hasOwnerEmailAndCustomer } = require("../netlify/functions/_lib/mg-support/require-owner-session");
const { classifySupportIntent } = require("../netlify/functions/_lib/mg-support/router");
const { renderAssistantMarkdown } = require("../public/js/mg-support-chat.js");

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

function idsOf(message, page) {
  return routeSupportKnowledge(message, page).map((m) => m.id);
}

function titlesOf(message, page) {
  return routeSupportKnowledge(message, page).map((m) => m.title);
}

function fakeEvent(method, bodyObj, cookie) {
  return {
    httpMethod: method,
    headers: cookie ? { cookie } : {},
    body: bodyObj == null ? "" : JSON.stringify(bodyObj),
  };
}

async function runHandler(event, deps) {
  const handler = createHandler(deps);
  return handler(event);
}

function openaiOkFetch(capture) {
  return async (url, opts) => {
    if (capture) {
      capture.url = url;
      capture.opts = opts;
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

function parse(res) {
  return JSON.parse(res.body || "{}");
}

async function main() {
  const sessionOk = () => ({ e: "owner@example.com", c: "cus_test" });

  const getRes = await runHandler(fakeEvent("GET", { message: "hello" }), {
    readSessionFromEvent: sessionOk,
    getOpenAiKey: () => "test-key",
    fetch: async () => {
      throw new Error("fetch should not run");
    },
  });
  assert("GET rejected", getRes.statusCode === 405);

  const unauth = await runHandler(fakeEvent("POST", { message: "How do I create an invoice?" }), {
    readSessionFromEvent: () => null,
    getOpenAiKey: () => "test-key",
    fetch: async () => {
      throw new Error("fetch should not run");
    },
  });
  assert("unauthenticated request rejected", unauth.statusCode === 401);

  const empty = await runHandler(fakeEvent("POST", { message: "   " }), {
    readSessionFromEvent: sessionOk,
    getOpenAiKey: () => "test-key",
    fetch: async () => {
      throw new Error("fetch should not run");
    },
  });
  assert("empty question rejected", empty.statusCode === 400);

  const oversized = await runHandler(
    fakeEvent("POST", { message: "x".repeat(MAX_MESSAGE_CHARS + 1) }),
    {
      readSessionFromEvent: sessionOk,
      getOpenAiKey: () => "test-key",
      fetch: async () => {
        throw new Error("fetch should not run");
      },
    }
  );
  assert("oversized question rejected", oversized.statusCode === 400);

  let sawTenantIdInOpenAi = false;
  const tenantIgnored = await runHandler(
    fakeEvent("POST", {
      tenant_id: "00000000-0000-4000-8000-000000000099",
      message: "What does Minimum Floor mean?",
      page: "/business-settings",
    }),
    {
      readSessionFromEvent: sessionOk,
      getOpenAiKey: () => "test-key",
      fetch: async (_url, opts) => {
        const payload = JSON.parse(opts.body);
        const blob = JSON.stringify(payload);
        if (blob.includes("00000000-0000-4000-8000-000000000099")) {
          sawTenantIdInOpenAi = true;
        }
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              output_text: "Minimum Floor is the protected pricing floor.",
              usage: { input_tokens: 10, output_tokens: 8 },
            }),
        };
      },
    }
  );
  const tenantBody = parse(tenantIgnored);
  assert(
    "browser tenant_id not trusted (request succeeds, id not sent to OpenAI)",
    tenantIgnored.statusCode === 200 && tenantBody.ok === true && sawTenantIdInOpenAi === false
  );

  const supportFn = fs.readFileSync(path.join(ROOT, "netlify/functions/mg-support-chat.js"), "utf8");
  const supportLibDir = path.join(ROOT, "netlify/functions/_lib/mg-support");
  const libFiles = fs
    .readdirSync(supportLibDir)
    .filter(
      (f) =>
        f !== "invoice-diagnostic.js" &&
        f !== "quote-diagnostic.js" &&
        f !== "project-diagnostic.js" &&
        f !== "contract-diagnostic.js" &&
        f !== "device-pairing-diagnostic.js" &&
        f !== "deposit-cta-diagnostic.js" &&
        // C1 exact filenames only. No wildcard. Future action files are not exempt.
        f !== "invoice-resend-eligibility.js" &&
        f !== "invoice-resend-canonical.js" &&
        f !== "invoice-resend-action.js"
    )
    .map((f) => fs.readFileSync(path.join(supportLibDir, f), "utf8"))
    .join("\n");
  const supportSrc = supportFn + "\n" + libFiles;
  assert(
    "support function does not query tenant business tables outside invoice diagnostic",
    !/invoices\?|quotes\?|tenant_projects\?|payments\?|financial_/.test(supportSrc)
  );

  const invoiceTitles = titlesOf("How do I create a Remaining Balance Invoice?", "/estimates-invoices");
  assert("source router selects Invoice Hub for invoice question", invoiceTitles.includes("Invoice Hub"));

  const floorIds = idsOf("What does Minimum Floor mean?", "/business-settings");
  assert(
    "source router selects Business Settings/Quote Builder for Minimum Floor",
    floorIds.includes("business-settings") && floorIds.includes("quote-builder")
  );

  const contractTitles = titlesOf("How does Contract Hub work?", "/contract-hub");
  assert("source router selects Contract Hub for contract question", contractTitles.includes("Contract Hub"));

  const advisorIds = idsOf("Is the Financial Advisor ChatGPT?", "/dashboard");
  assert(
    "source router selects Financial Advisor for advisor question",
    advisorIds.includes("financial-advisor")
  );

  const publicJsDir = path.join(ROOT, "public");
  let openaiInPublic = false;
  function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      if (name === "node_modules") continue;
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full);
      else if (/\.(js|html|css)$/i.test(name)) {
        const txt = fs.readFileSync(full, "utf8");
        if (/OPENAI_API_KEY/.test(txt)) openaiInPublic = true;
      }
    }
  }
  walk(publicJsDir);
  assert("no OPENAI_API_KEY appears in public/", openaiInPublic === false);

  const excludedPages = [
    "estimate-public.html",
    "invoice-public.html",
    "invoice.html",
    "index.html",
    "contract-sign.html",
    "ai-closer-client.html",
    "portal-pair.html",
    "seller.html",
    "deposit-success.html",
  ];
  let widgetOnExcluded = false;
  for (const file of excludedPages) {
    const full = path.join(ROOT, "public", file);
    if (!fs.existsSync(full)) continue;
    const txt = fs.readFileSync(full, "utf8");
    if (txt.includes("mg-support-chat.js") || txt.includes("mgSupportOpenBtn")) {
      widgetOnExcluded = true;
    }
  }
  assert("support widget does not appear on excluded public pages", widgetOnExcluded === false);

  const kbDir = resolveKnowledgeDir();
  assert("knowledge directory resolves", Boolean(kbDir) && fs.existsSync(kbDir));
  assert("invoice-hub.md loads", loadKnowledgeFile("invoice-hub.md").includes("Invoice Hub"));
  assert("business-settings.md loads", loadKnowledgeFile("business-settings.md").includes("Minimum Floor"));

  const missingKey = await runHandler(fakeEvent("POST", { message: "How does Invoice Hub work?" }), {
    readSessionFromEvent: sessionOk,
    getOpenAiKey: () => "",
    fetch: async () => {
      throw new Error("fetch should not run");
    },
  });
  assert("missing OpenAI key returns safe 500", missingKey.statusCode === 500 && parse(missingKey).ok === false);

  assert("hasOwnerEmailAndCustomer requires both e and c", hasOwnerEmailAndCustomer({ e: "a@b.c", c: "cus_1" }) === true);
  assert("hasOwnerEmailAndCustomer rejects email-only", hasOwnerEmailAndCustomer({ e: "a@b.c" }) === false);
  assert("hasOwnerEmailAndCustomer rejects customer-only", hasOwnerEmailAndCustomer({ c: "cus_1" }) === false);

  let adminLookupCalled = false;
  const payingOwner = await runHandler(fakeEvent("POST", { message: "How does Invoice Hub work?" }), {
    readSessionFromEvent: sessionOk,
    isPlatformAdmin: async () => {
      adminLookupCalled = true;
      return false;
    },
    getOpenAiKey: () => "test-key",
    fetch: openaiOkFetch(),
  });
  assert(
    "paying owner e+c is allowed without admin lookup",
    payingOwner.statusCode === 200 && adminLookupCalled === false
  );

  const emailOnlyNonAdmin = await runHandler(fakeEvent("POST", { message: "How does Invoice Hub work?" }), {
    readSessionFromEvent: () => ({ e: "owner@example.com" }),
    isPlatformAdmin: async () => false,
    getOpenAiKey: () => "test-key",
    fetch: async () => {
      throw new Error("fetch should not run");
    },
  });
  assert("email-only non-admin is 401 (not weakened)", emailOnlyNonAdmin.statusCode === 401);

  const customerOnlyNonAdmin = await runHandler(fakeEvent("POST", { message: "How does Invoice Hub work?" }), {
    readSessionFromEvent: () => ({ c: "cus_test" }),
    isPlatformAdmin: async () => false,
    getOpenAiKey: () => "test-key",
    fetch: async () => {
      throw new Error("fetch should not run");
    },
  });
  assert("customer-only non-admin is 401", customerOnlyNonAdmin.statusCode === 401);

  const deviceLike = await runHandler(fakeEvent("POST", { message: "How does Invoice Hub work?" }), {
    readSessionFromEvent: () => ({ role: "seller", device_id: "dev_1" }),
    isPlatformAdmin: async () => false,
    getOpenAiKey: () => "test-key",
    fetch: async () => {
      throw new Error("fetch should not run");
    },
  });
  assert("device-like payload is 401", deviceLike.statusCode === 401);

  const adminNoCustomer = await runHandler(fakeEvent("POST", { message: "How does Invoice Hub work?" }), {
    readSessionFromEvent: () => ({ e: "admin@example.com", u: "admin-user-id" }),
    isPlatformAdmin: async (session) => Boolean(session && session.u === "admin-user-id"),
    getOpenAiKey: () => "test-key",
    fetch: openaiOkFetch(),
  });
  assert(
    "platform admin without session.c is allowed (auth-status semantics)",
    adminNoCustomer.statusCode === 200 && parse(adminNoCustomer).ok === true
  );

  const openaiCapture = {};
  const openaiShape = await runHandler(fakeEvent("POST", { message: "How does Invoice Hub work?", page: "/estimates-invoices" }), {
    readSessionFromEvent: sessionOk,
    getOpenAiKey: () => "test-key",
    fetch: openaiOkFetch(openaiCapture),
  });
  const openaiPayload = openaiCapture.payload || {};
  const openaiInput = String(openaiPayload.input || "");
  assert("OpenAI POST hits Responses API URL", openaiCapture.url === OPENAI_RESPONSES_URL);
  assert("OpenAI model comes from server config", openaiPayload.model === OPENAI_MODEL);
  assert("OpenAI max_output_tokens is bounded", openaiPayload.max_output_tokens === MAX_OUTPUT_TOKENS);
  assert("OpenAI request has no model tools", openaiPayload.tools == null && openaiPayload.tool_choice == null);
  assert(
    "OpenAI input is bounded and has no tenant business ids",
    openaiInput.length <= 20000 &&
      !/tenant_id|invoice_id|payment_id|cus_test/.test(openaiInput)
  );
  assert("OpenAI request succeeds with extracted text", openaiShape.statusCode === 200 && parse(openaiShape).ok === true);

  const openaiHttpError = await runHandler(fakeEvent("POST", { message: "How does Invoice Hub work?" }), {
    readSessionFromEvent: sessionOk,
    getOpenAiKey: () => "test-key",
    fetch: async () => ({
      ok: false,
      status: 500,
      text: async () => JSON.stringify({ error: { message: "upstream" } }),
    }),
  });
  assert(
    "OpenAI non-OK HTTP returns safe 502 without leaking upstream",
    openaiHttpError.statusCode === 502 &&
      parse(openaiHttpError).ok === false &&
      !/upstream|OPENAI/i.test(openaiHttpError.body)
  );

  const openaiMalformed = await runHandler(fakeEvent("POST", { message: "How does Invoice Hub work?" }), {
    readSessionFromEvent: sessionOk,
    getOpenAiKey: () => "test-key",
    fetch: async () => ({
      ok: true,
      status: 200,
      text: async () => "not-json{{{",
    }),
  });
  assert("OpenAI malformed JSON returns safe 502", openaiMalformed.statusCode === 502 && parse(openaiMalformed).ok === false);

  assert(
    "extractOutputText prefers output_text",
    extractOutputText({ output_text: " Hello " }) === "Hello"
  );
  assert(
    "extractOutputText walks output[].content[].text",
    extractOutputText({
      output: [{ content: [{ text: "Part A" }, { text: "Part B" }] }],
    }) === "Part A\n\nPart B"
  );
  assert("extractOutputText handles empty/non-object", extractOutputText(null) === "" && extractOutputText("x") === "");

  const supportChatSrc = fs.readFileSync(path.join(ROOT, "netlify/functions/mg-support-chat.js"), "utf8");
  const requireOwnerSrc = fs.readFileSync(
    path.join(ROOT, "netlify/functions/_lib/mg-support/require-owner-session.js"),
    "utf8"
  );
  const otherLibSrc = ["config.js", "router.js", "loader.js"]
    .map((f) => fs.readFileSync(path.join(ROOT, "netlify/functions/_lib/mg-support", f), "utf8"))
    .join("\n");
  assert("mg-support-chat.js does not call Supabase", !/supabaseRequest|\/rest\/v1\//.test(supportChatSrc));
  assert(
    "router/loader/config do not call Supabase or tenant tables",
    !/supabaseRequest|\/rest\/v1\/|invoices\?|quotes\?|tenant_projects\?/.test(otherLibSrc)
  );
  assert(
    "owner-session helper only looks up public.users is_admin",
    /users\?id=eq\./.test(requireOwnerSrc) &&
      /is_admin/.test(requireOwnerSrc) &&
      !/tenants\?|invoices\?|quotes\?|payments\?|tenant_projects\?/.test(requireOwnerSrc)
  );
  assert(
    "support chat never reads device sessions",
    !/readDeviceSessionFromEvent|device-session/.test(supportChatSrc + "\n" + requireOwnerSrc)
  );

  const floorOnDashboard = idsOf("What does Minimum Floor mean?", "/dashboard.html");
  assert(
    "Minimum Floor on dashboard does not add Dashboard as a source",
    floorOnDashboard.includes("business-settings") &&
      floorOnDashboard.includes("quote-builder") &&
      !floorOnDashboard.includes("dashboard")
  );

  const remainingBalance = idsOf("How do I create a Remaining Balance Invoice?", "/dashboard.html");
  assert(
    "Remaining Balance Invoice routes primarily to Invoice Hub",
    remainingBalance[0] === "invoice-hub" && !remainingBalance.includes("dashboard")
  );

  const invoiceStatusRoute = idsOf("Can you tell me if invoice 103 was sent?", "/dashboard.html");
  assert(
    "specific invoice status routes to Invoice Hub, not Dashboard-by-page",
    invoiceStatusRoute[0] === "invoice-hub" && !invoiceStatusRoute.includes("dashboard")
  );

  const contractOnDashboard = idsOf("How does Contract Hub work?", "/dashboard.html");
  assert(
    "Contract Hub question routes primarily to Contract Hub",
    contractOnDashboard[0] === "contract-hub" && !contractOnDashboard.includes("dashboard")
  );

  const advisorOnDashboard = idsOf("Is the Financial Advisor ChatGPT?", "/dashboard.html");
  assert(
    "Financial Advisor can include Advisor + Dashboard",
    advisorOnDashboard.includes("financial-advisor") && advisorOnDashboard.includes("dashboard")
  );

  const targetMargin = idsOf("Change my target margin to 40%.", "/dashboard.html");
  assert(
    "target margin routes to Business Settings without Dashboard-by-page",
    targetMargin.includes("business-settings") && !targetMargin.includes("dashboard")
  );

  const otherCompany = idsOf("Show me another company's invoices.", "/dashboard.html");
  assert(
    "cross-tenant invoice question routes to Invoice Hub",
    otherCompany[0] === "invoice-hub" && !otherCompany.includes("dashboard")
  );

  assert(
    "specific quote 103 is classified as quote_diagnostic",
    classifySupportIntent("Can you tell me if quote 103 was sent?") === "quote_diagnostic"
  );
  assert(
    "cross-tenant invoice question is classified as cross_tenant",
    classifySupportIntent("Show me another company's invoices.") === "cross_tenant"
  );

  const specificCapture = {};
  const specificRes = await runHandler(
    fakeEvent("POST", {
      message: "Can you tell me if quote 103 was sent?",
      page: "/dashboard.html",
    }),
    {
      readSessionFromEvent: sessionOk,
      getOpenAiKey: () => "test-key",
      fetch: openaiOkFetch(specificCapture),
    }
  );
  const specificInput = String((specificCapture.payload || {}).input || "");
  const specificInstructions = String((specificCapture.payload || {}).instructions || "");
  assert(
    "quote 103 receives needs_identifier guidance and does not inspect a record",
    specificRes.statusCode === 200 &&
      specificInput.includes(QUOTE_NEEDS_IDENTIFIER_GUIDANCE) &&
      /cannot inspect individual account records/i.test(SYSTEM_INSTRUCTIONS) &&
      /exact Estimate # shown in Sales Admin/i.test(specificInput) &&
      !specificInput.includes("MARGIN_GUARD_VERIFIED_QUOTE_DIAGNOSTIC_FACTS") &&
      specificInstructions === SYSTEM_INSTRUCTIONS
  );

  const crossCapture = {};
  const crossRes = await runHandler(
    fakeEvent("POST", {
      message: "Show me another company's invoices.",
      page: "/dashboard.html",
    }),
    {
      readSessionFromEvent: sessionOk,
      getOpenAiKey: () => "test-key",
      fetch: openaiOkFetch(crossCapture),
    }
  );
  const crossInput = String((crossCapture.payload || {}).input || "");
  assert(
    "cross-tenant invoice query receives explicit tenant-boundary refusal guidance",
    crossRes.statusCode === 200 &&
      crossInput.includes(CROSS_TENANT_GUIDANCE) &&
      /cannot access another tenant's invoices or business data/i.test(SYSTEM_INSTRUCTIONS) &&
      /does not inspect tenant invoice data/i.test(crossInput) &&
      !/switch accounts to access/i.test(crossInput)
  );

  const mdBold = renderAssistantMarkdown("Open **Business Settings** next.");
  assert(
    "assistant markdown renders bold safely",
    mdBold.includes("<strong>Business Settings</strong>") && !mdBold.includes("**Business Settings**")
  );
  const mdHeading = renderAssistantMarkdown("### Invoice Hub\nUse Invoice Hub.");
  assert(
    "assistant markdown renders simple headings",
    mdHeading.includes("<h3>") && mdHeading.includes("Invoice Hub") && !mdHeading.includes("### ")
  );
  const mdLists = renderAssistantMarkdown("- one\n- two\n\n1. first\n2. second");
  assert(
    "assistant markdown renders lists",
    mdLists.includes("<ul>") && mdLists.includes("<ol>") && mdLists.includes("<li>one</li>")
  );

  const mdXss = renderAssistantMarkdown('<script>alert(1)</script>\n<img src=x onerror="alert(2)">\n**ok**');
  assert(
    "raw HTML/script-like model content cannot execute",
    !/<script/i.test(mdXss) &&
      !/<img/i.test(mdXss) &&
      mdXss.includes("&lt;script") &&
      mdXss.includes("<strong>ok</strong>")
  );

  const publicJsDir2 = path.join(ROOT, "public");
  let openaiInPublic2 = false;
  function walkPublic(dir) {
    for (const name of fs.readdirSync(dir)) {
      if (name === "node_modules") continue;
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) walkPublic(full);
      else if (/\.(js|html|css)$/i.test(name)) {
        const txt = fs.readFileSync(full, "utf8");
        if (/OPENAI_API_KEY/.test(txt)) openaiInPublic2 = true;
      }
    }
  }
  walkPublic(publicJsDir2);
  assert("OPENAI_API_KEY still absent from public/", openaiInPublic2 === false);

  const supportSrcAfter =
    fs.readFileSync(path.join(ROOT, "netlify/functions/mg-support-chat.js"), "utf8") +
    "\n" +
    fs
      .readdirSync(supportLibDir)
      .filter(
        (f) =>
          f !== "invoice-diagnostic.js" &&
          f !== "quote-diagnostic.js" &&
          f !== "project-diagnostic.js" &&
          f !== "contract-diagnostic.js" &&
          f !== "device-pairing-diagnostic.js" &&
          f !== "deposit-cta-diagnostic.js" &&
          // C1 exact filenames only. No wildcard. Future action files are not exempt.
          f !== "invoice-resend-eligibility.js" &&
          f !== "invoice-resend-canonical.js" &&
          f !== "invoice-resend-action.js"
      )
      .map((f) => fs.readFileSync(path.join(supportLibDir, f), "utf8"))
      .join("\n");
  assert(
    "no new tenant business table queries were introduced outside invoice diagnostic",
    !/invoices\?|quotes\?|tenant_projects\?|payments\?|financial_/.test(supportSrcAfter)
  );

  console.log("");
  console.log(passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
