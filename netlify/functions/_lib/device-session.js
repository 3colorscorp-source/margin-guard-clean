/**
 * Device-bound portal cookie helpers (mg_device_session).
 * Skeleton — not wired into handlers until Step 3E-C+.
 * @see DEVICE_BOUND_PORTAL_GUARD_SPEC.md
 */

const crypto = require("crypto");

const DEVICE_COOKIE_NAME = "mg_device_session";
const DEVICE_SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function fromBase64url(input) {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalized.length % 4;
  const padded = normalized + (pad ? "=".repeat(4 - pad) : "");
  return Buffer.from(padded, "base64").toString("utf8");
}

function getSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("Missing SESSION_SECRET");
  }
  return secret;
}

function signPayload(payload) {
  const encodedPayload = base64url(JSON.stringify(payload));
  const signature = crypto
    .createHmac("sha256", getSecret())
    .update(encodedPayload)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `${encodedPayload}.${signature}`;
}

function verifySignedToken(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) {
    return null;
  }

  const [encodedPayload, signature] = token.split(".");
  const expected = crypto
    .createHmac("sha256", getSecret())
    .update(encodedPayload)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  const sigA = Buffer.from(signature);
  const sigB = Buffer.from(expected);
  if (sigA.length !== sigB.length || !crypto.timingSafeEqual(sigA, sigB)) {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(fromBase64url(encodedPayload));
  } catch (_err) {
    return null;
  }

  if (!payload || typeof payload !== "object") {
    return null;
  }

  if (typeof payload.exp !== "number" || Date.now() / 1000 > payload.exp) {
    return null;
  }

  return payload;
}

function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader) return out;

  cookieHeader.split(";").forEach((chunk) => {
    const [rawKey, ...rest] = chunk.trim().split("=");
    if (!rawKey) return;
    out[rawKey] = decodeURIComponent(rest.join("=") || "");
  });
  return out;
}

/**
 * SHA-256 digest of the raw cookie token (stored in device_sessions.session_token_hash).
 */
function hashSessionToken(token) {
  return crypto.createHash("sha256").update(String(token || ""), "utf8").digest("hex");
}

/**
 * Build signed device cookie payload (not persisted until pair-device creates DB row).
 */
function buildDeviceSessionPayload({
  sessionId,
  deviceId,
  tenantId,
  membershipId,
  portalType,
  ttlSeconds = DEVICE_SESSION_TTL_SECONDS,
}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    sid: String(sessionId || ""),
    d: String(deviceId || ""),
    t: String(tenantId || ""),
    m: String(membershipId || ""),
    p: String(portalType || ""),
    iat: now,
    exp: now + Math.max(60, Number(ttlSeconds) || DEVICE_SESSION_TTL_SECONDS),
  };
}

/**
 * Read and verify mg_device_session from a Netlify event. Returns payload or null.
 */
function readDeviceSessionFromEvent(event) {
  const cookies = parseCookies(event?.headers?.cookie || event?.headers?.Cookie || "");
  const token = cookies[DEVICE_COOKIE_NAME];
  if (!token) return null;
  return verifySignedToken(token);
}

/**
 * Set-Cookie header value for an opaque signed device token.
 * @param {string} token - signed cookie value (from signPayload)
 * @param {{ maxAgeSeconds?: number }} [opts]
 */
function createDeviceSessionCookie(token, opts = {}) {
  const maxAge = Math.max(
    0,
    Number(opts.maxAgeSeconds) > 0 ? Number(opts.maxAgeSeconds) : DEVICE_SESSION_TTL_SECONDS
  );
  return `${DEVICE_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

/**
 * Create signed token + Set-Cookie from a device session payload object.
 */
function createDeviceSessionCookieFromPayload(payload, opts = {}) {
  const token = signPayload(payload);
  return {
    token,
    cookie: createDeviceSessionCookie(token, opts),
    tokenHash: hashSessionToken(token),
  };
}

function clearDeviceSessionCookie() {
  return `${DEVICE_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

module.exports = {
  DEVICE_COOKIE_NAME,
  DEVICE_SESSION_TTL_SECONDS,
  buildDeviceSessionPayload,
  clearDeviceSessionCookie,
  createDeviceSessionCookie,
  createDeviceSessionCookieFromPayload,
  hashSessionToken,
  readDeviceSessionFromEvent,
  signPayload,
  verifySignedToken,
};
