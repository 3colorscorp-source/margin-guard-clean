/**
 * MG-SUPPORT-003D.C1 — invoice resend confirmation tokens.
 * Dedicated type. Does not overload mg_support_escalation_v1.
 * SESSION_SECRET only. No PII/money/public token in payload.
 */
"use strict";

const crypto = require("crypto");

const TOKEN_TYPE = "mg_support_invoice_resend_v1";
const TOKEN_VERSION = 1;
const ACTION_TYPE = "invoice_resend";
const RESEND_TTL_SECONDS = 15 * 60;
const CLOCK_SKEW_SECONDS = 60;
const STATE_DOMAIN = "mg_support_invoice_resend_state_v1";
const ACTOR_DOMAIN = "mg_support_invoice_resend_actor_v1";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX64_RE = /^[a-f0-9]{64}$/;

function isUuid(value) {
  return UUID_RE.test(String(value || "").trim());
}

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function fromBase64url(input) {
  const normalized = String(input || "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalized.length % 4;
  const padded = normalized + (pad ? "=".repeat(4 - pad) : "");
  return Buffer.from(padded, "base64").toString("utf8");
}

function getSessionSecret(deps = {}) {
  if (typeof deps.getSessionSecret === "function") {
    return String(deps.getSessionSecret() || "");
  }
  return String(process.env.SESSION_SECRET || "").trim();
}

function nowUnix(deps = {}) {
  if (typeof deps.nowSeconds === "function") return Number(deps.nowSeconds());
  return Math.floor(Date.now() / 1000);
}

function timingSafeEqualStr(a, b) {
  const left = Buffer.from(String(a || ""), "utf8");
  const right = Buffer.from(String(b || ""), "utf8");
  if (left.length !== right.length) {
    if (left.length > 0) crypto.timingSafeEqual(left, left);
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function normalizePersistedEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function canonicalizeSentAt(value) {
  const text = String(value ?? "").trim();
  if (!text) return "null";
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return text;
  return parsed.toISOString();
}

function hasPublicTokenFlag(invoice) {
  return String(invoice?.public_token || "").trim() ? "1" : "0";
}

function canonicalizeRawStatus(value) {
  return String(value ?? "").trim();
}

function buildStateCanonical(invoice, tenantId) {
  return [
    STATE_DOMAIN,
    String(tenantId || "").trim(),
    String(invoice?.id || "").trim().toLowerCase(),
    normalizePersistedEmail(invoice?.customer_email),
    canonicalizeSentAt(invoice?.sent_at),
    hasPublicTokenFlag(invoice),
    canonicalizeRawStatus(invoice?.status),
  ].join("\n");
}

function computeStateFingerprint(invoice, tenantId, deps = {}) {
  const secret = getSessionSecret(deps);
  if (!secret) return "";
  return crypto.createHmac("sha256", secret).update(buildStateCanonical(invoice, tenantId), "utf8").digest("hex");
}

function canonicalActorPrincipal(session) {
  const userId = String(session?.u || "").trim();
  if (isUuid(userId)) return `u:${userId.toLowerCase()}`;
  const email = normalizePersistedEmail(session?.e);
  const customerId = String(session?.c || "").trim();
  if (email && customerId) return `e:${email}\nc:${customerId}`;
  return "";
}

function computeActorFingerprint(session, deps = {}) {
  const secret = getSessionSecret(deps);
  const principal = canonicalActorPrincipal(session);
  if (!secret || !principal) return "";
  return crypto
    .createHmac("sha256", secret)
    .update(`${ACTOR_DOMAIN}\n${principal}`, "utf8")
    .digest("hex");
}

function signEncodedPayload(encodedPayload, secret) {
  return crypto.createHmac("sha256", secret).update(encodedPayload).digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function mintInvoiceResendToken({ session, tenantId, invoice }, deps = {}) {
  const secret = getSessionSecret(deps);
  if (!secret) return null;
  const tid = String(tenantId || "").trim();
  const invoiceId = String(invoice?.id || "").trim();
  if (!isUuid(tid) || !isUuid(invoiceId)) return null;
  const actorFp = computeActorFingerprint(session, deps);
  const stateFp = computeStateFingerprint(invoice, tid, deps);
  if (!HEX64_RE.test(actorFp) || !HEX64_RE.test(stateFp)) return null;
  const now = nowUnix(deps);
  const payload = {
    type: TOKEN_TYPE,
    version: TOKEN_VERSION,
    action: ACTION_TYPE,
    tenant_id: tid,
    invoice_id: invoiceId.toLowerCase(),
    nonce: crypto.randomUUID(),
    state_fp: stateFp,
    actor_fp: actorFp,
    iat: now,
    exp: now + RESEND_TTL_SECONDS,
  };
  const encodedPayload = base64url(JSON.stringify(payload));
  const signature = signEncodedPayload(encodedPayload, secret);
  return {
    token: `${encodedPayload}.${signature}`,
    payload,
    expires_at: new Date(payload.exp * 1000).toISOString(),
  };
}

function verifyInvoiceResendToken(token, trustedTenantId, session, deps = {}) {
  const secret = getSessionSecret(deps);
  if (!secret || !token || typeof token !== "string" || !token.includes(".")) {
    return { ok: false, reason: "invalid_token" };
  }
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "invalid_token" };
  const [encodedPayload, signature] = parts;
  if (!encodedPayload || !signature) return { ok: false, reason: "invalid_token" };

  const expected = signEncodedPayload(encodedPayload, secret);
  const sigA = Buffer.from(signature);
  const sigB = Buffer.from(expected);
  if (sigA.length !== sigB.length || !crypto.timingSafeEqual(sigA, sigB)) {
    return { ok: false, reason: "invalid_token" };
  }

  let payload;
  try {
    payload = JSON.parse(fromBase64url(encodedPayload));
  } catch (_err) {
    return { ok: false, reason: "invalid_token" };
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, reason: "invalid_token" };
  }
  if (payload.type !== TOKEN_TYPE) return { ok: false, reason: "invalid_token" };
  if (payload.version !== TOKEN_VERSION) return { ok: false, reason: "invalid_token" };
  if (payload.action !== ACTION_TYPE) return { ok: false, reason: "invalid_token" };
  if (typeof payload.iat !== "number" || typeof payload.exp !== "number") {
    return { ok: false, reason: "invalid_token" };
  }
  const now = nowUnix(deps);
  if (payload.iat > now + CLOCK_SKEW_SECONDS) return { ok: false, reason: "invalid_token" };
  if (payload.exp > payload.iat + RESEND_TTL_SECONDS + CLOCK_SKEW_SECONDS) {
    return { ok: false, reason: "invalid_token" };
  }
  if (payload.exp < payload.iat) return { ok: false, reason: "invalid_token" };
  if (now > payload.exp) return { ok: false, reason: "expired" };
  if (!payload.nonce || typeof payload.nonce !== "string" || String(payload.nonce).length > 80) {
    return { ok: false, reason: "invalid_token" };
  }
  if (!isUuid(payload.nonce) || !isUuid(payload.tenant_id) || !isUuid(payload.invoice_id)) {
    return { ok: false, reason: "invalid_token" };
  }
  if (String(payload.tenant_id) !== String(trustedTenantId || "").trim()) {
    return { ok: false, reason: "invalid_token" };
  }
  if (!HEX64_RE.test(String(payload.state_fp || "")) || !HEX64_RE.test(String(payload.actor_fp || ""))) {
    return { ok: false, reason: "invalid_token" };
  }
  const currentActor = computeActorFingerprint(session, deps);
  if (!currentActor || !timingSafeEqualStr(payload.actor_fp, currentActor)) {
    return { ok: false, reason: "invalid_token" };
  }
  if (Object.prototype.hasOwnProperty.call(payload, "customer_email")) {
    return { ok: false, reason: "invalid_token" };
  }
  return { ok: true, payload };
}

function stateFingerprintMatches(payload, invoice, tenantId, deps = {}) {
  const expected = computeStateFingerprint(invoice, tenantId, deps);
  if (!expected || !payload?.state_fp) return false;
  return timingSafeEqualStr(payload.state_fp, expected);
}

module.exports = {
  TOKEN_TYPE,
  TOKEN_VERSION,
  ACTION_TYPE,
  RESEND_TTL_SECONDS,
  STATE_DOMAIN,
  ACTOR_DOMAIN,
  UUID_RE,
  isUuid,
  timingSafeEqualStr,
  normalizePersistedEmail,
  canonicalizeSentAt,
  buildStateCanonical,
  computeStateFingerprint,
  canonicalActorPrincipal,
  computeActorFingerprint,
  mintInvoiceResendToken,
  verifyInvoiceResendToken,
  stateFingerprintMatches,
};
