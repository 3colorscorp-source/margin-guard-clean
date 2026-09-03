/**
 * Shared Supabase Auth JWT verification (GoTrue /auth/v1/user).
 * Identity comes from the access token only — never from request body email.
 */
"use strict";

const { getSupabaseConfig } = require("./supabase-admin");

function readBearerToken(event) {
  const header = String(event?.headers?.authorization || event?.headers?.Authorization || "").trim();
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : "";
}

async function verifySupabaseAccessToken(accessToken, deps = {}) {
  const token = String(accessToken || "").trim();
  if (!token) {
    return { ok: false };
  }

  let url;
  let key;
  try {
    const cfg = typeof deps.getSupabaseConfig === "function" ? deps.getSupabaseConfig() : getSupabaseConfig();
    url = String(cfg.url || "").replace(/\/+$/, "");
    key = cfg.key;
  } catch (_err) {
    return { ok: false };
  }
  if (!url || !key) {
    return { ok: false };
  }

  const fetchImpl = typeof deps.fetchImpl === "function" ? deps.fetchImpl : globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    return { ok: false };
  }

  let response;
  try {
    response = await fetchImpl(`${url}/auth/v1/user`, {
      method: "GET",
      headers: {
        apikey: key,
        Authorization: `Bearer ${token}`,
      },
    });
  } catch (_err) {
    return { ok: false };
  }

  let data = {};
  try {
    data = await response.json();
  } catch (_err) {
    data = {};
  }

  if (!response.ok) {
    return { ok: false };
  }

  const email = String(data.email || "")
    .trim()
    .toLowerCase();
  const userId = String(data.id || "").trim();
  if (!email || !userId) {
    return { ok: false };
  }

  return { ok: true, email, userId };
}

module.exports = {
  readBearerToken,
  verifySupabaseAccessToken,
};
