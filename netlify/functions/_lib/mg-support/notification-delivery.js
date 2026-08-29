/**
 * MG-SUPPORT-003E.2D2 — Support case notification claim + Zapier delivery.
 *
 * Claimed means: local validation passed and this worker is about to POST.
 * If the process dies after claim, the row may remain claimed. D3 MUST NOT
 * automatically replay claimed rows (potentially attempted / unsafe to retry).
 * Duplicate prevention is preferred over guaranteed delivery.
 *
 * No OpenAI. No invoice/contract secrets. No recipient persistence.
 */
"use strict";

const {
  canonicalizeJson,
  signCanonicalBody,
  buildSignedWireEnvelope,
  isValidEmail,
} = require("../providers/zapier-provider");
const { timingSafeEqualString } = require("../email-delivery-handoff");
const { supabaseRequest } = require("../supabase-admin");
const { formatCaseRef } = require("./case-intake");

const OUTBOX_TABLE = "tenant_support_notification_outbox";
const CASE_TABLE = "tenant_support_cases";
const TENANT_TABLE = "tenants";
const DISPATCH_FUNCTION = "mg-support-case-notification-dispatch-background";
const SCHEMA_VERSION = "support_case_notification_v1";
const CTA_URL = "https://marginguardsystem.netlify.app/owner.html";
const POST_TIMEOUT_MS = 20000;
const KICK_TIMEOUT_MS = 2500;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ENV = {
  ENABLED: "SUPPORT_CASE_EMAIL_DELIVERY_ENABLED",
  WEBHOOK: "SUPPORT_CASE_EMAIL_ZAPIER_WEBHOOK_URL",
  HMAC: "SUPPORT_CASE_EMAIL_ZAPIER_HMAC_SECRET",
  DISPATCH: "SUPPORT_CASE_EMAIL_DISPATCH_SECRET",
};

const EVENT_TYPES = new Set([
  "case_in_review",
  "case_waiting_on_customer",
  "case_resolved",
  "case_reopened",
]);

const TEMPLATES = {
  case_in_review: {
    subject: "Margin Guard Support — Case Update",
    lines: [
      "Your support case {case_ref} is currently being reviewed.",
      "Open Margin Guard and select Ask Margin Guard → My Cases.",
      CTA_URL,
    ],
  },
  case_waiting_on_customer: {
    subject: "Margin Guard Support — Action Needed",
    lines: [
      "Support needs something from you before support case {case_ref} can continue.",
      "Open Margin Guard and select Ask Margin Guard → My Cases.",
      CTA_URL,
    ],
  },
  case_resolved: {
    subject: "Margin Guard Support — Case Resolved",
    lines: [
      "Support case {case_ref} has been resolved.",
      "Open Margin Guard and select Ask Margin Guard → My Cases.",
      CTA_URL,
    ],
  },
  case_reopened: {
    subject: "Margin Guard Support — Case Reopened",
    lines: [
      "Support case {case_ref} has been reopened.",
      "Open Margin Guard and select Ask Margin Guard → My Cases.",
      CTA_URL,
    ],
  },
};

const CLAIM_PROCESS_DEATH_NOTE =
  "claimed = potentially attempted / unsafe to automatically retry; D3 must not auto-replay claimed rows";

const DISPATCH_BODY_KEYS = new Set(["event_id"]);

const OUTBOX_SELECT =
  "id,tenant_id,case_id,event_type,from_status,to_status,case_status_version,payload_version,delivery_status,attempt_count,result_code,created_at,claimed_at,processed_at";
const CASE_SELECT = "id,tenant_id,status,status_version";
const TENANT_SELECT = "id,owner_email";

function isUuid(value) {
  return UUID_RE.test(String(value || "").trim());
}

function readEnv(name, deps = {}) {
  if (deps.env && Object.prototype.hasOwnProperty.call(deps.env, name)) {
    const raw = deps.env[name];
    return raw == null ? "" : String(raw).trim();
  }
  return String(process.env[name] || "").trim();
}

function nowIso(deps = {}) {
  if (typeof deps.nowIso === "function") return String(deps.nowIso());
  return new Date().toISOString();
}

