/**
 * CH-013A.1 — Signing Invitation lifecycle (hardened).
 *
 * Invitation = stable aggregate per (tenant, envelope, signer)
 * Generation = token-bound secure-link epoch (resend = N+1)
 * Delivery attempt = controlled status transitions (DELETE forbidden)
 *
 * Events describe the Invitation aggregate with generation context in payload.
 * No email providers. No UI. Envelope-send wire-up lives in CH-013B.
 */

"use strict";

const { supabaseRequest } = require("./supabase-admin");
const {
  scrubForbiddenKeys,
  trimField,
  validUuid,
  utcNowIso,
  createCorrelationId,
  assertCorrelationId,
} = require("./platform-events");
const { publishDomainEvent, beginCorrelation } = require("./platform-bus");
const { projectActivityFromEvent } = require("./platform-activity");
const { createNotification } = require("./platform-notifications");
const { isUniqueViolation } = require("./platform-outbox");
const {
  createSigningToken,
  ensureSigningTokenForSigner,
  revokeSigningToken,
  lookupSigningToken,
} = require("./contract-signing-token");

const API_VERSION = "ch-013a1-v1";
const INVITATIONS_TABLE = "tenant_contract_invitations";
const GENERATIONS_TABLE = "tenant_contract_invitation_generations";
const ATTEMPTS_TABLE = "tenant_contract_invitation_delivery_attempts";

const INVITATION_STATUSES = Object.freeze([
  "prepared",
  "queued",
  "sending",
  "sent",
  "delivered",
  "opened",
  "signed",
  "expired",
  "revoked",
  "cancelled",
  "failed",
  "bounced",
]);

const GENERATION_REASONS = Object.freeze([
  "initial_send",
  "owner_resend",
  "email_correction",
  "security_rotation",
]);

const GENERATION_STATUSES = Object.freeze([
  "active",
  "revoked",
  "expired",
  "superseded",
  "consumed",
]);

const TERMINAL_INVITATION = Object.freeze(
  new Set(["signed", "expired", "revoked", "cancelled"])
);

const ENVELOPE_TERMINAL = Object.freeze(
  new Set(["completed", "cancelled", "declined", "expired"])
);

const ALLOWED_TRANSITIONS = Object.freeze({
  prepared: Object.freeze(new Set(["queued", "cancelled", "expired", "revoked"])),
  queued: Object.freeze(new Set(["sending", "cancelled", "expired", "revoked"])),
  sending: Object.freeze(new Set(["sent", "failed", "cancelled", "revoked"])),
  sent: Object.freeze(
    new Set(["delivered", "opened", "bounced", "failed", "expired", "revoked", "queued"])
  ),
  delivered: Object.freeze(
    new Set(["opened", "bounced", "expired", "revoked", "queued", "failed"])
  ),
  opened: Object.freeze(new Set(["signed", "expired", "revoked", "queued", "failed"])),
  signed: Object.freeze(new Set([])),
  expired: Object.freeze(new Set([])),
  revoked: Object.freeze(new Set([])),
  cancelled: Object.freeze(new Set([])),
  failed: Object.freeze(new Set(["queued", "revoked", "cancelled", "expired"])),
  bounced: Object.freeze(new Set(["queued", "revoked", "cancelled", "expired"])),
});

const ATTEMPT_ALLOWED = Object.freeze({
  queued: Object.freeze(new Set(["sending", "cancelled", "failed"])),
  sending: Object.freeze(new Set(["sent", "delivered", "failed", "bounced", "cancelled"])),
  sent: Object.freeze(new Set([])),
  delivered: Object.freeze(new Set([])),
  failed: Object.freeze(new Set([])),
  bounced: Object.freeze(new Set([])),
  cancelled: Object.freeze(new Set([])),
});

const STATUS_EVENT_TYPE = Object.freeze({
  prepared: "contract.invitation.prepared",
  queued: "contract.invitation.queued",
  sent: "contract.invitation.sent",
  delivered: "contract.invitation.delivered",
  opened: "contract.invitation.opened",
  failed: "contract.invitation.failed",
  bounced: "contract.invitation.bounced",
  revoked: "contract.invitation.revoked",
  expired: "contract.invitation.expired",
});

const CHANNELS = Object.freeze(["email", "copy_link", "in_app"]);

function canTransition(fromStatus, toStatus) {
  const allowed = ALLOWED_TRANSITIONS[trimField(fromStatus)];
  return Boolean(allowed && allowed.has(trimField(toStatus)));
}

function assertTransition(fromStatus, toStatus) {
  if (!canTransition(fromStatus, toStatus)) {
    return {
      ok: false,
      error: `Illegal invitation transition ${fromStatus} → ${toStatus}`,
      code: "illegal_transition",
    };
  }
  return { ok: true };
}

function canTransitionAttempt(fromStatus, toStatus) {
  const allowed = ATTEMPT_ALLOWED[trimField(fromStatus)];
  return Boolean(allowed && allowed.has(trimField(toStatus)));
}

function assertAttemptTransition(fromStatus, toStatus) {
  if (!canTransitionAttempt(fromStatus, toStatus)) {
    return {
      ok: false,
      error: `Illegal attempt transition ${fromStatus} → ${toStatus}`,
      code: "illegal_attempt_transition",
    };
  }
  return { ok: true };
}

/**
 * Expiration policy:
 * - envelope.expires_at is the ceiling when present
 * - generation/token expires_at must be <= envelope deadline
 * - generation owns actual link expiration; token equals generation
 */
