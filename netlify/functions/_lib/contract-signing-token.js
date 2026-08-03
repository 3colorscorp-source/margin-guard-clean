/**
 * CH-011D — Signing token helpers (create / lookup / revoke).
 * Raw token returned once at create. Only SHA-256 hash stored.
 * No email, PDF, signing UI, or send pipeline.
 */

"use strict";

const crypto = require("crypto");
const { supabaseRequest } = require("./supabase-admin");

const API_VERSION = "ch-011d-v1";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const TOKEN_STATUSES = new Set(["active", "revoked", "consumed", "expired"]);
const DEFAULT_EXPIRES_DAYS = 14;
const RAW_TOKEN_BYTES = 32;

function trimField(value) {
  return String(value ?? "").trim();
}

function validUuid(value) {
  return UUID_RE.test(trimField(value));
}

function unknownKeys(input, allowed) {
  return Object.keys(input || {}).filter((key) => !allowed.has(key));
}

function sha256Hex(text) {
  return crypto.createHash("sha256").update(String(text), "utf8").digest("hex");
}

function generateRawToken() {
  return crypto.randomBytes(RAW_TOKEN_BYTES).toString("base64url");
}

function hashRawToken(rawToken) {
  return sha256Hex(trimField(rawToken));
}

function defaultExpiresAt(from = new Date(), days = DEFAULT_EXPIRES_DAYS) {
  const d = new Date(from.getTime());
  d.setUTCDate(d.getUTCDate() + Number(days));
  return d.toISOString();
}

