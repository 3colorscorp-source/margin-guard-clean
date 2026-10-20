/**
 * Server switch for native Stripe scheduling Checkout.
 * Absent or any value other than false keeps Checkout Session creation open.
 * false stops new scheduling Checkout Sessions only. It does not hide a
 * tenant's HTTPS deposit_payment_link, and it does not apply to invoice
 * checkout or other payment functions.
 *
 * This switch cannot invalidate a Stripe Checkout Session that was already
 * created. An already shared external payment URL also remains payable at
 * the provider until it expires or is handled there.
 *
 * The legacy finalize pause must not be wrapped around the verified
 * scheduling-deposit recorder. While checkout stays closed, that recorder
 * still accepts an already-paid Stripe session. New Checkout Sessions stay
 * blocked. Tenant external payment links stay available.
 */
"use strict";

const MAINTENANCE_PUBLIC_COPY =
  "Initial Scheduling Payment is temporarily unavailable. Please contact your contractor. This does not mean a payment was missed or declined.";

const MAINTENANCE_FINALIZE_COPY =
  "Scheduling payment recording is temporarily paused. A payment already completed at Stripe can be reconciled after maintenance. Do not pay again.";

function schedulingDepositCheckoutClosed() {
  return String(process.env.SCHEDULING_DEPOSIT_CHECKOUT_ENABLED || "").trim().toLowerCase() === "false";
}

module.exports = {
  MAINTENANCE_PUBLIC_COPY,
  MAINTENANCE_FINALIZE_COPY,
  schedulingDepositCheckoutClosed,
};