function resolveGenerationExpiresAt({ envelopeExpiresAt, requestedExpiresAt, now = new Date() }) {
  const nowMs = now.getTime();
  let requested = null;
  if (requestedExpiresAt != null && String(requestedExpiresAt).trim() !== "") {
    requested = new Date(requestedExpiresAt);
    if (Number.isNaN(requested.getTime()) || requested.getTime() <= nowMs) {
      return { ok: false, error: "expires_at must be a future timestamp", code: "invalid_expires_at" };
    }
  }

  let ceiling = null;
  if (envelopeExpiresAt != null && String(envelopeExpiresAt).trim() !== "") {
    ceiling = new Date(envelopeExpiresAt);
    if (Number.isNaN(ceiling.getTime())) {
      return { ok: false, error: "envelope.expires_at invalid", code: "invalid_envelope_expires_at" };
    }
    if (ceiling.getTime() <= nowMs) {
      return {
        ok: false,
        error: "Envelope deadline has passed; cannot create an active generation",
        code: "envelope_deadline_passed",
      };
    }
  }

  let chosen = requested;
  if (!chosen) {
    // Default: envelope ceiling if present, else +14 days
    chosen = ceiling || new Date(nowMs + 14 * 24 * 60 * 60 * 1000);
  }
  if (ceiling && chosen.getTime() > ceiling.getTime()) {
    chosen = ceiling;
  }

  return { ok: true, expires_at: chosen.toISOString(), envelope_ceiling: ceiling ? ceiling.toISOString() : null };
}

function maskEmail(email) {
  const s = trimField(email);
  if (!s || !s.includes("@")) return "[redacted]";
  const [user, domain] = s.split("@");
  const keep = Math.min(2, user.length);
  return `${user.slice(0, keep)}***@${domain}`;
}

function statusTimestampPatch(toStatus, nowIso) {
  const patch = { status: toStatus, updated_at: nowIso };
  const map = {
    queued: "queued_at",
    sending: "sending_at",
    sent: "sent_at",
    delivered: "delivered_at",
    opened: "opened_at",
    signed: "signed_at",
    expired: "expired_at",
    revoked: "revoked_at",
    cancelled: "cancelled_at",
    failed: "failed_at",
    bounced: "bounced_at",
  };
  if (map[toStatus]) patch[map[toStatus]] = nowIso;
  return patch;
}

async function loadEnvelope(tenantId, envelopeId) {
  const rows = await supabaseRequest(
    `tenant_contract_envelopes?tenant_id=eq.${encodeURIComponent(tenantId)}&id=eq.${encodeURIComponent(envelopeId)}&select=id,tenant_id,status,expires_at,package_id,project_id,quote_id&limit=1`,
    { method: "GET" }
  );
  return Array.isArray(rows) ? rows[0] : rows;
}

async function loadSigner(tenantId, signerId) {
  const rows = await supabaseRequest(
    `tenant_contract_signers?tenant_id=eq.${encodeURIComponent(tenantId)}&id=eq.${encodeURIComponent(signerId)}&select=id,tenant_id,envelope_id,email,party_name&limit=1`,
    { method: "GET" }
  );
  return Array.isArray(rows) ? rows[0] : rows;
}

async function getInvitation(tenantId, invitationId) {
  if (!validUuid(tenantId) || !validUuid(invitationId)) {
    return { ok: false, error: "tenant_id and invitation id must be UUIDs", code: "invalid_id" };
  }
  const rows = await supabaseRequest(
    `${INVITATIONS_TABLE}?tenant_id=eq.${encodeURIComponent(tenantId)}&id=eq.${encodeURIComponent(invitationId)}&select=*&limit=1`,
    { method: "GET" }
  );
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row) return { ok: false, error: "Invitation not found", code: "not_found" };
  return { ok: true, invitation: row };
}

async function getActiveGeneration(tenantId, invitationId) {
  const rows = await supabaseRequest(
    `${GENERATIONS_TABLE}?tenant_id=eq.${encodeURIComponent(tenantId)}&invitation_id=eq.${encodeURIComponent(invitationId)}&status=eq.active&select=*&limit=1`,
    { method: "GET" }
  );
  return Array.isArray(rows) ? rows[0] || null : rows || null;
}

async function getGenerationByNumber(tenantId, invitationId, generationNumber) {
  const rows = await supabaseRequest(
    `${GENERATIONS_TABLE}?tenant_id=eq.${encodeURIComponent(tenantId)}&invitation_id=eq.${encodeURIComponent(invitationId)}&generation_number=eq.${encodeURIComponent(generationNumber)}&select=*&limit=1`,
    { method: "GET" }
  );
  return Array.isArray(rows) ? rows[0] || null : rows || null;
}

