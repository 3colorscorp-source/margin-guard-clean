/**
 * CH-013A.2.1 — Attempt-scoped encrypted delivery handoff.
 *
 * Storage: invitation.metadata.email_handoffs[attempt_id] (map, safe merge).
 * Key: CONTRACT_EMAIL_HANDOFF_KEY only — exactly 32 decoded bytes. No dispatch-secret fallback.
 * AAD: tenant_id|invitation_id|generation_id|attempt_id
 *
 * Never stores plaintext. Never returned to UI/events/activity/notifications.
 */

"use strict";

const crypto = require("crypto");
const { supabaseRequest } = require("./supabase-admin");
const { trimField, utcNowIso, validUuid } = require("./platform-events");

const API_VERSION = "ch-013a21-v1";
const HANDOFF_TTL_MS = 15 * 60 * 1000;
const META_MAP_KEY = "email_handoffs";
const META_LEGACY_KEY = "email_handoff";
const ACCEPT_MAP_KEY = "email_acceptances";
const KEY_VERSION_DEFAULT = 1;

function decodeHandoffKeyMaterial(raw) {
  const s = trimField(raw);
  if (!s) return null;

  // Hex (64 chars → 32 bytes)
  if (/^[a-fA-F0-9]{64}$/.test(s)) {
    const buf = Buffer.from(s, "hex");
    return buf.length === 32 ? buf : null;
  }

  // Base64 / base64url
  try {
    const normalized = s.replace(/-/g, "+").replace(/_/g, "/");
    const pad = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
    const buf = Buffer.from(normalized + pad, "base64");
    if (buf.length === 32) return buf;
  } catch (_e) {
    /* fall through */
  }

  // Raw 32-byte UTF-8 / binary string
  const rawBuf = Buffer.from(s, "utf8");
  if (rawBuf.length === 32) return rawBuf;

  return null;
}

function getHandoffKeyInfo() {
  const raw = trimField(process.env.CONTRACT_EMAIL_HANDOFF_KEY);
  if (!raw) {
    return { ok: false, code: "handoff_key_missing", error: "CONTRACT_EMAIL_HANDOFF_KEY required" };
  }
  const key = decodeHandoffKeyMaterial(raw);
  if (!key) {
    return {
      ok: false,
      code: "handoff_key_invalid",
      error: "CONTRACT_EMAIL_HANDOFF_KEY must decode to exactly 32 bytes (hex or base64)",
    };
  }
  const ver = Number(process.env.CONTRACT_EMAIL_HANDOFF_KEY_VERSION);
  const key_version = Number.isFinite(ver) && ver >= 1 ? Math.floor(ver) : KEY_VERSION_DEFAULT;
  return { ok: true, key, key_version };
}

function handoffAvailable() {
  return getHandoffKeyInfo().ok === true;
}

function buildAad({ tenantId, invitationId, generationId, attemptId }) {
  return Buffer.from(
    [
      trimField(tenantId),
      trimField(invitationId),
      trimField(generationId),
      trimField(attemptId),
    ].join("|"),
    "utf8"
  );
}

function sealDeliverySecret({
  tenantId,
  invitationId,
  generationId,
  attemptId,
  rawToken,
  expiresAtMs,
}) {
  const keyInfo = getHandoffKeyInfo();
  if (!keyInfo.ok) return keyInfo;

  if (
    !validUuid(tenantId) ||
    !validUuid(invitationId) ||
    !validUuid(generationId) ||
    !validUuid(attemptId)
  ) {
    return { ok: false, code: "invalid_handoff_input", error: "ids required" };
  }
  const secret = trimField(rawToken);
  if (!secret) {
    return { ok: false, code: "invalid_handoff_input", error: "secret required" };
  }

  const iv = crypto.randomBytes(12);
  const aad = buildAad({ tenantId, invitationId, generationId, attemptId });
  const cipher = crypto.createCipheriv("aes-256-gcm", keyInfo.key, iv);
  cipher.setAAD(aad);
  const enc = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const exp = expiresAtMs || Date.now() + HANDOFF_TTL_MS;

  return {
    ok: true,
    package: {
      v: 2,
      key_version: keyInfo.key_version,
      tenant_id: tenantId,
      invitation_id: invitationId,
      generation_id: generationId,
      attempt_id: attemptId,
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      ciphertext: enc.toString("base64"),
      expires_at: new Date(exp).toISOString(),
      created_at: utcNowIso(),
      consumed_at: null,
    },
  };
}

