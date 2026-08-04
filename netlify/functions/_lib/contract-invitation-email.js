/**
 * CH-013A.2.1 — Contract invitation email queue + controlled dispatch.
 *
 * Token / generation design (PREFERRED):
 * - generation.token_id is immutable after insert (SQL protect).
 * - If Gen N raw secret is unavailable (typical after CH-013B Copy Link),
 *   explicit Email activation creates Generation N+1 via resendInvitation
 *   (DB reason=security_rotation; event activation_reason=email_delivery_activation).
 * - Never PATCH generation.token_id. Never mint onto an existing generation.
 * - Duplicate Email while attempt is queued/sending/sent is idempotent (no Gen N+2).
 *
 * Secret handoff (Design B):
 * - AES-256-GCM ciphertext purpose-bound to attempt_id on invitation.metadata.email_handoff.
 * - Background body carries only IDs (+ optional public_origin / correlation_id).
 * - Never put raw token in background body, events, attempts, logs, or UI.
 * - Netlify retries failed background invocations (body replayed) — plaintext body is unsafe.
 *
 * Delivery truth: queue HTTP 200 => Email queued only.
 * Sent only after Resend accepted + provider_message_id.
 */

"use strict";

const { supabaseRequest } = require("./supabase-admin");
const {
  prepareInvitation,
  createInitialGeneration,
  getActiveGeneration,
  createDeliveryAttempt,
  transitionDeliveryAttempt,
  transitionInvitation,
  markInvitationSending,
  markInvitationSent,
  markInvitationFailed,
  resendInvitation,
  maskEmail,
  ATTEMPTS_TABLE,
  TERMINAL_INVITATION,
  ENVELOPE_TERMINAL,
} = require("./contract-invitation");
const {
  buildDeliveryContext,
  maskEmail: engineMaskEmail,
} = require("./delivery-channel-engine");
const emailChannel = require("./channels/email");
const resendProvider = require("./providers/resend-provider");
const { publishDomainEvent, beginCorrelation } = require("./platform-bus");
const {
  scrubForbiddenKeys,
  EVENT_VERSION,
  trimField,
  validUuid,
  utcNowIso,
} = require("./platform-events");
const { projectActivityFromEvent } = require("./platform-activity");
const { createNotification } = require("./platform-notifications");
const {
  handoffAvailable,
  sealDeliverySecret,
  persistHandoff,
  openHandoffWithoutConsume,
  peekHandoff,
  clearHandoff,
  markHandoffConsumed,
  persistProviderAcceptance,
  markAcceptanceFinalized,
  readAcceptance,
  scrubSecretsDeep,
  HANDOFF_TTL_MS,
} = require("./email-delivery-handoff");

const API_VERSION = "ch-013a21-v1";
const PROVIDER = "resend";
const CHANNEL = "email";
const ACTIVATION_REASON = "email_delivery_activation";
const GENERATION_REASON_DB = "security_rotation";

const ACTIVE_ATTEMPT_STATUSES = new Set(["queued", "sending", "sent"]);
const STUCK_ATTEMPT_MS = 10 * 60 * 1000;

function normalizeEmail(email) {
  return trimField(email).toLowerCase();
}

function emailCapability(recipientEmail) {
  const health = resendProvider.health();
  const email = normalizeEmail(recipientEmail);
  const valid = email ? resendProvider.isValidEmail(email) : false;
  const allowed = valid ? resendProvider.isRecipientAllowlisted(email) : false;
  let unavailable_reason = "";
  if (!health.available) unavailable_reason = health.reason || "unavailable";
  else if (email && !valid) unavailable_reason = "invalid_recipient";
  else if (email && !allowed) unavailable_reason = "internal_recipient_only";
  return {
    enabled: health.available,
    provider: PROVIDER,
    internal_testing: true,
    recipient_allowed: allowed,
    unavailable_reason,
  };
}

async function loadEnvelope(tenantId, envelopeId) {
  const rows = await supabaseRequest(
    `tenant_contract_envelopes?tenant_id=eq.${encodeURIComponent(tenantId)}&id=eq.${encodeURIComponent(envelopeId)}&select=id,tenant_id,status,expires_at,package_id,project_id,quote_id,updated_at&limit=1`,
    { method: "GET" }
  );
  return Array.isArray(rows) ? rows[0] : rows;
}

async function loadSigner(tenantId, signerId) {
  const rows = await supabaseRequest(
    `tenant_contract_signers?tenant_id=eq.${encodeURIComponent(tenantId)}&id=eq.${encodeURIComponent(signerId)}&select=id,tenant_id,envelope_id,email,party_name,auth_method,sign_order&limit=1`,
    { method: "GET" }
  );
  return Array.isArray(rows) ? rows[0] : rows;
}

async function loadProject(tenantId, projectId) {
  if (!projectId) return null;
  const rows = await supabaseRequest(
    `tenant_projects?tenant_id=eq.${encodeURIComponent(tenantId)}&id=eq.${encodeURIComponent(projectId)}&select=id,project_name&limit=1`,
    { method: "GET" }
  );
  return Array.isArray(rows) ? rows[0] : rows;
}

async function loadAttempt(tenantId, attemptId) {
  const rows = await supabaseRequest(
    `${ATTEMPTS_TABLE}?tenant_id=eq.${encodeURIComponent(tenantId)}&attempt_id=eq.${encodeURIComponent(attemptId)}&select=*&limit=1`,
    { method: "GET" }
  );
  return Array.isArray(rows) ? rows[0] : rows;
}

async function loadInvitationById(tenantId, invitationId) {
  const rows = await supabaseRequest(
    `tenant_contract_invitations?tenant_id=eq.${encodeURIComponent(tenantId)}&id=eq.${encodeURIComponent(invitationId)}&select=*&limit=1`,
    { method: "GET" }
  );
  return Array.isArray(rows) ? rows[0] : rows;
}