function activityFor(status, extras = {}) {
  const masked = extras.masked_email ? ` to ${extras.masked_email}` : "";
  const preparedFor = extras.masked_email
    ? `Signing request prepared for ${extras.masked_email}`
    : "Signing request prepared";
  const map = {
    prepared: {
      title: preparedFor,
      summary: preparedFor,
    },
    queued: {
      title: "Signing request queued",
      summary: "A signing invitation was queued for delivery.",
    },
    sent: {
      title: `Invitation sent${masked}`,
      summary: "A signing invitation was marked sent.",
    },
    delivered: {
      title: "Signing request delivered",
      summary: "A signing invitation was marked delivered.",
    },
    opened: {
      title: "Customer opened signing request",
      summary: "A signing invitation was opened.",
    },
    failed: {
      title: "Delivery failed",
      summary: "A signing invitation delivery attempt failed.",
    },
    bounced: {
      title: "Delivery bounced",
      summary: "A signing invitation delivery bounced.",
    },
    expired: {
      title: "Signing request expired",
      summary: "A signing invitation / generation expired.",
    },
    revoked: {
      title: "Previous secure link revoked",
      summary: "A signing invitation generation was revoked.",
    },
    resent: {
      title: "Owner resent signing request",
      summary: "Owner resent signing request; previous secure link revoked.",
    },
    cancelled: {
      title: "Signing request cancelled",
      summary: "A signing invitation was cancelled.",
    },
    signed: {
      title: "Signing request signed",
      summary: "The signer completed signing for this invitation.",
    },
  };
  return map[status] || { title: `Signing request ${status}`, summary: "" };
}

/**
 * Events describe the Invitation aggregate; payload carries generation context.
 */
async function emitInvitationEvent({
  invitation,
  eventType,
  activityKey,
  causationId,
  idempotencyKey,
  notify,
  notifyPriority,
  extraPayload,
  maskedEmail,
}) {
  const payloadScrub = scrubForbiddenKeys(
    {
      invitation_id: invitation.id,
      envelope_id: invitation.envelope_id,
      signer_id: invitation.signer_id,
      status: invitation.status,
      current_generation: invitation.current_generation,
      channel: invitation.channel,
      ...(extraPayload && typeof extraPayload === "object" ? extraPayload : {}),
    },
    "payload"
  );
  if (!payloadScrub.ok) {
    return { ok: false, error: payloadScrub.error, code: "forbidden_payload" };
  }

  const published = await publishDomainEvent(
    {
      tenant_id: invitation.tenant_id,
      project_id: invitation.project_id,
      quote_id: invitation.quote_id,
      aggregate: "invitation",
      aggregate_id: invitation.id,
      type: eventType,
      correlation_id: invitation.correlation_id || createCorrelationId(),
      causation_id: causationId || null,
      payload: payloadScrub.value,
    },
    { idempotency_key: idempotencyKey }
  );
  if (!published.ok) return published;

  // Prefer outbox row on idempotent replay so projections use the canonical event_id.
  const eventForProjections =
    published.duplicate && published.outbox
      ? {
          event_id: published.outbox.event_id,
          event_version: published.outbox.event_version,
          tenant_id: published.outbox.tenant_id,
          project_id: published.outbox.project_id,
          quote_id: published.outbox.quote_id,
          aggregate: published.outbox.aggregate,
          aggregate_id: published.outbox.aggregate_id,
          type: published.outbox.type,
          occurred_at: published.outbox.occurred_at,
          correlation_id: published.outbox.correlation_id,
          causation_id: published.outbox.causation_id,
          payload:
            published.outbox.payload && typeof published.outbox.payload === "object"
              ? published.outbox.payload
              : payloadScrub.value,
        }
      : published.event;

  const copy = activityFor(activityKey, { masked_email: maskedEmail });
  // Always (re)project — activity is unique on (tenant_id, source_event_id).
  const activity = await projectActivityFromEvent(eventForProjections, {
    title: copy.title,
    summary: copy.summary,
    payload: payloadScrub.value,
  });
  if (!activity.ok) {
    return {
      ok: false,
      error: activity.error || "activity projection failed",
      code: activity.code || "activity_project_failed",
      event: eventForProjections,
      outbox: published.outbox,
      duplicate: Boolean(published.duplicate),
    };
  }

  const notifyEnabled = Boolean(notify);
  const customNotify = notify && typeof notify === "object" ? notify : null;
  if (notifyEnabled) {
    const notified = await ensureNotificationForEvent({
      tenant_id: invitation.tenant_id,
      project_id: invitation.project_id,
      quote_id: invitation.quote_id,
      source_event_id: eventForProjections.event_id,
      event_type: eventType,
      priority: notifyPriority || "normal",
      title: (customNotify && customNotify.title) || copy.title,
      body: (customNotify && customNotify.body) || copy.summary,
      correlation_id: eventForProjections.correlation_id,
      occurred_at: eventForProjections.occurred_at,
      payload: payloadScrub.value,
    });
    if (!notified.ok) {
      return {
        ok: false,
        error: notified.error || "notification projection failed",
        code: notified.code || "notification_project_failed",
        event: eventForProjections,
        outbox: published.outbox,
        duplicate: Boolean(published.duplicate),
      };
    }
  }

  return {
    ok: true,
    event: eventForProjections,
    outbox: published.outbox,
    duplicate: Boolean(published.duplicate),
  };
}

/**
 * Notification projection: one row per source_event_id (app-level; table has no unique).
 * Retries look up existing before insert to avoid duplicates.
 */
async function ensureNotificationForEvent(input = {}) {
  const tenantId = trimField(input.tenant_id);
  const sourceEventId = trimField(input.source_event_id);
  if (validUuid(tenantId) && validUuid(sourceEventId)) {
    try {
      const existing = await supabaseRequest(
        `platform_notifications?tenant_id=eq.${encodeURIComponent(tenantId)}` +
          `&source_event_id=eq.${encodeURIComponent(sourceEventId)}&select=*&limit=1`,
        { method: "GET" }
      );
      const row = Array.isArray(existing) ? existing[0] : existing;
      if (row?.id) {
        return { ok: true, row, duplicate: true };
      }
    } catch (_err) {
      /* fall through to create */
    }
  }
  const created = await createNotification(input);
  if (!created.ok) return created;
  return { ok: true, row: created.row, duplicate: false };
}

