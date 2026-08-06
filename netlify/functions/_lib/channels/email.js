/**
 * CH-013A.2.1Z — Email channel adapter (Zapier webhook via provider abstraction).
 * Does not call Zapier HTTP directly beyond ZapierProvider. Does not build URLs itself.
 * Does not persist raw tokens. Does not log template bodies.
 * Resend is not the active provider for beta.
 */

"use strict";

const { buildSigningLink } = require("../signing-link-builder");
const { renderTemplate } = require("../template-renderer");
const { resolveTenantBranding } = require("../tenant-branding");
const { renderContractInvitationEmail } = require("../templates/email-contract-invitation");
const zapierProvider = require("../providers/zapier-provider");

const CHANNEL = "email";
const API_VERSION = "ch-013a21z-v1";
const PROVIDER = "zapier";

function trim(v) {
  return v == null ? "" : String(v).trim();
}

function channel() {
  return CHANNEL;
}

function provider() {
  return PROVIDER;
}

function isAvailable() {
  return zapierProvider.health().available === true;
}

function health() {
  const h = zapierProvider.health();
  return {
    ok: h.available,
    channel: CHANNEL,
    provider: PROVIDER,
    available: h.available,
    reason: h.reason || "",
  };
}

function supportsTracking() {
  return {
    delivered: false,
    opened: false,
    bounced: false,
    complained: false,
  };
}

function verifyWebhook() {
  return { ok: false, error: "NOT_IMPLEMENTED", code: "not_implemented" };
}

function parseWebhook() {
  return { ok: false, error: "NOT_IMPLEMENTED", code: "not_implemented", events: [] };
}

function readOneShotSecret(_ctx, ephemeral) {
  return (
    trim(ephemeral?.oneShotSecret) ||
    trim(ephemeral?.one_shot_secret) ||
    trim(ephemeral?.raw_token_once)
  );
}

/**
 * Validate email delivery context (persistent fields only).
 */
async function prepare(ctx = {}, ephemeral = {}) {
  if (trim(ctx.channel) && trim(ctx.channel) !== CHANNEL) {
    return { ok: false, error: "Channel mismatch", code: "channel_mismatch" };
  }
  const h = health();
  if (!h.available) {
    return {
      ok: false,
      error: `Email channel unavailable: ${h.reason || "unavailable"}`,
      code: "channel_unavailable",
      reason: h.reason,
    };
  }
  const secret = readOneShotSecret(ctx, ephemeral);
  if (!secret) {
    return {
      ok: false,
      error: "Email delivery requires a one-shot raw token handoff",
      code: "link_unavailable",
    };
  }
  const to = trim(ephemeral?.recipient_email || ephemeral?.to || ctx.recipient_email);
  if (!to) {
    return { ok: false, error: "Recipient email required", code: "missing_recipient" };
  }
  if (!zapierProvider.isValidEmail(to)) {
    return { ok: false, error: "Invalid recipient email", code: "invalid_recipient" };
  }
  return { ok: true, prepared: true, api_version: API_VERSION };
}

/**
 * Deliver via ZapierProvider. Signing URL built only by SigningLinkBuilder.
 *
 * @param {object} ctx — persistent DeliveryContext (no raw token)
 * @param {{
 *   oneShotSecret?: string,
 *   recipient_email?: string,
 *   public_origin?: string,
 *   idempotency_key?: string,
 *   fetchImpl?: Function,
 *   tenant_id?: string,
 *   project_id?: string,
 *   quote_id?: string,
 *   package_id?: string,
 *   envelope_id?: string,
 *   invitation_id?: string,
 *   generation_id?: string,
 *   generation_number?: number,
 *   attempt_id?: string,
 *   correlation_id?: string,
 * }} [ephemeral]
 */
