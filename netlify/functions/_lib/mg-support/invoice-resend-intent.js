/**
 * MG-SUPPORT-003D.C2 — explicit invoice-resend intent (regex only).
 * Does not query tenant tables. Does not choose an invoice.
 */
"use strict";

function isExplicitInvoiceResendIntent(message) {
  const original = String(message || "");
  const text = original.toLowerCase().replace(/\s+/g, " ").trim();
  if (!text) return false;

  const mentionsInvoice = /\binvoice(s)?\b/.test(text) || /\binv-[a-z0-9]/i.test(original);
  if (!mentionsInvoice) return false;

  if (/\bresend\b/.test(text)) return true;
  if (/\bsend\b/.test(text) && /\bagain\b/.test(text)) return true;
  return false;
}

module.exports = {
  isExplicitInvoiceResendIntent,
};
