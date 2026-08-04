/**
 * CH-013A.2.0 — Delivery Channel Engine (foundation).
 * Transport orchestration only. Invitation Engine remains legal source of truth.
 * No provider credentials. No transport domain events yet (stubbed).
 *
 * Persistent DeliveryContext never contains raw tokens.
 * Ephemeral oneShotSecret is passed separately only for COPY_LINK mint/reveal.
 */

"use strict";

const copyLink = require("./channels/copy-link");
const email = require("./channels/email");
const sms = require("./channels/sms");
const whatsapp = require("./channels/whatsapp");
const esignHost = require("./channels/esign-host");
const { resolveTenantBranding } = require("./tenant-branding");
const { buildSigningLink } = require("./signing-link-builder");

const API_VERSION = "ch-013a20-v1";

const CHANNELS = Object.freeze([
  "copy_link",
  "email",
  "sms",
  "whatsapp",
  "esign_host",
]);

function trimField(value) {
  return value == null ? "" : String(value).trim();
}

function maskEmail(email) {
  const s = trimField(email);
  if (!s || !s.includes("@")) return "[redacted]";
  const [user, domain] = s.split("@");
  const keep = Math.min(2, user.length);
  return `${user.slice(0, keep)}***@${domain}`;
}

function isAdapterAvailable(adapter) {
  if (!adapter) return false;
  if (typeof adapter.isAvailable === "function") return adapter.isAvailable() === true;
  if (typeof adapter.available === "boolean") return adapter.available === true;
  // Fail closed: unknown adapters are not active.
  return false;
}

/** In-memory attempt store for foundation/tests only — not durable. Never stores secrets. */
const _memoryAttempts = new Map();

