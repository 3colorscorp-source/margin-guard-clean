/**
 * MG-SUPPORT-003E.2D3 — pending Support notification recovery.
 *
 * Recovers ONLY delivery_status=pending rows that are old enough to miss the
 * immediate D2 background kick. Never selects claimed / bridge_accepted /
 * submission_unknown / failed. Never resets claimed → pending.
 *
 * RELEASE RULE: Before setting SUPPORT_CASE_EMAIL_DELIVERY_ENABLED=true, inspect
 * every pending Support notification event created during the disabled window.
 * Kill switch controls delivery, not enqueue. No historical backfill. Post-release
 * pending rows created while delivery is OFF remain real and become eligible after
 * enable + 30s age. There is no automatic delete/skip/mark-delivered of pending.
 *
 * Delivery itself is D2: dispatchPendingEvent owns load, recipient, template,
 * HMAC, CAS claim, POST, and finalize. This module only lists a bounded batch
 * and invokes that helper once per selected id.
 */
"use strict";

const {
  OUTBOX_TABLE,
  dispatchPendingEvent,
  isDeliveryEnabled,
} = require("./notification-delivery");

const SWEEP_FUNCTION = "mg-support-case-notification-sweep";
const SWEEP_SCHEDULE = "*/5 * * * *";
const SWEEP_BATCH_SIZE = 10;
const PENDING_MIN_AGE_MS = 30000;
const ELIGIBLE_DELIVERY_STATUS = "pending";

const FAILED_PRE_SEND = new Set([
  "missing_owner_email",
  "invalid_owner_email",
  "local_config_error",
  "tenant_mismatch",
]);

function nowIso(deps = {}) {
  if (typeof deps.nowIso === "function") return String(deps.nowIso());
  return new Date().toISOString();
}

function requestFn(deps = {}) {
  return typeof deps.supabaseRequest === "function"
    ? deps.supabaseRequest
    : require("../supabase-admin").supabaseRequest;
}

function pendingAgeCutoffIso(now, ageMs) {
  const ms = Date.parse(String(now || ""));
  const age = Number.isFinite(ageMs) ? ageMs : PENDING_MIN_AGE_MS;
  const base = Number.isFinite(ms) ? ms : Date.now();
  return new Date(base - age).toISOString();
}

function buildPendingSweepPath(cutoffIso) {
  return (
    `${OUTBOX_TABLE}?delivery_status=eq.${ELIGIBLE_DELIVERY_STATUS}` +
    `&created_at=lte.${encodeURIComponent(String(cutoffIso))}` +
    `&order=created_at.asc,id.asc` +
    `&limit=${SWEEP_BATCH_SIZE}` +
    `&select=id`
  );
}

function emptySummary(result) {
  return {
    result,
    selected: 0,
    bridge_accepted: 0,
    submission_unknown: 0,
    failed_pre_send: 0,
    claim_conflict: 0,
    delivery_disabled: 0,
    not_pending: 0,
    read_failed: 0,
    other: 0,
  };
}

function classifySweepResult(dispatchResult) {
  const r = String((dispatchResult && dispatchResult.result) || "");
  const status = String((dispatchResult && dispatchResult.delivery_status) || "");
  if (r === "delivery_disabled") return "delivery_disabled";
  if (r === "claim_conflict") return "claim_conflict";
  if (r === "not_pending") return "not_pending";
  if (status === "bridge_accepted" || r === "bridge_accepted") return "bridge_accepted";
  if (
    status === "submission_unknown" ||
    r === "submission_unknown" ||
    r === "submission_unknown_timeout" ||
    r === "bridge_http_rejected"
  ) {
    return "submission_unknown";
  }
  if (status === "failed" || FAILED_PRE_SEND.has(r)) return "failed_pre_send";
  if (r === "read_failed" || r === "not_found" || r === "invalid_request") return "read_failed";
  return "other";
}

function logSweep(summary) {
  console.log("[mg-support-notify-sweep]", {
    result: summary.result,
    selected: summary.selected,
    bridge_accepted: summary.bridge_accepted,
    submission_unknown: summary.submission_unknown,
    failed_pre_send: summary.failed_pre_send,
    claim_conflict: summary.claim_conflict,
    delivery_disabled: summary.delivery_disabled,
  });
}

function safeSummary(summary) {
  const row = summary && typeof summary === "object" ? summary : emptySummary("read_failed");
  return {
    result: row.result || "read_failed",
    selected: Number(row.selected) || 0,
    bridge_accepted: Number(row.bridge_accepted) || 0,
    submission_unknown: Number(row.submission_unknown) || 0,
    failed_pre_send: Number(row.failed_pre_send) || 0,
    claim_conflict: Number(row.claim_conflict) || 0,
    delivery_disabled: Number(row.delivery_disabled) || 0,
  };
}

async function sweepPendingSupportCaseNotifications(deps = {}) {
  if (!isDeliveryEnabled(deps)) {
    const disabled = emptySummary("delivery_disabled");
    logSweep(disabled);
    return disabled;
  }

  const summary = emptySummary("swept");
  const cutoffIso = pendingAgeCutoffIso(nowIso(deps), PENDING_MIN_AGE_MS);
  const path = buildPendingSweepPath(cutoffIso);

  let rows;
  try {
    rows = await requestFn(deps)(path, { method: "GET" });
  } catch (_err) {
    summary.result = "read_failed";
    logSweep(summary);
    return summary;
  }

  const list = Array.isArray(rows) ? rows : [];
  const batch = list.slice(0, SWEEP_BATCH_SIZE);
  summary.selected = batch.length;

  const dispatch =
    typeof deps.dispatchPendingEvent === "function" ? deps.dispatchPendingEvent : dispatchPendingEvent;

  for (let i = 0; i < batch.length; i += 1) {
    const eventId = batch[i] && batch[i].id;
    try {
      const result = await dispatch(eventId, deps);
      const bucket = classifySweepResult(result);
      summary[bucket] = (summary[bucket] || 0) + 1;
    } catch (_err) {
      summary.other += 1;
    }
  }

  logSweep(summary);
  return summary;
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(body),
  };
}

function createHandler(deps = {}) {
  const sweep = deps.sweepPendingSupportCaseNotifications || sweepPendingSupportCaseNotifications;

  return async function handler(event) {
    const method = String(event && event.httpMethod ? event.httpMethod : "POST").toUpperCase();
    if (method !== "POST") {
      return json(405, safeSummary({ result: "invalid_request" }));
    }
    try {
      const summary = await sweep(deps);
      return json(200, safeSummary(summary));
    } catch (_err) {
      console.log("[mg-support-notify-sweep]", { result: "read_failed", selected: 0 });
      return json(200, safeSummary({ result: "read_failed" }));
    }
  };
}

module.exports = {
  SWEEP_FUNCTION,
  SWEEP_SCHEDULE,
  SWEEP_BATCH_SIZE,
  PENDING_MIN_AGE_MS,
  ELIGIBLE_DELIVERY_STATUS,
  pendingAgeCutoffIso,
  buildPendingSweepPath,
  classifySweepResult,
  safeSummary,
  sweepPendingSupportCaseNotifications,
  createHandler,
};