async function findInvitation(tenantId, envelopeId, signerId) {
  const rows = await supabaseRequest(
    `tenant_contract_invitations?tenant_id=eq.${encodeURIComponent(tenantId)}&envelope_id=eq.${encodeURIComponent(envelopeId)}&signer_id=eq.${encodeURIComponent(signerId)}&select=*&limit=1`,
    { method: "GET" }
  );
  return Array.isArray(rows) ? rows[0] || null : rows || null;
}

async function findActiveEmailAttempt(tenantId, invitationId, generationId) {
  let path =
    `${ATTEMPTS_TABLE}?tenant_id=eq.${encodeURIComponent(tenantId)}` +
    `&invitation_id=eq.${encodeURIComponent(invitationId)}` +
    `&provider=eq.${encodeURIComponent(PROVIDER)}` +
    `&status=in.(queued,sending,sent)` +
    `&select=*&order=started_at.desc&limit=5`;
  if (generationId) {
    path =
      `${ATTEMPTS_TABLE}?tenant_id=eq.${encodeURIComponent(tenantId)}&invitation_id=eq.${encodeURIComponent(invitationId)}` +
      `&generation_id=eq.${encodeURIComponent(generationId)}` +
      `&provider=eq.${encodeURIComponent(PROVIDER)}` +
      `&status=in.(queued,sending,sent)` +
      `&select=*&order=started_at.desc&limit=5`;
  }
  const rows = await supabaseRequest(path, { method: "GET" });
  const list = Array.isArray(rows) ? rows : rows ? [rows] : [];
  return list.find((a) => ACTIVE_ATTEMPT_STATUSES.has(a.status)) || null;
}

function uiStatusFromAttempt(attempt, handoff, acceptance) {
  if (!attempt) return { ui_status: "ready", stuck: false };
  const st = trimField(attempt.status);
  if (st === "sent") return { ui_status: "sent", stuck: false };
  if (st === "failed" || st === "cancelled" || st === "bounced") {
    return { ui_status: "failed", stuck: false };
  }
  // Provider accepted; DB sent transition pending — never claim failed.
  if (
    st === "sending" &&
    (attempt.provider_message_id || acceptance?.provider_message_id) &&
    !acceptance?.finalized
  ) {
    return { ui_status: "accepted_db_pending", stuck: true };
  }
  if (st === "sending") {
    const started = attempt.started_at ? new Date(attempt.started_at).getTime() : 0;
    const stuck =
      Number.isFinite(started) &&
      Date.now() - started > STUCK_ATTEMPT_MS &&
      !attempt.provider_message_id;
    return { ui_status: "sending", stuck };
  }
  if (st === "queued") {
    const started = attempt.started_at ? new Date(attempt.started_at).getTime() : 0;
    const stuck =
      Number.isFinite(started) &&
      Date.now() - started > STUCK_ATTEMPT_MS &&
      !(handoff && handoff.present);
    return { ui_status: "queued", stuck };
  }
  return { ui_status: st || "ready", stuck: false };
}

async function emitTransportEvent({
  type,
  tenantId,
  invitation,
  generation,
  attempt,
  signer,
  envelope,
  providerMessageId,
  correlationId,
  idempotencyKey,
  notify,
  notifyPriority,
  activityTitle,
  activitySummary,
  extraPayload,
}) {
  const recipientMasked = maskEmail(signer?.email);
  const payloadScrub = scrubForbiddenKeys(
    {
      attempt_id: attempt?.attempt_id || attempt?.id || null,
      invitation_id: invitation?.id || null,
      generation_id: generation?.id || null,
      generation_number:
        generation?.generation_number ?? invitation?.current_generation ?? null,
      channel: CHANNEL,
      provider: PROVIDER,
      signer_id: invitation?.signer_id || signer?.id || null,
      envelope_id: invitation?.envelope_id || envelope?.id || null,
      project_id: invitation?.project_id || envelope?.project_id || null,
      recipient_masked: recipientMasked,
      ...(providerMessageId ? { provider_message_id: providerMessageId } : {}),
      ...(extraPayload && typeof extraPayload === "object" ? extraPayload : {}),
    },
    "payload"
  );
  if (!payloadScrub.ok) {
    return { ok: false, error: payloadScrub.error, code: "forbidden_payload" };
  }

  let published;
  try {
    published = await publishDomainEvent(
      {
        type,
        event_version: EVENT_VERSION,
        tenant_id: tenantId,
        project_id: invitation?.project_id || envelope?.project_id || null,
        aggregate: "delivery_attempt",
        aggregate_id: attempt?.attempt_id || attempt?.id || null,
        correlation_id: correlationId || beginCorrelation(),
        payload: payloadScrub.value,
        occurred_at: utcNowIso(),
      },
      { idempotency_key: idempotencyKey }
    );
  } catch (err) {
    return { ok: false, error: err.message || String(err), code: "event_publish_failed" };
  }
  if (!published.ok) return published;

  const eventForProjections = published.event;

  if (activityTitle) {
    try {
      await projectActivityFromEvent(eventForProjections, {
        title: activityTitle,
        summary: activitySummary || activityTitle,
      });
    } catch (_e) {
      /* activity best-effort */
    }
  }

  if (notify && activityTitle) {
    try {
      await createNotification({
        tenant_id: tenantId,
        title:
          notifyPriority === "critical"
            ? "Contract email delivery failed"
            : "Signing invitation sent",
        body: activitySummary || activityTitle,
        priority: notifyPriority || "normal",
        event_type: type,
        source_event_id: eventForProjections.event_id || null,
        correlation_id: eventForProjections.correlation_id || null,
        payload: payloadScrub.value,
      });
    } catch (_e) {
      /* notify best-effort */
    }
  }

  return { ok: true, event: eventForProjections, duplicate: Boolean(published.duplicate) };
}

function dispatchRef(ids) {
  return {
    tenant_id: ids.tenant_id,
    attempt_id: ids.attempt_id,
    invitation_id: ids.invitation_id,
    public_origin: ids.public_origin || null,
    correlation_id: ids.correlation_id || null,
  };
}