function makeAttemptId() {
  return `att_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

function createRegistry(seedAdapters = []) {
  const map = new Map();

  function register(adapter) {
    if (!adapter || typeof adapter.channel !== "function") {
      throw new Error("adapter.channel() is required");
    }
    const name = trimField(adapter.channel()).toLowerCase();
    if (!name) throw new Error("adapter channel name required");
    map.set(name, adapter);
    return true;
  }

  /**
   * Resolve a channel adapter.
   * @param {string} channelName
   * @param {{ activeOnly?: boolean }} [opts] — default activeOnly=true so stubs
   *   cannot be treated as usable production adapters for deliver/queue.
   */
  function resolve(channelName, opts = {}) {
    const activeOnly = opts.activeOnly !== false;
    const name = trimField(channelName).toLowerCase();
    const adapter = map.get(name);
    if (!adapter) {
      return { ok: false, error: `Unknown channel: ${channelName}`, code: "unknown_channel" };
    }
    if (activeOnly && !isAdapterAvailable(adapter)) {
      return {
        ok: false,
        error: `Channel unavailable: ${name}`,
        code: "channel_unavailable",
        channel: name,
        available: false,
      };
    }
    return {
      ok: true,
      adapter,
      channel: name,
      available: isAdapterAvailable(adapter),
    };
  }

  /** Capability metadata (stubs may appear with available:false). */
  function list() {
    return [...map.entries()]
      .map(([name, adapter]) => ({
        channel: name,
        available: isAdapterAvailable(adapter),
        provider:
          typeof adapter.provider === "function"
            ? adapter.provider()
            : name === "copy_link"
              ? "none"
              : null,
      }))
      .sort((a, b) => a.channel.localeCompare(b.channel));
  }

  function listChannelNames() {
    return [...map.keys()].sort();
  }

  for (const a of seedAdapters) register(a);
  return { register, resolve, list, listChannelNames };
}

const defaultRegistry = createRegistry([
  copyLink,
  email,
  sms,
  whatsapp,
  esignHost,
]);

// ---------------------------------------------------------------------------
// Idempotency helpers
// ---------------------------------------------------------------------------

function deliveryIdempotencyKey({ tenantId, invitationId, channel, generationNumber, purpose }) {
  const parts = [
    "delivery",
    trimField(purpose) || "queue",
    trimField(tenantId),
    trimField(invitationId) || "none",
    trimField(channel),
    generationNumber != null ? String(generationNumber) : "0",
  ];
  return parts.join(":");
}

/**
 * Transport event stub — A.2.0 does not publish to Platform Bus.
 * Payload must never include raw tokens or signing URLs.
 */
function stubTransportEvent(type, payload = {}) {
  const safe = { ...payload };
  delete safe.raw_token;
  delete safe.raw_token_once;
  delete safe.oneShotSecret;
  delete safe.signing_url;
  delete safe.signing_link;
  delete safe.token;
  return {
    ok: true,
    stubbed: true,
    type,
    payload: safe,
    note: "CH-013A.2.0: transport events not emitted yet",
  };
}

/**
 * Pull ephemeral one-shot secret from caller input without placing it on context.
 */
function extractOneShotSecret(input = {}) {
  return (
    trimField(input.oneShotSecret) ||
    trimField(input.one_shot_secret) ||
    trimField(input.raw_token_once) ||
    ""
  );
}

// ---------------------------------------------------------------------------
// Context builder — persistent context NEVER includes raw token / signing URL secrets
// ---------------------------------------------------------------------------

async function buildDeliveryContext(input = {}) {
  const channel = trimField(input.channel).toLowerCase() || "copy_link";
  const tenantId = trimField(input.tenant_id || input.tenant?.id);
  const brandingResult = await resolveTenantBranding(tenantId || null);
  const recipientEmail = input.recipient?.email || input.signer?.email || "";
  const masked = trimField(input.masked_recipient) || maskEmail(recipientEmail);

  // Persistent context: no raw token, no signing_url reconstruction fields.
  const ctx = {
    tenant: input.tenant || (tenantId ? { id: tenantId } : null),
    tenant_id: tenantId || null,
    invitation: input.invitation
      ? {
          id: input.invitation.id || null,
          status: input.invitation.status || null,
        }
      : null,
    generation: input.generation
      ? {
          id: input.generation.id || null,
          generation_number: input.generation.generation_number ?? null,
          expires_at: input.generation.expires_at || null,
          // token_id / token_hash intentionally omitted from delivery context
        }
      : null,
    attempt: input.attempt || null,
    branding: brandingResult.branding,
    // No signing_link.url on persistent context — reveal is one-shot via adapter return only.
    signing_link: null,
    masked_recipient: masked,
    channel,
    metadata:
      input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata)
        ? scrubSecretsFromObject({ ...input.metadata })
        : {},
    project: input.project
      ? {
          project_id: input.project.project_id || input.project.id || null,
          project_name: trimField(input.project.project_name || input.project.name),
        }
      : null,
    recipient: {
      party_name: trimField(input.recipient?.party_name || input.signer?.party_name),
    },
    public_origin: input.public_origin || null,
    expires_at: input.expires_at || input.generation?.expires_at || null,
  };

  // Hard deny: never attach secret aliases onto persistent context.
  delete ctx.raw_token_once;
  delete ctx.raw_token;
  delete ctx.oneShotSecret;
  delete ctx.token;
  delete ctx.signing_token;
  delete ctx.token_hash;
  delete ctx.token_id;

  return { ok: true, context: Object.freeze({ ...ctx }), api_version: API_VERSION };
}

function scrubSecretsFromObject(obj) {
  const out = { ...obj };
  for (const k of [
    "raw_token",
    "raw_token_once",
    "oneShotSecret",
    "signing_url",
    "token",
    "token_hash",
  ]) {
    delete out[k];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Queue / claim / complete / fail (foundation — memory-backed for copy_link sync)
// ---------------------------------------------------------------------------

async function queueDelivery(input = {}) {
  const channel = trimField(input.channel).toLowerCase();
  const resolved = defaultRegistry.resolve(channel, { activeOnly: true });
  if (!resolved.ok) return resolved;

  // Never pass secrets into context builder via spread of input secrets.
  const built = await buildDeliveryContext({
    ...input,
    raw_token_once: undefined,
    oneShotSecret: undefined,
    one_shot_secret: undefined,
    signing_url: undefined,
    signing_link: undefined,
  });
  if (!built.ok) return built;

  const attempt = {
    attempt_id: makeAttemptId(),
    channel,
    status: "queued",
    invitation_id: input.invitation?.id || input.invitation_id || null,
    generation_id: input.generation?.id || input.generation_id || null,
    tenant_id: built.context.tenant_id,
    created_at: new Date().toISOString(),
    provider: channel === "copy_link" ? "none" : null,
    idempotency_key: deliveryIdempotencyKey({
      tenantId: built.context.tenant_id,
      invitationId: input.invitation?.id || input.invitation_id,
      channel,
      generationNumber: input.generation?.generation_number,
      purpose: "queue",
    }),
  };
  _memoryAttempts.set(attempt.attempt_id, {
    attempt,
    context: built.context,
    // Secrets are NEVER stored on the attempt row.
  });

  stubTransportEvent("delivery.channel.queued", {
    attempt_id: attempt.attempt_id,
    channel,
  });

  return {
    ok: true,
    api_version: API_VERSION,
    attempt,
    context: built.context,
    event_stub: true,
  };
}

async function claimDelivery(attemptId) {
  const row = _memoryAttempts.get(trimField(attemptId));
  if (!row) {
    return { ok: false, error: "Attempt not found", code: "not_found" };
  }
  if (row.attempt.status !== "queued") {
    return {
      ok: false,
      error: `Cannot claim attempt in status ${row.attempt.status}`,
      code: "illegal_claim",
    };
  }
  row.attempt.status = "sending";
  row.attempt.claimed_at = new Date().toISOString();
  return { ok: true, attempt: row.attempt, context: row.context, api_version: API_VERSION };
}

async function completeDelivery(attemptId, result = {}) {
  const row = _memoryAttempts.get(trimField(attemptId));
  if (!row) {
    return { ok: false, error: "Attempt not found", code: "not_found" };
  }
  const isCopyLink = row.attempt.channel === "copy_link";
  // Copy Link is not provider-sent — mark ready, not provider-accepted.
  row.attempt.status = isCopyLink ? "ready" : "sent";
  row.attempt.completed_at = new Date().toISOString();
  row.attempt.result = {
    accepted: result.accepted !== false,
    provider: result.provider || (isCopyLink ? "none" : null),
    // Never store signing_url or raw token on attempt result.
    has_signing_url: Boolean(result.signing_url || result.has_signing_url),
  };
  stubTransportEvent(
    isCopyLink ? "delivery.channel.ready" : "delivery.channel.sent",
    {
      attempt_id: row.attempt.attempt_id,
      channel: row.attempt.channel,
      provider: row.attempt.result.provider,
    }
  );
  return { ok: true, attempt: row.attempt, api_version: API_VERSION };
}

async function failDelivery(attemptId, errorInfo = {}) {
  const row = _memoryAttempts.get(trimField(attemptId));
  if (!row) {
    return { ok: false, error: "Attempt not found", code: "not_found" };
  }
  row.attempt.status = "failed";
  row.attempt.failed_at = new Date().toISOString();
  row.attempt.error_code = errorInfo.code || "delivery_failed";
  row.attempt.error_message = String(errorInfo.error || errorInfo.message || "failed").slice(
    0,
    500
  );
  stubTransportEvent("delivery.channel.failed", {
    attempt_id: row.attempt.attempt_id,
    channel: row.attempt.channel,
  });
  return { ok: true, attempt: row.attempt, api_version: API_VERSION };
}

/**
 * Synchronous Copy Link path used by CH-013B send response / Owner UI wiring.
 * Queues + claims + delivers + completes in-process (no network provider).
 *
 * @param {object} input — persistent delivery fields (no raw token required on object)
 * @param {string} [oneShotSecretArg] — optional raw token; also accepted as input.oneShotSecret
 */
async function deliverCopyLink(input = {}, oneShotSecretArg = null) {
  const oneShotSecret =
    trimField(oneShotSecretArg) || extractOneShotSecret(input);

  const queued = await queueDelivery({
    ...input,
    channel: "copy_link",
    raw_token_once: undefined,
    oneShotSecret: undefined,
  });
  if (!queued.ok) return queued;

  const claimed = await claimDelivery(queued.attempt.attempt_id);
  if (!claimed.ok) return claimed;

  const resolved = defaultRegistry.resolve("copy_link", { activeOnly: true });
  if (!resolved.ok) return resolved;

  // Ephemeral secret passed separately — never merged into persistent context object.
  const delivered = await resolved.adapter.deliver(claimed.context, {
    oneShotSecret,
    public_origin: input.public_origin || claimed.context.public_origin || null,
  });
  if (!delivered.ok) {
    await failDelivery(queued.attempt.attempt_id, delivered);
    return delivered;
  }

  await completeDelivery(queued.attempt.attempt_id, {
    accepted: true,
    provider: "none",
    has_signing_url: Boolean(delivered.signing_url),
  });

  const attempt = _memoryAttempts.get(queued.attempt.attempt_id)?.attempt || queued.attempt;

  return {
    ok: true,
    api_version: API_VERSION,
    channel: "copy_link",
    provider: "none",
    attempt,
    signing_url: delivered.signing_url,
    signing_link: delivered.signing_link,
    ui_copy: "Secure Link Ready",
  };
}

/**
 * Build a signing URL via SigningLinkBuilder only (helper for adapters/tests).
 */
function buildLinkFromRawToken(rawToken, extras = {}) {
  return buildSigningLink({
    raw_token: rawToken,
    public_origin: extras.public_origin,
    expires_at: extras.expires_at,
    generation_number: extras.generation_number,
  });
}

function _resetMemoryAttemptsForTests() {
  _memoryAttempts.clear();
}

module.exports = {
  API_VERSION,
  CHANNELS,
  createRegistry,
  defaultRegistry,
  register: defaultRegistry.register,
  resolve: defaultRegistry.resolve,
  list: defaultRegistry.list,
  listChannelNames: defaultRegistry.listChannelNames,
  isAdapterAvailable,
  deliveryIdempotencyKey,
  stubTransportEvent,
  buildDeliveryContext,
  extractOneShotSecret,
  queueDelivery,
  claimDelivery,
  completeDelivery,
  failDelivery,
  deliverCopyLink,
  buildLinkFromRawToken,
  maskEmail,
  _resetMemoryAttemptsForTests,
};
