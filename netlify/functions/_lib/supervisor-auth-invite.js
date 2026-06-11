/**
 * Step 3E-C14-E2B — Supabase Auth invite for supervisor memberships (server-side only).
 */

const { getSupabaseConfig } = require("./supabase-admin");

const INVITE_REDIRECT_TO = "https://marginguardsystem.netlify.app/supervisor-invite.html";
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

module.exports = {
  EMAIL_RE,
  INVITE_REDIRECT_TO,
  inviteAuthUserByEmail,
  isValidInviteEmail,
  normEmail,
};