/**
 * Prepare invitation (idempotent on tenant+envelope+signer). Does not create generation/token yet
 * unless options.create_initial_generation === true.
 *
 * When create_initial_generation is true: generation is ensured before the prepared event so the
 * payload can include generation_id / expires_at. Duplicate invitation rows reuse gen 1 + event.
 */
async function prepareInvitation(input = {}) {
  const tenantId = trimField(input.tenant_id);
  const envelopeId = trimField(input.envelope_id);
  const signerId = trimField(input.signer_id);
  if (!validUuid(tenantId) || !validUuid(envelopeId) || !validUuid(signerId)) {
    return {
      ok: false,
      error: "tenant_id, envelope_id, and signer_id must be UUIDs",
      code: "invalid_id",
    };
  }

  const channel = trimField(input.channel || "email") || "email";
  if (!CHANNELS.includes(channel)) {
    return { ok: false, error: "Invalid channel", code: "invalid_channel" };
  }

  let correlationId =
    input.correlation_id != null && trimField(input.correlation_id)
      ? trimField(input.correlation_id)
      : beginCorrelation();
  const corr = assertCorrelationId(correlationId);
  if (!corr.ok) return { ok: false, error: corr.error, code: "invalid_correlation_id" };
  correlationId = corr.value;

  const metaIn =
    input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata)
      ? input.metadata
      : {};
  const scrubbed = scrubForbiddenKeys(metaIn, "metadata");
  if (!scrubbed.ok) {
    return { ok: false, error: scrubbed.error, code: "forbidden_payload" };
  }

  const nowIso = utcNowIso();
  const row = {
    tenant_id: tenantId.toLowerCase(),
    envelope_id: envelopeId.toLowerCase(),
    signer_id: signerId.toLowerCase(),
    package_id: input.package_id || null,
    project_id: input.project_id || null,
    quote_id: input.quote_id || null,
    current_generation: 0,
    status: "prepared",
    channel,
    prepared_at: nowIso,
    correlation_id: correlationId,
    metadata: scrubbed.value,
  };

  let invitation;
  let duplicate = false;
  try {
    const inserted = await supabaseRequest(INVITATIONS_TABLE, {
      method: "POST",
      body: row,
      headers: { Prefer: "return=representation" },
    });
    invitation = Array.isArray(inserted) ? inserted[0] : inserted;
  } catch (err) {
    if (!isUniqueViolation(err)) {
      return { ok: false, error: err.message || String(err), code: "prepare_failed" };
    }
    duplicate = true;
    const existing = await supabaseRequest(
      `${INVITATIONS_TABLE}?tenant_id=eq.${encodeURIComponent(tenantId)}&envelope_id=eq.${encodeURIComponent(envelopeId)}&signer_id=eq.${encodeURIComponent(signerId)}&select=*&limit=1`,
      { method: "GET" }
    );
    invitation = Array.isArray(existing) ? existing[0] : existing;
    if (!invitation) {
      return { ok: false, error: "Invitation conflict unresolved", code: "idempotency_conflict" };
    }
  }

  let generation = null;
  let rawTokenOnce = null;
  if (input.create_initial_generation === true) {
    const created = await createInitialGeneration(invitation, {
      expires_at: input.expires_at,
      reason: "initial_send",
    });
    if (!created.ok) return { ...created, invitation };
    invitation = created.invitation;
    generation = created.generation;
    rawTokenOnce = created.raw_token_once || null;
  }

  const signer = await loadSigner(tenantId, signerId);
  const masked = maskEmail(signer?.email);
  const projectName =
    trimField(input.project_name) ||
    (await loadProjectName(tenantId, invitation.project_id)) ||
    "this project";

  let emitted = { ok: true, skipped: false, duplicate: false };
  // Always publish with deterministic key — outbox + projections are idempotent.
  emitted = await emitInvitationEvent({
    invitation,
    eventType: "contract.invitation.prepared",
    activityKey: "prepared",
    causationId: input.causation_id || null,
    idempotencyKey:
      input.idempotency_key || `invitation:prepared:${invitation.tenant_id}:${invitation.id}`,
    notify: {
      title: "Contract ready to send",
      body: `The secure signing request for ${projectName} is ready.`,
    },
    notifyPriority: "normal",
    maskedEmail: masked,
    extraPayload: {
      invitation_id: invitation.id,
      generation_id: generation?.id || null,
      generation_number: generation?.generation_number != null ? Number(generation.generation_number) : invitation.current_generation || null,
      envelope_id: invitation.envelope_id,
      signer_id: invitation.signer_id,
      package_id: invitation.package_id,
      project_id: invitation.project_id,
      quote_id: invitation.quote_id,
      channel: invitation.channel,
      expires_at: generation?.expires_at || null,
      masked_email: masked,
    },
  });
  if (!emitted.ok) {
    return { ok: false, error: emitted.error, code: emitted.code || "event_emit_failed", invitation, generation };
  }

  return {
    ok: true,
    invitation,
    generation,
    duplicate: duplicate || Boolean(emitted.duplicate),
    api_version: API_VERSION,
    event: emitted.event || null,
    raw_token_once: rawTokenOnce,
  };
}