async function sealAndPersistHandoff({
  tenantId,
  invitation,
  generationId,
  attemptId,
  rawToken,
}) {
  if (!handoffAvailable()) {
    return {
      ok: false,
      code: "handoff_key_missing",
      error: "CONTRACT_EMAIL_HANDOFF_KEY required (exactly 32 decoded bytes)",
    };
  }
  const sealed = sealDeliverySecret({
    tenantId,
    invitationId: invitation.id,
    generationId,
    attemptId,
    rawToken,
  });
  if (!sealed.ok) return sealed;
  const persisted = await persistHandoff(
    tenantId,
    invitation.id,
    sealed.package,
    invitation.metadata
  );
  if (!persisted.ok) return persisted;
  return { ok: true, invitation: persisted.invitation || invitation };
}

async function queueInvitationEmail({
  tenantId,
  envelopeId,
  signerId,
  publicOrigin,
  membershipId,
}) {
  if (!validUuid(tenantId) || !validUuid(envelopeId) || !validUuid(signerId)) {
    return { ok: false, status: 400, error: "Invalid ids", code: "invalid_id" };
  }
  if (!handoffAvailable()) {
    return {
      ok: false,
      status: 422,
      error: "Email handoff key not configured",
      code: "handoff_key_missing",
    };
  }

  const envelope = await loadEnvelope(tenantId, envelopeId);
  if (!envelope?.id) {
    return { ok: false, status: 404, error: "Envelope not found", code: "not_found" };
  }
  if (ENVELOPE_TERMINAL.has(trimField(envelope.status))) {
    return {
      ok: false,
      status: 422,
      error: `Envelope is ${envelope.status}`,
      code: "envelope_terminal",
    };
  }
  if (trimField(envelope.status) === "draft") {
    return {
      ok: false,
      status: 422,
      error: "Envelope is not signing-ready. Send for signature first.",
      code: "envelope_not_ready",
    };
  }

  const signer = await loadSigner(tenantId, signerId);
  if (!signer?.id || trimField(signer.envelope_id) !== trimField(envelopeId)) {
    return {
      ok: false,
      status: 404,
      error: "Signer not found on envelope",
      code: "invalid_signer_relationship",
    };
  }

  const recipient = normalizeEmail(signer.email);
  if (!resendProvider.isValidEmail(recipient)) {
    return {
      ok: false,
      status: 422,
      error: "Signer email is invalid",
      code: "invalid_recipient",
    };
  }

  const capability = emailCapability(recipient);
  if (!capability.enabled) {
    return {
      ok: false,
      status: 422,
      error: `Email delivery unavailable: ${capability.unavailable_reason}`,
      code: "email_delivery_unavailable",
      email_delivery: capability,
    };
  }
  if (!capability.recipient_allowed) {
    return {
      ok: false,
      status: 403,
      error: "Internal email testing only — recipient is not allowlisted",
      code: "internal_recipient_only",
      email_delivery: capability,
    };
  }

  let invitation = await findInvitation(tenantId, envelopeId, signerId);
  let rawTokenOnce = null;
  let generation = null;
  let activationRotated = false;

  if (!invitation) {
    const prep = await prepareInvitation({
      tenant_id: tenantId,
      envelope_id: envelopeId,
      signer_id: signerId,
      package_id: envelope.package_id,
      project_id: envelope.project_id,
      quote_id: envelope.quote_id,
      channel: "email",
      create_initial_generation: true,
    });
    if (!prep.ok) {
      return {
        ok: false,
        status: 422,
        error: prep.error || "Could not prepare invitation",
        code: prep.code || "prepare_failed",
      };
    }
    invitation = prep.invitation;
    rawTokenOnce = prep.raw_token_once || null;
  }

  if (TERMINAL_INVITATION.has(trimField(invitation.status))) {
    return {
      ok: false,
      status: 422,
      error: `Invitation is ${invitation.status}`,
      code: "invitation_terminal",
    };
  }

  generation = await getActiveGeneration(tenantId, invitation.id);
  if (!generation) {
    const gen = await createInitialGeneration(invitation, { reason: "initial_send" });
    if (!gen.ok) {
      return {
        ok: false,
        status: 422,
        error: gen.error || "Could not create generation",
        code: gen.code || "generation_create_failed",
      };
    }
    invitation = gen.invitation || invitation;
    generation = gen.generation;
    rawTokenOnce = gen.raw_token_once || rawTokenOnce;
  }

  const genExpires = generation.expires_at ? new Date(generation.expires_at).getTime() : NaN;
  if (Number.isFinite(genExpires) && genExpires <= Date.now()) {
    return {
      ok: false,
      status: 422,
      error: "Active generation is expired",
      code: "generation_expired",
    };
  }

  // Ordinary duplicate Email while queued/sending/sent: no Gen bump.
  const existing = await findActiveEmailAttempt(tenantId, invitation.id, generation.id);
  if (existing) {
    const correlationId = beginCorrelation();
    return {
      ok: true,
      idempotent: true,
      queued: true,
      ui_status:
        existing.status === "sent"
          ? "sent"
          : existing.status === "sending"
            ? "sending"
            : "queued",
      attempt_id: existing.attempt_id,
      invitation_id: invitation.id,
      generation_id: generation.id,
      generation_number: generation.generation_number,
      recipient_masked: maskEmail(recipient),
      email_delivery: capability,
      api_version: API_VERSION,
      _dispatch: dispatchRef({
        tenant_id: tenantId,
        attempt_id: existing.attempt_id,
        invitation_id: invitation.id,
        public_origin: publicOrigin || null,
        correlation_id: correlationId,
      }),
    };
  }

  let attempt = null;

  if (!rawTokenOnce) {
    // Gen N raw unavailable (CH-013B) — create Gen N+1 atomically; never swap token_id on Gen N.
    const rotated = await resendInvitation(tenantId, invitation.id, {
      reason: GENERATION_REASON_DB,
      provider: PROVIDER,
      causation_id: membershipId || null,
      idempotency_key: `invitation:rotate:${invitation.id}:from:${generation.generation_number}:email_delivery_activation`,
      event_idempotency_key: `invitation:resent:email-activation:${invitation.id}:from:${generation.generation_number}`,
      extraPayload: {
        activation_reason: ACTIVATION_REASON,
      },
    });
    if (!rotated.ok) {
      return {
        ok: false,
        status: rotated.code === "atomic_rotation_rpc_missing" ? 503 : 500,
        error: rotated.error || "email activation generation failed",
        code: rotated.code || "email_activation_failed",
        prior_generation_revoked: false,
      };
    }
    invitation = rotated.invitation;
    generation = rotated.generation;
    rawTokenOnce = rotated.raw_token_once || null;
    attempt = rotated.attempt || null;
    activationRotated = true;

    // Idempotent rotation replay without plaintext: reuse active attempt + existing handoff.
    if (!rawTokenOnce) {
      const existingAfter = await findActiveEmailAttempt(
        tenantId,
        invitation.id,
        generation.id
      );
      if (existingAfter) {
        return {
          ok: true,
          idempotent: true,
          queued: true,
          ui_status:
            existingAfter.status === "sent"
              ? "sent"
              : existingAfter.status === "sending"
                ? "sending"
                : "queued",
          attempt_id: existingAfter.attempt_id,
          invitation_id: invitation.id,
          generation_id: generation.id,
          generation_number: generation.generation_number,
          generation_rotated: true,
          recipient_masked: maskEmail(recipient),
          email_delivery: capability,
          api_version: API_VERSION,
          _dispatch: dispatchRef({
            tenant_id: tenantId,
            attempt_id: existingAfter.attempt_id,
            invitation_id: invitation.id,
            public_origin: publicOrigin || null,
            correlation_id: beginCorrelation(),
          }),
        };
      }
      return {
        ok: false,
        status: 500,
        error: "Idempotent rotation without deliverable secret",
        code: "link_unavailable",
      };
    }
  }

  if (!rawTokenOnce) {
    return {
      ok: false,
      status: 500,
      error: "Raw signing secret unavailable after activation",
      code: "link_unavailable",
    };
  }

  if (!attempt) {
    const attemptRes = await createDeliveryAttempt(invitation, {
      generation_id: generation.id,
      provider: PROVIDER,
      retry_number: 0,
    });
    if (!attemptRes.ok) {
      return {
        ok: false,
        status: 500,
        error: attemptRes.error || "Could not create delivery attempt",
        code: attemptRes.code || "attempt_create_failed",
      };
    }
    attempt = attemptRes.attempt;

    if (trimField(invitation.status) === "prepared") {
      await transitionInvitation(tenantId, invitation.id, "queued", {
        idempotency_key: `invitation:queued:${tenantId}:${invitation.id}:${attempt.attempt_id}`,
      });
    } else if (["failed", "bounced"].includes(trimField(invitation.status))) {
      await transitionInvitation(tenantId, invitation.id, "queued", {
        idempotency_key: `invitation:requeue:${tenantId}:${invitation.id}:${attempt.attempt_id}`,
      });
    }
  }

  const sealed = await sealAndPersistHandoff({
    tenantId,
    invitation,
    generationId: generation.id,
    attemptId: attempt.attempt_id,
    rawToken: rawTokenOnce,
  });
  if (!sealed.ok) {
    await transitionDeliveryAttempt(tenantId, attempt.attempt_id, "failed", {
      error_code: sealed.code || "handoff_persist_failed",
      error_message: sealed.error || "handoff persist failed",
    });
    return {
      ok: false,
      status: 500,
      error: sealed.error || "Could not seal delivery handoff",
      code: sealed.code || "handoff_persist_failed",
    };
  }
  invitation = sealed.invitation || invitation;
  rawTokenOnce = null;

  const correlationId = beginCorrelation();
  await emitTransportEvent({
    type: "delivery.channel.queued",
    tenantId,
    invitation,
    generation,
    attempt,
    signer,
    envelope,
    correlationId,
    idempotencyKey: `delivery:queued:${tenantId}:${attempt.attempt_id}`,
    notify: false,
    activityTitle: null,
    extraPayload: activationRotated
      ? { activation_reason: ACTIVATION_REASON, generation_rotated: true }
      : { generation_rotated: false },
  });

  if (!activationRotated) {
    try {
      const payloadScrub = scrubForbiddenKeys(
        {
          invitation_id: invitation.id,
          attempt_id: attempt.attempt_id,
          generation_id: generation.id,
          generation_number: generation.generation_number,
          channel: CHANNEL,
          provider: PROVIDER,
          signer_id: signer.id,
          envelope_id: envelope.id,
          recipient_masked: maskEmail(recipient),
        },
        "payload"
      );
      if (payloadScrub.ok) {
        await publishDomainEvent(
          {
            type: "contract.invitation.queued",
            event_version: EVENT_VERSION,
            tenant_id: tenantId,
            project_id: invitation.project_id || envelope.project_id || null,
            aggregate: "contract_invitation",
            aggregate_id: invitation.id,
            correlation_id: correlationId,
            payload: payloadScrub.value,
            occurred_at: utcNowIso(),
          },
          {
            idempotency_key: `invitation:queued:${tenantId}:${invitation.id}:${attempt.attempt_id}`,
          }
        );
      }
    } catch (_e) {
      /* best-effort */
    }
  }

  return {
    ok: true,
    idempotent: false,
    queued: true,
    ui_status: "queued",
    attempt_id: attempt.attempt_id,
    invitation_id: invitation.id,
    generation_id: generation.id,
    generation_number: generation.generation_number,
    generation_rotated: activationRotated,
    recipient_masked: maskEmail(recipient),
    email_delivery: capability,
    api_version: API_VERSION,
    _dispatch: dispatchRef({
      tenant_id: tenantId,
      attempt_id: attempt.attempt_id,
      invitation_id: invitation.id,
      public_origin: publicOrigin || null,
      correlation_id: correlationId,
    }),
  };
}

