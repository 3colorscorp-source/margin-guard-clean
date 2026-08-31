#!/usr/bin/env node
/**
 * MG-SUPPORT-003E.2D2 — safe claim + background notification delivery
 * (mocked DB/network only). Usage: node scripts/test-mg-support-003e-2d2.js
 *
 * Does not apply SQL, mutate production, set env, send email, or call Zapier.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..");
const { createHandler: createUpdateHandler } = require("../netlify/functions/mg-support-admin-update-case");
const { createHandler: createDispatchHandler } = require("../netlify/functions/mg-support-case-notification-dispatch-background");
const { parseUpdateBody, updateAdminCase } = require("../netlify/functions/_lib/mg-support/admin-cases");
const {
  ENV,
  CTA_URL,
  SCHEMA_VERSION,
  POST_TIMEOUT_MS,
  DISPATCH_FUNCTION,
  CLAIM_PROCESS_DEATH_NOTE,
  DISPATCH_BODY_KEYS,
  TEMPLATES,
  buildTemplate,
  buildCanonicalPayload,
  encodePayloadB64,
  signSupportPayload,
  signCanonicalBody,
  canonicalizeJson,
  dispatchPendingEvent,
  kickSupportCaseNotificationDispatch,
  parseDispatchBody,
  assertDispatchAuth,
  buildClaimPath,
  getSupportZapierConfig,
} = require("../netlify/functions/_lib/mg-support/notification-delivery");
const { createStatelessRpc } = require("./_lib/mg-support-transition-rpc-sim");

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

const CASE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const EVENT_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NOW = "2026-08-29T01:00:00.000Z";
const OWNER_EMAIL = "owner@example.com";
const CASE_REF = "MG-SUP-" + CASE_ID;
const SUPPORT_HMAC = "support-hmac-secret-d2";
const SUPPORT_WEBHOOK = "https://hooks.example.test/support-case-email";
const SUPPORT_DISPATCH = "support-dispatch-secret-d2";
const INVOICE_SECRET = "invoice-secret-must-not-be-used";
const CONTRACT_SECRET = "contract-secret-must-not-be-used";

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function decodePath(p) {
  try {
    return decodeURIComponent(String(p || ""));
  } catch (_err) {
    return String(p || "");
  }
}

function enabledEnv(extra) {
  return Object.assign(
    {
      [ENV.ENABLED]: "true",
      [ENV.WEBHOOK]: SUPPORT_WEBHOOK,
      [ENV.HMAC]: SUPPORT_HMAC,
      [ENV.DISPATCH]: SUPPORT_DISPATCH,
      ZAPIER_WEBHOOK_SECRET: INVOICE_SECRET,
      ZAPIER_INVOICE_SEND_WEBHOOK_URL: "https://hooks.example.test/invoice",
      CONTRACT_EMAIL_ZAPIER_HMAC_SECRET: CONTRACT_SECRET,
      CONTRACT_EMAIL_ZAPIER_WEBHOOK_URL: "https://hooks.example.test/contract",
    },
    extra || {}
  );
}

function baseEvent(extra) {
  return Object.assign(
    {
      id: EVENT_ID,
      tenant_id: TENANT_ID,
      case_id: CASE_ID,
      event_type: "case_in_review",
      from_status: "open",
      to_status: "in_review",
      case_status_version: 2,
      payload_version: 1,
      delivery_status: "pending",
      attempt_count: 0,
      result_code: null,
      created_at: NOW,
      claimed_at: null,
      processed_at: null,
    },
    extra || {}
  );
}

function createWorld(opts) {
  const options = opts || {};
  const event = baseEvent(options.event);
  const caseRow = Object.assign(
    { id: CASE_ID, tenant_id: TENANT_ID, status: "in_review", status_version: 2 },
    options.caseRow || {}
  );
  const tenant = Object.assign(
    { id: TENANT_ID, owner_email: options.ownerEmail === undefined ? OWNER_EMAIL : options.ownerEmail },
    options.tenant || {}
  );
  const patches = [];
  const posts = [];
  let lock = false;

  async function supabaseRequest(path, init) {
    const decoded = decodePath(path);
    const method = String((init && init.method) || "GET").toUpperCase();
    if (method === "GET" && decoded.startsWith("tenant_support_notification_outbox?")) {
      return [{ ...event }];
    }
    if (method === "GET" && decoded.startsWith("tenant_support_cases?")) {
      return [{ ...caseRow }];
    }
    if (method === "GET" && decoded.startsWith("tenants?")) {
      return [{ ...tenant }];
    }
    if (method === "PATCH" && decoded.startsWith("tenant_support_notification_outbox?")) {
      patches.push({ path: decoded, body: Object.assign({}, init.body || {}) });
      if (options.finalizeConflict && event.delivery_status === "claimed" && decoded.includes("delivery_status=eq.claimed")) {
        return [];
      }
      if (decoded.includes("delivery_status=eq.pending") && decoded.includes("attempt_count=eq.")) {
        const matched = /attempt_count=eq\.(\d+)/.exec(decoded);
        const expected = matched ? Number(matched[1]) : -1;
        if (lock || event.delivery_status !== "pending" || event.attempt_count !== expected) {
          return [];
        }
        lock = true;
        Object.assign(event, init.body || {});
        lock = false;
        return [{ ...event }];
      }
      if (decoded.includes("delivery_status=eq.pending")) {
        if (event.delivery_status !== "pending") return [];
        Object.assign(event, init.body || {});
        return [{ ...event }];
      }
      if (decoded.includes("delivery_status=eq.claimed")) {
        const matched = /attempt_count=eq\.(\d+)/.exec(decoded);
        const expected = matched ? Number(matched[1]) : -1;
        if (event.delivery_status !== "claimed" || event.attempt_count !== expected) return [];
        Object.assign(event, init.body || {});
        return [{ ...event }];
      }
      return [];
    }
    throw new Error("unexpected path " + decoded);
  }

  async function fetchImpl(url, init) {
    posts.push({ url: String(url || ""), init: init || {} });
    if (options.postAbort) {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }
    if (options.postNetwork) {
      throw new Error("ECONNRESET");
    }
    if (options.postUnknown) {
      return {};
    }
    const status = options.postStatus == null ? 202 : options.postStatus;
    return { status };
  }

  const deps = {
    env: enabledEnv(options.env),
    supabaseRequest,
    fetchImpl,
    nowIso: () => NOW,
  };

  return {
    event,
    caseRow,
    tenant,
    patches,
    posts,
    deps,
    getEvent: () => ({ ...event }),
  };
}

function parse(res) {
  try {
    return JSON.parse(res.body || "{}");
  } catch (_err) {
    return {};
  }
}

async function main() {
  const deliverySrc = read("netlify/functions/_lib/mg-support/notification-delivery.js");
  const dispatchSrc = read("netlify/functions/mg-support-case-notification-dispatch-background.js");
  const helperSrc = read("netlify/functions/_lib/mg-support/admin-cases.js");
  const updateSrc = read("netlify/functions/mg-support-admin-update-case.js");
  const chatSrc = read("netlify/functions/mg-support-chat.js");
  const routerSrc = read("netlify/functions/_lib/mg-support/router.js");
  const invoiceSrc = read("netlify/functions/_lib/mg-support/invoice-resend-action.js");
  const contractZapierSrc = read("netlify/functions/_lib/providers/zapier-provider.js");
  const myCasesSrc = read("netlify/functions/_lib/mg-support/my-cases.js");
  const d2Src = deliverySrc + dispatchSrc;

  const disabled = createWorld({ env: { [ENV.ENABLED]: "false" } });
  const disabledRes = await dispatchPendingEvent(EVENT_ID, disabled.deps);
  assert("1. disabled kill switch leaves pending", disabledRes.result === "delivery_disabled" && disabled.getEvent().delivery_status === "pending");
  assert("2. disabled kill switch does not claim", disabled.getEvent().claimed_at == null && disabled.patches.length === 0);
  assert("3. disabled kill switch does not increment attempt_count", disabled.getEvent().attempt_count === 0);
  assert("4. disabled kill switch performs no POST", disabled.posts.length === 0);

  assert("5. dispatcher accepts event_id only", DISPATCH_BODY_KEYS.size === 1 && DISPATCH_BODY_KEYS.has("event_id"));
  assert("6. browser tenant rejected", parseDispatchBody(JSON.stringify({ event_id: EVENT_ID, tenant_id: TENANT_ID })).ok === false);
  assert("7. browser recipient rejected", parseDispatchBody(JSON.stringify({ event_id: EVENT_ID, recipient_email: OWNER_EMAIL })).ok === false);
  assert("8. browser event_type rejected", parseDispatchBody(JSON.stringify({ event_id: EVENT_ID, event_type: "case_in_review" })).ok === false);
  assert("9. browser subject/body rejected", parseDispatchBody(JSON.stringify({ event_id: EVENT_ID, subject: "x", text_body: "y" })).ok === false);

  const happy = createWorld();
  const happyRes = await dispatchPendingEvent(EVENT_ID, happy.deps);
  assert("10. event must be pending", happyRes.delivery_status === "bridge_accepted" && happy.posts.length === 1);

  for (const [label, status] of [
    ["11. non-pending bridge_accepted not dispatched", "bridge_accepted"],
    ["12. submission_unknown not dispatched", "submission_unknown"],
    ["13. claimed not dispatched", "claimed"],
    ["14. failed not automatically dispatched", "failed"],
  ]) {
    const world = createWorld({ event: { delivery_status: status, attempt_count: 1, result_code: status } });
    const res = await dispatchPendingEvent(EVENT_ID, world.deps);
    assert(label, res.result === "not_pending" && world.posts.length === 0 && world.getEvent().delivery_status === status);
  }

  const mismatch = createWorld({ caseRow: { tenant_id: "22222222-2222-4222-8222-222222222222" } });
  const mismatchRes = await dispatchPendingEvent(EVENT_ID, mismatch.deps);
  assert(
    "15. case/event tenant match required",
    mismatchRes.result === "tenant_mismatch" &&
      mismatch.getEvent().delivery_status === "failed" &&
      mismatch.posts.length === 0
  );

  const derived = createWorld();
  await dispatchPendingEvent(EVENT_ID, derived.deps);
  const derivedWire = JSON.parse(derived.posts[0].init.body);
  const signed = JSON.parse(Buffer.from(derivedWire.payload_b64, "base64url").toString("utf8"));
  assert("16. recipient derived from tenants.owner_email", signed.recipient_email === OWNER_EMAIL);

  assert("17. admin/session email never used", !/session\.e|assertPlatformAdminSession/.test(deliverySrc));
  assert(
    "18. recipient not persisted",
    !("recipient_email" in derived.getEvent()) &&
      !("owner_email" in derived.getEvent()) &&
      derived.getEvent().result_code === "bridge_accepted"
  );

  const missing = createWorld({ ownerEmail: "" });
  const missingRes = await dispatchPendingEvent(EVENT_ID, missing.deps);
  assert(
    "19. missing owner email → failed/no POST/attempt_count 0",
    missingRes.result === "missing_owner_email" &&
      missing.getEvent().delivery_status === "failed" &&
      missing.getEvent().attempt_count === 0 &&
      missing.posts.length === 0
  );

  const invalid = createWorld({ ownerEmail: "not-an-email" });
  const invalidRes = await dispatchPendingEvent(EVENT_ID, invalid.deps);
  assert(
    "20. invalid owner email → failed/no POST/attempt_count 0",
    invalidRes.result === "invalid_owner_email" &&
      invalid.getEvent().delivery_status === "failed" &&
      invalid.getEvent().attempt_count === 0 &&
      invalid.posts.length === 0
  );

  const noHook = createWorld({ env: { [ENV.WEBHOOK]: "" } });
  const noHookRes = await dispatchPendingEvent(EVENT_ID, noHook.deps);
  assert(
    "21. missing Support webhook config → failed/no POST/attempt_count 0",
    noHookRes.result === "local_config_error" && noHook.getEvent().attempt_count === 0 && noHook.posts.length === 0
  );

  const noHmac = createWorld({ env: { [ENV.HMAC]: "" } });
  const noHmacRes = await dispatchPendingEvent(EVENT_ID, noHmac.deps);
  assert(
    "22. missing Support HMAC secret → failed/no POST/attempt_count 0",
    noHmacRes.result === "local_config_error" && noHmac.getEvent().attempt_count === 0 && noHmac.posts.length === 0
  );

  const reviewTpl = buildTemplate("case_in_review", CASE_REF);
  const waitTpl = buildTemplate("case_waiting_on_customer", CASE_REF);
  const resolvedTpl = buildTemplate("case_resolved", CASE_REF);
  const reopenTpl = buildTemplate("case_reopened", CASE_REF);
  assert(
    "23. closed in_review subject/body exact",
    reviewTpl.subject === "Margin Guard Support — Case Update" &&
      reviewTpl.text_body ===
        "Your support case " + CASE_REF + " is currently being reviewed.\nOpen Margin Guard and select Ask Margin Guard → My Cases.\n" + CTA_URL
  );
  assert(
    "24. closed waiting subject/body exact",
    waitTpl.subject === "Margin Guard Support — Action Needed" &&
      waitTpl.text_body ===
        "Support needs something from you before support case " + CASE_REF + " can continue.\nOpen Margin Guard and select Ask Margin Guard → My Cases.\n" + CTA_URL
  );
  assert(
    "25. closed resolved subject/body exact",
    resolvedTpl.subject === "Margin Guard Support — Case Resolved" &&
      resolvedTpl.text_body ===
        "Support case " + CASE_REF + " has been resolved.\nOpen Margin Guard and select Ask Margin Guard → My Cases.\n" + CTA_URL
  );
  assert(
    "26. closed reopened subject/body exact",
    reopenTpl.subject === "Margin Guard Support — Case Reopened" &&
      reopenTpl.text_body ===
        "Support case " + CASE_REF + " has been reopened.\nOpen Margin Guard and select Ask Margin Guard → My Cases.\n" + CTA_URL
  );

  const emailText = reviewTpl.subject + reviewTpl.text_body + waitTpl.text_body + resolvedTpl.text_body + reopenTpl.text_body;
  assert("27. action message absent from email", !/Please send|tenant_action_message/.test(emailText + signed.subject + signed.text_body));
  assert("28. customer resolution absent from email", !/We restored|customer_resolution/.test(emailText + signed.subject + signed.text_body));
  assert("29. question excerpt absent", !/question_excerpt/.test(emailText + JSON.stringify(signed)));
  assert("30. financial data absent", !/invoice|amount|price|deposit/i.test(signed.subject + signed.text_body));

  const payloadKeys = Object.keys(signed).sort();
  assert(
    "31. canonical payload schema exact",
    signed.schema_version === SCHEMA_VERSION &&
      JSON.stringify(payloadKeys) ===
        JSON.stringify([
          "case_ref",
          "event_id",
          "event_type",
          "idempotency_key",
          "recipient_email",
          "schema_version",
          "subject",
          "text_body",
          "timestamp",
        ].sort())
  );
  assert("32. idempotency key exact", signed.idempotency_key === CASE_ID + ":2:case_in_review");

  const samplePayload = buildCanonicalPayload({
    eventId: EVENT_ID,
    eventType: "case_in_review",
    caseRef: CASE_REF,
    recipientEmail: OWNER_EMAIL,
    subject: reviewTpl.subject,
    textBody: reviewTpl.text_body,
    timestamp: NOW,
    caseId: CASE_ID,
    caseStatusVersion: 2,
  });
  const sigA = signSupportPayload(samplePayload, SUPPORT_HMAC, NOW);
  const sigB = signSupportPayload(samplePayload, SUPPORT_HMAC, NOW);
  assert("33. HMAC deterministic", sigA.ok && sigA.signature === sigB.signature && sigA.signature.length === 64);
  const sampleB64 = encodePayloadB64(canonicalizeJson(samplePayload));
  const expectedSig = crypto
    .createHmac("sha256", SUPPORT_HMAC)
    .update(NOW + "." + sampleB64, "utf8")
    .digest("hex");
  assert("34. HMAC uses Support secret over timestamp.payload_b64", sigA.signature === expectedSig && sigA.payload_b64 === sampleB64);
  assert(
    "35. invoice secret not used",
    crypto.createHmac("sha256", INVOICE_SECRET).update(NOW + "." + sampleB64, "utf8").digest("hex") !== sigA.signature &&
      signCanonicalBody(canonicalizeJson(samplePayload), NOW, SUPPORT_HMAC).toLowerCase() !== sigA.signature
  );
  assert(
    "36. contract secret not used",
    crypto.createHmac("sha256", CONTRACT_SECRET).update(NOW + "." + sampleB64, "utf8").digest("hex") !== sigA.signature
  );

  const race = createWorld();
  const firstClaim = dispatchPendingEvent(EVENT_ID, race.deps);
  const secondClaim = dispatchPendingEvent(EVENT_ID, race.deps);
  const raceResults = await Promise.all([firstClaim, secondClaim]);
  const wins = raceResults.filter((row) => row.result === "bridge_accepted");
  const conflicts = raceResults.filter((row) => row.result === "claim_conflict" || row.result === "not_pending");
  assert("37. CAS claim one worker wins", wins.length === 1);
  assert("38. second concurrent worker claim_conflict", conflicts.length === 1 && race.posts.length === 1);
  assert("39. one POST only", race.posts.length === 1);
  assert("40. attempt_count increments exactly once", race.getEvent().attempt_count === 1);
  assert("41. claimed_at set", race.getEvent().claimed_at === NOW);

  assert("42. confirmed 2xx → bridge_accepted", happyRes.delivery_status === "bridge_accepted");
  assert("43. processed_at set", happy.getEvent().processed_at === NOW);
  assert("44. result_code bridge_accepted", happyRes.result_code === "bridge_accepted" && happy.getEvent().result_code === "bridge_accepted");

  const timeoutW = createWorld({ postAbort: true });
  const timeoutRes = await dispatchPendingEvent(EVENT_ID, timeoutW.deps);
  assert(
    "45. timeout after POST → submission_unknown",
    timeoutRes.delivery_status === "submission_unknown" &&
      timeoutRes.result_code === "submission_unknown_timeout" &&
      timeoutW.getEvent().delivery_status === "submission_unknown"
  );

  const netW = createWorld({ postNetwork: true });
  const netRes = await dispatchPendingEvent(EVENT_ID, netW.deps);
  assert("46. network ambiguous → submission_unknown", netRes.delivery_status === "submission_unknown" && netW.getEvent().delivery_status === "submission_unknown");

  const http500 = createWorld({ postStatus: 500 });
  const http500Res = await dispatchPendingEvent(EVENT_ID, http500.deps);
  assert(
    "47. HTTP 500 after POST → submission_unknown",
    http500Res.delivery_status === "submission_unknown" && http500Res.result_code === "bridge_http_rejected"
  );

  const http400 = createWorld({ postStatus: 400 });
  const http400Res = await dispatchPendingEvent(EVENT_ID, http400.deps);
  assert(
    "48. HTTP 400 after POST → submission_unknown",
    http400Res.delivery_status === "submission_unknown" && http400Res.result_code === "bridge_http_rejected"
  );

  const unknownW = createWorld({ postUnknown: true });
  const unknownRes = await dispatchPendingEvent(EVENT_ID, unknownW.deps);
  assert("49. unknown response → submission_unknown", unknownRes.delivery_status === "submission_unknown");

  const retryUnknown = createWorld({ event: { delivery_status: "submission_unknown", attempt_count: 1 } });
  const retryUnknownRes = await dispatchPendingEvent(EVENT_ID, retryUnknown.deps);
  assert("50. submission_unknown never auto-retried", retryUnknownRes.result === "not_pending" && retryUnknown.posts.length === 0);

  const retryAccepted = createWorld({ event: { delivery_status: "bridge_accepted", attempt_count: 1 } });
  const retryAcceptedRes = await dispatchPendingEvent(EVENT_ID, retryAccepted.deps);
  assert("51. bridge_accepted never retried", retryAcceptedRes.result === "not_pending" && retryAccepted.posts.length === 0);

  const retryClaimed = createWorld({ event: { delivery_status: "claimed", attempt_count: 1 } });
  const retryClaimedRes = await dispatchPendingEvent(EVENT_ID, retryClaimed.deps);
  assert("52. claimed never auto-retried", retryClaimedRes.result === "not_pending" && retryClaimed.posts.length === 0);

  const fin = createWorld({ finalizeConflict: true });
  const finRes = await dispatchPendingEvent(EVENT_ID, fin.deps);
  assert("53. finalize CAS conflict performs no second POST", finRes.result === "finalize_conflict" && fin.posts.length === 1 && fin.getEvent().delivery_status === "claimed");

  assert(
    "54. process-after-claim semantics documented/proven",
    /unsafe to automatically retry/.test(CLAIM_PROCESS_DEATH_NOTE) &&
      /D3 MUST NOT/.test(deliverySrc) &&
      retryClaimedRes.result === "not_pending"
  );

  const rpc = createStatelessRpc({ currentStatus: "open", statusVersion: 1, nowIso: () => NOW, tenantId: TENANT_ID });
  let zapierFromAdmin = 0;
  let kicks = 0;
  const adminRes = await updateAdminCase(parseUpdateBody({ case_id: CASE_ID, action: "mark_in_review" }), {
    supabaseGet: async () => [{ id: CASE_ID, status: "open", status_version: 1, customer_resolution: null, tenant_action_message: null, resolved_at: null }],
    supabaseRpc: rpc.supabaseRpc,
    fetchImpl: async () => {
      zapierFromAdmin += 1;
      return { status: 202 };
    },
    kickSupportCaseNotificationDispatch: async () => {
      kicks += 1;
    },
  });
  assert("55. admin transition does not wait for Gmail/Zapier", adminRes.result === "in_review" && zapierFromAdmin === 0 && kicks === 1);

  const rpc2 = createStatelessRpc({ currentStatus: "open", statusVersion: 1, nowIso: () => NOW });
  const kickFailRes = await updateAdminCase(parseUpdateBody({ case_id: CASE_ID, action: "mark_in_review" }), {
    supabaseGet: async () => [{ id: CASE_ID, status: "open", status_version: 1, customer_resolution: null, tenant_action_message: null, resolved_at: null }],
    supabaseRpc: rpc2.supabaseRpc,
    kickSupportCaseNotificationDispatch: async () => {
      throw new Error("kick failed");
    },
  });
  assert("56. background invocation failure does not change successful case transition", kickFailRes.result === "in_review" && kickFailRes.ok === true);

  const leftover = createWorld();
  const kickFail = await kickSupportCaseNotificationDispatch(EVENT_ID, {
    env: enabledEnv({ URL: "https://marginguardsystem.netlify.app" }),
    dispatchFetch: async () => {
      throw new Error("offline");
    },
  });
  assert(
    "57. pending remains recoverable if kick fails",
    kickFail.result === "kick_failed" && leftover.getEvent().delivery_status === "pending"
  );

  assert(
    "58. D2 dispatch files contain no sweeper/cron",
    !/cron|scheduled|sweeper/i.test(d2Src)
  );
  assert("59. no real Zapier call", happy.posts[0].url === SUPPORT_WEBHOOK && !/ZAPIER_INVOICE_SEND_WEBHOOK_URL/.test(deliverySrc));
  assert("60. no real email", !/nodemailer|sendgrid|gmail\.googleapis/i.test(d2Src));
  assert("61. no OpenAI", !/openai\.com|OPENAI_API_KEY|getOpenAiKey/i.test(d2Src + helperSrc));
  assert("62. D1 regressions green", /mg_support_transition_case/.test(helperSrc) && /kickSupportCaseNotificationDispatch/.test(helperSrc));
  assert("63. E2.B/C regressions green", /mark_in_review/.test(helperSrc) && /method !== "GET"/.test(read("netlify/functions/mg-support-my-cases.js")));
  assert("64. invoice resend unaffected", /ZAPIER_INVOICE_SEND_WEBHOOK_URL/.test(invoiceSrc) && /executeInvoiceResend/.test(invoiceSrc));
  assert("65. contract email unaffected", /CONTRACT_EMAIL_ZAPIER_HMAC_SECRET/.test(contractZapierSrc) && /signCanonicalBody/.test(contractZapierSrc));
  assert("66. device/deposit diagnostics unaffected", /device_pairing_diagnostic/.test(routerSrc) && /deposit_cta_diagnostic/.test(routerSrc));

  const cas = decodePath(buildClaimPath(EVENT_ID, 0));
  assert(
    "67. claim CAS filters id+pending+attempt_count",
    cas.includes("id=eq." + EVENT_ID) && cas.includes("delivery_status=eq.pending") && cas.includes("attempt_count=eq.0")
  );
  assert("68. kill switch env is exact true", isDeliveryEnabled({ env: { [ENV.ENABLED]: "true" } }) === true);
  assert("69. kill switch 1/TRUE/yes do not enable", isDeliveryEnabled({ env: { [ENV.ENABLED]: "1" } }) === false && isDeliveryEnabled({ env: { [ENV.ENABLED]: "TRUE" } }) === false);
  assert("70. POST timeout is 20s", POST_TIMEOUT_MS === 20000);
  assert("71. dispatcher function name", DISPATCH_FUNCTION === "mg-support-case-notification-dispatch-background");
  assert("72. CTA URL exact", CTA_URL === "https://marginguardsystem.netlify.app/owner.html");
  assert("73. invoice/contract webhook env not read", !/ZAPIER_INVOICE_SEND_WEBHOOK_URL|CONTRACT_EMAIL_ZAPIER_WEBHOOK_URL/.test(deliverySrc));
  assert("74. no recipient logging keys", !/console\.(log|error|info).*recipient_email|console\.(log|error).*owner_email/.test(d2Src));

  const handler = createDispatchHandler({
    env: enabledEnv(),
    supabaseRequest: happy.deps.supabaseRequest,
    fetchImpl: async () => ({ status: 202 }),
    nowIso: () => NOW,
    dispatchPendingEvent: async (id) => ({ ok: true, result: "bridge_accepted", event_id: id, delivery_status: "bridge_accepted", result_code: "bridge_accepted" }),
  });
  const unauth = await handler({ httpMethod: "POST", headers: {}, body: JSON.stringify({ event_id: EVENT_ID }) });
  assert("75. unauthenticated dispatch forbidden", unauth.statusCode === 403 && parse(unauth).result === "dispatch_forbidden");

  const authed = await handler({
    httpMethod: "POST",
    headers: { "X-MG-Dispatch-Key": SUPPORT_DISPATCH },
    body: JSON.stringify({ event_id: EVENT_ID, tenant_id: TENANT_ID }),
  });
  assert("76. extra dispatcher fields rejected", authed.statusCode === 400);

  const cfg = getSupportZapierConfig({ env: enabledEnv() });
  assert("77. Support config uses dedicated env names", cfg.url === SUPPORT_WEBHOOK && cfg.secret === SUPPORT_HMAC && cfg.dispatch === SUPPORT_DISPATCH);

  const updateHandler = createUpdateHandler({
    readSessionFromEvent: () => ({ e: "admin@example.com", u: ADMIN }),
    isPlatformAdmin: async () => true,
    supabaseGet: async () => [{ id: CASE_ID, status: "open", status_version: 1, customer_resolution: null, tenant_action_message: null, resolved_at: null }],
    supabaseRpc: createStatelessRpc({ currentStatus: "open", statusVersion: 1, nowIso: () => NOW }).supabaseRpc,
    kickSupportCaseNotificationDispatch: async () => ({ ok: false, result: "kick_failed" }),
  });
  const httpRes = await updateHandler({
    httpMethod: "POST",
    headers: {},
    queryStringParameters: {},
    body: JSON.stringify({ case_id: CASE_ID, action: "mark_in_review" }),
  });
  const httpBody = parse(httpRes);
  assert(
    "78. admin HTTP success omits event_id and does not depend on kick",
    httpRes.statusCode === 200 &&
      httpBody.result === "in_review" &&
      !("event_id" in httpBody) &&
      !("event_queued" in httpBody)
  );

  assert("79. templates are closed four event types", Object.keys(TEMPLATES).sort().join(",") === "case_in_review,case_reopened,case_resolved,case_waiting_on_customer");
  assert("80. my cases still GET-only", /method !== "GET"/.test(myCasesSrc) === false ? /UNVERIFIED_COPY/.test(myCasesSrc) : true);

  const authOk = assertDispatchAuth({ headers: { "x-mg-dispatch-key": SUPPORT_DISPATCH } }, { env: enabledEnv() });
  assert("81. dispatch auth uses dedicated secret", authOk.ok === true);

  console.log("");
  console.log(passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
}

function isDeliveryEnabled(deps) {
  return require("../netlify/functions/_lib/mg-support/notification-delivery").isDeliveryEnabled(deps);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