async function deliver(ctx = {}, ephemeral = {}) {
  const prepared = await prepare(ctx, ephemeral);
  if (!prepared.ok) return prepared;

  const secret = readOneShotSecret(ctx, ephemeral);
  const built = buildSigningLink({
    raw_token: secret,
    public_origin: ephemeral.public_origin || ctx.public_origin || null,
    expires_at: ctx.generation?.expires_at || ctx.expires_at || null,
    generation_number: ctx.generation?.generation_number ?? null,
  });
  if (!built.ok) return built;

  const tenantId = ctx.tenant_id || ctx.tenant?.id || ephemeral.tenant_id || null;
  let branding = ctx.branding;
  if (!branding || typeof branding !== "object") {
    const resolved = await resolveTenantBranding(tenantId);
    branding = resolved.branding;
  }

  const normalized = renderTemplate({
    channel: CHANNEL,
    template_id: "email.contract_invitation",
    branding,
    signing_link: built.signing_link,
    recipient: {
      masked_email: ctx.masked_recipient || "",
      party_name: ctx.recipient?.party_name || "",
    },
    project: ctx.project || {},
    metadata: ctx.metadata || {},
  });
  if (!normalized.ok) return normalized;

  const to = trim(ephemeral.recipient_email || ephemeral.to || ctx.recipient_email);
  const replyTo =
    trim(branding.reply_to) ||
    zapierProvider.getReplyToFallback() ||
    "";
  const fromName =
    trim(process.env.CONTRACT_EMAIL_FROM_NAME) ||
    trim(branding.from_name) ||
    trim(branding.business_name) ||
    zapierProvider.getFromNameFallback();

  const rendered = renderContractInvitationEmail({
    branding,
    project_name: ctx.project?.project_name || ctx.project?.name || "",
    signer_name: ctx.recipient?.party_name || "",
    signing_url: built.signing_link.url,
    expires_at: ctx.generation?.expires_at || ctx.expires_at || null,
    reply_to: replyTo,
  });
  if (!rendered.ok) return rendered;

  const sendResult = await zapierProvider.send({
    to,
    recipient_email: to,
    recipient_name: trim(ctx.recipient?.party_name),
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    from_name: fromName,
    reply_to: replyTo,
    idempotency_key: trim(ephemeral.idempotency_key),
    fetchImpl: ephemeral.fetchImpl,
    tenant_id: tenantId,
    project_id:
      trim(ephemeral.project_id) ||
      trim(ctx.project?.project_id) ||
      trim(ctx.project?.id) ||
      null,
    quote_id: trim(ephemeral.quote_id) || trim(ctx.metadata?.quote_id) || null,
    package_id: trim(ephemeral.package_id) || trim(ctx.metadata?.package_id) || null,
    envelope_id: trim(ephemeral.envelope_id) || trim(ctx.metadata?.envelope_id) || null,
    invitation_id:
      trim(ephemeral.invitation_id) || trim(ctx.invitation?.id) || null,
    generation_id:
      trim(ephemeral.generation_id) || trim(ctx.generation?.id) || null,
    generation_number:
      ephemeral.generation_number ?? ctx.generation?.generation_number ?? null,
    attempt_id:
      trim(ephemeral.attempt_id) || trim(ctx.attempt?.attempt_id) || null,
    expires_at: ctx.generation?.expires_at || ctx.expires_at || null,
    correlation_id: trim(ephemeral.correlation_id) || null,
  });

  if (!sendResult.accepted) {
    if (sendResult.awaiting_callback === true) {
      return {
        ok: true,
        api_version: API_VERSION,
        channel: CHANNEL,
        provider: PROVIDER,
        accepted: false,
        awaiting_callback: true,
        retryable: false,
        code: sendResult.error_code || "awaiting_zapier_callback",
        error: sendResult.error_message || "awaiting callback",
        provider_result: sendResult,
        has_signing_url: true,
        render_model: normalized.payload,
        tracking: supportsTracking(),
      };
    }
    return {
      ok: false,
      api_version: API_VERSION,
      channel: CHANNEL,
      provider: PROVIDER,
      accepted: false,
      retryable: sendResult.retryable === true,
      error: sendResult.error_message,
      code: sendResult.error_code,
      provider_result: sendResult,
    };
  }

  return {
    ok: true,
    api_version: API_VERSION,
    channel: CHANNEL,
    provider: PROVIDER,
    accepted: true,
    provider_message_id: sendResult.provider_message_id,
    provider_result: sendResult,
    // Never return signing_url to callers of network deliver — URL was sent in body only.
    has_signing_url: true,
    render_model: normalized.payload,
    tracking: supportsTracking(),
  };
}

module.exports = {
  CHANNEL,
  API_VERSION,
  available: false, // resolved dynamically via isAvailable()
  channel,
  provider,
  isAvailable,
  prepare,
  deliver,
  health,
  supportsTracking,
  verifyWebhook,
  parseWebhook,
};