async function getEmailDeliveryStatus({ tenantId, attemptId, envelopeId, signerId }) {
  let attempt = null;
  let invitation = null;

  if (validUuid(attemptId)) {
    attempt = await loadAttempt(tenantId, attemptId);
    if (attempt?.invitation_id) {
      invitation = await loadInvitationById(tenantId, attempt.invitation_id);
    }
  } else if (validUuid(envelopeId) && validUuid(signerId)) {
    invitation = await findInvitation(tenantId, envelopeId, signerId);
    if (invitation) {
      const gen = await getActiveGeneration(tenantId, invitation.id);
      attempt = await findActiveEmailAttempt(tenantId, invitation.id, gen?.id || null);
      if (!attempt) {
        const rows = await supabaseRequest(
          `${ATTEMPTS_TABLE}?tenant_id=eq.${encodeURIComponent(tenantId)}` +
            `&invitation_id=eq.${encodeURIComponent(invitation.id)}` +
            `&provider=eq.${encodeURIComponent(PROVIDER)}` +
            `&select=*&order=started_at.desc&limit=1`,
          { method: "GET" }
        );
        attempt = Array.isArray(rows) ? rows[0] : rows;
      }
    }
  }

  if (!attempt) {
    return {
      ok: true,
      ui_status: "ready",
      attempt_id: null,
      status: null,
      stuck: false,
      recoverable: false,
      provider_message_id: null,
      version: API_VERSION,
    };
  }

  const handoff = invitation
    ? await peekHandoff(tenantId, invitation.id, attempt.attempt_id)
    : { present: false };
  const acceptance = invitation
    ? readAcceptance(invitation.metadata, attempt.attempt_id)
    : null;
  const mapped = uiStatusFromAttempt(attempt, handoff, acceptance);
  const recoverable =
    (["queued", "sending"].includes(attempt.status) &&
      !attempt.provider_message_id &&
      Boolean(handoff && handoff.present)) ||
    mapped.ui_status === "accepted_db_pending";

  return {
    ok: true,
    ui_status: mapped.ui_status,
    attempt_id: attempt.attempt_id,
    invitation_id: attempt.invitation_id,
    generation_id: attempt.generation_id || null,
    status: attempt.status,
    stuck: mapped.stuck,
    recoverable,
    provider_message_id:
      attempt.provider_message_id || acceptance?.provider_message_id || null,
    error_code: attempt.error_code || null,
    version: API_VERSION,
  };
}

