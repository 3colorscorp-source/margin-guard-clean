const crypto = require("crypto");

const COOKIE_NAME = "mg_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

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

function sign(payload) {
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

function verify(token) {
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

function readSessionFromEvent(event) {
  const cookies = parseCookies(event.headers?.cookie || event.headers?.Cookie || "");
  const token = cookies[COOKIE_NAME];
  if (!token) return null;
  return verify(token);
}

function buildSessionPayload({ customerId, subscriptionId, email }) {
  const now = Math.floor(Date.now() / 1000);
  return {
    c: customerId,
    s: subscriptionId,
    e: email || "",
    iat: now,
    exp: now + SESSION_TTL_SECONDS,
  };
}

function createSessionCookie(payload) {
  const token = sign(payload);
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`;
}

function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

module.exports = {
  buildSessionPayload,
  clearSessionCookie,
  createSessionCookie,
  readSessionFromEvent,
};
