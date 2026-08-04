/**
 * CH-013A.2.0 — Copy Link delivery channel (first-class).
 * No provider. No network. Never stores raw token.
 *
 * Raw token arrives only as ephemeral oneShotSecret on the deliver call —
 * never as a field on persistent DeliveryContext.
 */

"use strict";

const { buildSigningLink } = require("../signing-link-builder");
const { renderTemplate } = require("../template-renderer");

const CHANNEL = "copy_link";
const API_VERSION = "ch-013a20-v1";
const NOT_IMPLEMENTED = "NOT_IMPLEMENTED";
const AVAILABLE = true;

function channel() {
  return CHANNEL;
}

function provider() {
  return "none";
}

function isAvailable() {
  return AVAILABLE;
}

function health() {
  return { ok: true, channel: CHANNEL, provider: "none", available: true };
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
  return { ok: false, error: NOT_IMPLEMENTED, code: "not_implemented" };
}

function parseWebhook() {
  return { ok: false, error: NOT_IMPLEMENTED, code: "not_implemented", events: [] };
}

function readOneShotSecret(ctx, ephemeral) {
  const fromEphemeral =
    trim(ephemeral?.oneShotSecret) ||
    trim(ephemeral?.one_shot_secret) ||
    trim(ephemeral?.raw_token_once);
  // Persistent context must not carry secrets; ignore if present.
  return fromEphemeral;
}

/**
 * Validate copy-link delivery context (persistent fields only).
 */
async function prepare(ctx = {}, ephemeral = {}) {
  if (trim(ctx.channel) && trim(ctx.channel) !== CHANNEL) {
    return { ok: false, error: "Channel mismatch", code: "channel_mismatch" };
  }
  const secret = readOneShotSecret(ctx, ephemeral);
  if (!secret) {
    return {
      ok: false,
      error: "link_unavailable: Copy Link requires a one-shot raw token",
      code: "link_unavailable",
    };
  }
  return { ok: true, prepared: true, api_version: API_VERSION };
}

/**
 * Deliver = build signing URL once via SigningLinkBuilder.
 * Does not persist token. Does not call any network provider.
 * COPY_LINK is not an email/provider transport.
 *
 * @param {object} ctx — persistent DeliveryContext (no raw token)
 * @param {{ oneShotSecret?: string, public_origin?: string }} [ephemeral]
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

  const rendered = renderTemplate({
    channel: CHANNEL,
    template_id: "copy_link.default",
    branding: ctx.branding || {},
    signing_link: built.signing_link,
    recipient: {
      masked_email: ctx.masked_recipient || ctx.masked_email || "",
      party_name: ctx.recipient?.party_name || "",
    },
    project: ctx.project || {},
    metadata: ctx.metadata || {},
  });
  if (!rendered.ok) return rendered;

  return {
    ok: true,
    api_version: API_VERSION,
    channel: CHANNEL,
    provider: "none",
    accepted: true,
    // One-shot reveal for Owner Copy Link — caller must not persist.
    signing_url: built.signing_link.url,
    signing_link: built.signing_link,
    render_payload: rendered.payload,
    tracking: supportsTracking(),
    ui_copy: "Secure Link Ready",
  };
}

function trim(v) {
  return v == null ? "" : String(v).trim();
}

module.exports = {
  CHANNEL,
  API_VERSION,
  available: AVAILABLE,
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