/**
 * Manual recover / re-dispatch for stuck queued|sending|accepted_db_pending.
 * Reuses same attempt_id / provider idempotency key. No Gen bump when handoff present.
 * If provider already accepted (ledger or provider_message_id), finalize DB only — no second send.
 */
async function recoverEmailDispatch({ tenantId, attemptId, publicOrigin }) {
  if (!validUuid(tenantId) || !validUuid(attemptId)) {
    return { ok: false, status: 400, error: "Invalid ids", code: "invalid_id" };
  }
  const attempt = await loadAttempt(tenantId, attemptId);
  if (!attempt) {
    return { ok: false, status: 404, error: "Attempt not found", code: "not_found" };
  }
  // Cross-tenant isolation
  if (trimField(attempt.tenant_id) !== trimField(tenantId)) {
    return { ok: false, status: 403, error: "Forbidden", code: "cross_tenant_blocked" };
  }
  if (attempt.status === "sent" && attempt.provider_message_id) {
    return {
      ok: true,
      idempotent: true,
      ui_status: "sent",
      attempt_id: attemptId,
      provider_message_id: attempt.provider_message_id,
    };
  }
  if (["failed", "cancelled", "bounced"].includes(attempt.status)) {
    return {
      ok: false,
      status: 422,
      error: `Cannot recover terminal attempt in status ${attempt.status}`,
      code: "terminal_attempt_replay_blocked",
    };
  }
  if (!["queued", "sending"].includes(attempt.status)) {
    return {
      ok: false,
      status: 422,
      error: `Cannot recover attempt in status ${attempt.status}`,
      code: "not_recoverable",
    };
  }

  const invitation = await loadInvitationById(tenantId, attempt.invitation_id);
  if (!invitation?.id) {
    return { ok: false, status: 404, error: "Invitation not found", code: "not_found" };
  }
  const acceptance = readAcceptance(invitation.metadata, attemptId);
  const providerMessageId =
    attempt.provider_message_id || acceptance?.provider_message_id || null;

  // accepted_db_pending: finalize sent without calling provider again
  if (providerMessageId && attempt.status === "sending") {
    const finalized = await finalizeAcceptedAttempt({
      tenantId,
      invitation,
      attempt,
      providerMessageId,
      correlationId: beginCorrelation(),
    });
    return {
      ok: finalized.ok,
      status: finalized.ok ? 200 : 500,
      recovered: true,
      finalize_only: true,
      ui_status: finalized.ok ? "sent" : "accepted_db_pending",
      attempt_id: attemptId,
      invitation_id: attempt.invitation_id,
      provider_message_id: providerMessageId,
      error: finalized.ok ? null : finalized.error,
      code: finalized.ok ? null : finalized.code,
    };
  }

  const handoff = await peekHandoff(tenantId, attempt.invitation_id, attemptId);
  if (!handoff.ok || !handoff.present) {
    return {
      ok: false,
      status: 422,
      error:
        "Delivery handoff missing or expired — re-activate Email to mint a new generation",
      code: "handoff_unavailable",
      ui_status: "failed",
    };
  }

  return {
    ok: true,
    recovered: true,
    ui_status: attempt.status === "sending" ? "sending" : "queued",
    attempt_id: attemptId,
    invitation_id: attempt.invitation_id,
    _dispatch: dispatchRef({
      tenant_id: tenantId,
      attempt_id: attemptId,
      invitation_id: attempt.invitation_id,
      public_origin: publicOrigin || null,
      correlation_id: beginCorrelation(),
    }),
  };
}

