/**
 * CH-013A.2.1 — Email channel adapter (Resend via provider abstraction).
 * Does not call Resend HTTP directly. Does not build URLs itself.
 * Does not persist raw tokens. Does not log template bodies.
 */

"use strict";

const { buildSigningLink } = require("../signing-link-builder");
const { renderTemplate } = require("../template-renderer");
const { resolveTenantBranding } = require("../tenant-branding");
const { renderContractInvitationEmail } = require("../templates/email-contract-invitation");
const resendProvider = require("../providers/resend-provider");

const CHANNEL = "email";
const API_VERSION = "ch-013a21-v1";
const PROVIDER = "resend";

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
  return resendProvider.health().available === true;
}

function health() {
  const h = resendProvider.health();
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
  if (!resendProvider.isValidEmail(to)) {
    return { ok: false, error: "Invalid recipient email", code: "invalid_recipient" };
  }
  if (!resendProvider.isRecipientAllowlisted(to)) {
    return {
      ok: false,
      error: "Recipient is outside the internal allowlist",
      code: "internal_recipient_only",
    };
  }
  return { ok: true, prepared: true, api_version: API_VERSION };
}

/**
 * Deliver via ResendProvider. Signing URL built only by SigningLinkBuilder.
 *
 * @param {object} ctx — persistent DeliveryContext (no raw token)
 * @param {{
 *   oneShotSecret?: string,
 *   recipient_email?: string,
 *   public_origin?: string,
 *   idempotency_key?: string,
 *   fetchImpl?: Function,
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

  const tenantId = ctx.tenant_id || ctx.tenant?.id || null;
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
  const rendered = renderContractInvitationEmail({
    branding,
    project_name: ctx.project?.project_name || ctx.project?.name || "",
    signer_name: ctx.recipient?.party_name || "",
    signing_url: built.signing_link.url,
    expires_at: ctx.generation?.expires_at || ctx.expires_at || null,
    reply_to: branding.reply_to || resendProvider.getReplyToFallback() || "",
  });
  if (!rendered.ok) return rendered;

  const sendResult = await resendProvider.send({
    to,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    from_name: branding.from_name || branding.business_name || "",
    reply_to: branding.reply_to || resendProvider.getReplyToFallback() || "",
    idempotency_key: trim(ephemeral.idempotency_key),
    fetchImpl: ephemeral.fetchImpl,
  });

  if (!sendResult.accepted) {
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
    // Never return signing_url to callers of network deliver — URL was sent to provider only.
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
