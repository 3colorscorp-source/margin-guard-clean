/**
 * Server switch for scheduling-deposit maintenance.
 * Absent or any value other than false keeps the current checkout behavior.
 * false stops new scheduling checkout and pauses legacy finalize writes.
 * It does not apply to invoice checkout or other payment functions.
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