async function finalizeAcceptedAttempt({
  tenantId,
  invitation,
  attempt,
  providerMessageId,
  correlationId,
  signer,
  envelope,
  generation,
}) {
  const attemptId = attempt.attempt_id;
  const invitationId = invitation.id;

  // Persist provider_message_id on attempt while still sending (SQL CH-013A.2.1 amend)
  if (!attempt.provider_message_id) {
    try {
      await supabaseRequest(
        `${ATTEMPTS_TABLE}?tenant_id=eq.${encodeURIComponent(tenantId)}&attempt_id=eq.${encodeURIComponent(attemptId)}`,
        {
          method: "PATCH",
          body: { provider_message_id: String(providerMessageId).slice(0, 200) },
          headers: { Prefer: "return=representation" },
        }
      );
    } catch (_e) {
      // Fall back to metadata ledger only
      await persistProviderAcceptance(
        tenantId,
        invitationId,
        attemptId,
        providerMessageId,
        invitation.metadata
      );
    }
  }

  const sentAttempt = await transitionDeliveryAttempt(tenantId, attemptId, "sent", {
    provider_message_id: providerMessageId,
  });
  if (!sentAttempt.ok) {
    if (sentAttempt.code === "illegal_attempt_transition") {
      const fresh = await loadAttempt(tenantId, attemptId);
      if (fresh?.status === "sent") {
        await markAcceptanceFinalized(tenantId, invitationId, attemptId, invitation.metadata);
        await markHandoffConsumed(tenantId, invitationId, attemptId);
        return { ok: true, idempotent: true, attempt: fresh };
      }
    }
    return {
      ok: false,
      code: "accepted_db_pending",
      error: sentAttempt.error || "DB sent transition pending",
    };
  }

  await markHandoffConsumed(tenantId, invitationId, attemptId);
  await markAcceptanceFinalized(tenantId, invitationId, attemptId, invitation.metadata);

  const sig =
    signer ||
    (await loadSigner(tenantId, invitation.signer_id));
  const env =
    envelope ||
    (await loadEnvelope(tenantId, invitation.envelope_id));
  const gen =
    generation ||
    (await getActiveGeneration(tenantId, invitationId));

  await emitTransportEvent({
    type: "delivery.channel.sent",
    tenantId,
    invitation,
    generation: gen,
    attempt: sentAttempt.attempt || { attempt_id: attemptId },
    signer: sig,
    envelope: env,
    providerMessageId,
    correlationId,
    idempotencyKey: `delivery:sent:${tenantId}:${attemptId}`,
    notify: true,
    notifyPriority: "normal",
    activityTitle: `Signing invitation emailed to ${maskEmail(sig?.email)}`,
    activitySummary: `Signing invitation emailed to ${maskEmail(sig?.email)}`,
  });

  try {
    await markInvitationSent(tenantId, invitationId, {
      idempotency_key: `invitation:sent:${tenantId}:${invitationId}:${attemptId}`,
      payload: {
        channel: CHANNEL,
        provider: PROVIDER,
        attempt_id: attemptId,
      },
    });
  } catch (_e) {
    /* ignore */
  }

  return { ok: true, attempt: sentAttempt.attempt };
}

