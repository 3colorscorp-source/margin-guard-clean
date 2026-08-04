/**
 * CH-013A.0 — Transactional outbox append helpers.
 * Append-only persistence. No worker / external queue.
 *
 * TRUST BOUNDARY: tenant_id is required; project/quote/aggregate refs are not
 * ownership-checked. Only call with service-role + server-resolved tenant scope.
 */

"use strict";

const { supabaseRequest } = require("./supabase-admin");
const {
  buildDomainEvent,
  scrubForbiddenKeys,
  trimField,
} = require("./platform-events");

const OUTBOX_TABLE = "platform_domain_event_outbox";

function isUniqueViolation(err) {
  const msg = String(err && err.message ? err.message : err || "");
  const raw = String(err && err.supabaseRaw ? err.supabaseRaw : "");
  return (
    err?.status === 409 ||
    /duplicate key|unique constraint|23505/i.test(msg) ||
    /duplicate key|unique constraint|23505/i.test(raw)
  );
}

/**
 * Append a pre-built domain event to the outbox.
 *
 * @param {object} event - from buildDomainEvent().event
 * @param {string} idempotencyKey
 * @returns {Promise<{ ok: true, row: object, duplicate?: boolean } | { ok: false, error: string, code?: string }>}
 */
async function appendOutboxEvent(event, idempotencyKey) {
  const key = trimField(idempotencyKey);
  if (!key) {
    return { ok: false, error: "idempotency_key is required", code: "missing_idempotency_key" };
  }
  if (!event || typeof event !== "object") {
    return { ok: false, error: "event is required", code: "missing_event" };
  }

  const payloadCheck = scrubForbiddenKeys(event.payload || {}, "payload");
  if (!payloadCheck.ok) {
    return { ok: false, error: payloadCheck.error, code: "forbidden_payload" };
  }

  const row = {
    event_id: event.event_id,
    event_version: event.event_version,
    tenant_id: event.tenant_id,
    project_id: event.project_id,
    quote_id: event.quote_id,
    aggregate: event.aggregate,
    aggregate_id: event.aggregate_id,
    type: event.type,
    occurred_at: event.occurred_at,
    correlation_id: event.correlation_id,
    causation_id: event.causation_id,
    payload: payloadCheck.value,
    idempotency_key: key,
  };

  try {
    const inserted = await supabaseRequest(OUTBOX_TABLE, {
      method: "POST",
      body: row,
      headers: {
        Prefer: "return=representation",
      },
    });
    const out = Array.isArray(inserted) ? inserted[0] : inserted;
    return { ok: true, row: out, duplicate: false };
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Idempotent replay: fetch existing by tenant + idempotency_key
      try {
        const existing = await supabaseRequest(
          `${OUTBOX_TABLE}?tenant_id=eq.${encodeURIComponent(event.tenant_id)}&idempotency_key=eq.${encodeURIComponent(key)}&select=*&limit=1`,
          { method: "GET" }
        );
        const rowExisting = Array.isArray(existing) ? existing[0] : existing;
        if (rowExisting) {
          return { ok: true, row: rowExisting, duplicate: true };
        }
      } catch (_fetchErr) {
        /* fall through */
      }
      return {
        ok: false,
        error: "Outbox idempotency conflict and existing row not found",
        code: "idempotency_conflict",
      };
    }
    return {
      ok: false,
      error: err.message || String(err),
      code: "outbox_append_failed",
    };
  }
}

/**
 * Build + append in one step.
 */
async function appendDomainEvent(input, idempotencyKey) {
  const built = buildDomainEvent(input);
  if (!built.ok) return built;
  return appendOutboxEvent(built.event, idempotencyKey);
}

module.exports = {
  OUTBOX_TABLE,
  appendOutboxEvent,
  appendDomainEvent,
  isUniqueViolation,
};
