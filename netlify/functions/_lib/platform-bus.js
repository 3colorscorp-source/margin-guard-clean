/**
 * CH-013A.0 — Internal Event Bus abstraction.
 * Publishes only to the transactional outbox. No consumers. No email.
 *
 * TRUST BOUNDARY: project_id / quote_id / aggregate_id are NOT cross-tenant
 * validated here. Callers must pass server-resolved, tenant-scoped IDs only.
 * Never trust these fields from a future client request without ownership checks.
 */

"use strict";

const { buildDomainEvent, createCorrelationId } = require("./platform-events");
const { appendOutboxEvent } = require("./platform-outbox");

/**
 * Publish a domain event onto the internal bus (outbox only).
 *
 * @param {object} input - fields for buildDomainEvent
 * @param {{ idempotency_key: string }} options
 */
async function publishDomainEvent(input, options = {}) {
  const idempotencyKey =
    options && options.idempotency_key != null
      ? String(options.idempotency_key).trim()
      : "";
  if (!idempotencyKey) {
    return {
      ok: false,
      error: "idempotency_key is required to publish",
      code: "missing_idempotency_key",
    };
  }

  const built = buildDomainEvent(input);
  if (!built.ok) return built;

  const appended = await appendOutboxEvent(built.event, idempotencyKey);
  if (!appended.ok) return appended;

  return {
    ok: true,
    event: built.event,
    outbox: appended.row,
    duplicate: Boolean(appended.duplicate),
  };
}

/**
 * Create a correlation id for a new causal chain (visible / searchable).
 */
function beginCorrelation() {
  return createCorrelationId();
}

module.exports = {
  publishDomainEvent,
  beginCorrelation,
  buildDomainEvent,
};