async function dispatchInvitationEmail(dispatchInput = {}, options = {}) {
  if (
    Object.prototype.hasOwnProperty.call(dispatchInput, "one_shot_secret") ||
    Object.prototype.hasOwnProperty.call(dispatchInput, "oneShotSecret") ||
    Object.prototype.hasOwnProperty.call(dispatchInput, "raw_token") ||
    Object.prototype.hasOwnProperty.call(dispatchInput, "raw_token_once")
  ) {
    return {
      ok: false,
      error: "Raw secrets are forbidden in dispatch body",
      code: "forbidden_field",
    };
  }
  if (Object.prototype.hasOwnProperty.call(dispatchInput, "recipient_email")) {
    return {
      ok: false,
      error: "recipient_email is resolved server-side only",
      code: "recipient_override_forbidden",
    };
  }

  const tenantId = trimField(dispatchInput.tenant_id);
  const attemptId = trimField(dispatchInput.attempt_id);
  const invitationId = trimField(dispatchInput.invitation_id);

  if (!validUuid(tenantId) || !validUuid(attemptId) || !validUuid(invitationId)) {
    return { ok: false, error: "Invalid dispatch ids", code: "invalid_id" };
  }

  const invitation = await loadInvitationById(tenantId, invitationId);
  if (!invitation?.id) {
    return { ok: false, error: "Invitation not found", code: "not_found" };
  }

  let attempt = await loadAttempt(tenantId, attemptId);
  if (!attempt?.attempt_id) {
    return { ok: false, error: "Attempt not found", code: "not_found" };
  }
  if (trimField(attempt.invitation_id) !== invitationId) {
    return { ok: false, error: "Attempt/invitation mismatch", code: "relationship_mismatch" };
  }
  if (trimField(attempt.provider) !== PROVIDER) {
    return { ok: false, error: "Attempt provider mismatch", code: "provider_mismatch" };
  }

  if (attempt.status === "sent" && attempt.provider_message_id) {
    return {
      ok: true,
      accepted: true,
      idempotent: true,
      attempt_id: attemptId,
      provider_message_id: attempt.provider_message_id,
      api_version: API_VERSION,
    };
  }
  if (["failed", "cancelled", "bounced"].includes(attempt.status)) {
    return {
      ok: false,
      idempotent: true,
      code: "attempt_terminal",
      error: `Attempt is ${attempt.status}`,
      attempt_id: attemptId,
      api_version: API_VERSION,
    };
  }

  const signer = await loadSigner(tenantId, invitation.signer_id);
  if (!signer?.id) {
    return { ok: false, error: "Signer not found", code: "invalid_signer_relationship" };
  }
  const recipientEmail = normalizeEmail(signer.email);
  const envelope = await loadEnvelope(tenantId, invitation.envelope_id);
  const generation = await getActiveGeneration(tenantId, invitationId);
  const project = await loadProject(
    tenantId,
    invitation.project_id || envelope?.project_id
  );

  // If provider already accepted, finalize DB only — never send again.
  const priorAcceptance = readAcceptance(invitation.metadata, attemptId);
  const priorMessageId =
    attempt.provider_message_id || priorAcceptance?.provider_message_id || null;
  if (priorMessageId && attempt.status === "sending") {
    const finalized = await finalizeAcceptedAttempt({
      tenantId,
      invitation,
      attempt,
      providerMessageId: priorMessageId,
      correlationId: dispatchInput.correlation_id,
      signer,
      envelope,
      generation,
    });
    if (finalized.ok) {
      return {
        ok: true,
        accepted: true,
        idempotent: Boolean(finalized.idempotent),
        finalize_only: true,
        attempt_id: attemptId,
        provider_message_id: priorMessageId,
        api_version: API_VERSION,
      };
    }
    return {
      ok: false,
      retryable: true,
      code: "accepted_db_pending",
      error: finalized.error || "DB finalization pending",
      attempt_id: attemptId,
      provider_message_id: priorMessageId,
      api_version: API_VERSION,
    };
  }

  const capability = emailCapability(recipientEmail);
  if (!capability.enabled || !capability.recipient_allowed) {
    await transitionDeliveryAttempt(tenantId, attemptId, "failed", {
      error_code: capability.unavailable_reason || "internal_recipient_only",
      error_message: "Recipient not deliverable under internal allowlist policy",
    });
    await clearHandoff(tenantId, invitationId, attemptId);
    return {
      ok: false,
      retryable: false,
      code: capability.unavailable_reason || "internal_recipient_only",
      attempt_id: attemptId,
      api_version: API_VERSION,
    };
  }

  if (attempt.status === "queued") {
    const claimed = await transitionDeliveryAttempt(tenantId, attemptId, "sending");
    if (!claimed.ok) {
      if (claimed.code === "illegal_attempt_transition") {
        attempt = await loadAttempt(tenantId, attemptId);
        if (attempt?.status === "sent" && attempt.provider_message_id) {
          return {
            ok: true,
            accepted: true,
            idempotent: true,
            attempt_id: attemptId,
            provider_message_id: attempt.provider_message_id,
            api_version: API_VERSION,
          };
        }
        if (attempt?.status !== "sending") {
          return {
            ok: true,
            idempotent: true,
            code: "already_claimed_or_terminal",
            api_version: API_VERSION,
          };
        }
      } else {
        return claimed;
      }
    } else {
      attempt = claimed.attempt;
    }

    await emitTransportEvent({
      type: "delivery.channel.sending",
      tenantId,
      invitation,
      generation,
      attempt,
      signer,
      envelope,
      correlationId: dispatchInput.correlation_id,
      idempotencyKey: `delivery:sending:${tenantId}:${attemptId}`,
      notify: false,
    });

    try {
      await markInvitationSending(tenantId, invitationId, {
        idempotency_key: `invitation:sending:${tenantId}:${invitationId}:${attemptId}`,
      });
    } catch (_e) {
      /* ignore */
    }
  }

  const generationIdForHandoff =
    attempt.generation_id || generation?.id || null;
  const opened = await openHandoffWithoutConsume(
    tenantId,
    invitationId,
    generationIdForHandoff,
    attemptId
  );
  if (!opened.ok) {
    if (opened.code === "handoff_expired" || opened.code === "handoff_missing") {
      await transitionDeliveryAttempt(tenantId, attemptId, "failed", {
        error_code: opened.code,
        error_message: opened.error || "handoff unavailable",
      });
      await emitTransportEvent({
        type: "delivery.channel.failed",
        tenantId,
        invitation,
        generation,
        attempt: { attempt_id: attemptId },
        signer,
        envelope,
        correlationId: dispatchInput.correlation_id,
        idempotencyKey: `delivery:failed:${tenantId}:${attemptId}`,
        notify: true,
        notifyPriority: "critical",
        activityTitle: "Signing invitation email failed",
        activitySummary: `Signing invitation email failed for ${maskEmail(recipientEmail)}`,
      });
      try {
        await markInvitationFailed(tenantId, invitationId, {
          error_code: opened.code,
          error_message: opened.error,
          idempotency_key: `invitation:failed:${tenantId}:${invitationId}:${attemptId}`,
        });
      } catch (_e) {
        /* ignore */
      }
    }
    return {
      ok: false,
      retryable: false,
      code: opened.code || "link_unavailable",
      error: opened.error || "handoff unavailable",
      attempt_id: attemptId,
      api_version: API_VERSION,
    };
  }

  const secret = opened.raw_token_once;

  const builtCtx = await buildDeliveryContext({
    channel: CHANNEL,
    tenant_id: tenantId,
    invitation: { id: invitationId, status: "sending" },
    generation: {
      id: generation?.id || attempt.generation_id,
      generation_number: generation?.generation_number,
      expires_at: generation?.expires_at,
    },
    attempt: { attempt_id: attemptId, status: "sending" },
    project: {
      id: project?.id || invitation.project_id,
      project_name: project?.project_name || "",
    },
    recipient: { party_name: signer.party_name },
    masked_recipient: engineMaskEmail(recipientEmail),
    public_origin: dispatchInput.public_origin,
    expires_at: generation?.expires_at,
  });
  if (!builtCtx.ok) {
    await transitionDeliveryAttempt(tenantId, attemptId, "failed", {
      error_code: builtCtx.code || "context_failed",
      error_message: builtCtx.error || "context failed",
    });
    await clearHandoff(tenantId, invitationId, attemptId);
    return builtCtx;
  }

  const ctx = Object.freeze({
    ...builtCtx.context,
    recipient_email: recipientEmail,
  });

  let delivered;
  try {
    delivered = await emailChannel.deliver(ctx, {
      oneShotSecret: secret,
      recipient_email: recipientEmail,
      public_origin: dispatchInput.public_origin,
      idempotency_key: `resend:attempt:${attemptId}`,
      fetchImpl: options.fetchImpl,
    });
  } catch (err) {
    const scrubbed = scrubSecretsDeep({
      message: err?.message || String(err),
      name: err?.name,
    });
    return {
      ok: false,
      retryable: true,
      code: "provider_exception",
      error: String(scrubbed.message || "provider exception").slice(0, 200),
      attempt_id: attemptId,
      api_version: API_VERSION,
    };
  }

  if (!delivered.ok || !delivered.accepted) {
    if (delivered.retryable) {
      // Keep handoff for Netlify retry / manual recover. Same attempt idempotency key.
      return {
        ok: false,
        retryable: true,
        code: delivered.code,
        error: String(delivered.error || "retryable").slice(0, 200),
        attempt_id: attemptId,
        api_version: API_VERSION,
      };
    }

    await transitionDeliveryAttempt(tenantId, attemptId, "failed", {
      error_code: delivered.code || "delivery_failed",
      error_message: delivered.error || "delivery failed",
    });
    await clearHandoff(tenantId, invitationId, attemptId);
    await emitTransportEvent({
      type: "delivery.channel.failed",
      tenantId,
      invitation,
      generation,
      attempt: { attempt_id: attemptId },
      signer,
      envelope,
      correlationId: dispatchInput.correlation_id,
      idempotencyKey: `delivery:failed:${tenantId}:${attemptId}`,
      notify: true,
      notifyPriority: "critical",
      activityTitle: "Signing invitation email failed",
      activitySummary: `Signing invitation email failed for ${maskEmail(recipientEmail)}`,
    });
    try {
      await markInvitationFailed(tenantId, invitationId, {
        error_code: delivered.code,
        error_message: delivered.error,
        idempotency_key: `invitation:failed:${tenantId}:${invitationId}:${attemptId}`,
      });
    } catch (_e) {
      /* ignore */
    }
    return {
      ok: false,
      retryable: false,
      code: delivered.code,
      error: delivered.error,
      attempt_id: attemptId,
      api_version: API_VERSION,
    };
  }

  // Provider accepted — persist acceptance ledger FIRST, then finalize sent (no second send on retry).
  await persistProviderAcceptance(
    tenantId,
    invitationId,
    attemptId,
    delivered.provider_message_id,
    invitation.metadata
  );

  const finalized = await finalizeAcceptedAttempt({
    tenantId,
    invitation,
    attempt: { ...attempt, status: "sending", attempt_id: attemptId },
    providerMessageId: delivered.provider_message_id,
    correlationId: dispatchInput.correlation_id,
    signer,
    envelope,
    generation,
  });
  if (!finalized.ok) {
    return {
      ok: false,
      retryable: true,
      code: "accepted_db_pending",
      error: "Provider accepted; DB sent transition pending reconcile",
      attempt_id: attemptId,
      provider_message_id: delivered.provider_message_id || null,
      api_version: API_VERSION,
    };
  }

  return {
    ok: true,
    accepted: true,
    attempt_id: attemptId,
    provider_message_id: delivered.provider_message_id,
    api_version: API_VERSION,
  };
}

