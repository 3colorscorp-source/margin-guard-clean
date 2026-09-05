/**
 * Invoice Hub normal payment amounts are DOLLARS, never cents.
 *
 * Documented 2-decimal rule:
 *   Math.round(n * 100) / 100 rounds to cents then converts back to dollars.
 *   That is display/storage precision only. It is NOT a dollars→cents write.
 *   PostgreSQL tenant_project_payments.amount remains numeric dollars.
 */
"use strict";

const NORMAL_PAYMENT_TYPES = new Set(["deposit", "progress", "final"]);

function parseInvoiceHubPaymentAmount(raw, paymentType) {
  if (raw === "" || raw == null) {
    return { ok: false, error: "invalid_amount" };
  }
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) {
    return { ok: false, error: "invalid_amount" };
  }
  const dollars = Math.round(n * 100) / 100;
  if (dollars === 0) {
    return { ok: false, error: "zero_amount" };
  }
  const type = String(paymentType || "").toLowerCase();
  if (NORMAL_PAYMENT_TYPES.has(type) && dollars < 0) {
    return { ok: false, error: "negative_normal_payment" };
  }
  return { ok: true, amount: dollars };
}

module.exports = {
  NORMAL_PAYMENT_TYPES,
  parseInvoiceHubPaymentAmount,
};
