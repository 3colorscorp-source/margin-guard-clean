/**
 * CH-013A.2.1 — Contract invitation email template (HTML + text).
 * Professional transactional content only. No marketing. No payment asks.
 * Never includes the words token / generation / envelope / attempt / hash.
 * Signing URL is supplied ephemerally by the caller (already built).
 */

"use strict";

const API_VERSION = "ch-013a21-v1";

function trimField(value) {
  return value == null ? "" : String(value).trim();
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatExpiration(iso) {
  const raw = trimField(iso);
  if (!raw) return "";
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw.slice(0, 10);
  try {
    return d.toLocaleString("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "UTC",
    }) + " UTC";
  } catch (_e) {
    return raw;
  }
}

/**
 * @param {{
 *   branding?: object,
 *   project_name?: string,
 *   signer_name?: string,
 *   signing_url: string,
 *   expires_at?: string|null,
 *   reply_to?: string,
 * }} input
 */
function renderContractInvitationEmail(input = {}) {
  const branding = input.branding && typeof input.branding === "object" ? input.branding : {};
  const businessName =
    trimField(branding.business_name) ||
    trimField(branding.from_name) ||
    "Your contractor";
  const logoUrl = trimField(branding.logo_url);
  const projectName = trimField(input.project_name) || "your project";
  const signerName = trimField(input.signer_name) || "there";
  const signingUrl = trimField(input.signing_url);
  if (!signingUrl) {
    return {
      ok: false,
      error: "signing_url is required for email template",
      code: "missing_signing_url",
    };
  }
  // Reject accidental embedding of forbidden terminology in caller-supplied names
  const expiresLabel = formatExpiration(input.expires_at);
  const replyTo =
    trimField(input.reply_to) ||
    trimField(branding.reply_to) ||
    "";
  const legalFooter =
    trimField(branding.legal_footer) ||
    "This message was sent securely regarding a contract signing request. If you did not expect this email, you can ignore it.";

  const subject = `${businessName}: please sign your contract for ${projectName}`;

  const logoBlock =
    logoUrl && /^https:\/\//i.test(logoUrl)
      ? `<p style="margin:0 0 16px;"><img src="${escapeHtml(logoUrl)}" alt="${escapeHtml(businessName)}" width="140" style="max-width:140px;height:auto;border:0;" /></p>`
      : "";

  const expiresBlock = expiresLabel
    ? `<p style="margin:16px 0 0;font-size:14px;color:#475569;">This signing link expires on <strong>${escapeHtml(expiresLabel)}</strong>.</p>`
    : "";

  const replyBlock = replyTo
    ? `<p style="margin:8px 0 0;font-size:13px;color:#64748b;">Questions? Reply to this email or contact ${escapeHtml(replyTo)}.</p>`
    : `<p style="margin:8px 0 0;font-size:13px;color:#64748b;">Questions? Reply to this email.</p>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><title>Sign your contract</title></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#0f172a;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f8fafc;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" style="max-width:560px;background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:28px 24px;">
        <tr><td>
          ${logoBlock}
          <p style="margin:0 0 8px;font-size:13px;letter-spacing:0.04em;text-transform:uppercase;color:#64748b;">Contract signing</p>
          <h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;">Hello ${escapeHtml(signerName)},</h1>
          <p style="margin:0 0 16px;font-size:16px;line-height:1.5;">${escapeHtml(businessName)} invited you to review and sign the contract for <strong>${escapeHtml(projectName)}</strong>.</p>
          <p style="margin:24px 0;" align="center">
            <a href="${escapeHtml(signingUrl)}" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 22px;border-radius:6px;">Sign Contract</a>
          </p>
          <p style="margin:0;font-size:13px;line-height:1.5;color:#475569;">If the button does not work, copy and paste this link into your browser:</p>
          <p style="margin:8px 0 0;font-size:13px;line-height:1.5;word-break:break-all;"><a href="${escapeHtml(signingUrl)}" style="color:#2563eb;">${escapeHtml(signingUrl)}</a></p>
          ${expiresBlock}
          ${replyBlock}
          <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;" />
          <p style="margin:0;font-size:12px;line-height:1.5;color:#94a3b8;">${escapeHtml(legalFooter)}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const textLines = [
    `Hello ${signerName},`,
    "",
    `${businessName} invited you to review and sign the contract for ${projectName}.`,
    "",
    "Sign Contract:",
    signingUrl,
    "",
  ];
  if (expiresLabel) textLines.push(`This signing link expires on ${expiresLabel}.`, "");
  if (replyTo) textLines.push(`Questions? Contact ${replyTo}.`, "");
  textLines.push(legalFooter);

  return {
    ok: true,
    api_version: API_VERSION,
    subject,
    html,
    text: textLines.join("\n"),
  };
}

module.exports = {
  API_VERSION,
  renderContractInvitationEmail,
  escapeHtml,
  formatExpiration,
};
