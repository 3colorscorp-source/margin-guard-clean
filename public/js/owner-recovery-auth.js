/**
 * Owner recovery / invite password establishment helpers.
 * Browser global: window.MgOwnerRecoveryAuth
 * Node tests: module.exports
 *
 * Recovery/invite Supabase sessions prove email possession only.
 * They must not mint mg_session until updateUser({ password }) succeeds.
 */
(function (root) {
  "use strict";

  const MIN_PASSWORD_LEN = 8;
  const MAX_PASSWORD_LEN = 120;

  function parseHashParams(hash) {
    const raw = String(hash || "").replace(/^#/, "");
    let type = "";
    try {
      type = String(new URLSearchParams(raw).get("type") || "")
        .trim()
        .toLowerCase();
    } catch (_err) {
      type = "";
    }
    return { type };
  }

  function hasAuthCallbackHash(hash) {
    const value = String(hash || "");
    return /access_token=|refresh_token=|type=invite|type=recovery|type=magiclink/i.test(value);
  }

  function hashIndicatesRecovery(hash) {
    return parseHashParams(hash).type === "recovery";
  }

  function hashIndicatesInvite(hash) {
    return parseHashParams(hash).type === "invite";
  }

  function isPasswordRecoveryEvent(event) {
    return String(event || "") === "PASSWORD_RECOVERY";
  }

  function classifyAuthCallback(hash, event) {
    if (isPasswordRecoveryEvent(event) || hashIndicatesRecovery(hash)) {
      return "recovery";
    }
    if (hashIndicatesInvite(hash)) {
      return "invite";
    }
    if (hasAuthCallbackHash(hash)) {
      return "blocked_hash";
    }
    return "none";
  }

  function requiresPasswordEstablishment(hash, event) {
    const kind = classifyAuthCallback(hash, event);
    return kind === "recovery" || kind === "invite";
  }

  function allowMintOwnerSession(classification, passwordUpdated) {
    if (classification === "recovery" || classification === "invite") {
      return Boolean(passwordUpdated);
    }
    if (classification === "blocked_hash") {
      return false;
    }
    return true;
  }

  function recoveryRedirectTo(origin) {
    const base = String(origin || "").replace(/\/+$/, "");
    return base + "/index.html";
  }

  function validateNewPassword(password, confirm) {
    const next = String(password || "");
    const check = String(confirm || "");
    if (next.length < MIN_PASSWORD_LEN) {
      return { ok: false, error: "password_too_short" };
    }
    if (next.length > MAX_PASSWORD_LEN) {
      return { ok: false, error: "password_too_long" };
    }
    if (next !== check) {
      return { ok: false, error: "password_mismatch" };
    }
    return { ok: true };
  }

  /**
   * @param {{
   *   password: string,
   *   confirm: string,
   *   updateUser: (payload: { password: string }) => Promise<{ error?: unknown }>,
   *   getSession: () => Promise<{ access_token?: string } | null>,
   *   mintOwnerSession: (accessToken: string) => Promise<void>,
   * }} deps
   */
  async function completePasswordEstablishment(deps) {
    const valid = validateNewPassword(deps.password, deps.confirm);
    if (!valid.ok) {
      return { ok: false, error: valid.error, minted: false, updateCalled: false };
    }
    const updated = await deps.updateUser({ password: String(deps.password) });
    if (updated && updated.error) {
      return { ok: false, error: "update_failed", minted: false, updateCalled: true };
    }
    const session = await deps.getSession();
    const accessToken = session && session.access_token ? String(session.access_token) : "";
    if (!accessToken) {
      return { ok: false, error: "session_lost", minted: false, updateCalled: true };
    }
    await deps.mintOwnerSession(accessToken);
    return { ok: true, error: "", minted: true, updateCalled: true };
  }

  const api = {
    MIN_PASSWORD_LEN,
    MAX_PASSWORD_LEN,
    allowMintOwnerSession,
    classifyAuthCallback,
    completePasswordEstablishment,
    hasAuthCallbackHash,
    hashIndicatesInvite,
    hashIndicatesRecovery,
    isPasswordRecoveryEvent,
    recoveryRedirectTo,
    requiresPasswordEstablishment,
    validateNewPassword,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  root.MgOwnerRecoveryAuth = api;
})(typeof window !== "undefined" ? window : typeof globalThis !== "undefined" ? globalThis : this);
