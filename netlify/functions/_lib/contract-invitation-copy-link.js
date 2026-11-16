/**
 * Owner Copy Signing Link after refresh.
 * CH-013B Policy A: never reconstruct a raw token from hash.
 * Mint Generation N+1 and reveal signing_url once via the copy-link channel.
 */

"use strict";

const { supabaseRequest } = require("./supabase-admin");
const { trimField, validUuid } = require("./platform-events");
const {
  INVITATIONS_TABLE,
  resendInvitation,
  maskEmail,
  TERMINAL_INVITATION,
  ENVELOPE_TERMINAL,
} = require("./contract-invitation");
const { deliverCopyLink } = require("./delivery-channel-engine");

const API_VERSION = "ch-013-copy-link-v1";
const COPY_REASON = "owner_resend";
const ACTIVATION_REASON = "owner_copy_link_reveal";
const COPYABLE_ENVELOPE = new Set(["sent", "opened"]);

function loadInvitationByEnvelopeSigner(tenantId, envelopeId, signerId) {
  return supabaseRequest(
    `${INVITATIONS_TABLE}?tenant_id=eq.${encodeURIComponent(tenantId)}` +
      `&envelope_id=eq.${encodeURIComponent(envelopeId)}` +
      `&signer_id=eq.${encodeURIComponent(signerId)}` +
      `&select=*&limit=1`,
    { method: "GET" }
  );
}

async function revealOwnerCopyLink({
  tenantId,
  envelopeId,
  signerId,
  membershipId,
  publicOrigin,
}) {
  if (!validUuid(tenantId) || !validUuid(envelopeId) || !validUuid(signerId)) {
    return {
      ok: false,
      status: 400,
      error: "envelope_id and signer_id are required",
      code: "invalid_id",
    };
  }

  const envRows = await supabaseRequest(
    `tenant_contract_envelopes?tenant_id=eq.${encodeURIComponent(tenantId)}` +
      `&id=eq.${encodeURIComponent(envelopeId)}` +
      `&select=id,tenant_id,status,expires_at,package_id,project_id,quote_id&limit=1`,
    { method: "GET" }
  );
  const envelope = Array.isArray(envRows) ? envRows[0] : envRows;
  if (!envelope?.id) {
    return { ok: false, status: 404, error: "Envelope not found", code: "not_found" };
  }
  const envStatus = trimField(envelope.status).toLowerCase();
  if (ENVELOPE_TERMINAL.has(envStatus)) {
    return {
      ok: false,
      status: 409,
      error: "This contract is no longer waiting for a signature.",
      code: "envelope_terminal",
    };
  }
  if (!COPYABLE_ENVELOPE.has(envStatus)) {
    return {
      ok: false,
      status: 409,
      error: "Copy Signing Link is available after the signing request is sent.",
      code: "envelope_not_sent",
    };
  }

  const signerRows = await supabaseRequest(
    `tenant_contract_signers?tenant_id=eq.${encodeURIComponent(tenantId)}` +
      `&id=eq.${encodeURIComponent(signerId)}` +
      `&select=id,tenant_id,envelope_id,email,party_name,role,sign_order&limit=1`,
    { method: "GET" }
  );
  const signer = Array.isArray(signerRows) ? signerRows[0] : signerRows;
  if (!signer?.id || String(signer.envelope_id) !== String(envelopeId)) {
    return { ok: false, status: 404, error: "Signer not found", code: "signer_not_found" };
  }

  const invRows = await loadInvitationByEnvelopeSigner(tenantId, envelopeId, signerId);
  const invitation = Array.isArray(invRows) ? invRows[0] : invRows;
  if (!invitation?.id) {
    return {
      ok: false,
      status: 404,
      error: "Signing invitation not found",
      code: "invitation_not_found",
    };
  }
  if (TERMINAL_INVITATION.has(trimField(invitation.status).toLowerCase())) {
    return {
      ok: false,
      status: 409,
      error: "This signing invitation can no longer issue a link.",
      code: "invitation_terminal",
    };
  }

  const priorGenNum = Number(invitation.current_generation) || 0;
  const rotated = await resendInvitation(tenantId, invitation.id, {
    reason: COPY_REASON,
    provider: "none",
    causation_id: membershipId || null,
    idempotency_key: `invitation:rotate:${invitation.id}:from:${priorGenNum}:owner_copy_link`,
    event_idempotency_key: `invitation:resent:owner-copy-link:${invitation.id}:from:${priorGenNum}`,
    extraPayload: {
      activation_reason: ACTIVATION_REASON,
      channel: "copy_link",
    },
  });
  if (!rotated.ok) {
    return {
      ok: false,
      status: rotated.code === "atomic_rotation_rpc_missing" ? 503 : 409,
      error: rotated.error || "Could not create a new signing link",
      code: rotated.code || "copy_link_failed",
    };
  }

  const rawToken = rotated.raw_token_once || null;
  if (!rawToken) {
    return {
      ok: false,
      status: 409,
      error: "Could not create a new signing link. Try Copy Signing Link again.",
      code: "link_unavailable",
    };
  }

  const copy = await deliverCopyLink(
    {
      tenant_id: tenantId,
      channel: "copy_link",
      invitation: rotated.invitation,
      generation: rotated.generation,
      signer,
      project: { project_id: envelope.project_id },
      expires_at: rotated.generation?.expires_at || envelope.expires_at,
      masked_recipient: maskEmail(signer.email),
      recipient: { party_name: signer.party_name },
    },
    rawToken
  );
  if (!copy.ok || !copy.signing_url) {
    return {
      ok: false,
      status: 500,
      error: copy.error || "Could not build the signing link",
      code: copy.code || "copy_link_deliver_failed",
    };
  }

  return {
    ok: true,
    api_version: API_VERSION,
    signing_url: copy.signing_url,
    previous_link_replaced: true,
    generation_number: rotated.generation?.generation_number ?? null,
    recipient_masked: maskEmail(signer.email),
  };
}

module.exports = {
  API_VERSION,
  COPY_REASON,
  ACTIVATION_REASON,
  revealOwnerCopyLink,
};