async function invokeBackgroundDispatch(dispatchIds, options = {}) {
  if (
    !dispatchIds ||
    !dispatchIds.attempt_id ||
    !dispatchIds.tenant_id ||
    !dispatchIds.invitation_id
  ) {
    return { ok: false, error: "missing dispatch ids", code: "invalid_id" };
  }
  if (dispatchIds.one_shot_secret || dispatchIds.raw_token_once || dispatchIds.recipient_email) {
    return { ok: false, error: "forbidden dispatch fields", code: "forbidden_field" };
  }

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    return { ok: false, error: "fetch unavailable", code: "fetch_unavailable" };
  }

  const origin =
    trimField(options.site_origin) ||
    trimField(dispatchIds.public_origin) ||
    trimField(process.env.URL) ||
    trimField(process.env.DEPLOY_PRIME_URL) ||
    trimField(process.env.SITE_URL) ||
    "";

  if (!origin) {
    if (options.inline === true) {
      return dispatchInvitationEmail(dispatchIds, options);
    }
    return {
      ok: false,
      error: "site origin unavailable for background dispatch",
      code: "dispatch_origin_missing",
    };
  }

  const url = `${origin.replace(/\/+$/, "")}/.netlify/functions/contract-invitation-email-dispatch-background`;
  const headers = { "Content-Type": "application/json" };
  const internal = trimField(process.env.CONTRACT_EMAIL_DISPATCH_SECRET);
  if (!internal) {
    return {
      ok: false,
      error: "CONTRACT_EMAIL_DISPATCH_SECRET required",
      code: "dispatch_secret_missing",
    };
  }
  headers["X-MG-Dispatch-Key"] = internal;

  const body = {
    tenant_id: dispatchIds.tenant_id,
    attempt_id: dispatchIds.attempt_id,
    invitation_id: dispatchIds.invitation_id,
    public_origin: dispatchIds.public_origin || null,
    correlation_id: dispatchIds.correlation_id || null,
  };

  const res = await fetchImpl(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  return {
    ok: res.ok || res.status === 202,
    status: res.status,
    dispatched: true,
  };
}

module.exports = {
  API_VERSION,
  PROVIDER,
  CHANNEL,
  ACTIVATION_REASON,
  GENERATION_REASON_DB,
  HANDOFF_TTL_MS,
  emailCapability,
  queueInvitationEmail,
  dispatchInvitationEmail,
  invokeBackgroundDispatch,
  getEmailDeliveryStatus,
  recoverEmailDispatch,
  findActiveEmailAttempt,
  normalizeEmail,
  scrubSecretsDeep,
};
