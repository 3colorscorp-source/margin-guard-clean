/**
 * CH-011E / CH-013B — Envelope send pipeline (provider-agnostic).
 * Pre-send validation, invitation prep + token ensure/reuse, draft → sent, delivery manifest.
 * Does not send email. delivery_status = prepared.
 */

"use strict";

const { supabaseRequest } = require("./supabase-admin");
const {
  serializeEnvelope,
  loadPackageForTenant,
  listActiveEnvelopes,
  trimField,
  validUuid,
  unknownKeys,
} = require("./contract-envelope");
const {
  listSignersForEnvelope,
  AUTH_METHODS,
  validEmail,
  normalizeEmail,
} = require("./contract-signer");
const {
  ensureSigningTokenForSigner,
  loadActiveTokenForSigner,
  evaluateTokenValidity,
} = require("./contract-signing-token");
const {
  prepareInvitation,
} = require("./contract-invitation");
const { beginCorrelation } = require("./platform-bus");

const API_VERSION = "ch-011e-v1";

const PUBLIC_SIGNING_URL_SHAPE = "/contract-sign?token={token}";
const DELIVERY_MODES = new Set(["prepared", "email_link"]);

/**
 * CH-013B Policy A — raw signing_token is returned only when newly minted in this response.
 * It is never reconstructed from hash. Idempotent / already-sent responses omit it.
 */

function blocker(code, message, extra = {}) {
  return { code, message, ...extra };
}

