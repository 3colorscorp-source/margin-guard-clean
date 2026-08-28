/**
 * MG-SUPPORT-003D.D1 — explicit deposit CTA / public-estimate deposit availability.
 * Does not route on bare "deposit".
 * Does not steal invoice, contract, or ordinary quote-status intents.
 */
"use strict";

const { extractQuoteIdentifier } = require("./quote-diagnostic");

function hasDepositCtaWording(text) {
  const t = String(text || "").toLowerCase();
  if (!t) return false;
  if (/\bno deposit (button|option|link|action)\b/.test(t)) return true;
  if (/\bdeposit (button|option|link|action|cta)\b/.test(t) && /\b(missing|gone|hidden|absent|blank|not showing|not appearing|won't show|will not show|does not show|doesn't show|not visible)\b/.test(t)) {
    return true;
  }
  if (/\b(button|option|link|action)\b/.test(t) && /\bdeposit\b/.test(t) && /\b(missing|gone|hidden|not showing|not appearing|won't show|will not show|does not show|doesn't show)\b/.test(t)) {
    return true;
  }
  if (/\b(cannot|can't|unable to|won't|will not)\b/.test(t) && /\b(pay|paying)\b/.test(t) && /\bdeposit\b/.test(t)) {
    return true;
  }
  if (/\bwhy\b/.test(t) && /\b(customer|client)\b/.test(t) && /\b(cannot|can't|unable)\b/.test(t) && /\bdeposit\b/.test(t)) {
    return true;
  }
  if (/\binitial scheduling payment\b/.test(t) && /\b(missing|not showing|not appearing|won't show|will not show|does not show|doesn't show|hidden|gone|cannot|can't)\b/.test(t)) {
    return true;
  }
  if (/\bdeposit action not showing\b/.test(t)) return true;
  return false;
}

function hasPublicEstimateReference(text) {
  return /\bpublic estimate\b/.test(String(text || "").toLowerCase());
}

function isDepositCtaDiagnosticQuestion(message) {
  const text = String(message || "").toLowerCase();
  if (!text) return false;
  if (/\binvoice(s)?\b/.test(text)) return false;
  if (/\bcontracts?\b/.test(text)) return false;
  if (!hasDepositCtaWording(text)) return false;
  if (extractQuoteIdentifier(message)) return true;
  if (hasPublicEstimateReference(text)) return true;
  return false;
}

module.exports = {
  hasDepositCtaWording,
  hasPublicEstimateReference,
  isDepositCtaDiagnosticQuestion,
};
