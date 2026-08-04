/**
 * CH-013A.0 — Canonical domain event catalog + envelope shape.
 * No emission into production flows yet (except via explicit bus helpers in tests).
 */

"use strict";

const crypto = require("crypto");

const EVENT_VERSION = 1;
const FABRIC_VERSION = "ch-013a0-v1";

/** Canonical contract/delivery domain event types (exact names). */
const DOMAIN_EVENT_TYPES = Object.freeze([
  "contract.package.frozen",
  "contract.envelope.prepared",
  "contract.invitation.prepared",
  "contract.invitation.queued",
  "contract.invitation.sent",
  "contract.invitation.delivered",
  "contract.invitation.failed",
  "contract.invitation.opened",
  "contract.invitation.bounced",
  "contract.invitation.resent",
  "contract.invitation.revoked",
  "contract.invitation.expired",
  "contract.signed",
  "contract.completed",
  "contract.certificate.created",
  "contract.signed_pdf.created",
  "contract.reminder.sent",
  // CH-013A.2.1 — transport lifecycle (email / future network channels)
  "delivery.channel.queued",
  "delivery.channel.sending",
  "delivery.channel.sent",
  "delivery.channel.failed",
]);

const DOMAIN_EVENT_TYPE_SET = new Set(DOMAIN_EVENT_TYPES);

const AGGREGATES = Object.freeze([
  "package",
  "envelope",
  "invitation",
  "delivery_attempt",
  "certificate",
  "signed_pdf",
  "signer",
  "project",
]);

const AGGREGATE_SET = new Set(AGGREGATES);

const CORRELATION_RE = /^MG-EVT-[0-9A-Z]{8}$/;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Payload keys that must never appear (case-insensitive; recursive on nested objects/arrays).
 * Covers raw tokens, tokenized/signed URLs, signature vectors, API keys, secrets.
 */
const FORBIDDEN_PAYLOAD_KEY_RE =
  /^(raw_token|signing_token|invite_token|token|token_url|tokenized_url|signed_url|signing_url|download_url|magic_link|signature|signature_json|signature_payload|signature_vector|drawn_path|password|secret|api_key|service_role|authorization|cookie)$/i;

function trimField(value) {
  return String(value ?? "").trim();
}

function validUuid(value) {
  return UUID_RE.test(trimField(value));
}

function isDomainEventType(type) {
  return DOMAIN_EVENT_TYPE_SET.has(trimField(type));
}

function isAggregate(value) {
  return AGGREGATE_SET.has(trimField(value));
}

/**
 * Stable searchable correlation id: MG-EVT-XXXXXXXX (A-Z0-9).
 */
function createCorrelationId(seedBytes) {
  const bytes =
    seedBytes && Buffer.isBuffer(seedBytes) && seedBytes.length >= 5
      ? seedBytes
      : crypto.randomBytes(5);
  // 5 bytes → 40 bits → 8 base36-ish chars via hex then map to A-Z0-9
  const hex = bytes.toString("hex").toUpperCase().slice(0, 8);
  const mapped = hex.replace(/[^0-9A-Z]/g, "0");
  return `MG-EVT-${mapped}`;
}

function assertCorrelationId(value) {
  const id = trimField(value);
  if (!CORRELATION_RE.test(id)) {
    return { ok: false, error: "correlation_id must match MG-EVT-XXXXXXXX" };
  }
  return { ok: true, value: id };
}

function utcNowIso() {
  return new Date().toISOString();
}

function scrubForbiddenKeys(value, path) {
  if (value == null) return { ok: true, value };
  if (Array.isArray(value)) {
    const out = [];
    for (let i = 0; i < value.length; i += 1) {
      const next = scrubForbiddenKeys(value[i], `${path}[${i}]`);
      if (!next.ok) return next;
      out.push(next.value);
    }
    return { ok: true, value: out };
  }
  if (typeof value !== "object") {
    return { ok: true, value };
  }
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_PAYLOAD_KEY_RE.test(String(key))) {
      return {
        ok: false,
        error: `Forbidden payload key "${key}" at ${path || "payload"}`,
      };
    }
    const next = scrubForbiddenKeys(child, path ? `${path}.${key}` : key);
    if (!next.ok) return next;
    out[key] = next.value;
  }
  return { ok: true, value: out };
}

/**
 * Build a canonical domain event envelope (in-memory). Does not persist.
 *
 * @param {object} input
 * @returns {{ ok: true, event: object } | { ok: false, error: string, code?: string }}
 */
