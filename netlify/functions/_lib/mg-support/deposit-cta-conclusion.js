/**
 * Closed public-estimate deposit CTA answers for Support AI.
 * OpenAI must not generate these conclusions or contradictory workarounds.
 */
"use strict";

const NOT_PUBLISHED =
  "This estimate is not currently available through a public estimate page.";

const NOT_ACCEPTED =
  "The estimate has not reached the accepted/approved state required for the deposit workflow.";

const WORKFLOW_INCOMPLETE =
  "The estimate is accepted, but the required approval acknowledgements are not complete yet.";

const DEPOSIT_NOT_REQUIRED = "This estimate is not currently configured to require a deposit.";

const ALREADY_RECORDED =
  "A deposit has already been recorded for this estimate, so the deposit action is not expected to appear.";

const PAYMENT_UNAVAILABLE =
  "The estimate requires a deposit, but no active deposit payment path is currently available.";

const CTA_EXPECTED =
  "Margin Guard expects the deposit action to be available on the public estimate.";

const UNVERIFIED = "Margin Guard could not verify the current deposit availability state.";

const NEEDS_IDENTIFIER =
  "Share the estimate number shown in Quote Builder so Margin Guard can check whether the deposit action should appear on the public estimate.";

const NOT_FOUND =
  "No matching estimate was found in this Margin Guard account. Use the estimate number shown in Quote Builder.";

const AMBIGUOUS =
  "More than one estimate matches this request. Use the exact estimate number shown in Quote Builder.";

const NEEDS_OWNER_TENANT =
  "Deposit availability can be checked only for the signed-in owner's public estimates.";

const REASON_COPY = {
  not_published: NOT_PUBLISHED,
  not_accepted: NOT_ACCEPTED,
  workflow_incomplete: WORKFLOW_INCOMPLETE,
  deposit_not_required: DEPOSIT_NOT_REQUIRED,
  already_recorded: ALREADY_RECORDED,
  payment_path_unavailable: PAYMENT_UNAVAILABLE,
  cta_expected_visible: CTA_EXPECTED,
  status_unverified: UNVERIFIED,
};

function copyForDepositReason(reason) {
  return REASON_COPY[String(reason || "")] || null;
}

function depositCtaAnswer(intent, diagnostic) {
  if (intent !== "deposit_cta_diagnostic") return null;
  if (!diagnostic) return null;
  const outcome = diagnostic.outcome;
  if (outcome === "no_tenant_context") return NEEDS_OWNER_TENANT;
  if (outcome === "needs_identifier") return NEEDS_IDENTIFIER;
  if (outcome === "not_found") return NOT_FOUND;
  if (outcome === "ambiguous") return AMBIGUOUS;
  if (outcome === "status_unverified") return UNVERIFIED;
  if (outcome === "ok") {
    return copyForDepositReason(diagnostic.facts && diagnostic.facts.reason);
  }
  return UNVERIFIED;
}

module.exports = {
  NOT_PUBLISHED,
  NOT_ACCEPTED,
  WORKFLOW_INCOMPLETE,
  DEPOSIT_NOT_REQUIRED,
  ALREADY_RECORDED,
  PAYMENT_UNAVAILABLE,
  CTA_EXPECTED,
  UNVERIFIED,
  NEEDS_IDENTIFIER,
  NOT_FOUND,
  AMBIGUOUS,
  NEEDS_OWNER_TENANT,
  copyForDepositReason,
  depositCtaAnswer,
};