async function loadProjectName(tenantId, projectId) {
  if (!validUuid(tenantId) || !validUuid(projectId)) return null;
  try {
    const rows = await supabaseRequest(
      `tenant_projects?tenant_id=eq.${encodeURIComponent(tenantId)}&id=eq.${encodeURIComponent(projectId)}&select=project_name&limit=1`,
      { method: "GET" }
    );
    const row = Array.isArray(rows) ? rows[0] : rows;
    return trimField(row?.project_name) || null;
  } catch (_err) {
    return null;
  }
}

/**
 * Create generation 1 + signing token. Fails if invitation already has a generation.
 * Token expires_at === generation.expires_at <= envelope.expires_at.
 * Reuses a still-valid active signing token when present (no rotation on ordinary prepare).
 */
async function createInitialGeneration(invitation, options = {}) {
  if (Number(invitation.current_generation) > 0) {
    const existing = await getGenerationByNumber(
      invitation.tenant_id,
      invitation.id,
      invitation.current_generation
    );
    return {
      ok: true,
      invitation,
      generation: existing,
      duplicate: true,
    };
  }

  const envelope = await loadEnvelope(invitation.tenant_id, invitation.envelope_id);
  if (!envelope?.id) {
    return { ok: false, error: "Envelope not found", code: "envelope_missing" };
  }
  if (ENVELOPE_TERMINAL.has(envelope.status)) {
    return {
      ok: false,
      error: `Envelope is ${envelope.status}; cannot create active generation`,
      code: "envelope_terminal",
    };
  }

  const expires = resolveGenerationExpiresAt({
    envelopeExpiresAt: envelope.expires_at,
    requestedExpiresAt: options.expires_at,
  });
  if (!expires.ok) return expires;

  const ensured = await ensureSigningTokenForSigner({
    tenantId: invitation.tenant_id,
    signerId: invitation.signer_id,
    expiresAt: expires.expires_at,
  });
  if (!ensured.ok) {
    return {
      ok: false,
      error: ensured.error || "token create failed",
      code: ensured.code || "token_create_failed",
    };
  }

  const tokenId = ensured.token.id;
  // Align token expiry with generation (must be equal).
  const tokenExpiresMs = ensured.token.expires_at
    ? new Date(ensured.token.expires_at).getTime()
    : NaN;
  const genExpiresMs = new Date(expires.expires_at).getTime();
  if (!Number.isFinite(tokenExpiresMs) || tokenExpiresMs !== genExpiresMs) {
    try {
      await supabaseRequest(
        `tenant_contract_signing_tokens?tenant_id=eq.${encodeURIComponent(invitation.tenant_id)}&id=eq.${encodeURIComponent(tokenId)}`,
        {
          method: "PATCH",
          body: { expires_at: expires.expires_at, updated_at: utcNowIso() },
        }
      );
    } catch (err) {
      if (!ensured.reused) {
        await revokeSigningToken({ tenantId: invitation.tenant_id, tokenId });
      }
      return {
        ok: false,
        error: err.message || String(err),
        code: "token_expires_align_failed",
      };
    }
  }

  // Never persist raw token on invitation/generation
  const genRow = {
    tenant_id: invitation.tenant_id,
    invitation_id: invitation.id,
    generation_number: 1,
    token_id: tokenId,
    status: "active",
    expires_at: expires.expires_at,
    reason: options.reason || "initial_send",
  };

  let generation;
  try {
    const inserted = await supabaseRequest(GENERATIONS_TABLE, {
      method: "POST",
      body: genRow,
      headers: { Prefer: "return=representation" },
    });
    generation = Array.isArray(inserted) ? inserted[0] : inserted;
  } catch (err) {
    if (!ensured.reused) {
      await revokeSigningToken({ tenantId: invitation.tenant_id, tokenId });
    }
    return {
      ok: false,
      error: err.message || String(err),
      code: "generation_create_failed",
    };
  }

  const updated = await supabaseRequest(
    `${INVITATIONS_TABLE}?tenant_id=eq.${encodeURIComponent(invitation.tenant_id)}&id=eq.${encodeURIComponent(invitation.id)}`,
    {
      method: "PATCH",
      body: { current_generation: 1, updated_at: utcNowIso() },
      headers: { Prefer: "return=representation" },
    }
  );
  const invitationOut = Array.isArray(updated) ? updated[0] : updated;

  return {
    ok: true,
    invitation: invitationOut || { ...invitation, current_generation: 1 },
    generation,
    // Raw token returned once to caller only — never stored / never in events
    raw_token_once: ensured.reused ? null : ensured.token?.token || null,
    duplicate: false,
  };
}

