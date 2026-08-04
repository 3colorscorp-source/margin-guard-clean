/**
 * CH-013A.0 — Activity projection helpers (storage only, no UI).
 */

"use strict";

const { supabaseRequest } = require("./supabase-admin");
const {
  scrubForbiddenKeys,
  trimField,
  validUuid,
  assertCorrelationId,
} = require("./platform-events");
const { isUniqueViolation } = require("./platform-outbox");

const ACTIVITY_TABLE = "platform_activity_events";

/**
 * Project a domain event into the activity timeline store.
 * Idempotent on (tenant_id, source_event_id) when source_event_id is set.
 */
async function projectActivityFromEvent(event, extras = {}) {
  if (!event || typeof event !== "object") {
    return { ok: false, error: "event is required", code: "missing_event" };
  }
  if (!validUuid(event.tenant_id)) {
    return { ok: false, error: "tenant_id must be a UUID", code: "invalid_tenant_id" };
  }

  const payloadIn =
    extras.payload && typeof extras.payload === "object"
      ? extras.payload
      : event.payload && typeof event.payload === "object"
        ? event.payload
        : {};
  const scrubbed = scrubForbiddenKeys(payloadIn, "payload");
  if (!scrubbed.ok) {
    return { ok: false, error: scrubbed.error, code: "forbidden_payload" };
  }

  let correlationId = null;
  if (event.correlation_id) {
    const c = assertCorrelationId(event.correlation_id);
    if (!c.ok) return { ok: false, error: c.error, code: "invalid_correlation_id" };
    correlationId = c.value;
  }

  const row = {
    tenant_id: trimField(event.tenant_id).toLowerCase(),
    project_id: event.project_id || null,
    quote_id: event.quote_id || null,
    source_event_id: event.event_id || null,
    event_type: trimField(event.type || extras.event_type),
    occurred_at: event.occurred_at || new Date().toISOString(),
    correlation_id: correlationId,
    title: String(extras.title ?? ""),
    summary: String(extras.summary ?? ""),
    payload: scrubbed.value,
  };

  if (!row.event_type) {
    return { ok: false, error: "event_type is required", code: "missing_event_type" };
  }

  try {
    const inserted = await supabaseRequest(ACTIVITY_TABLE, {
      method: "POST",
      body: row,
      headers: { Prefer: "return=representation" },
    });
    const out = Array.isArray(inserted) ? inserted[0] : inserted;
    return { ok: true, row: out, duplicate: false };
  } catch (err) {
    if (isUniqueViolation(err) && row.source_event_id) {
      try {
        const existing = await supabaseRequest(
          `${ACTIVITY_TABLE}?tenant_id=eq.${encodeURIComponent(row.tenant_id)}&source_event_id=eq.${encodeURIComponent(row.source_event_id)}&select=*&limit=1`,
          { method: "GET" }
        );
        const rowExisting = Array.isArray(existing) ? existing[0] : existing;
        if (rowExisting) {
          return { ok: true, row: rowExisting, duplicate: true };
        }
      } catch (_e) {
        /* fall through */
      }
    }
    return {
      ok: false,
      error: err.message || String(err),
      code: "activity_project_failed",
    };
  }
}

module.exports = {
  ACTIVITY_TABLE,
  projectActivityFromEvent,
};