function openDeliverySecret(pkg, ids) {
  const keyInfo = getHandoffKeyInfo();
  if (!keyInfo.ok) return keyInfo;
  if (!pkg || typeof pkg !== "object") {
    return { ok: false, code: "handoff_missing", error: "handoff package missing" };
  }

  const tenantId = trimField(ids.tenantId);
  const invitationId = trimField(ids.invitationId);
  const generationId = trimField(ids.generationId);
  const attemptId = trimField(ids.attemptId);

  if (trimField(pkg.attempt_id) !== attemptId) {
    return { ok: false, code: "handoff_attempt_mismatch", error: "handoff not bound to attempt" };
  }
  if (trimField(pkg.tenant_id) !== tenantId) {
    return { ok: false, code: "handoff_tenant_mismatch", error: "handoff tenant mismatch" };
  }
  if (trimField(pkg.invitation_id) !== invitationId) {
    return {
      ok: false,
      code: "handoff_invitation_mismatch",
      error: "handoff invitation mismatch",
    };
  }
  if (trimField(pkg.generation_id) !== generationId) {
    return {
      ok: false,
      code: "handoff_generation_mismatch",
      error: "handoff generation mismatch",
    };
  }
  if (pkg.consumed_at) {
    return { ok: false, code: "handoff_consumed", error: "handoff already consumed" };
  }

  const exp = pkg.expires_at ? new Date(pkg.expires_at).getTime() : NaN;
  if (Number.isFinite(exp) && exp <= Date.now()) {
    return { ok: false, code: "handoff_expired", error: "handoff expired" };
  }

  try {
    const iv = Buffer.from(String(pkg.iv || ""), "base64");
    const tag = Buffer.from(String(pkg.tag || ""), "base64");
    const ciphertext = Buffer.from(String(pkg.ciphertext || ""), "base64");
    const aad = buildAad({ tenantId, invitationId, generationId, attemptId });
    const decipher = crypto.createDecipheriv("aes-256-gcm", keyInfo.key, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    const raw = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    if (!raw) {
      return { ok: false, code: "handoff_empty", error: "empty secret" };
    }
    return { ok: true, raw_token_once: raw, key_version: pkg.key_version || keyInfo.key_version };
  } catch (_e) {
    return { ok: false, code: "handoff_decrypt_failed", error: "handoff decrypt failed" };
  }
}

function cloneMetadata(metadata) {
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? { ...metadata }
    : {};
}

function getHandoffMap(meta) {
  const map = meta[META_MAP_KEY];
  if (map && typeof map === "object" && !Array.isArray(map)) return { ...map };
  return {};
}

function readAttemptHandoff(meta, attemptId) {
  const map = getHandoffMap(meta);
  const keyed = map[attemptId];
  if (keyed && typeof keyed === "object") return keyed;
  // Legacy single-value (migrate-on-read; never overwrite other attempts)
  const legacy = meta[META_LEGACY_KEY];
  if (legacy && typeof legacy === "object" && trimField(legacy.attempt_id) === trimField(attemptId)) {
    return legacy;
  }
  return null;
}

async function loadInvitationMetadata(tenantId, invitationId) {
  const rows = await supabaseRequest(
    `tenant_contract_invitations?tenant_id=eq.${encodeURIComponent(tenantId)}&id=eq.${encodeURIComponent(invitationId)}&select=id,metadata&limit=1`,
    { method: "GET" }
  );
  return Array.isArray(rows) ? rows[0] : rows;
}

/**
 * Safe merge: write handoff under email_handoffs[attempt_id] without clobbering siblings.
 */
async function persistHandoff(tenantId, invitationId, handoffPackage, existingMetadata) {
  const meta = cloneMetadata(existingMetadata);
  const map = getHandoffMap(meta);
  const attemptId = trimField(handoffPackage?.attempt_id);
  if (!attemptId) {
    return { ok: false, code: "invalid_handoff_input", error: "attempt_id required" };
  }
  map[attemptId] = handoffPackage;
  meta[META_MAP_KEY] = map;
  // Drop legacy global single handoff to avoid overwrite races.
  delete meta[META_LEGACY_KEY];
  delete meta.raw_token;
  delete meta.raw_token_once;
  delete meta.one_shot_secret;
  delete meta.signing_url;

  try {
    const rows = await supabaseRequest(
      `tenant_contract_invitations?tenant_id=eq.${encodeURIComponent(tenantId)}&id=eq.${encodeURIComponent(invitationId)}`,
      {
        method: "PATCH",
        body: { metadata: meta, updated_at: utcNowIso() },
        headers: { Prefer: "return=representation" },
      }
    );
    return { ok: true, invitation: Array.isArray(rows) ? rows[0] : rows };
  } catch (err) {
    return { ok: false, error: err.message || String(err), code: "handoff_persist_failed" };
  }
}

async function openHandoffWithoutConsume(tenantId, invitationId, generationId, attemptId) {
  const row = await loadInvitationMetadata(tenantId, invitationId);
  if (!row) return { ok: false, code: "not_found", error: "invitation not found" };
  const meta = cloneMetadata(row.metadata);
  const pkg = readAttemptHandoff(meta, attemptId);
  return openDeliverySecret(pkg, { tenantId, invitationId, generationId, attemptId });
}

async function clearHandoff(tenantId, invitationId, attemptId) {
  const row = await loadInvitationMetadata(tenantId, invitationId);
  if (!row) return { ok: true };
  const meta = cloneMetadata(row.metadata);
  const map = getHandoffMap(meta);
  if (attemptId && map[attemptId]) {
    delete map[attemptId];
  } else if (!attemptId) {
    for (const k of Object.keys(map)) delete map[k];
  }
  meta[META_MAP_KEY] = map;
  delete meta[META_LEGACY_KEY];
  try {
    await supabaseRequest(
      `tenant_contract_invitations?tenant_id=eq.${encodeURIComponent(tenantId)}&id=eq.${encodeURIComponent(invitationId)}`,
      {
        method: "PATCH",
        body: { metadata: meta, updated_at: utcNowIso() },
      }
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || String(err), code: "handoff_clear_failed" };
  }
}

async function markHandoffConsumed(tenantId, invitationId, attemptId) {
  const row = await loadInvitationMetadata(tenantId, invitationId);
  if (!row) return { ok: false, code: "not_found" };
  const meta = cloneMetadata(row.metadata);
  const map = getHandoffMap(meta);
  const pkg = map[attemptId] || readAttemptHandoff(meta, attemptId);
  if (!pkg) return { ok: true };
  map[attemptId] = { ...pkg, consumed_at: utcNowIso(), ciphertext: "[consumed]" };
  // Prefer delete after sent/fatal — consumed marker then remove.
  delete map[attemptId];
  meta[META_MAP_KEY] = map;
  delete meta[META_LEGACY_KEY];
  try {
    await supabaseRequest(
      `tenant_contract_invitations?tenant_id=eq.${encodeURIComponent(tenantId)}&id=eq.${encodeURIComponent(invitationId)}`,
      { method: "PATCH", body: { metadata: meta, updated_at: utcNowIso() } }
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || String(err), code: "handoff_consume_failed" };
  }
}

async function peekHandoff(tenantId, invitationId, attemptId) {
  const row = await loadInvitationMetadata(tenantId, invitationId);
  if (!row) return { ok: false, code: "not_found", present: false };
  const meta = cloneMetadata(row.metadata);
  const pkg = readAttemptHandoff(meta, attemptId);
  if (!pkg) return { ok: true, present: false };
  if (trimField(pkg.attempt_id) !== trimField(attemptId)) {
    return { ok: true, present: false, mismatch: true };
  }
  if (pkg.consumed_at) return { ok: true, present: false, consumed: true };
  const exp = pkg.expires_at ? new Date(pkg.expires_at).getTime() : NaN;
  const expired = Number.isFinite(exp) && exp <= Date.now();
  return {
    ok: true,
    present: !expired,
    expired,
    expires_at: pkg.expires_at || null,
    generation_id: pkg.generation_id || null,
  };
}

/**
 * Persist provider acceptance before/without requiring sent transition.
 * Used for accepted_db_pending recovery (no second provider send).
 */
async function persistProviderAcceptance(
  tenantId,
  invitationId,
  attemptId,
  providerMessageId,
  existingMetadata
) {
  const meta = cloneMetadata(existingMetadata);
  const map =
    meta[ACCEPT_MAP_KEY] && typeof meta[ACCEPT_MAP_KEY] === "object"
      ? { ...meta[ACCEPT_MAP_KEY] }
      : {};
  const existing = map[attemptId];
  if (existing?.provider_message_id && existing.finalized) {
    return { ok: true, idempotent: true, metadata: meta };
  }
  map[attemptId] = {
    provider_message_id: String(providerMessageId).slice(0, 200),
    accepted_at: utcNowIso(),
    finalized: false,
  };
  meta[ACCEPT_MAP_KEY] = map;
  try {
    const rows = await supabaseRequest(
      `tenant_contract_invitations?tenant_id=eq.${encodeURIComponent(tenantId)}&id=eq.${encodeURIComponent(invitationId)}`,
      {
        method: "PATCH",
        body: { metadata: meta, updated_at: utcNowIso() },
        headers: { Prefer: "return=representation" },
      }
    );
    return { ok: true, invitation: Array.isArray(rows) ? rows[0] : rows, metadata: meta };
  } catch (err) {
    return { ok: false, error: err.message || String(err), code: "acceptance_persist_failed" };
  }
}

async function markAcceptanceFinalized(tenantId, invitationId, attemptId, existingMetadata) {
  const meta = cloneMetadata(existingMetadata);
  const map =
    meta[ACCEPT_MAP_KEY] && typeof meta[ACCEPT_MAP_KEY] === "object"
      ? { ...meta[ACCEPT_MAP_KEY] }
      : {};
  if (!map[attemptId]) return { ok: true };
  map[attemptId] = { ...map[attemptId], finalized: true, finalized_at: utcNowIso() };
  meta[ACCEPT_MAP_KEY] = map;
  try {
    await supabaseRequest(
      `tenant_contract_invitations?tenant_id=eq.${encodeURIComponent(tenantId)}&id=eq.${encodeURIComponent(invitationId)}`,
      { method: "PATCH", body: { metadata: meta, updated_at: utcNowIso() } }
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

function readAcceptance(metadata, attemptId) {
  const meta = cloneMetadata(metadata);
  const map = meta[ACCEPT_MAP_KEY];
  if (!map || typeof map !== "object") return null;
  const row = map[attemptId];
  return row && typeof row === "object" ? row : null;
}

function scrubSecretsDeep(value, depth = 0) {
  if (depth > 8) return "[truncated]";
  if (value == null) return value;
  if (typeof value === "string") {
    if (/raw_token|one_shot|signing_url|Bearer\s+[A-Za-z0-9._-]+/i.test(value)) {
      return "[redacted]";
    }
    if (value.length > 500 && /token=/i.test(value)) return "[redacted]";
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => scrubSecretsDeep(v, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (
        /raw_token|one_shot|signing_url|signing_token|authorization|api_key|ciphertext|handoff|email_handoffs|email_acceptances/i.test(
          k
        )
      ) {
        out[k] = "[redacted]";
      } else {
        out[k] = scrubSecretsDeep(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}

/** Constant-time string compare for dispatch auth. */
function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a || ""), "utf8");
  const right = Buffer.from(String(b || ""), "utf8");
  if (left.length !== right.length) {
    // Consume comparable work without leaking which branch via early crypto throw.
    const digL = crypto.createHash("sha256").update(left).digest();
    const digR = crypto.createHash("sha256").update(right).digest();
    crypto.timingSafeEqual(digL, digR);
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

module.exports = {
  API_VERSION,
  HANDOFF_TTL_MS,
  META_MAP_KEY,
  META_LEGACY_KEY,
  ACCEPT_MAP_KEY,
  handoffAvailable,
  getHandoffKeyInfo,
  decodeHandoffKeyMaterial,
  sealDeliverySecret,
  openDeliverySecret,
  persistHandoff,
  openHandoffWithoutConsume,
  peekHandoff,
  clearHandoff,
  markHandoffConsumed,
  persistProviderAcceptance,
  markAcceptanceFinalized,
  readAcceptance,
  scrubSecretsDeep,
  timingSafeEqualString,
  buildAad,
};
