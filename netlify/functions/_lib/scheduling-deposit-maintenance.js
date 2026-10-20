/**
 * Server switch for scheduling-deposit maintenance.
 * Absent or any value other than false keeps the current checkout behavior.
 * false stops new scheduling checkout, hides the public deposit link, and
 * pauses legacy finalize writes. It does not apply to invoice checkout or
 * other payment functions.
 *
 * This switch cannot invalidate a Stripe Checkout Session that was already
 * created, or an external payment URL that was already shared outside the
 * public estimate response. Those remain payable until they expire or are
 * handled at the provider.
 *
 * The legacy finalize pause must not be wrapped around the verified
 * scheduling-deposit recorder. While checkout stays closed, that recorder
 * still accepts an already-paid Stripe session. New Checkout Sessions and
 * the public external link stay blocked.
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