function isDeliveryEnabled(deps = {}) {
  return readEnv(ENV.ENABLED, deps) === "true";
}

function requestFn(deps = {}) {
  return typeof deps.supabaseRequest === "function" ? deps.supabaseRequest : supabaseRequest;
}

function firstRow(raw) {
  if (Array.isArray(raw)) return raw[0] || null;
  if (raw && typeof raw === "object") return raw;
  return null;
}

function representationRows(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") return [raw];
  return [];
}

function logDelivery(fields) {
  console.log("[mg-support-notify]", {
    event_id: fields.event_id || null,
    event_type: fields.event_type || null,
    case_ref: fields.case_ref || null,
    delivery_status: fields.delivery_status || null,
    result_code: fields.result_code || null,
  });
}

function outcome(result, extra) {
  const row = Object.assign(
    {
      ok: false,
      result,
      event_id: null,
      event_type: null,
      case_ref: null,
      delivery_status: null,
      result_code: result,
      attempt_count: null,
      posted: false,
    },
    extra || {}
  );
  logDelivery(row);
  return row;
}

function buildTemplate(eventType, caseRef) {
  const plan = TEMPLATES[eventType];
  if (!plan) return null;
  const text_body = plan.lines.map((line) => line.replace(/\{case_ref\}/g, caseRef)).join("\n");
  return { subject: plan.subject, text_body };
}

function buildCanonicalPayload({
  eventId,
  eventType,
  caseRef,
  recipientEmail,
  subject,
  textBody,
  timestamp,
  caseId,
  caseStatusVersion,
}) {
  return {
    schema_version: SCHEMA_VERSION,
    event_id: eventId,
    event_type: eventType,
    case_ref: caseRef,
    recipient_email: recipientEmail,
    subject,
    text_body: textBody,
    timestamp,
    idempotency_key: `${caseId}:${caseStatusVersion}:${eventType}`,
  };
}

function signSupportPayload(payload, secret, timestamp) {
  const signedBody = canonicalizeJson(payload);
  return buildSignedWireEnvelope({
    signedBody,
    timestamp,
    secret,
  });
}

function buildEventGetPath(eventId) {
  return `${OUTBOX_TABLE}?id=eq.${encodeURIComponent(eventId)}&select=${OUTBOX_SELECT}&limit=1`;
}

function buildCaseGetPath(caseId) {
  return `${CASE_TABLE}?id=eq.${encodeURIComponent(caseId)}&select=${CASE_SELECT}&limit=1`;
}

function buildTenantGetPath(tenantId) {
  return `${TENANT_TABLE}?id=eq.${encodeURIComponent(tenantId)}&select=${TENANT_SELECT}&limit=1`;
}

function buildClaimPath(eventId, attemptCount) {
  return (
    `${OUTBOX_TABLE}?id=eq.${encodeURIComponent(eventId)}` +
    `&delivery_status=eq.pending&attempt_count=eq.${encodeURIComponent(String(attemptCount))}` +
    `&select=${OUTBOX_SELECT}`
  );
}

function buildPendingFailPath(eventId) {
  return (
    `${OUTBOX_TABLE}?id=eq.${encodeURIComponent(eventId)}` +
    `&delivery_status=eq.pending&select=${OUTBOX_SELECT}`
  );
}

function buildFinalizePath(eventId, attemptCount) {
  return (
    `${OUTBOX_TABLE}?id=eq.${encodeURIComponent(eventId)}` +
    `&delivery_status=eq.claimed&attempt_count=eq.${encodeURIComponent(String(attemptCount))}` +
    `&select=${OUTBOX_SELECT}`
  );
}

function getSupportZapierConfig(deps = {}) {
  return {
    url: readEnv(ENV.WEBHOOK, deps),
    secret: readEnv(ENV.HMAC, deps),
    dispatch: readEnv(ENV.DISPATCH, deps),
  };
}

function isConfirmedHttp2xx(res) {
  const status = Number(res && res.status);
  return Number.isInteger(status) && status >= 200 && status < 300;
}

function isAbortError(err) {
  return Boolean(
    err && (err.name === "AbortError" || /aborted|timeout/i.test(String(err.message || err)))
  );
}

