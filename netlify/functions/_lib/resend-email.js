/**
 * Minimal Resend sender (shared pattern with deposit-post-automation).
 */

const fetch = globalThis.fetch;
if (!fetch) {
  throw new Error("Global fetch is not available.");
}

function pickFirst(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  return "";
}

function maskEmailForLog(email) {
  const s = String(email || "").trim();
  if (!s.includes("@")) return "(no-email)";
  const [local, dom] = s.split("@");
  if (!dom) return "(invalid)";
  const maskLocal = !local ? "*" : local.length <= 2 ? "**" : `${local[0]}***`;
  return `${maskLocal}@${dom}`;
}

function getResendApiKey() {
  return String(process.env.RESEND_API_KEY || "").trim();
}

function getResendFromAddress() {
  return pickFirst(
    process.env.RESEND_FROM_EMAIL,
    process.env.DEPOSIT_EMAIL_FROM,
    process.env.RESEND_FROM
  );
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * @param {{ to: string; subject: string; html: string; replyTo?: string; label: string }} opts
 */
async function tryResendEmail({ to, subject, html, replyTo, label }) {
  const key = getResendApiKey();
  const from = getResendFromAddress();

  if (!to) {
    console.warn(`[resend-email:${label}] skipped: no recipient`);
    return { ok: false, reason: "no_recipient" };
  }
  if (!key) {
    console.warn(
      `[resend-email:${label}] skipped: RESEND_API_KEY missing — cannot send to ${maskEmailForLog(to)}`
    );
    return { ok: false, reason: "no_api_key" };
  }
  if (!from) {
    console.warn(`[resend-email:${label}] skipped: no From address (RESEND_FROM_EMAIL / DEPOSIT_EMAIL_FROM)`);
    return { ok: false, reason: "no_from" };
  }

  try {
    const body = { from, to: [to], subject, html };
    const rt = pickFirst(replyTo);
    if (rt) body.reply_to = rt;

    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    const rawText = await r.text();
    if (!r.ok) {
      console.warn(`[resend-email:${label}] failure`, r.status, rawText?.slice(0, 400));
      return { ok: false, reason: "http_error", status: r.status };
    }
    console.log(`[resend-email:${label}] sent to ${maskEmailForLog(to)}`);
    return { ok: true };
  } catch (err) {
    console.warn(`[resend-email:${label}] exception`, err?.message || err);
    return { ok: false, reason: "exception" };
  }
}

module.exports = { tryResendEmail, escapeHtml, pickFirst };
