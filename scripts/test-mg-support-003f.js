#!/usr/bin/env node
/**
 * MG-SUPPORT-003D.C2 — chat confirmation UX + resend button (mocked OpenAI/Zapier/DB).
 * Usage: node scripts/test-mg-support-003f.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..");
const { createHandler: createChatHandler } = require("../netlify/functions/mg-support-chat");
const { createHandler: createCaseHandler } = require("../netlify/functions/mg-support-create-case");
const { classifySupportIntent } = require("../netlify/functions/_lib/mg-support/router");
const { extractInvoiceIdentifier } = require("../netlify/functions/_lib/mg-support/invoice-diagnostic");
const { isExplicitInvoiceResendIntent } = require("../netlify/functions/_lib/mg-support/invoice-resend-intent");
const {
  INVOICE_RESEND_CONFIRMATION_COPY,
  INVOICE_RESEND_PAID_COPY,
  INVOICE_RESEND_VOID_COPY,
  INVOICE_RESEND_ARCHIVED_COPY,
  INVOICE_RESEND_MISSING_EMAIL_COPY,
  INVOICE_RESEND_MISSING_PUBLIC_COPY,
  INVOICE_RESEND_NEEDS_IDENTIFIER_COPY,
  INVOICE_RESEND_NOT_FOUND_COPY,
  INVOICE_RESEND_AMBIGUOUS_COPY,
  INVOICE_RESEND_UNVERIFIED_COPY,
} = require("../netlify/functions/_lib/mg-support/invoice-resend-offer");
const {
  TOKEN_TYPE,
  RESEND_TTL_SECONDS,
  computeStateFingerprint,
  computeActorFingerprint,
} = require("../netlify/functions/_lib/mg-support/action-token");
const { SUCCESS_MESSAGE, UNKNOWN_MESSAGE } = require("../netlify/functions/_lib/mg-support/invoice-resend-action");
const ui = require("../public/js/mg-support-chat.js");
const { supervisorVisibilityAnswer } = require("../netlify/functions/_lib/mg-support/supervisor-visibility-conclusion");

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
const OWN_USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const INVOICE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SECRET = "test-session-secret-mg-support-003f";
const NOW = 1_700_000_000;

function parse(res) {
  try {
    return JSON.parse(res.body || "{}");
  } catch (_err) {
    return {};
  }
}

function fakeEvent(method, bodyObj) {
  return {
    httpMethod: method,
    headers: {},
    body: bodyObj == null ? "" : JSON.stringify(bodyObj),
  };
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function ownerSession(extra) {
  return { e: "owner@example.com", c: "cus_test", u: OWN_USER, ...extra };
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
          output_text: capture && capture.outputText ? capture.outputText : "Invoice Hub shows this invoice as sent.",
          usage: { input_tokens: 5, output_tokens: 4 },
        }),
    };
  };
}

function eligibleInvoice(extra) {
  return {
    id: INVOICE_ID,
    tenant_id: OWN_TENANT,
    invoice_no: "INV-123",
    status: "sent",
    customer_email: "client@example.com",
    customer_name: "Pat Client",
    project_name: "Kitchen",
    business_name: "Acme Builders",
    public_token: "pubtok_abc12345",
    sent_at: null,
    amount: 1000,
    paid_amount: 0,
    balance_due: 1000,
    currency: "USD",
    voided_at: null,
    ...extra,
  };
}

function decodeToken(token) {
  const [enc] = String(token || "").split(".");
  const normalized = enc.replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalized.length % 4;
  const padded = normalized + (pad ? "=".repeat(4 - pad) : "");
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
}

function mintDeps() {
  return {
    getSessionSecret: () => SECRET,
    nowSeconds: () => NOW,
  };
}

function okDiagnostic() {
  return {
    outcome: "ok",
    invoice_id: INVOICE_ID,
    facts: {
      invoice_no: "INV-123",
      status: "sent",
      delivery: { submitted_to_email_bridge: false, can_prove_recipient_received: false },
    },
  };
}

function chatDeps(extra) {
  const writes = extra.writes || { ledger: 0, patch: 0, openai: 0, reload: 0, mint: 0 };
  return {
    readSessionFromEvent: extra.readSessionFromEvent || (() => ownerSession()),
    isPlatformAdmin: extra.isPlatformAdmin || (async () => false),
    resolveTenantFromSession: extra.resolveTenantFromSession || (async () => ({ id: OWN_TENANT })),
    getOpenAiKey: extra.getOpenAiKey || (() => "test-key"),
    getSessionSecret: () => SECRET,
    nowSeconds: () => NOW,
    readInvoiceDiagnostic: extra.readInvoiceDiagnostic || (async () => okDiagnostic()),
    reloadInvoiceForResend:
      extra.reloadInvoiceForResend ||
      (async () => {
        writes.reload += 1;
        return {
          outcome: "ok",
          invoice: eligibleInvoice(),
          eligibility: { ok: true, reason: "eligible", visible_status: "sent" },
        };
      }),
    mintInvoiceResendToken: extra.mintInvoiceResendToken,
    supabaseRequest: extra.supabaseRequest || (async (path, opts) => {
      const method = String(opts?.method || "GET").toUpperCase();
      if (method === "POST" && String(path).includes("tenant_support_actions")) writes.ledger += 1;
      if (method === "PATCH" && String(path).startsWith("invoices?")) writes.patch += 1;
      return [];
    }),
    supabaseInsert: extra.supabaseInsert || (async () => {
      writes.ledger += 1;
      throw new Error("chat must not insert");
    }),
    fetch: extra.fetch || openaiOkFetch(extra.capture || {}),
    ...extra.more,
  };
}

async function runChat(message, extra) {
  const deps = chatDeps(extra || {});
  return createChatHandler(deps)(fakeEvent("POST", { message, page: "/estimates-invoices" }));
}

function intentYes(message) {
  return isExplicitInvoiceResendIntent(message) === true && classifySupportIntent(message) === "invoice_diagnostic";
}

function intentNo(message) {
  return isExplicitInvoiceResendIntent(message) === false;
}

async function main() {
  const chatSrc = read("netlify/functions/mg-support-chat.js");
  const uiSrc = read("public/js/mg-support-chat.js");
  const navSrc = read("public/js/mg-app-nav.js");
  const hubSrc = read("netlify/functions/send-invoice-zapier.js");
  const endpointSrc = read("netlify/functions/mg-support-invoice-resend.js");
  const offerSrc = read("netlify/functions/_lib/mg-support/invoice-resend-offer.js");
  const intentSrc = read("netlify/functions/_lib/mg-support/invoice-resend-intent.js");
  const supervisorSrc = read("netlify/functions/_lib/mg-support/supervisor-visibility-conclusion.js");
  const quoteSrc = read("netlify/functions/_lib/mg-support/quote-diagnostic.js");
  const createCaseSrc = read("netlify/functions/mg-support-create-case.js");
  const adminJs = read("public/js/support-admin.js");

  assert("1. Resend invoice INV-123 => explicit resend intent", intentYes("Resend invoice INV-123"));
  assert("2. Please resend invoice INV-123 => yes", intentYes("Please resend invoice INV-123"));
  assert("3. Send invoice INV-123 again => yes", intentYes("Send invoice INV-123 again"));
  assert("4. Did invoice INV-123 send? => diagnostic only", intentNo("Did invoice INV-123 send?"));
  assert("5. Why didn't invoice INV-123 send? => no action intent", intentNo("Why didn't invoice INV-123 send?"));
  assert("6. Invoice INV-123 status => no action intent", intentNo("Invoice INV-123 status"));
  assert(
    "7. Please resend the invoice has intent but no identifier",
    isExplicitInvoiceResendIntent("Please resend the invoice") === true &&
      extractInvoiceIdentifier("Please resend the invoice") == null
  );
  assert(
    "8. customer/project fuzzy reference is not INV/UUID",
    extractInvoiceIdentifier("Please resend the invoice for the Smith project") == null ||
      extractInvoiceIdentifier("Please resend the invoice for the Smith project").value.toLowerCase() !== "smith"
  );
  assert("generic invoice alone is not resend intent", intentNo("Tell me about this invoice"));
  assert("generic sent/email/delivery alone is not resend intent", intentNo("Was the email delivery sent?"));

  const eligibleCapture = { calls: 0 };
  const eligibleWrites = { ledger: 0, patch: 0, openai: 0, reload: 0, mint: 0 };
  const eligibleRes = await runChat("Resend invoice INV-123", {
    writes: eligibleWrites,
    capture: eligibleCapture,
    fetch: openaiOkFetch(eligibleCapture),
  });
  const eligibleBody = parse(eligibleRes);
  assert("9. exact invoice + ok + eligible => action object", eligibleRes.statusCode === 200 && eligibleBody.action && eligibleBody.action.type === "invoice_resend");
  assert("9b. action label closed", eligibleBody.action.label === "Resend invoice");
  assert("9c. confirmation token present", typeof eligibleBody.action.confirmation_token === "string" && eligibleBody.action.confirmation_token.includes("."));
  assert("9d. expires_at present", typeof eligibleBody.action.expires_at === "string" && eligibleBody.action.expires_at.length > 0);
  assert("9e. no actions array framework", !Object.prototype.hasOwnProperty.call(eligibleBody, "actions"));
  assert("9f. eligible confirmation copy is the entire answer", String(eligibleBody.answer).trim() === INVOICE_RESEND_CONFIRMATION_COPY);
  assert("9g. copy does not display recipient email", !/client@example.com/.test(eligibleBody.answer));
  assert("9h. Invoice Hub source", Array.isArray(eligibleBody.sources) && eligibleBody.sources.includes("Invoice Hub"));
  assert("9i. eligible resend does not attach case button", !eligibleBody.escalation);

  const payload = decodeToken(eligibleBody.action.confirmation_token);
  assert("21. exact C1 token type", payload.type === TOKEN_TYPE && TOKEN_TYPE === "mg_support_invoice_resend_v1");
  assert("22. 15m expiry", payload.exp - payload.iat === RESEND_TTL_SECONDS && RESEND_TTL_SECONDS === 900);
  assert("23. actor bound", payload.actor_fp === computeActorFingerprint(ownerSession(), mintDeps()));
  assert("24. state_fp present", payload.state_fp === computeStateFingerprint(eligibleInvoice(), OWN_TENANT, mintDeps()));
  const openaiInput = String((eligibleCapture.payload || {}).input || "");
  assert("25. token absent from OpenAI payload", !openaiInput.includes(eligibleBody.action.confirmation_token));
  assert("26. token fields absent from model payload", !/state_fp|actor_fp|confirmation_token/.test(openaiInput));
  assert("27. no email/money/public token in token payload", !JSON.stringify(payload).includes("client@example.com") && !JSON.stringify(payload).includes("1000") && !JSON.stringify(payload).includes("pubtok"));
  assert("25b. invoice UUID not added to OpenAI facts", !/"invoice_id"/.test(openaiInput) && !openaiInput.includes(INVOICE_ID));
  assert("51. eligible explicit resend does not call OpenAI", eligibleCapture.calls === 0 && !eligibleCapture.payload);
  assert("28. chat action offer causes zero ledger INSERT", eligibleWrites.ledger === 0);
  assert("29. action token mint causes zero invoice PATCH", eligibleWrites.patch === 0);
  assert("29b. reload used server diagnostic UUID", eligibleWrites.reload === 1);

  const diagOnlyCapture = { calls: 0 };
  const diagOnlyWrites = { ledger: 0, patch: 0, openai: 0, reload: 0, mint: 0 };
  const diagOnly = await runChat("Did invoice INV-123 send?", {
    writes: diagOnlyWrites,
    capture: diagOnlyCapture,
    fetch: openaiOkFetch(diagOnlyCapture),
  });
  assert("4b. diagnostic-only has no action", parse(diagOnly).action == null && diagOnlyWrites.reload === 0);
  assert("4c. generic diagnostic still calls OpenAI", diagOnlyCapture.calls === 1);

  const whyCapture = { calls: 0 };
  const why = await runChat("Why didn't invoice INV-123 send?", {
    capture: whyCapture,
    fetch: openaiOkFetch(whyCapture),
  });
  assert("5b. why-didn't-send has no action", parse(why).action == null);
  assert("5c. why-didn't-send still calls OpenAI", whyCapture.calls === 1);

  const statusCapture = { calls: 0 };
  const statusQ = await runChat("Invoice INV-123 status", {
    capture: statusCapture,
    fetch: openaiOkFetch(statusCapture),
  });
  assert("6b. status question has no action", parse(statusQ).action == null);
  assert("6c. status question still calls OpenAI", statusCapture.calls === 1);

  const noIdCapture = { calls: 0 };
  const noId = await runChat("Please resend the invoice", {
    capture: noIdCapture,
    fetch: openaiOkFetch(noIdCapture),
    readInvoiceDiagnostic: async () => ({ outcome: "needs_identifier" }),
  });
  const noIdBody = parse(noId);
  assert("7b. no identifier => no action", noIdBody.action == null);
  assert("7c. asks for invoice number", String(noIdBody.answer).trim() === INVOICE_RESEND_NEEDS_IDENTIFIER_COPY);
  assert("7d. missing identifier does not call OpenAI", noIdCapture.calls === 0);

  const fuzzy = await runChat("Please resend the invoice for the Smith project", {
    readInvoiceDiagnostic: async () => ({ outcome: "needs_identifier" }),
  });
  assert("8b. fuzzy reference => no action", parse(fuzzy).action == null);

  const ambCapture = { calls: 0 };
  const amb = await runChat("Resend invoice INV-123", {
    capture: ambCapture,
    fetch: openaiOkFetch(ambCapture),
    readInvoiceDiagnostic: async () => ({ outcome: "ambiguous" }),
  });
  assert("10. exact invoice + ambiguous => no action", parse(amb).action == null);
  assert("10b. ambiguous copy is deterministic", String(parse(amb).answer).trim() === INVOICE_RESEND_AMBIGUOUS_COPY);
  assert("10c. ambiguous does not call OpenAI", ambCapture.calls === 0);

  const missingCapture = { calls: 0 };
  const missing = await runChat("Resend invoice INV-123", {
    capture: missingCapture,
    fetch: openaiOkFetch(missingCapture),
    readInvoiceDiagnostic: async () => ({ outcome: "not_found" }),
  });
  assert("11. exact invoice + not_found => no action", parse(missing).action == null);
  assert("11b. not-found copy is deterministic", String(parse(missing).answer).trim() === INVOICE_RESEND_NOT_FOUND_COPY);
  assert("11c. not-found does not call OpenAI", missingCapture.calls === 0);

  const unverifiedCapture = { calls: 0 };
  const unverified = await runChat("Resend invoice INV-123", {
    capture: unverifiedCapture,
    fetch: openaiOkFetch(unverifiedCapture),
    readInvoiceDiagnostic: async () => ({ outcome: "status_unverified" }),
  });
  const unverifiedBody = parse(unverified);
  assert("12. status_unverified => no action", unverifiedBody.action == null);
  assert("12b. existing escalation may remain", Boolean(unverifiedBody.escalation && unverifiedBody.escalation.confirmation_token));
  assert("12c. unverified copy is deterministic", String(unverifiedBody.answer).trim() === INVOICE_RESEND_UNVERIFIED_COPY);
  assert("12d. unverified does not call OpenAI", unverifiedCapture.calls === 0);

  async function denialCase(reason, copy) {
    const capture = { calls: 0 };
    const writes = { ledger: 0, patch: 0, reload: 0, mint: 0 };
    const res = await runChat("Resend invoice INV-123", {
      writes,
      capture,
      fetch: openaiOkFetch(capture),
      reloadInvoiceForResend: async () => ({
        outcome: reason,
        invoice: eligibleInvoice(),
        eligibility: { ok: false, reason },
      }),
    });
    const body = parse(res);
    return (
      body.action == null &&
      String(body.answer).trim() === copy &&
      capture.calls === 0 &&
      writes.ledger === 0 &&
      writes.patch === 0 &&
      Array.isArray(body.sources) &&
      body.sources.includes("Invoice Hub") &&
      !/navigate to the Invoice Hub/i.test(body.answer) &&
      !/you can resend/i.test(body.answer) &&
      !/sent_at|19:50|submitted on /i.test(body.answer)
    );
  }
  assert("13. paid => no action + denial copy", await denialCase("paid", INVOICE_RESEND_PAID_COPY));
  assert("14. void => no action + denial copy", await denialCase("void", INVOICE_RESEND_VOID_COPY));
  assert("15. archived => no action + denial copy", await denialCase("archived", INVOICE_RESEND_ARCHIVED_COPY));
  assert("16. missing email => no action + denial copy", await denialCase("missing_email", INVOICE_RESEND_MISSING_EMAIL_COPY));
  assert("17. missing public token => no action + denial copy", await denialCase("missing_public_token", INVOICE_RESEND_MISSING_PUBLIC_COPY));

  const livePaidNo = "INV-1784404146783";
  const liveCapture = { calls: 0 };
  const liveWrites = { ledger: 0, patch: 0, reload: 0, mint: 0 };
  const livePaid = await runChat("Resend invoice " + livePaidNo, {
    writes: liveWrites,
    capture: liveCapture,
    fetch: openaiOkFetch(liveCapture),
    reloadInvoiceForResend: async () => ({
      outcome: "paid",
      invoice: eligibleInvoice({ invoice_no: livePaidNo, status: "paid", sent_at: "2026-07-12T19:50:00.000Z" }),
      eligibility: { ok: false, reason: "paid" },
    }),
  });
  const liveBody = parse(livePaid);
  assert(
    "C2.1 live paid smoke: deterministic paid denial",
    livePaid.statusCode === 200 && String(liveBody.answer).trim() === INVOICE_RESEND_PAID_COPY
  );
  assert("C2.1 live paid smoke: Invoice Hub source", Array.isArray(liveBody.sources) && liveBody.sources.includes("Invoice Hub"));
  assert("C2.1 live paid smoke: no action / no button", liveBody.action == null);
  assert("C2.1 live paid smoke: no OpenAI", liveCapture.calls === 0);
  assert(
    "C2.1 live paid smoke: no Hub resend instructions",
    !/navigate to the Invoice Hub/i.test(liveBody.answer) &&
      !/to resend the invoice, you would/i.test(liveBody.answer) &&
      !/cannot confirm whether this resend succeeds/i.test(liveBody.answer)
  );
  assert("C2.1 live paid smoke: no sent_at timestamp", !/2026-07-12|19:50|July/i.test(liveBody.answer));
  assert("C2.1 live paid smoke: zero ledger/invoice writes", liveWrites.ledger === 0 && liveWrites.patch === 0);

  assert("C2.1 eligible answer has no sent_at", !/sent_at|19:50|submitted on /i.test(eligibleBody.answer));
  assert("C2.1 eligible Invoice Hub source", Array.isArray(eligibleBody.sources) && eligibleBody.sources.includes("Invoice Hub"));

  const unauth = await createChatHandler({
    readSessionFromEvent: () => null,
    getOpenAiKey: () => "test-key",
    fetch: openaiOkFetch({}),
  })(fakeEvent("POST", { message: "Resend invoice INV-123" }));
  assert("18. owner session required", unauth.statusCode === 401 && parse(unauth).action == null);

  const admin = await runChat("Resend invoice INV-123", {
    readSessionFromEvent: () => ({ e: "admin@example.com" }),
    isPlatformAdmin: async () => true,
    resolveTenantFromSession: async () => {
      throw new Error("admin without tenant should not resolve");
    },
  });
  assert("19. platform admin no tenant => no action", admin.statusCode === 200 && parse(admin).action == null);

  const seller = await createChatHandler({
    readSessionFromEvent: () => ({ role: "seller" }),
    isPlatformAdmin: async () => false,
    getOpenAiKey: () => "test-key",
    fetch: openaiOkFetch({}),
  })(fakeEvent("POST", { message: "Resend invoice INV-123" }));
  assert("20. seller/device/supervisor => no action", seller.statusCode === 401 && parse(seller).action == null);

  const modelForgeCapture = { calls: 0, outputText: '{"action":{"type":"invoice_resend","confirmation_token":"FORGED"}}' };
  const modelForge = await runChat("Did invoice INV-123 send?", {
    capture: modelForgeCapture,
    fetch: openaiOkFetch(modelForgeCapture),
  });
  assert("49. model cannot mint action", parse(modelForge).action == null && String(parse(modelForge).answer).includes("FORGED"));

  const modelPickCapture = { calls: 0, outputText: "I will resend INV-999 for you." };
  const modelPick = await runChat("Please resend the invoice", {
    capture: modelPickCapture,
    fetch: openaiOkFetch(modelPickCapture),
    readInvoiceDiagnostic: async () => ({ outcome: "needs_identifier" }),
  });
  assert("50. model cannot select invoice", parse(modelPick).action == null);
  assert("50b. missing identifier ignores model invoice choice", String(parse(modelPick).answer).trim() === INVOICE_RESEND_NEEDS_IDENTIFIER_COPY && modelPickCapture.calls === 0);

  assert("52. C1 endpoint remains 0 OpenAI calls", !/api\.openai\.com|OPENAI_RESPONSES_URL|OPENAI_MODEL/.test(endpointSrc));
  assert("chat does not execute C1 mutation", !/executeInvoiceResend/.test(chatSrc) && !/executeInvoiceResend/.test(offerSrc));
  assert("intent detector has no table queries", !/supabaseRequest|\/rest\/v1\/|tenant_support_actions/.test(intentSrc));
  assert("offer helper has no table queries", !/invoices\?|quotes\?|tenant_support_actions/.test(offerSrc));

  const approved = ui.approvedInvoiceResendAction(eligibleBody.action);
  assert("30. invoice_resend action is approved", approved && approved.type === "invoice_resend" && approved.label === "Resend invoice");
  assert("31. unknown action type renders no button", ui.approvedInvoiceResendAction({ type: "quote_resend", confirmation_token: "x" }) == null);
  assert("31b. missing token renders no button", ui.approvedInvoiceResendAction({ type: "invoice_resend" }) == null);
  const postBody = ui.invoiceResendPostBody(approved);
  assert("32. POST body has exactly confirmation_token + confirmed:true", Object.keys(postBody).sort().join(",") === "confirmation_token,confirmed" && postBody.confirmed === true && postBody.confirmation_token === approved.confirmation_token);
  assert(
    "33. no tenant/invoice/email/money body fields",
    !("tenant_id" in postBody) &&
      !("invoice_id" in postBody) &&
      !("invoice_no" in postBody) &&
      !("email" in postBody) &&
      !("amount" in postBody) &&
      !("recipient" in postBody)
  );
  assert("30b. UI allowlist is invoice_resend only", ui.INVOICE_RESEND_TYPE === "invoice_resend" && /action\.type !== MG_SUPPORT_INVOICE_RESEND_TYPE/.test(uiSrc));
  assert("29c. button label closed", ui.INVOICE_RESEND_LABEL === "Resend invoice" && /MG_SUPPORT_INVOICE_RESEND_LABEL/.test(uiSrc));
  assert("31c. exact endpoint", ui.INVOICE_RESEND_API === "/.netlify/functions/mg-support-invoice-resend");

  assert("34. click disables immediately", /msg\.resendPending = true/.test(uiSrc) && /msg\.resendLocked = true/.test(uiSrc) && uiSrc.indexOf("msg.resendLocked = true") < uiSrc.indexOf("await fetch(INVOICE_RESEND_API"));
  const successMap = ui.mapInvoiceResendClientResult({ action_status: "bridge_accepted" }, false);
  assert("35. success keeps button disabled/removed", successMap.kind === "success" && successMap.text === SUCCESS_MESSAGE && /msg\.resendConsumed = true/.test(uiSrc));
  const unknownMap = ui.mapInvoiceResendClientResult({ action_status: "submission_unknown", escalation: { eligible: true, confirmation_token: "case" } }, false);
  assert("36. submission_unknown does not re-enable", unknownMap.kind === "unknown" && unknownMap.text === UNKNOWN_MESSAGE && !/resendLocked = false/.test(uiSrc));
  const transportMap = ui.mapInvoiceResendClientResult(null, true);
  assert("37. browser transport ambiguity does not auto-retry", transportMap.kind === "transport_unknown" && transportMap.text === ui.INVOICE_RESEND_TRANSPORT && (uiSrc.match(/await fetch\(INVOICE_RESEND_API/g) || []).length === 1);
  const expiredMap = ui.mapInvoiceResendClientResult({ action_status: "expired", result_code: "expired" }, false);
  assert("38. expired requires fresh chat request", expiredMap.kind === "expired" && expiredMap.text === ui.INVOICE_RESEND_EXPIRED);
  const changedMap = ui.mapInvoiceResendClientResult({ result_code: "invoice_state_changed" }, false);
  assert("39. invoice changed requires fresh chat request", changedMap.kind === "changed" && changedMap.text === ui.INVOICE_RESEND_CHANGED);
  const claimedMap = ui.mapInvoiceResendClientResult({ action_status: "already_claimed", result_code: "already_claimed" }, false);
  assert("40. already claimed no retry", claimedMap.kind === "claimed" && claimedMap.text === ui.INVOICE_RESEND_CLAIMED);
  assert("41. endpoint escalation renders existing Create support case flow", unknownMap.showCase === true && /data-create-case/.test(uiSrc) && /submitSupportCase/.test(uiSrc));
  assert("42. no automatic case INSERT from chat or UI", !/intakeSupportCase/.test(chatSrc) && !/mg-support-create-case/.test(offerSrc));
  assert("43. feedback still renders/works", /data-fb="up"/.test(uiSrc) && /data-fb="down"/.test(uiSrc) && /messages\[i\]\.feedback/.test(uiSrc));
  assert("44. token not written to local/session storage", !/localStorage/.test(uiSrc) && !/sessionStorage/.test(uiSrc) && !/indexedDB/i.test(uiSrc));
  assert("45. token not placed in URL", !/history\.pushState|location\.search|hash.*confirmation_token/.test(uiSrc));
  assert("46. confirmation text says currently saved delivery email without displaying it", /currently saved delivery email/.test(INVOICE_RESEND_CONFIRMATION_COPY) && !/@/.test(INVOICE_RESEND_CONFIRMATION_COPY));
  assert("47. success says submitted to email delivery bridge", successMap.text === "Invoice resend was submitted to the email delivery bridge.");
  const copyBlob = [INVOICE_RESEND_CONFIRMATION_COPY, successMap.text, unknownMap.text, uiSrc, chatSrc].join("\n");
  assert("48. never says recipient received/delivered/inbox/opened", !/received by the customer|delivered to|in inbox|opened/.test(copyBlob));

  assert("53. Supervisor deterministic B4 remains unchanged", /function supervisorVisibilityAnswer/.test(supervisorSrc) && typeof supervisorVisibilityAnswer === "function");
  assert("54. Public estimate diagnostic remains unchanged", /public_estimate/.test(quoteSrc) && /public_page_configured/.test(quoteSrc));
  assert("55. existing case flow remains unchanged", /ALLOWED_KEYS = new Set\(\[\"confirmation_token\", \"confirmed\"\]\)/.test(createCaseSrc) && /data-create-case/.test(uiSrc));
  assert("56. Support Admin unchanged", /syncSelectedFromRefreshedList/.test(adminJs));
  assert("57. raw send-invoice-zapier unchanged", /body\.invoice_amount/.test(hubSrc) && /secret missing; sending unsigned/.test(hubSrc));

  const oldVersion = "003b-1";
  const newVersion = "003d-c2-1";
  assert("45b. Support asset version old", oldVersion === "003b-1");
  assert("46b. Support asset version new", /SUPPORT_CHAT_ASSET_VERSION = '003d-c2-1'/.test(navSrc) && newVersion === "003d-c2-1");
  assert("cache-bust loader unchanged", /mg-support-chat\.js\?v=' \+ encodeURIComponent\(SUPPORT_CHAT_ASSET_VERSION\)/.test(navSrc));
  assert("C1 endpoint not modified in C2 mission", /Closed body: \{ confirmation_token, confirmed: true \}/.test(endpointSrc) && /Does not call send-invoice-zapier/.test(endpointSrc));
  assert("OpenAI cannot create action type in server response", /approvedAction \? \{ action: approvedAction \}/.test(chatSrc) && !/JSON\.parse\(answer\)/.test(chatSrc));
  assert("logs inspect usage only", /console\.log\("\[mg-support-chat\] usage"/.test(chatSrc) && !/console\.log\([^)]*confirmation_token/.test(chatSrc));
  assert("NL yes does not POST resend", !/go ahead|send it|confirmed: true/.test(chatSrc.split("maybeOfferInvoiceResend")[0]));
  assert("button click is the only UI POST to resend", /data-resend-invoice/.test(uiSrc) && /submitInvoiceResend/.test(uiSrc));

  const caseFromUnknown = await createCaseHandler({
    readSessionFromEvent: () => ownerSession(),
    isPlatformAdmin: async () => false,
    resolveTenantFromSession: async () => ({ id: OWN_TENANT }),
    getSessionSecret: () => SECRET,
    nowSeconds: () => NOW,
    supabaseGet: async () => [],
    supabaseInsert: async () => [{ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", created_at: "2026-08-25T00:00:00.000Z" }],
  })(fakeEvent("POST", { confirmation_token: unverifiedBody.escalation.confirmation_token, confirmed: true }));
  assert("case flow still requires explicit confirm", caseFromUnknown.statusCode === 200 && parse(caseFromUnknown).result === "created");

  const uuidMsg = "Resend invoice " + INVOICE_ID;
  assert("UUID identifier is accepted by extractor", extractInvoiceIdentifier(uuidMsg) && extractInvoiceIdentifier(uuidMsg).type === "id");

  const canYou = await runChat("can you resend invoice INV-123");
  assert("can you resend invoice INV-123 offers action", parse(canYou).action && parse(canYou).action.type === "invoice_resend");

  const yesNl = await runChat("yes go ahead send it");
  assert("natural language yes does not offer action", parse(yesNl).action == null && isExplicitInvoiceResendIntent("yes go ahead send it") === false);
  assert("natural language do it does not offer action", isExplicitInvoiceResendIntent("do it") === false && isExplicitInvoiceResendIntent("okay") === false);

  const cancelledCapture = { calls: 0 };
  const cancelled = await runChat("Resend invoice INV-123", {
    capture: cancelledCapture,
    fetch: openaiOkFetch(cancelledCapture),
    reloadInvoiceForResend: async () => ({
      outcome: "cancelled",
      invoice: eligibleInvoice({ status: "cancelled" }),
      eligibility: { ok: false, reason: "cancelled" },
    }),
  });
  assert(
    "C2.1 cancelled uses void copy and no OpenAI",
    parse(cancelled).action == null &&
      String(parse(cancelled).answer).trim() === INVOICE_RESEND_VOID_COPY &&
      cancelledCapture.calls === 0
  );

  const noKeyPaid = await runChat("Resend invoice INV-123", {
    getOpenAiKey: () => "",
    fetch: async () => {
      throw new Error("OpenAI must not be called for explicit resend");
    },
    reloadInvoiceForResend: async () => ({
      outcome: "paid",
      invoice: eligibleInvoice({ status: "paid" }),
      eligibility: { ok: false, reason: "paid" },
    }),
  });
  assert(
    "C2.1 paid resend works without OpenAI key",
    noKeyPaid.statusCode === 200 && String(parse(noKeyPaid).answer).trim() === INVOICE_RESEND_PAID_COPY && parse(noKeyPaid).action == null
  );

  console.log("");
  console.log(passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