async function postSignedSupportWebhook({ url, secret, payload, deps, timeoutMs, timestamp, sealed: prepared }) {
  const fetchImpl = typeof deps.fetchImpl === "function" ? deps.fetchImpl : globalThis.fetch;
  const sealed =
    prepared && prepared.ok ? prepared : signSupportPayload(payload, secret, timestamp || payload.timestamp);
  if (!sealed.ok) {
    return { res: null, aborted: false, err: new Error(sealed.error || "envelope_build_failed"), sealed };
  }
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-Margin-Guard-Timestamp": sealed.timestamp,
    "X-Margin-Guard-Signature": sealed.signature,
    "X-Margin-Guard-Idempotency-Key": String(payload.idempotency_key || "").slice(0, 256),
  };
  const controller = new AbortController();
  const ms = Number(timeoutMs) > 0 ? Number(timeoutMs) : POST_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers,
      body: sealed.wire_body,
      signal: controller.signal,
    });
    return { res, aborted: false, sealed };
  } catch (err) {
    return { res: null, aborted: isAbortError(err), err, sealed };
  } finally {
    clearTimeout(timer);
  }
}

async function loadEvent(eventId, deps) {
  const rows = await requestFn(deps)(buildEventGetPath(eventId), { method: "GET" });
  return firstRow(rows);
}

async function loadCase(caseId, deps) {
  const rows = await requestFn(deps)(buildCaseGetPath(caseId), { method: "GET" });
  return firstRow(rows);
}

async function loadTenant(tenantId, deps) {
  const rows = await requestFn(deps)(buildTenantGetPath(tenantId), { method: "GET" });
  return firstRow(rows);
}

async function casPendingToFailed(event, resultCode, deps) {
  const stamp = nowIso(deps);
  let patched;
  try {
    patched = await requestFn(deps)(buildPendingFailPath(event.id), {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: {
        delivery_status: "failed",
        result_code: resultCode,
        processed_at: stamp,
      },
    });
  } catch (_err) {
    return { ok: false, result: "state_changed" };
  }
  const rows = representationRows(patched);
  if (rows.length !== 1) {
    return { ok: false, result: "state_changed" };
  }
  return { ok: true, row: rows[0] };
}

async function casClaim(event, deps) {
  const stamp = nowIso(deps);
  const nextAttempt = Number(event.attempt_count) + 1;
  let patched;
  try {
    patched = await requestFn(deps)(buildClaimPath(event.id, event.attempt_count), {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: {
        delivery_status: "claimed",
        claimed_at: stamp,
        attempt_count: nextAttempt,
        result_code: null,
      },
    });
  } catch (_err) {
    return { ok: false, result: "claim_conflict" };
  }
  const rows = representationRows(patched);
  if (rows.length !== 1) {
    return { ok: false, result: "claim_conflict" };
  }
  return { ok: true, row: rows[0], attempt_count: nextAttempt, claimed_at: stamp };
}

async function casFinalize(eventId, attemptCount, deliveryStatus, resultCode, deps) {
  const stamp = nowIso(deps);
  let patched;
  try {
    patched = await requestFn(deps)(buildFinalizePath(eventId, attemptCount), {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: {
        delivery_status: deliveryStatus,
        result_code: resultCode,
        processed_at: stamp,
      },
    });
  } catch (_err) {
    return { ok: false, result: "finalize_conflict" };
  }
  const rows = representationRows(patched);
  if (rows.length !== 1) {
    return { ok: false, result: "finalize_conflict" };
  }
  return { ok: true, row: rows[0] };
}

function classifyPostOutcome(posted) {
  if (posted && posted.res && isConfirmedHttp2xx(posted.res)) {
    return { delivery_status: "bridge_accepted", result_code: "bridge_accepted" };
  }
  if (posted && posted.aborted) {
    return { delivery_status: "submission_unknown", result_code: "submission_unknown_timeout" };
  }
  const status = Number(posted && posted.res && posted.res.status);
  if (Number.isInteger(status) && status > 0 && (status < 200 || status >= 300)) {
    return { delivery_status: "submission_unknown", result_code: "bridge_http_rejected" };
  }
  if (posted && posted.err) {
    return { delivery_status: "submission_unknown", result_code: "submission_unknown" };
  }
  return { delivery_status: "submission_unknown", result_code: "submission_unknown" };
}

