/**
 * CH-013A.2.1 — Delivery Worker (controlled dispatch helper).
 * No scheduler. No loops. No automatic registration on load.
 * Email network dispatch is driven by contract-invitation-email-dispatch-background
 * with Design B encrypted handoff (attempt IDs only in background body).
 */

"use strict";

const engine = require("./delivery-channel-engine");
const {
  dispatchInvitationEmail,
} = require("./contract-invitation-email");

const API_VERSION = "ch-013a21-v1";

/**
 * Claim a queued in-memory attempt (copy_link foundation / tests).
 */
async function claim(attemptId) {
  return engine.claimDelivery(attemptId);
}

/**
 * Dispatch a claimed attempt.
 * - copy_link: in-memory engine path (sync)
 * - email: requires durable attempt + encrypted handoff (IDs only)
 */
async function dispatch(attemptId, ephemeral = {}) {
  const channelHint = String(ephemeral.channel || "").toLowerCase();

  if (
    channelHint === "email" ||
    ephemeral.attempt_id ||
    ephemeral.invitation_id
  ) {
    return dispatchInvitationEmail(
      {
        tenant_id: ephemeral.tenant_id,
        attempt_id: ephemeral.attempt_id || attemptId,
        invitation_id: ephemeral.invitation_id,
        public_origin: ephemeral.public_origin,
        correlation_id: ephemeral.correlation_id,
      },
      { fetchImpl: ephemeral.fetchImpl }
    );
  }

  let row = await engine.claimDelivery(attemptId);
  if (!row.ok && row.code === "illegal_claim") {
    return {
      ok: false,
      error: row.error,
      code: row.code,
    };
  }
  if (!row.ok) return row;

  const channel = row.attempt.channel;
  const resolved = engine.resolve(channel, { activeOnly: true });
  if (!resolved.ok) {
    return {
      ok: false,
      error: resolved.error || "channel_unavailable",
      code: resolved.code || "channel_unavailable",
      channel,
    };
  }

  if (channel === "email") {
    return {
      ok: false,
      error: "Email dispatch requires durable attempt + encrypted handoff (Design B)",
      code: "email_handoff_required",
      channel,
    };
  }

  if (channel !== "copy_link") {
    return {
      ok: false,
      error: "NOT_IMPLEMENTED",
      code: "not_implemented",
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

async function complete(attemptId, result = {}) {
  return engine.completeDelivery(attemptId, result);
}

module.exports = {
  API_VERSION,
  claim,
  dispatch,
  complete,
};

if (require.main === module) {
  // eslint-disable-next-line no-console
  console.error(
    "delivery-worker is a library (CH-013A.2.1); it cannot run automatically."
  );
  process.exit(1);
}
