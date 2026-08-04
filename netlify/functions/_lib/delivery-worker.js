/**
 * CH-013A.2.0 — Delivery Worker skeleton.
 * No scheduler. No loops. No provider calls. No automatic registration.
 * TODO(A.2.1): poll queued network-channel attempts and dispatch EmailChannelAdapter.
 *
 * This module is a library only. It must not process production attempts on load.
 */

"use strict";

const engine = require("./delivery-channel-engine");

const API_VERSION = "ch-013a20-v1";

/**
 * Claim a queued attempt for processing.
 * TODO(A.2.1): lease TTL + durable attempt table claim.
 */
async function claim(attemptId) {
  return engine.claimDelivery(attemptId);
}

/**
 * Dispatch a claimed attempt to its channel adapter.
 * Expects attempt already claimed (status=sending) OR still queued (will claim).
 * TODO(A.2.1): resolve adapter, call prepare/deliver for email/sms/whatsapp.
 * Copy Link is handled synchronously via engine.deliverCopyLink today.
 */
async function dispatch(attemptId, ephemeral = {}) {
  let row = await engine.claimDelivery(attemptId);
  if (!row.ok && row.code === "illegal_claim") {
    return {
      ok: false,
      error: row.error,
      code: row.code,
      note: "TODO(A.2.1): support re-entrant dispatch for leased sending attempts",
    };
  }
  if (!row.ok) return row;

  const channel = row.attempt.channel;
  const resolved = engine.resolve(channel, { activeOnly: true });
  if (!resolved.ok) {
    return {
      ok: false,
      error: resolved.error || "NOT_IMPLEMENTED",
      code: resolved.code || "not_implemented",
      note: "TODO(A.2.1): stubs are not active delivery channels",
      channel,
    };
  }

  // TODO(A.2.1): network adapters — EmailChannelAdapter.deliver(ctx)
  if (channel !== "copy_link") {
    return {
      ok: false,
      error: "NOT_IMPLEMENTED",
      code: "not_implemented",
      note: "TODO(A.2.1): dispatch network channels via provider adapters",
      channel,
    };
  }

  const delivered = await resolved.adapter.deliver(row.context, ephemeral);
  if (!delivered.ok) {
    await engine.failDelivery(attemptId, delivered);
    return delivered;
  }
  await engine.completeDelivery(attemptId, {
    accepted: true,
    provider: "none",
    has_signing_url: Boolean(delivered.signing_url),
  });
  return {
    ok: true,
    api_version: API_VERSION,
    attempt_id: attemptId,
    channel,
    result: {
      accepted: true,
      provider: "none",
      has_signing_url: Boolean(delivered.signing_url),
    },
  };
}

/**
 * Mark attempt complete (success path helper).
 * TODO(A.2.1): persist provider_message_id; emit delivery.channel.sent.
 */
async function complete(attemptId, result = {}) {
  return engine.completeDelivery(attemptId, result);
}

module.exports = {
  API_VERSION,
  claim,
  dispatch,
  complete,
};

// Fail closed if executed as a script — no automatic processing.
if (require.main === module) {
  // eslint-disable-next-line no-console
  console.error(
    "delivery-worker is a library skeleton (CH-013A.2.0); it cannot run automatically."
  );
  process.exit(1);
}