async function loadEnvelopeFull(tenantId, envelopeId) {
  const rows = await supabaseRequest(
    `tenant_contract_envelopes?tenant_id=eq.${encodeURIComponent(tenantId)}` +
      `&id=eq.${encodeURIComponent(envelopeId)}` +
      `&select=id,tenant_id,package_id,project_id,quote_id,status,created_by,created_at,updated_at,expires_at,sent_at,sent_by,completed_at,cancelled_at,declined_at,metadata` +
      `&limit=1`,
    { method: "GET" }
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

function parseExpiresAt(value) {
  if (value == null || String(value).trim() === "") return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return { error: true };
  return { iso: d.toISOString(), date: d };
}

function buildDeliveryManifest({
  envelope,
  packageRow,
  signers,
  signerTokenEntries,
  deliveryMode,
}) {
  const ordered = [...signers].sort((a, b) => {
    const ao = Number(a.sign_order) - Number(b.sign_order);
    if (ao !== 0) return ao;
    const ac = String(a.created_at || "").localeCompare(String(b.created_at || ""));
    if (ac !== 0) return ac;
    return String(a.id).localeCompare(String(b.id));
  });

  return {
    envelope_id: envelope.id,
    package_id: envelope.package_id,
    project_id: envelope.project_id,
    quote_id: envelope.quote_id,
    package_version: packageRow?.version ?? null,
    status: trimField(envelope.status),
    sent_at: envelope.sent_at || null,
    expires_at: envelope.expires_at || null,
    delivery_mode: deliveryMode,
    delivery_status: "prepared",
    public_signing_url_shape: PUBLIC_SIGNING_URL_SHAPE,
    signers: ordered.map((s) => {
      const entry = signerTokenEntries.get(s.id) || {};
      const out = {
        signer_id: s.id,
        role: s.role,
        party_name: s.party_name,
        email: s.email,
        sign_order: s.sign_order,
        auth_method: s.auth_method,
        is_required: s.is_required !== false,
        token_id: entry.token_id || null,
        token_reused: !!entry.reused,
        public_signing_url_shape: PUBLIC_SIGNING_URL_SHAPE,
      };
      if (entry.raw_token) {
        out.signing_token = entry.raw_token;
      }
      return out;
    }),
  };
}

/**
 * Collect pre-send blockers. Empty array = ready.
 */
async function validateEnvelopeForSend({
  tenantId,
  envelope,
  packageRow,
  signers,
  expiresAtOverride,
}) {
  const blockers = [];

  if (!envelope?.id) {
    blockers.push(blocker("envelope_missing", "Envelope not found"));
    return blockers;
  }

  const status = trimField(envelope.status).toLowerCase();
  if (status !== "draft" && status !== "sent") {
    blockers.push(
      blocker("envelope_not_draft", "Envelope must be draft to send", {
        envelope_status: status,
      })
    );
  }

  if (!packageRow?.id) {
    blockers.push(blocker("package_missing", "Contract package not found"));
  } else {
    const pkgStatus = trimField(packageRow.status).toLowerCase();
    if (pkgStatus !== "ready") {
      blockers.push(
        blocker("package_not_ready", "Package must be ready", {
          package_status: pkgStatus,
        })
      );
    }
    if (
      String(packageRow.project_id) !== String(envelope.project_id) ||
      String(packageRow.quote_id) !== String(envelope.quote_id)
    ) {
      blockers.push(
        blocker(
          "package_refs_mismatch",
          "Envelope package/project/quote consistency broken"
        )
      );
    }
  }

  if (!Array.isArray(signers) || signers.length === 0) {
    blockers.push(blocker("no_signers", "At least one signer is required"));
  }

  const required = (signers || []).filter((s) => s.is_required !== false);
  const requiredCustomers = required.filter(
    (s) => trimField(s.role).toLowerCase() === "customer"
  );
  if ((signers || []).length > 0 && requiredCustomers.length === 0) {
    blockers.push(
      blocker(
        "no_required_customer",
        "At least one required customer signer is required"
      )
    );
  }

  const emails = new Map();
  for (const s of signers || []) {
    const email = normalizeEmail(s.email);
    if (email) {
      if (emails.has(email)) {
        blockers.push(
          blocker("duplicate_signer_email", "Duplicate signer email", {
            email,
            signer_id: s.id,
          })
        );
      } else {
        emails.set(email, s.id);
      }
    }
  }

  for (const s of required) {
    const name = trimField(s.party_name);
    if (!name) {
      blockers.push(
        blocker("invalid_required_signer", "Required signer missing party_name", {
          signer_id: s.id,
          field: "party_name",
        })
      );
    }
    const method = trimField(s.auth_method).toLowerCase();
    if (!AUTH_METHODS.has(method)) {
      blockers.push(
        blocker("invalid_required_signer", "Unsupported auth_method", {
          signer_id: s.id,
          field: "auth_method",
          auth_method: method,
        })
      );
    }
    if (method === "email_link" && !validEmail(s.email)) {
      blockers.push(
        blocker("invalid_required_signer", "Required signer needs valid email", {
          signer_id: s.id,
          field: "email",
        })
      );
    }
    const order = Number(s.sign_order);
    if (!Number.isSafeInteger(order) || order < 1) {
      blockers.push(
        blocker("invalid_required_signer", "sign_order must be >= 1", {
          signer_id: s.id,
          field: "sign_order",
        })
      );
    }
  }

  // Optional signers that will receive tokens: must also be structurally valid.
  for (const s of signers || []) {
    if (s.is_required !== false) continue;
    const method = trimField(s.auth_method).toLowerCase();
    if (method === "email_link" && trimField(s.email) && !validEmail(s.email)) {
      blockers.push(
        blocker("invalid_optional_signer", "Optional signer email invalid", {
          signer_id: s.id,
          field: "email",
        })
      );
    }
  }

  const expiresCheck = expiresAtOverride
    ? parseExpiresAt(expiresAtOverride)
    : envelope.expires_at
      ? parseExpiresAt(envelope.expires_at)
      : null;
  if (expiresCheck?.error) {
    blockers.push(blocker("invalid_expires_at", "expires_at is invalid"));
  } else if (expiresCheck?.date && expiresCheck.date.getTime() <= Date.now()) {
    blockers.push(
      blocker("envelope_expired", "Envelope expires_at is in the past")
    );
  }

  const active = await listActiveEnvelopes(tenantId, envelope.package_id);
  const conflict = active.find((e) => e.id !== envelope.id);
  if (conflict) {
    blockers.push(
      blocker(
        "active_envelope_conflict",
        "Another active envelope exists for this package",
        {
          conflicting_envelope_id: conflict.id,
          conflicting_status: conflict.status,
        }
      )
    );
  }

  return blockers;
}

function signersNeedingTokens(signers) {
  // Required always; optional when present with usable email_link/in_app identity.
  return (signers || []).filter((s) => {
    if (s.is_required !== false) return true;
    const method = trimField(s.auth_method).toLowerCase();
    if (method === "email_link") return validEmail(s.email);
    if (method === "in_app") return Boolean(trimField(s.party_name));
    return false;
  });
}

async function buildIdempotentDelivery({
  tenantId,
  envelope,
  packageRow,
  signers,
  deliveryMode,
}) {
  const entries = new Map();
  for (const s of signersNeedingTokens(signers)) {
    const active = await loadActiveTokenForSigner(tenantId, s.id);
    if (active?.id && evaluateTokenValidity(active).ok) {
      entries.set(s.id, {
        token_id: active.id,
        reused: true,
        raw_token: null,
      });
    } else {
      entries.set(s.id, {
        token_id: null,
        reused: false,
        raw_token: null,
      });
    }
  }
  return buildDeliveryManifest({
    envelope,
    packageRow,
    signers,
    signerTokenEntries: entries,
    deliveryMode,
  });
}

/**
 * Prepare invitations (email_link) or ensure tokens (other auth methods).
 * Ordinary retries are idempotent: same invitation, generation 1, active token.
 */
async function prepareSignersForSend({
  tenantId,
  envelope,
  signers,
  expiresIso,
  deliveryMode,
}) {
  const tokenTargets = signersNeedingTokens(signers);
  const signerTokenEntries = new Map();
  const invitations = [];
  const correlationId = beginCorrelation();
  const channel = deliveryMode === "email_link" ? "email" : "copy_link";

  for (const s of tokenTargets) {
    const method = trimField(s.auth_method).toLowerCase();

    if (method === "email_link") {
      const prep = await prepareInvitation({
        tenant_id: tenantId,
        envelope_id: envelope.id,
        signer_id: s.id,
        package_id: envelope.package_id,
        project_id: envelope.project_id,
        quote_id: envelope.quote_id,
        channel,
        correlation_id: correlationId,
        expires_at: expiresIso,
        create_initial_generation: true,
        idempotency_key: `invitation:prepared:${tenantId}:${envelope.id}:${s.id}`,
      });
      if (!prep.ok) {
        return {
          ok: false,
          status: prep.status || 500,
          error: prep.error || "Invitation prepare failed",
          code: prep.code || "invitation_prepare_failed",
          signer_id: s.id,
        };
      }

      const tokenId = prep.generation?.token_id || null;
      invitations.push({
        invitation_id: prep.invitation?.id || null,
        generation_id: prep.generation?.id || null,
        generation_number: prep.generation?.generation_number ?? null,
        signer_id: s.id,
        duplicate: !!prep.duplicate,
      });
      signerTokenEntries.set(s.id, {
        token_id: tokenId,
        reused: !!prep.duplicate || !prep.raw_token_once,
        raw_token: prep.raw_token_once || null,
        invitation_id: prep.invitation?.id || null,
        generation_id: prep.generation?.id || null,
      });
      continue;
    }

    const ensured = await ensureSigningTokenForSigner({
      tenantId,
      signerId: s.id,
      expiresAt: expiresIso,
    });
    if (!ensured.ok) {
      return {
        ok: false,
        status: ensured.status || 500,
        error: ensured.error || "Token ensure failed",
        code: ensured.code || "token_ensure_failed",
        signer_id: s.id,
      };
    }
    signerTokenEntries.set(s.id, {
      token_id: ensured.token?.id || null,
      reused: !!ensured.reused,
      raw_token: ensured.reused ? null : ensured.token?.token || null,
    });
  }

  return { ok: true, signerTokenEntries, invitations, correlation_id: correlationId };
}

/**
 * Envelope must not become signing-ready without an active invitation generation
 * for every email_link signer that needs a token.
 */
function assertInvitationsReadyForSend({ signers, invitations, signerTokenEntries }) {
  const emailLinkTargets = signersNeedingTokens(signers).filter(
    (s) => trimField(s.auth_method).toLowerCase() === "email_link"
  );
  for (const s of emailLinkTargets) {
    const inv = (invitations || []).find((i) => String(i.signer_id) === String(s.id));
    if (!inv?.invitation_id || !inv?.generation_id) {
      return {
        ok: false,
        status: 500,
        error: "Invitation generation incomplete; envelope not activated",
        code: "invitation_incomplete",
        signer_id: s.id,
      };
    }
    if (!(Number(inv.generation_number) >= 1)) {
      return {
        ok: false,
        status: 500,
        error: "Active invitation generation missing",
        code: "invitation_generation_missing",
        signer_id: s.id,
      };
    }
    const entry = signerTokenEntries.get(s.id);
    if (!entry?.token_id) {
      return {
        ok: false,
        status: 500,
        error: "Signing token missing for invitation generation",
        code: "invitation_token_missing",
        signer_id: s.id,
      };
    }
  }
  return { ok: true };
}

/**
 * Send (or idempotently re-read) a contract envelope.
 */
async function sendContractEnvelope({
  tenantId,
  envelopeId,
  expectedUpdatedAt,
  expiresAt = null,
  deliveryMode = "prepared",
  sentBy = null,
}) {
  const mode = trimField(deliveryMode || "prepared").toLowerCase() || "prepared";
  if (!DELIVERY_MODES.has(mode)) {
    return {
      ok: false,
      status: 400,
      error: "Unsupported delivery_mode",
      code: "invalid_delivery_mode",
    };
  }

  const expected = trimField(expectedUpdatedAt);
  if (!expected) {
    return {
      ok: false,
      status: 400,
      error: "expected_updated_at is required",
      code: "invalid_expected_updated_at",
    };
  }

  const envelope = await loadEnvelopeFull(tenantId, envelopeId);
  if (!envelope?.id) {
    return {
      ok: false,
      status: 404,
      error: "Envelope not found",
      code: "not_found",
    };
  }

  if (String(envelope.updated_at) !== expected) {
    return {
      ok: false,
      status: 409,
      error: "Envelope was modified; refresh and retry",
      code: "stale_updated_at",
      current_updated_at: envelope.updated_at || null,
    };
  }

  const packageRow = await loadPackageForTenant(tenantId, envelope.package_id);
  const signers = await listSignersForEnvelope(tenantId, envelopeId);
  const status = trimField(envelope.status).toLowerCase();

  // Already sent → idempotent return (no new tokens, no resend claim).
  if (status === "sent") {
    const meta =
      envelope.metadata && typeof envelope.metadata === "object"
        ? envelope.metadata
        : {};
    const priorMode = trimField(meta.send_delivery_mode) || mode;
    const delivery = await buildIdempotentDelivery({
      tenantId,
      envelope,
      packageRow,
      signers,
      deliveryMode: priorMode,
    });
    delivery.link_ready = true;
    delivery.raw_link_available = false;
    delivery.invitations = Array.isArray(meta.send_invitation_ids)
      ? meta.send_invitation_ids.map((id) => ({ invitation_id: id }))
      : [];
    return {
      ok: true,
      idempotent: true,
      envelope: serializeEnvelope(envelope),
      delivery,
    };
  }

  const blockers = await validateEnvelopeForSend({
    tenantId,
    envelope,
    packageRow,
    signers,
    expiresAtOverride: expiresAt,
  });
  const effective =
    status === "draft"
      ? blockers.filter((b) => b.code !== "envelope_not_draft")
      : blockers;

  if (status !== "draft") {
    return {
      ok: false,
      status: 422,
      error: "Envelope cannot be sent",
      code: "send_blocked",
      blockers: effective.length
        ? effective
        : [blocker("envelope_not_draft", "Envelope must be draft to send", {
            envelope_status: status,
          })],
    };
  }

  if (effective.length) {
    return {
      ok: false,
      status: 422,
      error: "Envelope cannot be sent",
      code: "send_blocked",
      blockers: effective,
    };
  }

  let expiresIso = envelope.expires_at || null;
  if (expiresAt != null && String(expiresAt).trim() !== "") {
    const parsed = parseExpiresAt(expiresAt);
    if (parsed.error || !parsed.iso) {
      return {
        ok: false,
        status: 422,
        error: "Envelope cannot be sent",
        code: "send_blocked",
        blockers: [blocker("invalid_expires_at", "expires_at is invalid")],
      };
    }
    expiresIso = parsed.iso;
  }

  const prepared = await prepareSignersForSend({
    tenantId,
    envelope,
    signers,
    expiresIso,
    deliveryMode: mode,
  });
  if (!prepared.ok) {
    return prepared;
  }
  const { signerTokenEntries, invitations } = prepared;

  const readyGate = assertInvitationsReadyForSend({
    signers,
    invitations,
    signerTokenEntries,
  });
  if (!readyGate.ok) {
    return readyGate;
  }

  const nowIso = new Date().toISOString();
  const prevMeta =
    envelope.metadata && typeof envelope.metadata === "object" && !Array.isArray(envelope.metadata)
      ? { ...envelope.metadata }
      : {};
  const nextMeta = {
    ...prevMeta,
    send_delivery_mode: mode,
    send_prepared_at: nowIso,
    send_token_ids: [...signerTokenEntries.values()]
      .map((e) => e.token_id)
      .filter(Boolean),
    send_invitation_ids: invitations.map((i) => i.invitation_id).filter(Boolean),
    link_ready: true,
  };

  const patchRows = await supabaseRequest(
    `tenant_contract_envelopes?tenant_id=eq.${encodeURIComponent(tenantId)}` +
      `&id=eq.${encodeURIComponent(envelopeId)}` +
      `&updated_at=eq.${encodeURIComponent(expected)}`,
    {
      method: "PATCH",
      body: {
        status: "sent",
        sent_at: nowIso,
        sent_by: sentBy || null,
        expires_at: expiresIso,
        metadata: nextMeta,
      },
    }
  );
  const updated = Array.isArray(patchRows) ? patchRows[0] : patchRows;
  if (!updated?.id) {
    // Race: concurrent update
    const fresh = await loadEnvelopeFull(tenantId, envelopeId);
    if (trimField(fresh?.status).toLowerCase() === "sent") {
      const delivery = await buildIdempotentDelivery({
        tenantId,
        envelope: fresh,
        packageRow,
        signers,
        deliveryMode: mode,
      });
      delivery.link_ready = true;
      delivery.raw_link_available = false;
      return {
        ok: true,
        idempotent: true,
        envelope: serializeEnvelope(fresh),
        delivery,
      };
    }
    return {
      ok: false,
      status: 409,
      error: "Envelope was modified; refresh and retry",
      code: "stale_updated_at",
      current_updated_at: fresh?.updated_at || null,
    };
  }

  const delivery = buildDeliveryManifest({
    envelope: updated,
    packageRow,
    signers,
    signerTokenEntries,
    deliveryMode: mode,
  });
  delivery.invitations = invitations;
  delivery.link_ready = true;
  delivery.raw_link_available = [...signerTokenEntries.values()].some((e) => e.raw_token);

  return {
    ok: true,
    idempotent: false,
    envelope: serializeEnvelope(updated),
    delivery,
  };
}

module.exports = {
  API_VERSION,
  PUBLIC_SIGNING_URL_SHAPE,
  DELIVERY_MODES,
  validUuid,
  unknownKeys,
  trimField,
  validateEnvelopeForSend,
  sendContractEnvelope,
  buildDeliveryManifest,
  signersNeedingTokens,
  prepareSignersForSend,
  assertInvitationsReadyForSend,
};