async function transitionInvitation(tenantId, invitationId, toStatus, options = {}) {
  const loaded = await getInvitation(tenantId, invitationId);
  if (!loaded.ok) return loaded;
  const invitation = loaded.invitation;

  if (toStatus === "revoked" && invitation.status === "signed") {
    return {
      ok: true,
      invitation,
      unchanged: true,
      code: "signed_remains_signed",
      api_version: API_VERSION,
    };
  }

  const gate = assertTransition(invitation.status, toStatus);
  if (!gate.ok) return gate;

  const nowIso = utcNowIso();
  const patch = statusTimestampPatch(toStatus, nowIso);
  if (toStatus === "opened" && invitation.opened_at) delete patch.opened_at;
  if (options.error_code != null) patch.last_error_code = String(options.error_code).slice(0, 120);
  if (options.error_message != null) {
    patch.last_error_message = String(options.error_message).slice(0, 1000);
  }

  let updated;
  try {
    const rows = await supabaseRequest(
      `${INVITATIONS_TABLE}?tenant_id=eq.${encodeURIComponent(tenantId)}&id=eq.${encodeURIComponent(invitationId)}`,
      { method: "PATCH", body: patch, headers: { Prefer: "return=representation" } }
    );
    updated = Array.isArray(rows) ? rows[0] : rows;
  } catch (err) {
    return { ok: false, error: err.message || String(err), code: "transition_failed" };
  }

  const eventType = STATUS_EVENT_TYPE[toStatus];
  let emitted = { ok: true, skipped: !eventType };
  if (eventType) {
    const notifyCritical = toStatus === "failed" || toStatus === "bounced";
    const notifyOpened = toStatus === "opened";
    const notify =
      notifyCritical || toStatus === "expired" || toStatus === "revoked" || notifyOpened;
    const priority = notifyCritical
      ? "critical"
      : notifyOpened
        ? "silent"
        : "normal";
    // prepared/queued: no Owner notification (handled by not being in STATUS_EVENT notify set for queued via transition — queued may notify false)
    const skipNotify = toStatus === "queued" || toStatus === "prepared";

    let maskedEmail = null;
    if (toStatus === "sent") {
      const signer = await loadSigner(tenantId, updated.signer_id);
      maskedEmail = maskEmail(signer?.email);
    }

    emitted = await emitInvitationEvent({
      invitation: updated,
      eventType,
      activityKey: toStatus,
      causationId: options.causation_id || null,
      idempotencyKey:
        options.idempotency_key ||
        `invitation:${toStatus}:${updated.tenant_id}:${updated.id}:${updated.updated_at}`,
      notify: notify && !skipNotify,
      notifyPriority: priority,
      extraPayload: {
        generation_number: updated.current_generation || null,
        ...(options.payload || {}),
      },
      maskedEmail,
    });
  }

  return {
    ok: true,
    invitation: updated,
    event: emitted.event || null,
    api_version: API_VERSION,
  };
}

async function createDeliveryAttempt(invitation, fields = {}) {
  const row = {
    tenant_id: invitation.tenant_id,
    invitation_id: invitation.id,
    generation_id: fields.generation_id || null,
    provider: trimField(fields.provider || "none") || "none",
    provider_message_id: fields.provider_message_id || null,
    status: "queued",
    started_at: utcNowIso(),
    retry_number: fields.retry_number != null ? Number(fields.retry_number) : 0,
  };
  try {
    const inserted = await supabaseRequest(ATTEMPTS_TABLE, {
      method: "POST",
      body: row,
      headers: { Prefer: "return=representation" },
    });
    return { ok: true, attempt: Array.isArray(inserted) ? inserted[0] : inserted };
  } catch (err) {
    return { ok: false, error: err.message || String(err), code: "attempt_create_failed" };
  }
}

async function transitionDeliveryAttempt(tenantId, attemptId, toStatus, options = {}) {
  const rows = await supabaseRequest(
    `${ATTEMPTS_TABLE}?tenant_id=eq.${encodeURIComponent(tenantId)}&attempt_id=eq.${encodeURIComponent(attemptId)}&select=*&limit=1`,
    { method: "GET" }
  );
  const attempt = Array.isArray(rows) ? rows[0] : rows;
  if (!attempt) return { ok: false, error: "Attempt not found", code: "not_found" };

  const gate = assertAttemptTransition(attempt.status, toStatus);
  if (!gate.ok) return gate;

  const patch = { status: toStatus };
  if (toStatus === "failed" || toStatus === "bounced") {
    if (options.error_code != null) patch.error_code = String(options.error_code).slice(0, 120);
    if (options.error_message != null) {
      patch.error_message = String(options.error_message).slice(0, 1000);
    }
  }
  if (options.provider_message_id != null && !attempt.provider_message_id) {
    patch.provider_message_id = String(options.provider_message_id).slice(0, 200);
  }

  try {
    const updated = await supabaseRequest(
      `${ATTEMPTS_TABLE}?tenant_id=eq.${encodeURIComponent(tenantId)}&attempt_id=eq.${encodeURIComponent(attemptId)}`,
      { method: "PATCH", body: patch, headers: { Prefer: "return=representation" } }
    );
    return { ok: true, attempt: Array.isArray(updated) ? updated[0] : updated };
  } catch (err) {
    return { ok: false, error: err.message || String(err), code: "attempt_transition_failed" };
  }
}

async function queueInvitation(tenantId, invitationId, options = {}) {
  const result = await transitionInvitation(tenantId, invitationId, "queued", options);
  if (!result.ok) return result;
  const active = await getActiveGeneration(tenantId, invitationId);
  const attempt = await createDeliveryAttempt(result.invitation, {
    generation_id: active?.id || null,
    provider: options.provider || "none",
    retry_number: options.retry_number,
  });
  return {
    ...result,
    attempt: attempt.ok ? attempt.attempt : null,
    attempt_error: attempt.ok ? null : attempt,
  };
}

/**
 * Explicit Resend:
 * 1) revoke generation N + token
 * 2) create token N+1
 * 3) create generation N+1
 * 4) update invitation.current_generation
 * 5) emit resent once (after safe create)
 * Failure after revoke but before new gen leaves zero active generations (retryable).
 */
