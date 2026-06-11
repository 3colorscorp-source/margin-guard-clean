/**
 * Step 3E-C14-E2B — Supabase Auth invite for supervisor memberships (server-side only).
 * Step 3E-C14-E2G-D1C — Recovery resend for existing unlinked Auth users.
 */

const { getSupabaseConfig } = require("./supabase-admin");

const INVITE_REDIRECT_TO = "https://marginguardsystem.netlify.app/supervisor-invite.html";
const RECOVERY_REDIRECT_TO = INVITE_REDIRECT_TO;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normEmail(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function isValidInviteEmail(email) {
  const em = normEmail(email);
  return Boolean(em) && EMAIL_RE.test(em);
}

/**
 * @param {string} email
 * @returns {Promise<{ ok: true } | { ok: false, code: "invite_failed" }>}
 */
async function inviteAuthUserByEmail(email) {
  const em = normEmail(email);
  if (!isValidInviteEmail(em)) {
    return { ok: false, code: "invite_failed" };
  }

  const { url, key } = getSupabaseConfig();
  let response;
  try {
    response = await fetch(`${url}/auth/v1/invite`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        email: em,
        redirect_to: INVITE_REDIRECT_TO,
      }),
    });
  } catch (_err) {
    return { ok: false, code: "invite_failed" };
  }

  if (response.ok) {
    return { ok: true };
  }

  return { ok: false, code: "invite_failed" };
}

/**
 * Send a password recovery email for an existing Auth user (server-side only).
 * Uses GoTrue /recover which emails the user and returns an empty JSON body on success.
 * @param {string} email
 * @returns {Promise<{ ok: true } | { ok: false, code: "recovery_failed" }>}
 */
async function recoverAuthUserByEmail(email) {
  const em = normEmail(email);
  if (!isValidInviteEmail(em)) {
    return { ok: false, code: "recovery_failed" };
  }

  const { url, key } = getSupabaseConfig();
  const recoverUrl = `${url}/auth/v1/recover?redirect_to=${encodeURIComponent(
    RECOVERY_REDIRECT_TO
  )}`;

  let response;
  try {
    response = await fetch(recoverUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ email: em }),
    });
  } catch (_err) {
    return { ok: false, code: "recovery_failed" };
  }

  if (response.ok) {
    return { ok: true };
  }

  return { ok: false, code: "recovery_failed" };
}

module.exports = {
  EMAIL_RE,
  INVITE_REDIRECT_TO,
  RECOVERY_REDIRECT_TO,
  inviteAuthUserByEmail,
  recoverAuthUserByEmail,
  isValidInviteEmail,
  normEmail,
};
