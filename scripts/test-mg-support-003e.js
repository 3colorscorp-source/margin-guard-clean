#!/usr/bin/env node
/**
 * MG-SUPPORT-003D.C1 — invoice resend backend + action ledger (mocked Zapier/Supabase).
 * Usage: node scripts/test-mg-support-003e.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..");
const { createHandler } = require("../netlify/functions/mg-support-invoice-resend");
const { createHandler: createCaseHandler } = require("../netlify/functions/mg-support-create-case");
const {
  TOKEN_TYPE,
  TOKEN_VERSION,
  ACTION_TYPE,
  RESEND_TTL_SECONDS,
  STATE_DOMAIN,
  computeStateFingerprint,
  computeActorFingerprint,
  canonicalActorPrincipal,
  mintInvoiceResendToken,
  verifyInvoiceResendToken,
  buildStateCanonical,
} = require("../netlify/functions/_lib/mg-support/action-token");
const {
  classifySupportInvoiceCopyVariant,
  buildSupportCanonicalInvoiceEmail,
  validateCanonicalInvoiceEmail,
  isPartialBalanceDueInvoice,
} = require("../netlify/functions/_lib/mg-support/invoice-resend-canonical");
const { evaluateInvoiceResendEligibility } = require("../netlify/functions/_lib/mg-support/invoice-resend-eligibility");
const { verifyEscalationToken } = require("../netlify/functions/_lib/mg-support/case-intake");
const { SUCCESS_MESSAGE, UNKNOWN_MESSAGE } = require("../netlify/functions/_lib/mg-support/invoice-resend-action");

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
const OTHER_USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const INVOICE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CASE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SECRET = "test-session-secret-mg-support-003e";
const ZAP_SECRET = "test-zapier-webhook-secret";
const ZAP_URL = "https://hooks.zapier.com/test/mg-support-003e";
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
    headers: extra?.headers || { host: "app.example.com", "x-forwarded-proto": "https" },
    queryStringParameters: extra?.query || {},
    body: bodyObj == null ? "" : typeof bodyObj === "string" ? bodyObj : JSON.stringify(bodyObj),
  };
}

function mintDeps(nowSeconds) {
  return {
    getSessionSecret: () => SECRET,
    nowSeconds: () => (typeof nowSeconds === "number" ? nowSeconds : NOW),
  };
}

function ownerSession(extra) {
  return { e: "owner@example.com", c: "cus_test_003e", u: OWN_USER, ...extra };
}

function decodeToken(token) {
  const [enc] = String(token || "").split(".");
  const normalized = enc.replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalized.length % 4;
  const padded = normalized + (pad ? "=".repeat(4 - pad) : "");
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
}

function uniqueErr() {
  const err = new Error("duplicate key value violates unique constraint");
  err.status = 409;
  err.supabaseRaw = "23505";
  return err;
}

function baseInvoice(extra) {
  return {
    id: INVOICE_ID,
    tenant_id: OWN_TENANT,
    invoice_no: "INV-100",
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
    invoice_label: null,
    notes: null,
    quote_id: null,
    project_id: null,
    payment_status: null,
    voided_at: null,
    ...extra,
  };
}

function makeStore(invoice, options = {}) {
  const invoiceRow = { ...invoice };
  const actions = [];
  const inflight = new Set();
  let caseInserts = 0;
  const payments = options.payments || [];
  const quotes = options.quotes || [];
  const projects = options.projects || [];

  function inflightKey(row) {
    return `${row.tenant_id}:${row.action_type}:${row.related_entity_id}`;
  }

  async function supabaseRequest(path, opts = {}) {
    const method = String(opts.method || "GET").toUpperCase();
    if (path.startsWith("invoices?") && method === "GET") {
      if (options.invoiceGetFail) throw new Error("invoice get failed");
      if (options.invoiceMissing) return [];
      if (options.invoiceAmbiguous) return [invoiceRow, { ...invoiceRow, id: OTHER_USER }];
      return [invoiceRow];
    }
    if (path.startsWith("invoices?") && method === "PATCH") {
      if (options.invoicePatchFail === "both") {
        const err = new Error("database_update_failed");
        err.status = 500;
        throw err;
      }
      if (options.invoicePatchFail === "issued" && opts.body && Object.prototype.hasOwnProperty.call(opts.body, "status")) {
        const err = new Error("violates check constraint invoices_status_check");
        err.status = 400;
        throw err;
      }
      Object.assign(invoiceRow, opts.body || {});
      return [{ ...invoiceRow }];
    }
    if (path.startsWith("tenant_project_payments") && method === "GET") {
      if (options.paymentsFail) throw new Error("payments failed");
      return payments;
    }
    if (path.startsWith("quotes?") && method === "GET") return quotes;
    if (path.startsWith("tenant_projects?") && method === "GET") return projects;
    if (path.startsWith("tenants?") && method === "GET") {
      return [{ id: OWN_TENANT, name: "Acme Builders" }];
    }
    if (path === "tenant_support_actions" && method === "POST") {
      const row = { ...(opts.body || {}) };
      if (actions.some((a) => a.idempotency_key === row.idempotency_key)) throw uniqueErr();
      if (row.status === "claimed" || row.status === "submission_unknown") {
        const key = inflightKey(row);
        if (inflight.has(key)) throw uniqueErr();
        inflight.add(key);
      }
      const created = { ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() };
      actions.push(created);
      return [created];
    }
    if (path.startsWith("tenant_support_actions?") && method === "PATCH") {
      if (options.ledgerFinalFail && opts.body && opts.body.status === "bridge_accepted") {
        throw new Error("ledger final patch failed");
      }
      const idMatch = path.match(/id=eq\.([^&]+)/);
      const id = idMatch ? decodeURIComponent(idMatch[1]) : "";
      const row = actions.find((a) => a.id === id);
      if (!row) return [];
      Object.assign(row, opts.body || {});
      if (row.status === "bridge_accepted") inflight.delete(inflightKey(row));
      return [row];
    }
    if (path === "tenant_support_cases" && method === "POST") {
      caseInserts += 1;
      return [{ id: CASE_ID, created_at: "2026-08-25T00:00:00.000Z" }];
    }
    return [];
  }

  return {
    invoiceRow,
    actions,
    inflight,
    supabaseRequest,
    caseInserts: () => caseInserts,
  };
}

function okFetch(capture) {
  return async (url, opts) => {
    if (capture) {
      capture.calls.push({ url, opts });
    }
    return { ok: true, status: 200, text: async () => "ok" };
  };
}

function statusFetch(status, capture) {
  return async (url, opts) => {
    if (capture) capture.calls.push({ url, opts });
    return { ok: status >= 200 && status < 300, status, text: async () => "err" };
  };
}

function resendDeps(store, session, extra) {
  const capture = extra?.capture || { calls: [] };
  return {
    readSessionFromEvent: extra?.readSessionFromEvent || (() => session),
    isPlatformAdmin: extra?.isPlatformAdmin || (async () => false),
    resolveTenantFromSession:
      extra?.resolveTenantFromSession || (async () => (extra?.tenantId === null ? null : { id: extra?.tenantId || OWN_TENANT })),
    getSessionSecret: () => SECRET,
    nowSeconds: () => extra?.nowSeconds || NOW,
    supabaseRequest: extra?.supabaseRequest || store.supabaseRequest,
    fetchImpl: extra?.fetchImpl || okFetch(capture),
    getZapierInvoiceWebhookUrl: extra?.getZapierInvoiceWebhookUrl || (() => ZAP_URL),
    getZapierWebhookSecret: extra?.getZapierWebhookSecret || (() => ZAP_SECRET),
    zapierTimeoutMs: extra?.zapierTimeoutMs,
    capture,
  };
}

async function runResend(event, deps) {
  return createHandler(deps)(event);
}

function mintFor(invoice, session, nowSeconds) {
  return mintInvoiceResendToken(
    { session: session || ownerSession(), tenantId: OWN_TENANT, invoice },
    mintDeps(nowSeconds)
  );
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function responseHasForbidden(body) {
  const raw = JSON.stringify(body);
  return (
    /client@example\.com/i.test(raw) ||
    /owner@example\.com/i.test(raw) ||
    /Pat Client/i.test(raw) ||
    /pubtok_/i.test(raw) ||
    /invoice-public\.html/i.test(raw) ||
    /hooks\.zapier\.com/i.test(raw) ||
    /"amount"\s*:/.test(raw) ||
    /1000/.test(raw) && /balance/i.test(raw)
  );
}

async function main() {
  const migration = read("SUPABASE_MG_SUPPORT_003C_ACTIONS.sql");
  const verifySql = read("SUPABASE_MG_SUPPORT_003C_ACTIONS_VERIFY.sql");
  const hubSrc = read("netlify/functions/send-invoice-zapier.js");
  const chatSrc = read("netlify/functions/mg-support-chat.js");
  const uiSrc = read("public/js/mg-support-chat.js");
  const endpointSrc = read("netlify/functions/mg-support-invoice-resend.js");
  const tokenSrc = read("netlify/functions/_lib/mg-support/action-token.js");
  const actionSrc = read("netlify/functions/_lib/mg-support/invoice-resend-action.js");
  const createCaseSrc = read("netlify/functions/mg-support-create-case.js");

  const invoice = baseInvoice();
  const minted = mintFor(invoice);
  const payload = decodeToken(minted.token);

  assert("token type dedicated", payload.type === TOKEN_TYPE && TOKEN_TYPE === "mg_support_invoice_resend_v1");
  assert("token version", payload.version === TOKEN_VERSION);
  assert("token action", payload.action === ACTION_TYPE);
  assert("17. state_fp keyed HMAC", payload.state_fp === computeStateFingerprint(invoice, OWN_TENANT, mintDeps()));
  assert("state domain used", buildStateCanonical(invoice, OWN_TENANT).startsWith(STATE_DOMAIN + "\n"));
  assert(
    "not raw sha256 email",
    payload.state_fp !== crypto.createHash("sha256").update("client@example.com", "utf8").digest("hex")
  );
  assert("18. raw email absent from token", !JSON.stringify(payload).includes("client@example.com"));
  assert("19. actor principal raw absent", !JSON.stringify(payload).includes(OWN_USER) && !JSON.stringify(payload).includes("owner@example.com"));
  const minted2 = mintFor(invoice);
  assert("20. nonce unique", minted.payload.nonce !== minted2.payload.nonce);
  assert("21. 15-minute TTL", payload.exp - payload.iat === RESEND_TTL_SECONDS && RESEND_TTL_SECONDS === 900);
  assert("22. timingSafeEqual in token helper", /timingSafeEqual/.test(tokenSrc));
  assert("actor_fp HMAC", payload.actor_fp === computeActorFingerprint(ownerSession(), mintDeps()));
  assert("canonical actor uses user id when present", canonicalActorPrincipal(ownerSession()) === "u:" + OWN_USER);
  assert(
    "no-u actor uses e+c not c-only",
    canonicalActorPrincipal({ e: "Owner@Example.com", c: "cus_shared" }) === "e:owner@example.com\nc:cus_shared"
  );
  assert("c-only actor principal rejected", canonicalActorPrincipal({ c: "cus_shared" }) === "");
  assert("e-only actor principal rejected", canonicalActorPrincipal({ e: "owner@example.com" }) === "");
  const approvedTokenKeys = [
    "type",
    "version",
    "action",
    "tenant_id",
    "invoice_id",
    "nonce",
    "state_fp",
    "actor_fp",
    "iat",
    "exp",
  ];
  assert(
    "token exact payload keys",
    Object.keys(payload).sort().join(",") === approvedTokenKeys.slice().sort().join(",")
  );
  assert("owner email absent from token", !JSON.stringify(payload).includes("owner@example.com"));
  assert(
    "customer PII/money/url absent from token",
    !/customer_email|customer_name|amount|balance|subject|email_body|public_token|invoice-public|notes/.test(
      JSON.stringify(payload)
    )
  );

  const expired = verifyInvoiceResendToken(minted.token, OWN_TENANT, ownerSession(), mintDeps(NOW + 16 * 60));
  assert("4. expired token deny", expired.ok === false && expired.reason === "expired");

  const wrongType = verifyInvoiceResendToken(
    require("../netlify/functions/_lib/mg-support/case-intake").mintEscalationToken(
      {
        tenant_id: OWN_TENANT,
        category: "diagnostic_unavailable",
        support_module: "invoice_hub",
        related_entity_type: "invoice",
        related_entity_ref: "INV-100",
        question_excerpt: "test",
      },
      mintDeps()
    ).token,
    OWN_TENANT,
    ownerSession(),
    mintDeps()
  );
  assert("3. wrong token type deny", wrongType.ok === false);

  const otherTenant = verifyInvoiceResendToken(minted.token, OTHER_TENANT, ownerSession(), mintDeps());
  assert("5. tenant mismatch deny", otherTenant.ok === false);

  const otherActor = verifyInvoiceResendToken(
    minted.token,
    OWN_TENANT,
    ownerSession({ u: OTHER_USER }),
    mintDeps()
  );
  assert("6. actor mismatch deny", otherActor.ok === false);

  const storeOk = makeStore(baseInvoice());
  const captureOk = { calls: [] };
  const happy = await runResend(
    fakeEvent("POST", { confirmation_token: minted.token, confirmed: true }),
    resendDeps(storeOk, ownerSession(), { capture: captureOk })
  );
  const happyBody = parse(happy);
  assert(
    "39. 2xx + invoice PATCH => bridge_accepted",
    happy.statusCode === 200 && happyBody.ok === true && happyBody.action_status === "bridge_accepted"
  );
  assert("47. success wording", happyBody.message === SUCCESS_MESSAGE);
  assert("30. 2xx path fetch once", captureOk.calls.length === 1);
  assert("29. outbound idempotency is nonce", JSON.parse(captureOk.calls[0].opts.body).idempotency_key === minted.payload.nonce);
  assert("signed Zapier headers", captureOk.calls[0].opts.headers["X-MG-Signature"] && captureOk.calls[0].opts.headers["X-MG-Nonce"]);
  assert("43. sent_at patched", Boolean(storeOk.invoiceRow.sent_at));
  assert("27. bridge_accepted releases lock", storeOk.inflight.size === 0 && storeOk.actions[0].status === "bridge_accepted");
  assert("50. no email in success response", !responseHasForbidden(happyBody) && !/client@example/.test(JSON.stringify(happyBody)));
  assert("51. no money in success response", !/"amount"|balance_due|1000/.test(JSON.stringify(happyBody).replace(SUCCESS_MESSAGE, "")));
  assert("52. no public token/URL", !/pubtok_|invoice-public/.test(JSON.stringify(happyBody)));
  assert("53. no raw Zapier response", !/"details"|zapier_error/.test(JSON.stringify(happyBody)));
  assert("57. no financial exposure", !/1000|\$/.test(JSON.stringify(happyBody)));

  const unauthStore = makeStore(baseInvoice());
  const unauthCap = { calls: [] };
  const unauth = await runResend(
    fakeEvent("POST", { confirmation_token: minted.token, confirmed: true }),
    resendDeps(unauthStore, null, {
      capture: unauthCap,
      readSessionFromEvent: () => null,
    })
  );
  assert(
    "1. unauthenticated deny",
    unauth.statusCode === 401 && parse(unauth).action_status === "local_denied" && unauthStore.actions.length === 0 && unauthCap.calls.length === 0
  );

  const noTenantStore = makeStore(baseInvoice());
  const noTenantCap = { calls: [] };
  const noTenant = await runResend(
    fakeEvent("POST", { confirmation_token: minted.token, confirmed: true }),
    resendDeps(noTenantStore, ownerSession(), { capture: noTenantCap, tenantId: null })
  );
  assert(
    "2. no tenant deny",
    noTenant.statusCode === 403 && noTenantStore.actions.length === 0 && noTenantCap.calls.length === 0
  );

  const paidInv = baseInvoice({ status: "paid", paid_amount: 1000, balance_due: 0 });
  const paidMint = mintFor(paidInv);
  const paidStore = makeStore(paidInv);
  const paidCap = { calls: [] };
  const paidRes = await runResend(
    fakeEvent("POST", { confirmation_token: paidMint.token, confirmed: true }),
    resendDeps(paidStore, ownerSession(), { capture: paidCap })
  );
  assert("8. paid deny", parse(paidRes).action_status === "local_denied" && paidStore.actions.length === 0 && paidCap.calls.length === 0);

  const voidInv = baseInvoice({ status: "void" });
  const voidMint = mintFor(voidInv);
  const voidStore = makeStore(voidInv);
  const voidCap = { calls: [] };
  const voidRes = await runResend(
    fakeEvent("POST", { confirmation_token: voidMint.token, confirmed: true }),
    resendDeps(voidStore, ownerSession(), { capture: voidCap })
  );
  assert("9. void deny", parse(voidRes).result_code === "void" && voidCap.calls.length === 0 && voidStore.actions.length === 0);

  const archInv = baseInvoice({ status: "archived" });
  const archMint = mintFor(archInv);
  const archStore = makeStore(archInv);
  const archCap = { calls: [] };
  const archRes = await runResend(
    fakeEvent("POST", { confirmation_token: archMint.token, confirmed: true }),
    resendDeps(archStore, ownerSession(), { capture: archCap })
  );
  assert("10. archived deny", parse(archRes).result_code === "archived" && archCap.calls.length === 0);

  const noEmailInv = baseInvoice({ customer_email: "" });
  const noEmailMint = mintFor(noEmailInv);
  const noEmailStore = makeStore(noEmailInv);
  const noEmailCap = { calls: [] };
  const noEmailRes = await runResend(
    fakeEvent("POST", { confirmation_token: noEmailMint.token, confirmed: true }),
    resendDeps(noEmailStore, ownerSession(), { capture: noEmailCap })
  );
  assert(
    "11. missing email deny",
    parse(noEmailRes).result_code === "missing_email" && /saved delivery email is missing/.test(parse(noEmailRes).message) && noEmailCap.calls.length === 0
  );

  const noTokInv = baseInvoice({ public_token: "" });
  const noTokMint = mintFor(noTokInv);
  const noTokStore = makeStore(noTokInv);
  const noTokCap = { calls: [] };
  const noTokRes = await runResend(
    fakeEvent("POST", { confirmation_token: noTokMint.token, confirmed: true }),
    resendDeps(noTokStore, ownerSession(), { capture: noTokCap })
  );
  assert("12. missing public token deny", parse(noTokRes).result_code === "missing_public_token" && noTokCap.calls.length === 0);

  const cfgUrlStore = makeStore(baseInvoice());
  const cfgUrlCap = { calls: [] };
  const cfgUrl = await runResend(
    fakeEvent("POST", { confirmation_token: mintFor(baseInvoice()).token, confirmed: true }),
    resendDeps(cfgUrlStore, ownerSession(), {
      capture: cfgUrlCap,
      getZapierInvoiceWebhookUrl: () => "",
    })
  );
  const cfgUrlBody = parse(cfgUrl);
  assert("13. missing webhook URL deny", cfgUrlBody.result_code === "local_config_error" && cfgUrlStore.actions.length === 0 && cfgUrlCap.calls.length === 0);
  assert("56. local_config_error mints case token", cfgUrlBody.escalation && cfgUrlBody.escalation.confirmation_token && cfgUrlBody.escalation.label === "Create support case");

  const cfgSecStore = makeStore(baseInvoice());
  const cfgSecCap = { calls: [] };
  const cfgSec = await runResend(
    fakeEvent("POST", { confirmation_token: mintFor(baseInvoice()).token, confirmed: true }),
    resendDeps(cfgSecStore, ownerSession(), {
      capture: cfgSecCap,
      getZapierWebhookSecret: () => "",
    })
  );
  assert("14. missing Zapier secret deny", parse(cfgSec).result_code === "local_config_error" && cfgSecStore.actions.length === 0 && cfgSecCap.calls.length === 0);

  const fpInv = baseInvoice();
  const fpMint = mintFor(fpInv);
  const fpChanged = baseInvoice({ sent_at: "2026-08-01T00:00:00.000Z" });
  const fpStore = makeStore(fpChanged);
  const fpCap = { calls: [] };
  const fpRes = await runResend(
    fakeEvent("POST", { confirmation_token: fpMint.token, confirmed: true }),
    resendDeps(fpStore, ownerSession(), { capture: fpCap })
  );
  assert("7. state fingerprint mismatch deny", parse(fpRes).result_code === "invoice_state_changed" && fpCap.calls.length === 0 && fpStore.actions.length === 0);

  assert("15. no ledger claim on pre-network denial", paidStore.actions.length === 0 && voidStore.actions.length === 0 && cfgUrlStore.actions.length === 0);
  assert("16. no fetch on pre-network denial", paidCap.calls.length === 0 && cfgSecCap.calls.length === 0);

  const replayStore = makeStore(baseInvoice());
  const replayCap = { calls: [] };
  const replayToken = mintFor(baseInvoice());
  const replayDeps = resendDeps(replayStore, ownerSession(), { capture: replayCap });
  await runResend(fakeEvent("POST", { confirmation_token: replayToken.token, confirmed: true }), replayDeps);
  const replay2 = await runResend(fakeEvent("POST", { confirmation_token: replayToken.token, confirmed: true }), replayDeps);
  assert("23. same nonce replay blocks", parse(replay2).action_status === "local_denied" || parse(replay2).action_status === "already_claimed");
  assert("38. no automatic second fetch", replayCap.calls.length === 1);

  const tabStore = makeStore(baseInvoice());
  const tabCap = { calls: [] };
  const tabToken = mintFor(baseInvoice());
  const tabDeps = resendDeps(tabStore, ownerSession(), { capture: tabCap });
  const tab1 = runResend(fakeEvent("POST", { confirmation_token: tabToken.token, confirmed: true }), tabDeps);
  const tab2 = runResend(fakeEvent("POST", { confirmation_token: tabToken.token, confirmed: true }), tabDeps);
  const tabOut = await Promise.all([tab1, tab2]);
  const tabOk = tabOut.filter((r) => parse(r).action_status === "bridge_accepted").length;
  const tabBlocked = tabOut.filter((r) => {
    const b = parse(r);
    return b.action_status === "already_claimed" || b.result_code === "already_claimed" || b.result_code === "invoice_state_changed";
  }).length;
  assert("24. same-token two-tab blocks", tabOk === 1 && tabBlocked === 1 && tabCap.calls.length === 1);

  const concStore = makeStore(baseInvoice());
  const concCap = { calls: [] };
  const tA = mintFor(baseInvoice());
  const tB = mintFor(baseInvoice());
  const concDeps = resendDeps(concStore, ownerSession(), { capture: concCap });
  const concOut = await Promise.all([
    runResend(fakeEvent("POST", { confirmation_token: tA.token, confirmed: true }), concDeps),
    runResend(fakeEvent("POST", { confirmation_token: tB.token, confirmed: true }), concDeps),
  ]);
  const concAccepted = concOut.filter((r) => parse(r).action_status === "bridge_accepted").length;
  const concDenied = concOut.filter((r) => {
    const b = parse(r);
    return b.action_status === "already_claimed" || b.result_code === "already_claimed" || b.result_code === "invoice_state_changed";
  }).length;
  assert("25. two tokens concurrent one claim", concAccepted === 1 && concDenied === 1 && concCap.calls.length === 1);

  const unkStore = makeStore(baseInvoice());
  const unkCap = { calls: [] };
  const unkToken = mintFor(baseInvoice());
  const unk500 = await runResend(
    fakeEvent("POST", { confirmation_token: unkToken.token, confirmed: true }),
    resendDeps(unkStore, ownerSession(), { capture: unkCap, fetchImpl: statusFetch(500, unkCap) })
  );
  assert("34. 500 => submission_unknown", parse(unk500).action_status === "submission_unknown" && parse(unk500).message === UNKNOWN_MESSAGE);
  assert("26. submission_unknown keeps lock", unkStore.inflight.size === 1 && unkStore.actions[0].status === "submission_unknown");
  const unkRetryCap = { calls: [] };
  const unkRetry = await runResend(
    fakeEvent("POST", { confirmation_token: mintFor(baseInvoice()).token, confirmed: true }),
    resendDeps(unkStore, ownerSession(), { capture: unkRetryCap })
  );
  assert("unknown blocks later token", parse(unkRetry).action_status === "already_claimed" && unkRetryCap.calls.length === 0);

  const oldAInv = baseInvoice();
  const oldStore = makeStore(oldAInv);
  const tokenBeforeA = mintFor(oldAInv);
  const tokenBeforeB = mintFor(oldAInv);
  const oldCap = { calls: [] };
  const oldDeps = resendDeps(oldStore, ownerSession(), { capture: oldCap });
  const first = await runResend(fakeEvent("POST", { confirmation_token: tokenBeforeA.token, confirmed: true }), oldDeps);
  const secondOld = await runResend(fakeEvent("POST", { confirmation_token: tokenBeforeB.token, confirmed: true }), oldDeps);
  assert("28. old token after sent_at change fails state_fp", parse(first).ok === true && parse(secondOld).result_code === "invoice_state_changed" && oldCap.calls.length === 1);

  const emailMintInv = baseInvoice();
  const emailMint = mintFor(emailMintInv);
  const emailStore = makeStore(baseInvoice({ customer_email: "new@example.com" }));
  const emailCap = { calls: [] };
  const emailRes = await runResend(
    fakeEvent("POST", { confirmation_token: emailMint.token, confirmed: true }),
    resendDeps(emailStore, ownerSession(), { capture: emailCap })
  );
  assert("29b. email change after mint fails state_fp", parse(emailRes).result_code === "invoice_state_changed" && emailCap.calls.length === 0);

  async function networkCase(status, label) {
    const st = makeStore(baseInvoice());
    const cap = { calls: [] };
    const res = await runResend(
      fakeEvent("POST", { confirmation_token: mintFor(baseInvoice()).token, confirmed: true }),
      resendDeps(st, ownerSession(), { capture: cap, fetchImpl: statusFetch(status, cap) })
    );
    assert(label, parse(res).action_status === "submission_unknown" && cap.calls.length === 1 && st.actions[0].status === "submission_unknown");
  }
  await networkCase(400, "31. 400 => submission_unknown");
  await networkCase(401, "32. 401 => submission_unknown");
  await networkCase(403, "32b. 403 => submission_unknown");
  await networkCase(429, "33. 429 => submission_unknown");

  const throwStore = makeStore(baseInvoice());
  const throwCap = { calls: [] };
  const throwRes = await runResend(
    fakeEvent("POST", { confirmation_token: mintFor(baseInvoice()).token, confirmed: true }),
    resendDeps(throwStore, ownerSession(), {
      capture: throwCap,
      fetchImpl: async (url, opts) => {
        throwCap.calls.push({ url, opts });
        throw new Error("ECONNRESET");
      },
    })
  );
  assert("35. fetch throw => submission_unknown", parse(throwRes).action_status === "submission_unknown" && throwCap.calls.length === 1);

  const abortStore = makeStore(baseInvoice());
  const abortCap = { calls: [] };
  const abortRes = await runResend(
    fakeEvent("POST", { confirmation_token: mintFor(baseInvoice()).token, confirmed: true }),
    resendDeps(abortStore, ownerSession(), {
      capture: abortCap,
      zapierTimeoutMs: 20,
      fetchImpl: (url, opts) =>
        new Promise((_resolve, reject) => {
          abortCap.calls.push({ url, opts });
          opts.signal.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
    })
  );
  assert("36. timeout/abort => submission_unknown", parse(abortRes).action_status === "submission_unknown" && abortCap.calls.length === 1);

  const malStore = makeStore(baseInvoice());
  const malCap = { calls: [] };
  const malRes = await runResend(
    fakeEvent("POST", { confirmation_token: mintFor(baseInvoice()).token, confirmed: true }),
    resendDeps(malStore, ownerSession(), {
      capture: malCap,
      fetchImpl: async (url, opts) => {
        malCap.calls.push({ url, opts });
        return { ok: true, text: async () => "not-a-status" };
      },
    })
  );
  assert("37. malformed response after POST => submission_unknown", parse(malRes).action_status === "submission_unknown");

  const issuedStore = makeStore(baseInvoice(), { invoicePatchFail: "issued" });
  const issuedCap = { calls: [] };
  const issuedRes = await runResend(
    fakeEvent("POST", { confirmation_token: mintFor(baseInvoice()).token, confirmed: true }),
    resendDeps(issuedStore, ownerSession(), { capture: issuedCap })
  );
  assert(
    "40. issued constraint + sent_at fallback => bridge_accepted",
    parse(issuedRes).action_status === "bridge_accepted" && issuedStore.invoiceRow.sent_at && issuedStore.invoiceRow.status !== "issued"
  );

  const bothStore = makeStore(baseInvoice(), { invoicePatchFail: "both" });
  const bothCap = { calls: [] };
  const bothRes = await runResend(
    fakeEvent("POST", { confirmation_token: mintFor(baseInvoice()).token, confirmed: true }),
    resendDeps(bothStore, ownerSession(), { capture: bothCap })
  );
  assert(
    "41. 2xx + invoice PATCH failure => submission_unknown",
    parse(bothRes).action_status === "submission_unknown" && bothStore.actions[0].status === "submission_unknown" && bothCap.calls.length === 1
  );

  const ledStore = makeStore(baseInvoice(), { ledgerFinalFail: true });
  const ledCap = { calls: [] };
  const ledRes = await runResend(
    fakeEvent("POST", { confirmation_token: mintFor(baseInvoice()).token, confirmed: true }),
    resendDeps(ledStore, ownerSession(), { capture: ledCap })
  );
  const ledBody = parse(ledRes);
  assert(
    "42. invoice PATCH success + ledger final fail => no retry",
    ledBody.ok === false && ledStore.invoiceRow.sent_at && ledStore.actions[0].status === "claimed" && ledCap.calls.length === 1
  );

  const stdBuilt = await buildSupportCanonicalInvoiceEmail({
    invoice: baseInvoice(),
    publicUrl: "https://example.com/invoice-public.html?token=x",
    businessName: "Acme",
  });
  assert("44. standard server-only build", stdBuilt.variant === "standard" && validateCanonicalInvoiceEmail(stdBuilt.canonical).ok);

  const matBuilt = await buildSupportCanonicalInvoiceEmail({
    invoice: baseInvoice({ invoice_label: "Material Cost", amount: 250, balance_due: 250 }),
    publicUrl: "https://example.com/invoice-public.html?token=x",
    businessName: "Acme",
  });
  assert("45. material_cost server-only build", matBuilt.variant === "material_cost" && validateCanonicalInvoiceEmail(matBuilt.canonical).ok);

  const projInvoice = baseInvoice({
    invoice_label: "Start Payment",
    project_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    quote_id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    amount: 400,
    balance_due: 400,
  });
  const projBuilt = await buildSupportCanonicalInvoiceEmail({
    invoice: projInvoice,
    publicUrl: "https://example.com/invoice-public.html?token=x",
    businessName: "Acme",
    deps: {
      supabaseGet: async (p) => {
        if (p.startsWith("quotes?")) return [{ total: 2000 }];
        if (p.startsWith("tenant_projects?")) return [{ sale_price: 2000 }];
        if (p.startsWith("tenant_project_payments?")) return [{ amount: 200 }];
        return [];
      },
    },
  });
  assert("46. project_payment server-only build", projBuilt.variant === "project_payment" && validateCanonicalInvoiceEmail(projBuilt.canonical).ok);

  const partialInv = baseInvoice({ amount: 1000, paid_amount: 400, balance_due: 600 });
  const partialBuilt = await buildSupportCanonicalInvoiceEmail({
    invoice: partialInv,
    publicUrl: "https://example.com/invoice-public.html?token=x",
    businessName: "Acme",
  });
  assert("47b. partial_balance_due server-only build", partialBuilt.variant === "partial_balance_due" && isPartialBalanceDueInvoice(partialInv) && validateCanonicalInvoiceEmail(partialBuilt.canonical).ok);

  assert("48. Support classifier has no body hints", classifySupportInvoiceCopyVariant.length === 1);

  const zeroInv = baseInvoice({ amount: 0, balance_due: 0, paid_amount: 0 });
  const zeroElig = evaluateInvoiceResendEligibility(zeroInv, { isFullyPaid: false, balanceDue: 0 });
  assert("49. validation/amount failure local deny", zeroElig.ok === false);

  const extraKeys = await runResend(
    fakeEvent("POST", { confirmation_token: minted.token, confirmed: true, amount: 12, email: "x@y.com" }),
    resendDeps(makeStore(baseInvoice()), ownerSession(), { capture: { calls: [] } })
  );
  assert("45b. extra keys rejected", extraKeys.statusCode === 400 && parse(extraKeys).result_code === "invalid_request");

  const unkCaseBody = parse(unk500);
  assert("55. submission_unknown mints case confirmation", unkCaseBody.escalation && unkCaseBody.escalation.confirmation_token);
  const caseVerified = verifyEscalationToken(unkCaseBody.escalation.confirmation_token, OWN_TENANT, mintDeps());
  assert("case token verifies with existing helper", caseVerified.ok === true && caseVerified.payload.category === "diagnostic_unavailable");
  assert("case excerpt has no PII", !/client@|Pat Client|1000|pubtok/.test(caseVerified.payload.question_excerpt));

  const caseCounters = { inserts: 0 };
  const caseFromUnknown = await createCaseHandler({
    readSessionFromEvent: () => ownerSession(),
    isPlatformAdmin: async () => false,
    resolveTenantFromSession: async () => ({ id: OWN_TENANT }),
    getSessionSecret: () => SECRET,
    nowSeconds: () => NOW,
    supabaseGet: async () => [],
    supabaseInsert: async (row) => {
      caseCounters.inserts += 1;
      return [{ id: CASE_ID, created_at: "2026-08-25T00:00:00.000Z" }];
    },
  })(fakeEvent("POST", { confirmation_token: unkCaseBody.escalation.confirmation_token, confirmed: true }));
  assert("59. existing create-case contract unchanged", caseFromUnknown.statusCode === 200 && parse(caseFromUnknown).result === "created");
  assert("57b. action endpoint itself did not insert a case", unkStore.caseInserts() === 0);
  assert("58. business denial does not mint case", !parse(paidRes).escalation && !parse(voidRes).escalation);

  assert("54. no model call in endpoint source", !/api\.openai\.com|OPENAI_RESPONSES_URL|OPENAI_MODEL|OPENAI_API/.test(endpointSrc + actionSrc));
  assert("51b. chat action not exposed", !/mintInvoiceResendToken|invoice_resend/.test(chatSrc));
  assert("52b. UI button not exposed", !/Resend invoice|mg-support-invoice-resend/.test(uiSrc));

  assert("60. Hub still accepts client amount hints", /body\.invoice_amount/.test(hubSrc) && /body\.paid_to_date/.test(hubSrc));
  assert("61. Hub auth unchanged", /session\?\.e \|\| !session\?\.c/.test(hubSrc) || /session\?\.e && session\?\.c/.test(hubSrc) || /if \(!session\?\.e \|\| !session\?\.c\)/.test(hubSrc));
  assert("62. Hub tenant derivation unchanged", /resolveTenantFromSession/.test(hubSrc));
  assert("63. Hub recipient remains DB customer_email", /pickFirstStr\(invoice\.customer_email\)/.test(hubSrc));
  assert("64. Hub network behavior unchanged", !/AbortController/.test(hubSrc) && /ZAPIER_INVOICE_SEND_WEBHOOK_URL/.test(hubSrc));
  assert("Hub unsigned still allowed when secret missing", /secret missing; sending unsigned/.test(hubSrc));
  assert("raw endpoint not rewritten as wrapper", /exports\.handler = async \(event\) =>/.test(hubSrc));

  assert("migration table", /create table if not exists public\.tenant_support_actions/.test(migration));
  assert("unique nonce constraint", /unique \(idempotency_key\)/.test(migration));
  assert("partial inflight unique", /where status in \('claimed', 'submission_unknown'\)/.test(migration));
  assert("RLS enabled", /enable row level security/.test(migration));
  assert("revoke anon/authenticated", /revoke all on table public\.tenant_support_actions from anon/.test(migration));
  assert("no PII columns", !/customer_email|amount|email_body|public_token/.test(migration.split("create table")[1].split(";")[0]));
  assert("verify file read-only", /does not insert, update, or delete rows/i.test(verifySql) && /VERIFY PASS/.test(verifySql));
  assert("status check claimed/bridge_accepted/unknown", /claimed.*bridge_accepted.*submission_unknown/s.test(migration));
  assert("C1 does not mint from chat", !/mintInvoiceResendToken/.test(chatSrc));
  assert("create-case still closed body", /ALLOWED_KEYS = new Set\(\[\"confirmation_token\", \"confirmed\"\]\)/.test(createCaseSrc));

  const extraDenied = evaluateInvoiceResendEligibility(baseInvoice({ status: "unknown_status" }), {
    isFullyPaid: false,
    balanceDue: 1000,
  });
  assert("unknown status denied", extraDenied.ok === false && extraDenied.reason === "ineligible_status");

  const sameUStore = makeStore(baseInvoice());
  const sameUCap = { calls: [] };
  const sameUToken = mintFor(baseInvoice(), ownerSession());
  const sameURes = await runResend(
    fakeEvent("POST", { confirmation_token: sameUToken.token, confirmed: true }),
    resendDeps(sameUStore, ownerSession(), { capture: sameUCap })
  );
  assert("G1. session.u owner A executes own token", parse(sameURes).action_status === "bridge_accepted" && sameUCap.calls.length === 1);

  const diffUStore = makeStore(baseInvoice());
  const diffUCap = { calls: [] };
  const ownerAToken = mintFor(baseInvoice(), ownerSession());
  const diffURes = await runResend(
    fakeEvent("POST", { confirmation_token: ownerAToken.token, confirmed: true }),
    resendDeps(diffUStore, ownerSession({ u: OTHER_USER }), { capture: diffUCap })
  );
  const diffUBody = parse(diffURes);
  assert("G2. different session.u same tenant denied", diffUBody.action_status === "local_denied" && diffUBody.result_code === "invalid_token");
  assert("G2 no ledger", diffUStore.actions.length === 0);
  assert("G2 no fetch", diffUCap.calls.length === 0);
  assert("G2 no PII", !/owner@example|client@example|cus_test|aaaaaaaa/.test(JSON.stringify(diffUBody)));

  const noUOwnerA = { e: "owner-a@example.com", c: "cus_shared_003e" };
  const noUOwnerB = { e: "owner-b@example.com", c: "cus_shared_003e" };
  const noUSameEDiffC = { e: "owner-a@example.com", c: "cus_other_003e" };
  const noUAToken = mintInvoiceResendToken(
    { session: noUOwnerA, tenantId: OWN_TENANT, invoice: baseInvoice() },
    mintDeps()
  );
  const noUAStore = makeStore(baseInvoice());
  const noUACap = { calls: [] };
  const noUARes = await runResend(
    fakeEvent("POST", { confirmation_token: noUAToken.token, confirmed: true }),
    resendDeps(noUAStore, noUOwnerA, { capture: noUACap })
  );
  assert("G3. no-u same e+c allowed", parse(noUARes).action_status === "bridge_accepted" && noUACap.calls.length === 1);
  assert("created_by_user_id null without session.u", noUAStore.actions[0].created_by_user_id === null);

  const noUBStore = makeStore(baseInvoice());
  const noUBCap = { calls: [] };
  const noUBToken = mintInvoiceResendToken(
    { session: noUOwnerA, tenantId: OWN_TENANT, invoice: baseInvoice() },
    mintDeps()
  );
  const noUBRes = await runResend(
    fakeEvent("POST", { confirmation_token: noUBToken.token, confirmed: true }),
    resendDeps(noUBStore, noUOwnerB, { capture: noUBCap })
  );
  const noUBBody = parse(noUBRes);
  assert("G4. no-u different e same c denied", noUBBody.result_code === "invalid_token" && noUBStore.actions.length === 0 && noUBCap.calls.length === 0);

  const noUCStore = makeStore(baseInvoice());
  const noUCCap = { calls: [] };
  const noUCRes = await runResend(
    fakeEvent("POST", { confirmation_token: noUBToken.token, confirmed: true }),
    resendDeps(noUCStore, noUSameEDiffC, { capture: noUCCap })
  );
  assert("G5. same e different c denied", parse(noUCRes).result_code === "invalid_token" && noUCStore.actions.length === 0 && noUCCap.calls.length === 0);
  assert("G6 actor mismatch before ledger", diffUStore.actions.length === 0 && noUBStore.actions.length === 0);
  assert("G7 actor mismatch before fetch", diffUCap.calls.length === 0 && noUBCap.calls.length === 0 && noUCCap.calls.length === 0);
  assert("G8 actor mismatch no PII", !/owner-a@|owner-b@|cus_shared/.test(JSON.stringify(noUBBody)));

  const stage1Src = read("scripts/test-mg-support-001b.js");
  const stage1Exempt = [...stage1Src.matchAll(/f !== "([^"]+\.js)"/g)].map((m) => m[1]);
  const uniqueExempt = [...new Set(stage1Exempt)];
  const c1Exempt = [
    "invoice-resend-eligibility.js",
    "invoice-resend-canonical.js",
    "invoice-resend-action.js",
  ];
  assert(
    "001b C1 exemption is exact three files",
    c1Exempt.every((f) => uniqueExempt.includes(f)) && uniqueExempt.filter((f) => f.startsWith("invoice-resend-")).length === 3
  );
  assert("001b no wildcard exemption", !/startsWith\(|endsWith\(|invoice-resend-\*|\/invoice-resend/.test(stage1Src));
  assert("future quote-resend-action.js not exempt", !uniqueExempt.includes("quote-resend-action.js"));
  assert("no generic action bypass", !uniqueExempt.includes("action.js") && !/startsWith\(|endsWith\(/.test(stage1Src));

  const actionImplSrc =
    read("netlify/functions/_lib/mg-support/invoice-resend-eligibility.js") +
    "\n" +
    read("netlify/functions/_lib/mg-support/invoice-resend-canonical.js") +
    "\n" +
    read("netlify/functions/_lib/mg-support/invoice-resend-action.js") +
    "\n" +
    read("netlify/functions/mg-support-invoice-resend.js");
  const tableRefs = [...actionImplSrc.matchAll(/`([a-z_]+)\?/g)].map((m) => m[1]);
  const allowedTables = new Set([
    "invoices",
    "quotes",
    "tenant_projects",
    "tenant_project_payments",
    "tenants",
    "tenant_support_actions",
  ]);
  assert("closed table list only", tableRefs.every((t) => allowedTables.has(t)));
  assert("no contacts/users/device/quote mutation paths", !/contacts\?|users\?|device_sessions\?|financial_/.test(actionImplSrc));
  assert("ACTIONS_TABLE is tenant_support_actions", /ACTIONS_TABLE = "tenant_support_actions"/.test(actionSrc));
  assert("no request-selected table", !/body\.(table|path)|req\.table/.test(actionImplSrc));
  assert("no chat mint in this phase", !/mintInvoiceResendToken/.test(chatSrc) && !/mg-support-invoice-resend/.test(uiSrc));

  console.log(passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
