/**
 * CH-011G — Electronic signature capture (token-gated).
 * Typed + drawn. ESIGN consent required. No certificate generation or outbound mail.
 */

"use strict";

const { supabaseRequest } = require("./supabase-admin");
const {
  hashRawToken,
  loadTokenByHash,
  evaluateTokenValidity,
  trimField,
  validUuid,
  unknownKeys,
} = require("./contract-signing-token");

const API_VERSION = "ch-011g-v1";

const SIGNATURE_METHODS = new Set(["typed", "drawn"]);
const MAX_TYPED_NAME = 200;
const MAX_DRAWN_CHARS = 100000;

function sanitizeTypedName(value) {
  let s = String(value ?? "")
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]*>/g, "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/[<>&"'`]/g, "")
    .trim();
  if (s.length > MAX_TYPED_NAME) s = s.slice(0, MAX_TYPED_NAME);
  return s;
}

function clientIpFromEvent(event) {
  const h = event?.headers || {};
  const xff = String(h["x-forwarded-for"] || h["X-Forwarded-For"] || "").trim();
  if (xff) return xff.split(",")[0].trim().slice(0, 128);
  const real = String(h["x-real-ip"] || h["X-Real-Ip"] || "").trim();
  if (real) return real.slice(0, 128);
  return null;
}

function userAgentFromEvent(event) {
  const h = event?.headers || {};
  const ua = String(h["user-agent"] || h["User-Agent"] || "").trim();
  return ua ? ua.slice(0, 1000) : null;
}

function validateSignaturePayload(method, payload) {
  if (payload == null || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      ok: false,
      code: "empty_signature_payload",
      error: "signature_payload is required",
    };
  }

  if (method === "typed") {
    const typedName = sanitizeTypedName(
      payload.typed_name ?? payload.full_name ?? payload.name
    );
    if (!typedName) {
      return {
        ok: false,
        code: "empty_signature_payload",
        error: "Typed signature name is required",
      };
    }
    const rendered = sanitizeTypedName(payload.rendered_name || typedName);
    const signedAt = new Date().toISOString();
    return {
      ok: true,
      signature_json: {
        method: "typed",
        typed_name: typedName,
        rendered_name: rendered,
        signed_at: signedAt,
      },
    };
  }

  if (method === "drawn") {
    const svgPath = trimField(payload.svg_path || payload.path);
    const paths = payload.paths;
    const vectors = payload.vectors;
    let signature_json = null;

    if (svgPath) {
      if (svgPath.length > MAX_DRAWN_CHARS) {
        return {
          ok: false,
          code: "empty_signature_payload",
          error: "Drawn signature is too large",
        };
      }
      if (/<img|base64|data:image/i.test(svgPath)) {
        return {
          ok: false,
          code: "unsupported_signature_method",
          error: "Raster images are not allowed",
        };
      }
      signature_json = {
        method: "drawn",
        format: "svg_path",
        svg_path: svgPath,
        signed_at: new Date().toISOString(),
      };
    } else if (Array.isArray(paths) && paths.length) {
      const raw = JSON.stringify(paths);
      if (raw.length > MAX_DRAWN_CHARS) {
        return {
          ok: false,
          code: "empty_signature_payload",
          error: "Drawn signature is too large",
        };
      }
      signature_json = {
        method: "drawn",
        format: "vector_paths",
        paths,
        signed_at: new Date().toISOString(),
      };
    } else if (vectors && typeof vectors === "object") {
      const raw = JSON.stringify(vectors);
      if (raw.length > MAX_DRAWN_CHARS) {
        return {
          ok: false,
          code: "empty_signature_payload",
          error: "Drawn signature is too large",
        };
      }
      signature_json = {
        method: "drawn",
        format: "vector_json",
        vectors,
        signed_at: new Date().toISOString(),
      };
    } else {
      return {
        ok: false,
        code: "empty_signature_payload",
        error: "Drawn signature paths are required",
      };
    }

    return { ok: true, signature_json };
  }

  return {
    ok: false,
    code: "unsupported_signature_method",
    error: "Unsupported signature method",
  };
}

