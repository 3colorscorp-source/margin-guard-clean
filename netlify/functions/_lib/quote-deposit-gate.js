/**
 * Public deposit is allowed only after the full client workflow on the quote row.
 * All checks use fields from a quote loaded with public_token + tenant_id scope.
 */

function isNonEmptyTs(value) {
  if (value === null || value === undefined) return false;
  return String(value).trim() !== "";
}

function isNonEmptyInitials(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s/g, "")
    .length > 0;
}

/**
 * @param {object} row - Quote row (subset ok)
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
function assertPublicDepositAllowed(row) {
  if (!row || !row.tenant_id) {
    return { ok: false, error: "Quote not found or missing tenant scope." };
  }

  if (!isNonEmptyTs(row.accepted_at)) {
    return {
      ok: false,
      error:
        "Deposit is available only after the estimate is approved and all workflow steps are complete."
    };
  }

  if (!isNonEmptyInitials(row.exclusions_initials)) {
    return {
      ok: false,
      error: "Complete the exclusions acknowledgment (step 2) before paying the deposit."
    };
  }

  if (!isNonEmptyTs(row.exclusions_acknowledged_at)) {
    return {
      ok: false,
      error: "Complete the exclusions acknowledgment (step 2) before paying the deposit."
    };
  }

  if (!isNonEmptyTs(row.change_order_acknowledged_at)) {
    return {
      ok: false,
      error: "Complete the change-order acknowledgment (step 3) before paying the deposit."
    };
  }

  return { ok: true };
}

/**
 * @param {object} row
 * @returns {boolean}
 */
function isPublicDepositWorkflowComplete(row) {
  return assertPublicDepositAllowed(row).ok;
}

module.exports = {
  assertPublicDepositAllowed,
  isPublicDepositWorkflowComplete,
  isNonEmptyTs,
  isNonEmptyInitials
};