async function resendInvitation(tenantId, invitationId, options = {}) {
  const loaded = await getInvitation(tenantId, invitationId);
  if (!loaded.ok) return loaded;
  let invitation = loaded.invitation;

  if (invitation.status === "signed" || TERMINAL_INVITATION.has(invitation.status)) {
    return {
      ok: false,
      error: `Cannot resend invitation in status ${invitation.status}`,
      code: "illegal_transition",
    };
  }

  const envelope = await loadEnvelope(tenantId, invitation.envelope_id);
  if (!envelope?.id) {
    return { ok: false, error: "Envelope not found", code: "envelope_missing" };
  }
  if (ENVELOPE_TERMINAL.has(envelope.status)) {
    return {
      ok: false,
      error: `Envelope is ${envelope.status}; cannot resend`,
      code: "envelope_terminal",
    };
  }

  const priorGenNum = Number(invitation.current_generation) || 0;
  const prior = priorGenNum
    ? await getGenerationByNumber(tenantId, invitationId, priorGenNum)
    : null;

  const expires = resolveGenerationExpiresAt({
    envelopeExpiresAt: envelope.expires_at,
    requestedExpiresAt: options.expires_at,
  });
  if (!expires.ok) return expires;

  // Revoke prior generation + token first (ensures at most one active pair)
  if (prior && prior.status === "active") {
    try {
      await supabaseRequest(
        `${GENERATIONS_TABLE}?tenant_id=eq.${encodeURIComponent(tenantId)}&id=eq.${encodeURIComponent(prior.id)}`,
        {
          method: "PATCH",
          body: { status: "revoked", revoked_at: utcNowIso() },
          headers: { Prefer: "return=representation" },
        }
      );
    } catch (err) {
      return { ok: false, error: err.message || String(err), code: "prior_generation_revoke_failed" };
    }
    const revokedTok = await revokeSigningToken({
      tenantId,
      tokenId: prior.token_id,
    });
    if (!revokedTok.ok && revokedTok.code !== "not_found") {
      // Continue — generation already revoked; token revoke best-effort
    }
  }

  const nextNum = priorGenNum + 1 || 1;
  const tokenCreated = await createSigningToken({
    tenantId,
    signerId: invitation.signer_id,
    expiresAt: expires.expires_at,
  });
  if (!tokenCreated.ok) {
    return {
      ok: false,
      error: tokenCreated.error || "token create failed",
      code: tokenCreated.code || "token_create_failed",
      prior_generation_revoked: Boolean(prior),
    };
  }

  const newTokenId = tokenCreated.token.id;
  let generation;
  try {
    const inserted = await supabaseRequest(GENERATIONS_TABLE, {
      method: "POST",
      body: {
        tenant_id: tenantId,
        invitation_id: invitationId,
        generation_number: nextNum,
        token_id: newTokenId,
        status: "active",
        expires_at: expires.expires_at,
        reason: options.reason || "owner_resend",
      },
      headers: { Prefer: "return=representation" },
    });
    generation = Array.isArray(inserted) ? inserted[0] : inserted;
  } catch (err) {
    await revokeSigningToken({ tenantId, tokenId: newTokenId });
    return {
      ok: false,
      error: err.message || String(err),
      code: "generation_create_failed",
      prior_generation_revoked: Boolean(prior),
    };
  }

  // Move invitation to queued for new delivery cycle
  const queued = await transitionInvitation(tenantId, invitationId, "queued", {
    causation_id: options.causation_id,
    idempotency_key:
      options.queue_idempotency_key ||
      `invitation:resend-queue:${invitationId}:${generation.id}`,
    payload: {
      generation_number: nextNum,
      prior_generation_number: priorGenNum || null,
    },
  });
  if (!queued.ok) {
    // Best-effort: revoke new generation so we don't leave orphan active
    try {
      await supabaseRequest(
        `${GENERATIONS_TABLE}?tenant_id=eq.${encodeURIComponent(tenantId)}&id=eq.${encodeURIComponent(generation.id)}`,
        { method: "PATCH", body: { status: "revoked", revoked_at: utcNowIso() } }
      );
      await revokeSigningToken({ tenantId, tokenId: newTokenId });
    } catch (_e) {
      /* ignore */
    }
    return queued;
  }

  invitation = {
    ...queued.invitation,
    current_generation: nextNum,
  };
  await supabaseRequest(
    `${INVITATIONS_TABLE}?tenant_id=eq.${encodeURIComponent(tenantId)}&id=eq.${encodeURIComponent(invitationId)}`,
    {
      method: "PATCH",
      body: { current_generation: nextNum, updated_at: utcNowIso() },
    }
  );

  const attempt = await createDeliveryAttempt(invitation, {
    generation_id: generation.id,
    provider: options.provider || "none",
    retry_number: nextNum - 1,
  });

  const resent = await emitInvitationEvent({
    invitation,
    eventType: "contract.invitation.resent",
    activityKey: "resent",
    causationId: options.causation_id || null,
    idempotencyKey:
      options.idempotency_key ||
      `invitation:resent:${invitationId}:gen:${nextNum}`,
    notify: true,
    notifyPriority: "normal",
    extraPayload: {
      generation_number: nextNum,
      prior_generation_number: priorGenNum || null,
      generation_id: generation.id,
      prior_generation_id: prior?.id || null,
      reason: options.reason || "owner_resend",
    },
  });

  return {
    ok: true,
    invitation,
    generation,
    prior_generation: prior,
    attempt: attempt.ok ? attempt.attempt : null,
    event: resent.event || null,
    // Raw token once — never in event payload
    raw_token_once: tokenCreated.token.token || null,
    api_version: API_VERSION,
  };
}