async function loadSignerFull(tenantId, signerId) {
  const rows = await supabaseRequest(
    `tenant_contract_signers?tenant_id=eq.${encodeURIComponent(tenantId)}` +
      `&id=eq.${encodeURIComponent(signerId)}` +
      `&select=*` +
      `&limit=1`,
    { method: "GET" }
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function loadEnvelopeFull(tenantId, envelopeId) {
  const rows = await supabaseRequest(
    `tenant_contract_envelopes?tenant_id=eq.${encodeURIComponent(tenantId)}` +
      `&id=eq.${encodeURIComponent(envelopeId)}` +
      `&select=*` +
      `&limit=1`,
    { method: "GET" }
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function loadPackageLite(tenantId, packageId) {
  const rows = await supabaseRequest(
    `tenant_contract_packages?tenant_id=eq.${encodeURIComponent(tenantId)}` +
      `&id=eq.${encodeURIComponent(packageId)}` +
      `&select=id,version,status,executed_at,updated_at` +
      `&limit=1`,
    { method: "GET" }
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function listSignersRaw(tenantId, envelopeId) {
  const rows = await supabaseRequest(
    `tenant_contract_signers?tenant_id=eq.${encodeURIComponent(tenantId)}` +
      `&envelope_id=eq.${encodeURIComponent(envelopeId)}` +
      `&select=id,role,party_name,email,sign_order,status,is_required,signed_at,updated_at` +
      `&order=sign_order.asc,created_at.asc,id.asc`,
    { method: "GET" }
  );
  return Array.isArray(rows) ? rows : [];
}

function nextPendingRequired(signers, excludeSignerId) {
  return (signers || []).find((s) => {
    if (String(s.id) === String(excludeSignerId)) return false;
    if (s.is_required === false) return false;
    return trimField(s.status).toLowerCase() !== "signed";
  });
}

function allRequiredSigned(signers) {
  const required = (signers || []).filter((s) => s.is_required !== false);
  if (!required.length) return false;
  return required.every((s) => trimField(s.status).toLowerCase() === "signed");
}

/**
 * Capture electronic signature using raw signing token as sole auth.
 */
async function captureContractSignature({
  rawToken,
  signatureMethod,
  signaturePayload,
  consentEsign,
  expectedUpdatedAt,
  ipAddress = null,
  userAgent = null,
}) {
  const tokenValue = trimField(rawToken);
  if (!tokenValue) {
    return {
      ok: false,
      status: 400,
      code: "invalid_token",
      error: "signing_token is required",
    };
  }

  if (consentEsign !== true) {
    return {
      ok: false,
      status: 422,
      code: "consent_required",
      error: "ESIGN consent is required",
    };
  }

  const method = trimField(signatureMethod).toLowerCase();
  if (!SIGNATURE_METHODS.has(method)) {
    return {
      ok: false,
      status: 422,
      code: "unsupported_signature_method",
      error: "signature_method must be typed or drawn",
    };
  }

  const expected = trimField(expectedUpdatedAt);
  if (!expected) {
    return {
      ok: false,
      status: 400,
      code: "invalid_expected_updated_at",
      error: "expected_updated_at is required",
    };
  }

  const payloadCheck = validateSignaturePayload(method, signaturePayload);
  if (!payloadCheck.ok) {
    return {
      ok: false,
      status: 422,
      code: payloadCheck.code,
      error: payloadCheck.error,
    };
  }

  const tokenRow = await loadTokenByHash(hashRawToken(tokenValue));
  if (!tokenRow?.id) {
    return {
      ok: false,
      status: 404,
      code: "invalid_token",
      error: "This signing link is invalid or unavailable",
    };
  }

  const tenantId = tokenRow.tenant_id;
  const tokenStatus = trimField(tokenRow.status).toLowerCase();

  // Idempotent replay: consumed token must not mutate anything.
  if (tokenStatus === "consumed") {
    const priorSigner = await loadSignerFull(tenantId, tokenRow.signer_id);
    return {
      ok: false,
      status: 409,
      code: "signature_already_recorded",
      error: "Signature already recorded for this signing link",
      signer_status: trimField(priorSigner?.status) || "signed",
      signed_at: priorSigner?.signed_at || tokenRow.consumed_at || null,
    };
  }

  const validity = evaluateTokenValidity(tokenRow);
  if (!validity.ok) {
    const code =
      validity.code === "revoked" || validity.code === "expired"
        ? validity.code
        : "invalid_token";
    return {
      ok: false,
      status: 409,
      code,
      error: validity.error || "Token not valid for signing",
    };
  }

  const signer = await loadSignerFull(tenantId, tokenRow.signer_id);
  if (!signer?.id) {
    return {
      ok: false,
      status: 404,
      code: "invalid_token",
      error: "This signing link is invalid or unavailable",
    };
  }

  if (trimField(signer.status).toLowerCase() === "signed") {
    return {
      ok: false,
      status: 409,
      code: "signature_already_recorded",
      error: "Signature already recorded for this signing link",
      signer_status: "signed",
      signed_at: signer.signed_at || null,
    };
  }

  const envelope = await loadEnvelopeFull(tenantId, tokenRow.envelope_id);
  if (!envelope?.id) {
    return {
      ok: false,
      status: 404,
      code: "invalid_token",
      error: "This signing link is invalid or unavailable",
    };
  }

  const envStatus = trimField(envelope.status).toLowerCase();
  if (envStatus === "completed") {
    return {
      ok: false,
      status: 409,
      code: "envelope_completed",
      error: "This contract has already been completed",
    };
  }
  if (envStatus === "declined") {
    return {
      ok: false,
      status: 409,
      code: "envelope_declined",
      error: "This contract was declined",
    };
  }
  if (envStatus === "cancelled") {
    return {
      ok: false,
      status: 409,
      code: "envelope_cancelled",
      error: "This contract was cancelled",
    };
  }
  if (envStatus === "expired") {
    return {
      ok: false,
      status: 409,
      code: "envelope_expired",
      error: "This contract envelope has expired",
    };
  }
  if (envStatus !== "sent" && envStatus !== "opened") {
    return {
      ok: false,
      status: 409,
      code: "envelope_not_signable",
      error: "This contract is not available for signing",
    };
  }

  if (String(envelope.updated_at) !== expected) {
    return {
      ok: false,
      status: 409,
      code: "stale_updated_at",
      error: "Envelope was modified; refresh and retry",
      current_updated_at: envelope.updated_at || null,
    };
  }

  const packageId = envelope.package_id || signer.package_id;
  const pkg = await loadPackageLite(tenantId, packageId);
  if (!pkg?.id) {
    return {
      ok: false,
      status: 404,
      code: "invalid_token",
      error: "This signing link is invalid or unavailable",
    };
  }

  const pkgStatus = trimField(pkg.status).toLowerCase();
  if (pkgStatus === "void" || pkgStatus === "superseded") {
    return {
      ok: false,
      status: 409,
      code: pkgStatus === "void" ? "package_void" : "package_superseded",
      error: "This contract package is not available for signing",
    };
  }
  if (pkgStatus === "executed") {
    return {
      ok: false,
      status: 409,
      code: "package_executed",
      error: "This contract package is already executed",
    };
  }

  const nowIso = new Date().toISOString();

  // Append-only audit row first (unique per signer blocks replay).
  let eventRow = null;
  try {
    const inserted = await supabaseRequest(`tenant_contract_signature_events`, {
      method: "POST",
      body: {
        tenant_id: tenantId,
        envelope_id: envelope.id,
        signer_id: signer.id,
        package_id: pkg.id,
        token_id: tokenRow.id,
        signature_method: method,
        signature_json: payloadCheck.signature_json,
        signed_at: nowIso,
        ip_address: ipAddress,
        user_agent: userAgent,
        signer_role: trimField(signer.role),
        signer_party_name: trimField(signer.party_name),
        package_version: Number(pkg.version) || 1,
        envelope_status_at_sign: envStatus,
        consent_esign: true,
      },
    });
    eventRow = Array.isArray(inserted) ? inserted[0] : inserted;
  } catch (err) {
    const text = String(err?.message || err?.supabaseRaw || "");
    if (/duplicate|unique|23505/i.test(text)) {
      return {
        ok: false,
        status: 409,
        code: "signature_already_recorded",
        error: "Signature already recorded for this signing link",
        signer_status: "signed",
        signed_at: signer.signed_at || null,
      };
    }
    throw err;
  }

  if (!eventRow?.id) {
    return {
      ok: false,
      status: 500,
      code: "audit_insert_failed",
      error: "Could not record signature",
    };
  }

  // Mark signer signed
  const signerPatch = await supabaseRequest(
    `tenant_contract_signers?tenant_id=eq.${encodeURIComponent(tenantId)}` +
      `&id=eq.${encodeURIComponent(signer.id)}`,
    {
      method: "PATCH",
      body: {
        status: "signed",
        signed_at: nowIso,
      },
    }
  );
  const signerUpdated = Array.isArray(signerPatch) ? signerPatch[0] : signerPatch;
  if (!signerUpdated?.id) {
    return {
      ok: false,
      status: 500,
      code: "signer_update_failed",
      error: "Could not update signer status",
    };
  }

  // Consume token
  await supabaseRequest(
    `tenant_contract_signing_tokens?tenant_id=eq.${encodeURIComponent(tenantId)}` +
      `&id=eq.${encodeURIComponent(tokenRow.id)}`,
    {
      method: "PATCH",
      body: {
        status: "consumed",
        consumed_at: nowIso,
      },
    }
  );

  // Refresh signers for progression
  const signers = await listSignersRaw(tenantId, envelope.id);
  // Ensure current signer reflected as signed in list
  for (const s of signers) {
    if (String(s.id) === String(signer.id)) {
      s.status = "signed";
      s.signed_at = nowIso;
    }
  }

  const next = nextPendingRequired(signers, signer.id);
  let envelopeOut = envelope;
  let packageOut = pkg;
  let progression = "next_signer_pending";

  if (!next && allRequiredSigned(signers)) {
    const envPatch = await supabaseRequest(
      `tenant_contract_envelopes?tenant_id=eq.${encodeURIComponent(tenantId)}` +
        `&id=eq.${encodeURIComponent(envelope.id)}` +
        `&updated_at=eq.${encodeURIComponent(expected)}`,
      {
        method: "PATCH",
        body: {
          status: "completed",
          completed_at: nowIso,
        },
      }
    );
    const envUpdated = Array.isArray(envPatch) ? envPatch[0] : envPatch;
    if (!envUpdated?.id) {
      // Race: reload
      envelopeOut = (await loadEnvelopeFull(tenantId, envelope.id)) || envelope;
    } else {
      envelopeOut = envUpdated;
    }

    const pkgPatch = await supabaseRequest(
      `tenant_contract_packages?tenant_id=eq.${encodeURIComponent(tenantId)}` +
        `&id=eq.${encodeURIComponent(pkg.id)}`,
      {
        method: "PATCH",
        body: {
          status: "executed",
          executed_at: nowIso,
        },
      }
    );
    const pkgUpdated = Array.isArray(pkgPatch) ? pkgPatch[0] : pkgPatch;
    packageOut = pkgUpdated?.id ? pkgUpdated : pkg;
    progression = "completed";
  } else if (next) {
    // Touch envelope updated_at so concurrency advances without status change
    const touch = await supabaseRequest(
      `tenant_contract_envelopes?tenant_id=eq.${encodeURIComponent(tenantId)}` +
        `&id=eq.${encodeURIComponent(envelope.id)}` +
        `&updated_at=eq.${encodeURIComponent(expected)}`,
      {
        method: "PATCH",
        body: {
          status: envStatus === "sent" ? "opened" : envStatus,
        },
      }
    );
    const touched = Array.isArray(touch) ? touch[0] : touch;
    if (touched?.id) envelopeOut = touched;
    progression = "next_signer_pending";
  }

  return {
    ok: true,
    progression,
    signature_event_id: eventRow.id,
    signer: {
      id: signerUpdated.id,
      role: trimField(signerUpdated.role),
      party_name: trimField(signerUpdated.party_name),
      status: trimField(signerUpdated.status),
      signed_at: signerUpdated.signed_at || nowIso,
      sign_order: Number(signerUpdated.sign_order) || 1,
    },
    token: {
      id: tokenRow.id,
      status: "consumed",
      consumed_at: nowIso,
    },
    envelope: {
      id: envelopeOut.id,
      status: trimField(envelopeOut.status),
      completed_at: envelopeOut.completed_at || null,
      updated_at: envelopeOut.updated_at || null,
    },
    package: {
      id: packageOut.id,
      version: packageOut.version,
      status: trimField(packageOut.status),
      executed_at: packageOut.executed_at || null,
    },
    next_signer: next
      ? {
          role: trimField(next.role),
          party_name: trimField(next.party_name),
          sign_order: Number(next.sign_order) || 1,
        }
      : null,
  };
}

module.exports = {
  API_VERSION,
  SIGNATURE_METHODS,
  validUuid,
  unknownKeys,
  trimField,
  sanitizeTypedName,
  validateSignaturePayload,
  captureContractSignature,
  clientIpFromEvent,
  userAgentFromEvent,
  nextPendingRequired,
  allRequiredSigned,
};