async function dispatchPendingEvent(eventId, deps = {}) {
  const id = String(eventId || "").trim();
  if (!isUuid(id)) {
    return outcome("invalid_request");
  }

  let event;
  try {
    event = await loadEvent(id, deps);
  } catch (_err) {
    return outcome("read_failed", { event_id: id });
  }
  if (!event || !event.id) {
    return outcome("not_found", { event_id: id });
  }

  const eventType = String(event.event_type || "");
  const caseRef = formatCaseRef(event.case_id);
  const status = String(event.delivery_status || "");
  const attempt = Number(event.attempt_count);

  if (status !== "pending") {
    return outcome("not_pending", {
      ok: true,
      event_id: String(event.id),
      event_type: eventType,
      case_ref: caseRef,
      delivery_status: status,
      result_code: event.result_code || "not_pending",
      attempt_count: Number.isInteger(attempt) ? attempt : null,
    });
  }

  if (!isDeliveryEnabled(deps)) {
    return outcome("delivery_disabled", {
      ok: true,
      event_id: String(event.id),
      event_type: eventType,
      case_ref: caseRef,
      delivery_status: "pending",
      result_code: "delivery_disabled",
      attempt_count: Number.isInteger(attempt) ? attempt : 0,
    });
  }

  if (!EVENT_TYPES.has(eventType) || !isUuid(event.case_id) || !isUuid(event.tenant_id)) {
    const failed = await casPendingToFailed(event, "local_config_error", deps);
    if (!failed.ok) {
      return outcome(failed.result, {
        event_id: String(event.id),
        event_type: eventType,
        case_ref: caseRef,
        delivery_status: "pending",
        attempt_count: attempt,
      });
    }
    return outcome("local_config_error", {
      event_id: String(event.id),
      event_type: eventType,
      case_ref: caseRef,
      delivery_status: "failed",
      result_code: "local_config_error",
      attempt_count: 0,
    });
  }

  let caseRow;
  try {
    caseRow = await loadCase(event.case_id, deps);
  } catch (_err) {
    return outcome("read_failed", {
      event_id: String(event.id),
      event_type: eventType,
      case_ref: caseRef,
      delivery_status: "pending",
      attempt_count: attempt,
    });
  }
  if (!caseRow || String(caseRow.id) !== String(event.case_id)) {
    const failed = await casPendingToFailed(event, "local_config_error", deps);
    if (!failed.ok) {
      return outcome(failed.result, {
        event_id: String(event.id),
        event_type: eventType,
        case_ref: caseRef,
        delivery_status: "pending",
        attempt_count: attempt,
      });
    }
    return outcome("local_config_error", {
      event_id: String(event.id),
      event_type: eventType,
      case_ref: caseRef,
      delivery_status: "failed",
      result_code: "local_config_error",
      attempt_count: 0,
    });
  }
  if (String(caseRow.tenant_id) !== String(event.tenant_id)) {
    const failed = await casPendingToFailed(event, "tenant_mismatch", deps);
    if (!failed.ok) {
      return outcome(failed.result, {
        event_id: String(event.id),
        event_type: eventType,
        case_ref: caseRef,
        delivery_status: "pending",
        attempt_count: attempt,
      });
    }
    return outcome("tenant_mismatch", {
      event_id: String(event.id),
      event_type: eventType,
      case_ref: caseRef,
      delivery_status: "failed",
      result_code: "tenant_mismatch",
      attempt_count: 0,
    });
  }

  let tenant;
  try {
    tenant = await loadTenant(event.tenant_id, deps);
  } catch (_err) {
    return outcome("read_failed", {
      event_id: String(event.id),
      event_type: eventType,
      case_ref: caseRef,
      delivery_status: "pending",
      attempt_count: attempt,
    });
  }
  const ownerEmail = tenant && tenant.owner_email != null ? String(tenant.owner_email).trim() : "";
  if (!ownerEmail) {
    const failed = await casPendingToFailed(event, "missing_owner_email", deps);
    if (!failed.ok) {
      return outcome(failed.result, {
        event_id: String(event.id),
        event_type: eventType,
        case_ref: caseRef,
        delivery_status: "pending",
        attempt_count: attempt,
      });
    }
    return outcome("missing_owner_email", {
      event_id: String(event.id),
      event_type: eventType,
      case_ref: caseRef,
      delivery_status: "failed",
      result_code: "missing_owner_email",
      attempt_count: 0,
    });
  }
  if (!isValidEmail(ownerEmail)) {
    const failed = await casPendingToFailed(event, "invalid_owner_email", deps);
    if (!failed.ok) {
      return outcome(failed.result, {
        event_id: String(event.id),
        event_type: eventType,
        case_ref: caseRef,
        delivery_status: "pending",
        attempt_count: attempt,
      });
    }
    return outcome("invalid_owner_email", {
      event_id: String(event.id),
      event_type: eventType,
      case_ref: caseRef,
      delivery_status: "failed",
      result_code: "invalid_owner_email",
      attempt_count: 0,
    });
  }

  const zapier = getSupportZapierConfig(deps);
  if (!zapier.url || /TU_WEBHOOK_URL_AQUI/i.test(zapier.url) || !zapier.secret) {
    const failed = await casPendingToFailed(event, "local_config_error", deps);
    if (!failed.ok) {
      return outcome(failed.result, {
        event_id: String(event.id),
        event_type: eventType,
        case_ref: caseRef,
        delivery_status: "pending",
        attempt_count: attempt,
      });
    }
    return outcome("local_config_error", {
      event_id: String(event.id),
      event_type: eventType,
      case_ref: caseRef,
      delivery_status: "failed",
      result_code: "local_config_error",
      attempt_count: 0,
    });
  }

  const templated = buildTemplate(eventType, caseRef);
  if (!templated) {
    const failed = await casPendingToFailed(event, "local_config_error", deps);
    if (!failed.ok) {
      return outcome(failed.result, {
        event_id: String(event.id),
        event_type: eventType,
        case_ref: caseRef,
        delivery_status: "pending",
        attempt_count: attempt,
      });
    }
    return outcome("local_config_error", {
      event_id: String(event.id),
      event_type: eventType,
      case_ref: caseRef,
      delivery_status: "failed",
      result_code: "local_config_error",
      attempt_count: 0,
    });
  }

  const timestamp = nowIso(deps);
  const payload = buildCanonicalPayload({
    eventId: String(event.id),
    eventType,
    caseRef,
    recipientEmail: ownerEmail,
    subject: templated.subject,
    textBody: templated.text_body,
    timestamp,
    caseId: String(event.case_id),
    caseStatusVersion: event.case_status_version,
  });

  const sealed = signSupportPayload(payload, zapier.secret, timestamp);
  if (!sealed.ok) {
    const failed = await casPendingToFailed(event, "local_config_error", deps);
    if (!failed.ok) {
      return outcome(failed.result, {
        event_id: String(event.id),
        event_type: eventType,
        case_ref: caseRef,
        delivery_status: "pending",
        attempt_count: attempt,
      });
    }
    return outcome("local_config_error", {
      event_id: String(event.id),
      event_type: eventType,
      case_ref: caseRef,
      delivery_status: "failed",
      result_code: "local_config_error",
      attempt_count: 0,
    });
  }

  const claimed = await casClaim(event, deps);
  if (!claimed.ok) {
    return outcome("claim_conflict", {
      event_id: String(event.id),
      event_type: eventType,
      case_ref: caseRef,
      delivery_status: "pending",
      result_code: "claim_conflict",
      attempt_count: attempt,
    });
  }

  let posted;
  try {
    posted = await postSignedSupportWebhook({
      url: zapier.url,
      secret: zapier.secret,
      payload,
      deps,
      timeoutMs: deps.zapierTimeoutMs,
      timestamp,
      sealed,
    });
  } catch (err) {
    posted = { res: null, aborted: false, err };
  }

  const classified = classifyPostOutcome(posted);
  const finalized = await casFinalize(
    String(event.id),
    claimed.attempt_count,
    classified.delivery_status,
    classified.result_code,
    deps
  );
  if (!finalized.ok) {
    return outcome("finalize_conflict", {
      event_id: String(event.id),
      event_type: eventType,
      case_ref: caseRef,
      delivery_status: "claimed",
      result_code: "finalize_conflict",
      attempt_count: claimed.attempt_count,
      posted: true,
    });
  }

  return outcome(classified.result_code, {
    ok: classified.delivery_status === "bridge_accepted",
    event_id: String(event.id),
    event_type: eventType,
    case_ref: caseRef,
    delivery_status: classified.delivery_status,
    result_code: classified.result_code,
    attempt_count: claimed.attempt_count,
    posted: true,
  });
}

