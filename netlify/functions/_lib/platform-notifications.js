/**
 * CH-013A.0 — Notification projection helpers (storage only, no UI / no send).
 */

"use strict";

const { supabaseRequest } = require("./supabase-admin");
const {
  scrubForbiddenKeys,
  trimField,
  validUuid,
  assertCorrelationId,
} = require("./platform-events");

const NOTIFICATIONS_TABLE = "platform_notifications";

const PRIORITIES = Object.freeze([
  "critical",
  "high",
  "normal",
  "low",
  "silent",
]);
const PRIORITY_SET = new Set(PRIORITIES);

/**
 * Create a notification projection row from a domain event (or standalone).
 */
async function createNotification(input = {}) {
  const tenantId = trimField(input.tenant_id);
  if (!validUuid(tenantId)) {
    return { ok: false, error: "tenant_id must be a UUID", code: "invalid_tenant_id" };
  }

  const priority = trimField(input.priority || "normal") || "normal";
  if (!PRIORITY_SET.has(priority)) {
    return { ok: false, error: "Invalid priority", code: "invalid_priority" };
  }

  const payloadIn =
    input.payload && typeof input.payload === "object" && !Array.isArray(input.payload)
      ? input.payload
      : {};
  const scrubbed = scrubForbiddenKeys(payloadIn, "payload");
  if (!scrubbed.ok) {
    return { ok: false, error: scrubbed.error, code: "forbidden_payload" };
  }

  let correlationId = null;
  if (input.correlation_id != null && trimField(input.correlation_id) !== "") {
    const c = assertCorrelationId(input.correlation_id);
    if (!c.ok) return { ok: false, error: c.error, code: "invalid_correlation_id" };
    correlationId = c.value;
  }

  const row = {
    tenant_id: tenantId.toLowerCase(),
    project_id: input.project_id || null,
    quote_id: input.quote_id || null,
    source_event_id: input.source_event_id || input.event_id || null,
    event_type: input.event_type || input.type || null,
    priority,
    title: String(input.title ?? ""),
    body: String(input.body ?? ""),
    payload: scrubbed.value,
    correlation_id: correlationId,
    occurred_at: input.occurred_at || new Date().toISOString(),
  };

  try {
    const inserted = await supabaseRequest(NOTIFICATIONS_TABLE, {
      method: "POST",
      body: row,
      headers: { Prefer: "return=representation" },
    });
    const out = Array.isArray(inserted) ? inserted[0] : inserted;
    return { ok: true, row: out };
  } catch (err) {
    return {
      ok: false,
      error: err.message || String(err),
      code: "notification_create_failed",
    };
  }
}

async function markNotificationRead(tenantId, notificationId) {
  if (!validUuid(tenantId) || !validUuid(notificationId)) {
    return { ok: false, error: "tenant_id and notification id must be UUIDs" };
  }
  try {
    const updated = await supabaseRequest(
      `${NOTIFICATIONS_TABLE}?tenant_id=eq.${encodeURIComponent(tenantId)}&id=eq.${encodeURIComponent(notificationId)}`,
      {
        method: "PATCH",
        body: { read_at: new Date().toISOString() },
        headers: { Prefer: "return=representation" },
      }
    );
    const out = Array.isArray(updated) ? updated[0] : updated;
    return { ok: true, row: out };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

async function dismissNotification(tenantId, notificationId) {
  if (!validUuid(tenantId) || !validUuid(notificationId)) {
    return { ok: false, error: "tenant_id and notification id must be UUIDs" };
  }
  try {
    const updated = await supabaseRequest(
      `${NOTIFICATIONS_TABLE}?tenant_id=eq.${encodeURIComponent(tenantId)}&id=eq.${encodeURIComponent(notificationId)}`,
      {
        method: "PATCH",
        body: { dismissed_at: new Date().toISOString() },
        headers: { Prefer: "return=representation" },
      }
    );
    const out = Array.isArray(updated) ? updated[0] : updated;
    return { ok: true, row: out };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

module.exports = {
  NOTIFICATIONS_TABLE,
  PRIORITIES,
  PRIORITY_SET,
  createNotification,
  markNotificationRead,
  dismissNotification,
};