function serializeToken(row, { includeRaw = false, rawToken = null } = {}) {
  if (!row?.id) return null;
  const out = {
    id: row.id,
    tenant_id: row.tenant_id,
    envelope_id: row.envelope_id,
    signer_id: row.signer_id,
    status: trimField(row.status),
    expires_at: row.expires_at || null,
    consumed_at: row.consumed_at || null,
    revoked_at: row.revoked_at || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
  if (includeRaw && rawToken) {
    out.token = rawToken;
  }
  return out;
}

function evaluateTokenValidity(row, now = new Date()) {
  if (!row?.id) {
    return { ok: false, code: "not_found", error: "Token not found" };
  }
  const status = trimField(row.status).toLowerCase();
  if (status === "revoked") {
    return { ok: false, code: "revoked", error: "Token revoked" };
  }
  if (status === "consumed") {
    return { ok: false, code: "consumed", error: "Token already consumed" };
  }
  if (status === "expired") {
    return { ok: false, code: "expired", error: "Token expired" };
  }
  const expiresAt = row.expires_at ? new Date(row.expires_at) : null;
  if (expiresAt && !Number.isNaN(expiresAt.getTime()) && expiresAt.getTime() <= now.getTime()) {
    return { ok: false, code: "expired", error: "Token expired" };
  }
  if (status !== "active") {
    return { ok: false, code: "invalid_status", error: "Token not active" };
  }
  return { ok: true, code: "valid" };
}

async function loadSignerForTenant(tenantId, signerId) {
  const rows = await supabaseRequest(
    `tenant_contract_signers?tenant_id=eq.${encodeURIComponent(tenantId)}` +
      `&id=eq.${encodeURIComponent(signerId)}` +
      `&select=id,tenant_id,envelope_id,package_id,project_id,role,email,status` +
      `&limit=1`,
    { method: "GET" }
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function loadActiveTokenForSigner(tenantId, signerId) {
  const rows = await supabaseRequest(
    `tenant_contract_signing_tokens?tenant_id=eq.${encodeURIComponent(tenantId)}` +
      `&signer_id=eq.${encodeURIComponent(signerId)}` +
      `&status=eq.active` +
      `&select=*` +
      `&limit=1`,
    { method: "GET" }
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function loadTokenById(tenantId, tokenId) {
  const rows = await supabaseRequest(
    `tenant_contract_signing_tokens?tenant_id=eq.${encodeURIComponent(tenantId)}` +
      `&id=eq.${encodeURIComponent(tokenId)}` +
      `&select=*` +
      `&limit=1`,
    { method: "GET" }
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function loadTokenByHash(tokenHash) {
  const rows = await supabaseRequest(
    `tenant_contract_signing_tokens?token_hash=eq.${encodeURIComponent(tokenHash)}` +
      `&select=*` +
      `&limit=1`,
    { method: "GET" }
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function createSigningToken({
  tenantId,
  signerId,
  expiresInDays = DEFAULT_EXPIRES_DAYS,
  expiresAt = null,
}) {
  const signer = await loadSignerForTenant(tenantId, signerId);
  if (!signer?.id) {
    return {
      ok: false,
      status: 404,
      error: "Signer not found",
      code: "not_found",
    };
  }

  const existing = await loadActiveTokenForSigner(tenantId, signerId);
  if (existing?.id) {
    return {
      ok: false,
      status: 409,
      error: "An active signing token already exists for this signer",
      code: "active_token_exists",
      active_token_id: existing.id,
    };
  }

  let expiresIso = null;
  if (expiresAt != null && String(expiresAt).trim() !== "") {
    const d = new Date(expiresAt);
    if (Number.isNaN(d.getTime()) || d.getTime() <= Date.now()) {
      return {
        ok: false,
        status: 400,
        error: "expires_at must be a future timestamp",
        code: "invalid_expires_at",
      };
    }
    expiresIso = d.toISOString();
  } else {
    const days = Number(expiresInDays);
    if (!Number.isSafeInteger(days) || days < 1 || days > 365) {
      return {
        ok: false,
        status: 400,
        error: "expires_in_days must be an integer from 1 to 365",
        code: "invalid_expires_in_days",
      };
    }
    expiresIso = defaultExpiresAt(new Date(), days);
  }

  const rawToken = generateRawToken();
  const tokenHash = hashRawToken(rawToken);

  let inserted = null;
  try {
    const rows = await supabaseRequest(`tenant_contract_signing_tokens`, {
      method: "POST",
      body: {
        tenant_id: tenantId,
        envelope_id: signer.envelope_id,
        signer_id: signerId,
        token_hash: tokenHash,
        status: "active",
        expires_at: expiresIso,
      },
    });
    inserted = Array.isArray(rows) ? rows[0] : rows;
  } catch (err) {
    const text = String(err?.message || err?.supabaseRaw || "");
    if (/duplicate|unique|23505/i.test(text)) {
      return {
        ok: false,
        status: 409,
        error: "An active signing token already exists for this signer",
        code: "active_token_exists",
      };
    }
    throw err;
  }

  if (!inserted?.id) {
    return {
      ok: false,
      status: 500,
      error: "Could not create signing token",
      code: "insert_failed",
    };
  }

  return {
    ok: true,
    token: serializeToken(inserted, { includeRaw: true, rawToken }),
  };
}

/**
 * Reuse a still-valid active token, or create a new one.
 * Raw token returned only when newly created.
 */
async function ensureSigningTokenForSigner({
  tenantId,
  signerId,
  expiresAt = null,
}) {
  const existing = await loadActiveTokenForSigner(tenantId, signerId);
  if (existing?.id) {
    const validity = evaluateTokenValidity(existing);
    if (validity.ok) {
      return {
        ok: true,
        reused: true,
        token: serializeToken(existing),
      };
    }
    // Clear expired/invalid active row so a replacement can be created.
    await supabaseRequest(
      `tenant_contract_signing_tokens?tenant_id=eq.${encodeURIComponent(tenantId)}` +
        `&id=eq.${encodeURIComponent(existing.id)}`,
      {
        method: "PATCH",
        body: {
          status: "expired",
        },
      }
    );
  }

  const created = await createSigningToken({
    tenantId,
    signerId,
    expiresAt,
  });
  if (!created.ok) return created;
  return {
    ok: true,
    reused: false,
    token: created.token,
  };
}

async function lookupSigningToken({ rawToken }) {
  const token = trimField(rawToken);
  if (!token) {
    return {
      ok: false,
      status: 400,
      error: "token is required",
      code: "invalid_token",
    };
  }

  const row = await loadTokenByHash(hashRawToken(token));
  if (!row?.id) {
    return {
      ok: false,
      status: 404,
      error: "Token not found",
      code: "not_found",
    };
  }

  const validity = evaluateTokenValidity(row);
  if (!validity.ok) {
    return {
      ok: false,
      status: 409,
      error: validity.error,
      code: validity.code,
      token: serializeToken(row),
    };
  }

  return {
    ok: true,
    validity: "valid",
    token: serializeToken(row),
  };
}

async function revokeSigningToken({ tenantId, tokenId }) {
  const existing = await loadTokenById(tenantId, tokenId);
  if (!existing?.id) {
    return {
      ok: false,
      status: 404,
      error: "Token not found",
      code: "not_found",
    };
  }

  const status = trimField(existing.status).toLowerCase();
  if (status === "revoked") {
    return {
      ok: true,
      idempotent: true,
      token: serializeToken(existing),
    };
  }
  if (status === "consumed") {
    return {
      ok: false,
      status: 409,
      error: "Consumed token cannot be revoked",
      code: "consumed",
    };
  }

  const now = new Date().toISOString();
  const rows = await supabaseRequest(
    `tenant_contract_signing_tokens?tenant_id=eq.${encodeURIComponent(tenantId)}` +
      `&id=eq.${encodeURIComponent(tokenId)}`,
    {
      method: "PATCH",
      body: {
        status: "revoked",
        revoked_at: now,
      },
    }
  );
  const updated = Array.isArray(rows) ? rows[0] : rows;
  if (!updated?.id) {
    return {
      ok: false,
      status: 500,
      error: "Could not revoke token",
      code: "update_failed",
    };
  }

  return {
    ok: true,
    idempotent: false,
    token: serializeToken(updated),
  };
}

module.exports = {
  API_VERSION,
  TOKEN_STATUSES,
  DEFAULT_EXPIRES_DAYS,
  validUuid,
  unknownKeys,
  trimField,
  sha256Hex,
  generateRawToken,
  hashRawToken,
  evaluateTokenValidity,
  serializeToken,
  createSigningToken,
  ensureSigningTokenForSigner,
  lookupSigningToken,
  revokeSigningToken,
  loadSignerForTenant,
  loadActiveTokenForSigner,
  loadTokenByHash,
};