function assertDispatchAuth(event, deps = {}) {
  const expected = readEnv(ENV.DISPATCH, deps);
  if (!expected) {
    return { ok: false, status: 403, result: "dispatch_secret_missing" };
  }
  const headers = (event && event.headers) || {};
  const got = String(
    headers["x-mg-dispatch-key"] ||
      headers["X-MG-Dispatch-Key"] ||
      headers["x-mg-dispatch-secret"] ||
      ""
  ).trim();
  if (!timingSafeEqualString(got, expected)) {
    return { ok: false, status: 403, result: "dispatch_forbidden" };
  }
  return { ok: true };
}

function parseDispatchBody(raw) {
  let body;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch (_err) {
    return { ok: false, result: "invalid_request" };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, result: "invalid_request" };
  }
  const keys = Object.keys(body);
  if (keys.some((k) => !DISPATCH_BODY_KEYS.has(k))) {
    return { ok: false, result: "invalid_request" };
  }
  const eventId = String(body.event_id || "").trim();
  if (!isUuid(eventId)) {
    return { ok: false, result: "invalid_request" };
  }
  return { ok: true, event_id: eventId };
}

async function kickSupportCaseNotificationDispatch(eventId, deps = {}) {
  const id = String(eventId || "").trim();
  if (!isUuid(id)) return { ok: false, result: "kick_skipped" };
  const secret = readEnv(ENV.DISPATCH, deps);
  if (!secret) return { ok: false, result: "kick_skipped" };
  const origin = (
    String(deps.siteOrigin || "").trim() ||
    readEnv("URL", deps) ||
    readEnv("DEPLOY_PRIME_URL", deps) ||
    readEnv("SITE_URL", deps)
  ).replace(/\/+$/, "");
  if (!origin) return { ok: false, result: "kick_skipped" };

  const fetchImpl =
    typeof deps.dispatchFetch === "function"
      ? deps.dispatchFetch
      : typeof deps.fetchImpl === "function"
        ? deps.fetchImpl
        : globalThis.fetch;
  if (typeof fetchImpl !== "function") return { ok: false, result: "kick_skipped" };

  const url = `${origin}/.netlify/functions/${DISPATCH_FUNCTION}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), KICK_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-MG-Dispatch-Key": secret,
      },
      body: JSON.stringify({ event_id: id }),
      signal: controller.signal,
    });
    return { ok: res.ok || res.status === 202, status: Number(res.status), result: "kicked" };
  } catch (_err) {
    return { ok: false, result: "kick_failed" };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  OUTBOX_TABLE,
  DISPATCH_FUNCTION,
  SCHEMA_VERSION,
  CTA_URL,
  POST_TIMEOUT_MS,
  ENV,
  TEMPLATES,
  CLAIM_PROCESS_DEATH_NOTE,
  DISPATCH_BODY_KEYS,
  isUuid,
  isDeliveryEnabled,
  buildTemplate,
  buildCanonicalPayload,
  signSupportPayload,
  canonicalizeJson,
  signCanonicalBody,
  getSupportZapierConfig,
  dispatchPendingEvent,
  kickSupportCaseNotificationDispatch,
  assertDispatchAuth,
  parseDispatchBody,
  buildClaimPath,
  buildFinalizePath,
  buildPendingFailPath,
};