function buildDomainEvent(input) {
  const raw = input && typeof input === "object" ? input : {};
  const type = trimField(raw.type);
  if (!isDomainEventType(type)) {
    return { ok: false, error: "Unknown or invalid domain event type", code: "invalid_event_type" };
  }

  const tenantId = trimField(raw.tenant_id);
  if (!validUuid(tenantId)) {
    return { ok: false, error: "tenant_id must be a UUID", code: "invalid_tenant_id" };
  }

  const aggregate = trimField(raw.aggregate);
  if (!isAggregate(aggregate)) {
    return { ok: false, error: "Invalid aggregate", code: "invalid_aggregate" };
  }

  let aggregateId = null;
  if (raw.aggregate_id != null && trimField(raw.aggregate_id) !== "") {
    if (!validUuid(raw.aggregate_id)) {
      return { ok: false, error: "aggregate_id must be a UUID", code: "invalid_aggregate_id" };
    }
    aggregateId = trimField(raw.aggregate_id).toLowerCase();
  }

  let projectId = null;
  if (raw.project_id != null && trimField(raw.project_id) !== "") {
    if (!validUuid(raw.project_id)) {
      return { ok: false, error: "project_id must be a UUID", code: "invalid_project_id" };
    }
    projectId = trimField(raw.project_id).toLowerCase();
  }

  let quoteId = null;
  if (raw.quote_id != null && trimField(raw.quote_id) !== "") {
    if (!validUuid(raw.quote_id)) {
      return { ok: false, error: "quote_id must be a UUID", code: "invalid_quote_id" };
    }
    quoteId = trimField(raw.quote_id).toLowerCase();
  }

  const corrIn = raw.correlation_id != null ? assertCorrelationId(raw.correlation_id) : null;
  const correlationId = corrIn
    ? corrIn.ok
      ? corrIn.value
      : null
    : createCorrelationId();
  if (corrIn && !corrIn.ok) {
    return { ok: false, error: corrIn.error, code: "invalid_correlation_id" };
  }

  let causationId = null;
  if (raw.causation_id != null && trimField(raw.causation_id) !== "") {
    const c = assertCorrelationId(raw.causation_id);
    if (!c.ok) {
      return { ok: false, error: c.error, code: "invalid_causation_id" };
    }
    causationId = c.value;
  }

  const payloadIn =
    raw.payload && typeof raw.payload === "object" && !Array.isArray(raw.payload)
      ? raw.payload
      : {};
  const scrubbed = scrubForbiddenKeys(payloadIn, "payload");
  if (!scrubbed.ok) {
    return { ok: false, error: scrubbed.error, code: "forbidden_payload" };
  }

  const eventId =
    raw.event_id && validUuid(raw.event_id)
      ? trimField(raw.event_id).toLowerCase()
      : crypto.randomUUID();

  const occurredAt = raw.occurred_at
    ? new Date(raw.occurred_at).toISOString()
    : utcNowIso();
  if (Number.isNaN(Date.parse(occurredAt))) {
    return { ok: false, error: "occurred_at must be a valid timestamp", code: "invalid_occurred_at" };
  }

  const eventVersion =
    raw.event_version == null ? EVENT_VERSION : Number(raw.event_version);
  if (!Number.isInteger(eventVersion) || eventVersion < 1) {
    return { ok: false, error: "event_version must be an integer >= 1", code: "invalid_event_version" };
  }

  return {
    ok: true,
    event: {
      event_id: eventId,
      event_version: eventVersion,
      tenant_id: tenantId.toLowerCase(),
      project_id: projectId,
      quote_id: quoteId,
      aggregate,
      aggregate_id: aggregateId,
      type,
      occurred_at: occurredAt,
      correlation_id: correlationId,
      causation_id: causationId,
      payload: scrubbed.value,
      fabric_version: FABRIC_VERSION,
    },
  };
}

module.exports = {
  EVENT_VERSION,
  FABRIC_VERSION,
  DOMAIN_EVENT_TYPES,
  DOMAIN_EVENT_TYPE_SET,
  AGGREGATES,
  CORRELATION_RE,
  createCorrelationId,
  assertCorrelationId,
  buildDomainEvent,
  isDomainEventType,
  isAggregate,
  scrubForbiddenKeys,
  utcNowIso,
  validUuid,
  trimField,
};