async function recordInvitationOpen(tenantId, invitationId, openInfo = {}, options = {}) {
  const loaded = await getInvitation(tenantId, invitationId);
  if (!loaded.ok) return loaded;
  const invitation = loaded.invitation;

  if (["expired", "revoked", "cancelled"].includes(invitation.status)) {
    return {
      ok: false,
      error: `Cannot open invitation in status ${invitation.status}`,
      code: "illegal_transition",
    };
  }
  if (invitation.status === "signed") {
    return { ok: true, invitation, unchanged: true, code: "already_signed" };
  }

  const nowIso = utcNowIso();
  const firstOpen = !invitation.opened_at;
  const patch = {
    open_count: Number(invitation.open_count || 0) + 1,
    last_opened_at: nowIso,
    updated_at: nowIso,
  };
  if (firstOpen) {
    patch.opened_at = nowIso;
    if (openInfo.opened_ip != null) patch.opened_ip = String(openInfo.opened_ip).slice(0, 64);
    if (openInfo.opened_user_agent != null) {
      patch.opened_user_agent = String(openInfo.opened_user_agent).slice(0, 512);
    }
  }

  const shouldTransition = canTransition(invitation.status, "opened");
  if (shouldTransition) {
    patch.status = "opened";
    if (!firstOpen) delete patch.opened_at;
  }

  const rows = await supabaseRequest(
    `${INVITATIONS_TABLE}?tenant_id=eq.${encodeURIComponent(tenantId)}&id=eq.${encodeURIComponent(invitationId)}`,
    { method: "PATCH", body: patch, headers: { Prefer: "return=representation" } }
  );
  const updated = Array.isArray(rows) ? rows[0] : rows;

  let emitted = { ok: true, skipped: true };
  if (shouldTransition && firstOpen) {
    emitted = await emitInvitationEvent({
      invitation: updated,
      eventType: "contract.invitation.opened",
      activityKey: "opened",
      causationId: options.causation_id || null,
      idempotencyKey:
        options.idempotency_key || `invitation:opened:${updated.tenant_id}:${updated.id}`,
      notify: true,
      notifyPriority: "silent",
      extraPayload: { generation_number: updated.current_generation || null },
    });
  }

  return {
    ok: true,
    invitation: updated,
    first_open: firstOpen,
    event: emitted.event || null,
    api_version: API_VERSION,
  };
}

async function markInvitationSending(tenantId, invitationId, options = {}) {
  return transitionInvitation(tenantId, invitationId, "sending", options);
}
async function markInvitationSent(tenantId, invitationId, options = {}) {
  return transitionInvitation(tenantId, invitationId, "sent", options);
}
async function markInvitationDelivered(tenantId, invitationId, options = {}) {
  return transitionInvitation(tenantId, invitationId, "delivered", options);
}
async function markInvitationFailed(tenantId, invitationId, options = {}) {
  return transitionInvitation(tenantId, invitationId, "failed", options);
}
async function markInvitationBounced(tenantId, invitationId, options = {}) {
  return transitionInvitation(tenantId, invitationId, "bounced", options);
}
async function markInvitationSigned(tenantId, invitationId, options = {}) {
  return transitionInvitation(tenantId, invitationId, "signed", options);
}
async function expireInvitation(tenantId, invitationId, options = {}) {
  return transitionInvitation(tenantId, invitationId, "expired", options);
}
async function revokeInvitation(tenantId, invitationId, options = {}) {
  return transitionInvitation(tenantId, invitationId, "revoked", options);
}
async function cancelInvitation(tenantId, invitationId, options = {}) {
  return transitionInvitation(tenantId, invitationId, "cancelled", options);
}

/**
 * Validate that a raw token belongs to the invitation's active generation.
 * Used by QA / future portal — does not store raw token.
 */
async function validateActiveGenerationToken(tenantId, invitationId, rawToken) {
  const active = await getActiveGeneration(tenantId, invitationId);
  if (!active) {
    return { ok: false, error: "No active generation", code: "no_active_generation" };
  }
  const looked = await lookupSigningToken({ rawToken });
  if (!looked.ok) return looked;
  if (looked.token.id !== active.token_id) {
    return { ok: false, error: "Token is not the active generation token", code: "token_generation_mismatch" };
  }
  if (looked.token.tenant_id && looked.token.tenant_id !== tenantId) {
    return { ok: false, error: "Token tenant mismatch", code: "tenant_mismatch" };
  }
  return { ok: true, generation: active, token: looked.token };
}

module.exports = {
  API_VERSION,
  INVITATIONS_TABLE,
  GENERATIONS_TABLE,
  ATTEMPTS_TABLE,
  INVITATION_STATUSES,
  GENERATION_REASONS,
  GENERATION_STATUSES,
  TERMINAL_INVITATION,
  ENVELOPE_TERMINAL,
  ALLOWED_TRANSITIONS,
  ATTEMPT_ALLOWED,
  CHANNELS,
  canTransition,
  assertTransition,
  canTransitionAttempt,
  assertAttemptTransition,
  resolveGenerationExpiresAt,
  maskEmail,
  prepareInvitation,
  createInitialGeneration,
  getInvitation,
  getActiveGeneration,
  getGenerationByNumber,
  transitionInvitation,
  queueInvitation,
  createDeliveryAttempt,
  transitionDeliveryAttempt,
  resendInvitation,
  recordInvitationOpen,
  markInvitationSending,
  markInvitationSent,
  markInvitationDelivered,
  markInvitationFailed,
  markInvitationBounced,
  markInvitationSigned,
  expireInvitation,
  revokeInvitation,
  cancelInvitation,
  validateActiveGenerationToken,
};
