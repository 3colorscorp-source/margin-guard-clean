/**
 * Closed read-only public-estimate deposit CTA diagnostic for Support AI.
 * GET only. Trusted tenant_id from the signed owner session.
 * Never return deposit amounts, payment URLs, Stripe ids, public tokens, or PII.
 * Does not trust localStorage, query flags, or browser paid state.
 */
"use strict";

const { supabaseRequest } = require("../supabase-admin");
const { isPublicDepositWorkflowComplete } = require("../quote-deposit-gate");
const {
  extractQuoteIdentifier,
  isEstimateDisplayNumber,
  isValidPublicReferenceFormat,
} = require("./quote-diagnostic");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const QUOTE_SELECT_FIELDS = [
  "id",
  "tenant_id",
  "quote_number_display",
  "status",
  "accepted_at",
  "public_token",
  "exclusions_initials",
  "exclusions_acknowledged_at",
  "change_order_acknowledged_at",
  "deposit_paid_at",
  "deposit_required",
];

const QUOTE_SELECT = QUOTE_SELECT_FIELDS.join(",");

const REASONS = new Set([
  "not_published",
  "not_accepted",
  "workflow_incomplete",
  "deposit_not_required",
  "already_recorded",
  "payment_path_unavailable",
  "cta_expected_visible",
  "status_unverified",
]);

function isUuid(value) {
  return UUID_RE.test(String(value || "").trim());
}

function isNonEmpty(value) {
  return String(value ?? "").trim() !== "";
}

function normId(value) {
  return String(value || "").trim();
}

function normalizeStatus(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function quoteAccepted(row) {
  const status = normalizeStatus(row?.status);
  return status === "accepted" || status === "approved";
}

function depositRequiredPositive(row) {
  const amount = Number(row?.deposit_required);
  return Number.isFinite(amount) && amount > 0;
}

function quotePubliclyAvailable(row) {
  if (!isNonEmpty(row?.public_token)) return false;
  return isValidPublicReferenceFormat(row.public_token);
}

function emptyFacts(reason) {
  return {
    quote_publicly_available: false,
    quote_accepted: false,
    workflow_complete: false,
    deposit_required_positive: false,
    deposit_already_recorded: false,
    payment_link_configured: false,
    stripe_connect_charges_enabled: false,
    deposit_payment_available: false,
    deposit_cta_visible_expected: false,
    reason: REASONS.has(reason) ? reason : "status_unverified",
  };
}

function deriveReason(flags) {
  if (!flags.quote_publicly_available) return "not_published";
  if (!flags.quote_accepted) return "not_accepted";
  if (!flags.workflow_complete) return "workflow_incomplete";
  if (!flags.deposit_required_positive) return "deposit_not_required";
  if (flags.deposit_already_recorded) return "already_recorded";
  if (!flags.payment_path_ready) return "payment_path_unavailable";
  if (flags.deposit_cta_visible_expected) return "cta_expected_visible";
  return "status_unverified";
}

function toModelFacts(row, payment) {
  const publiclyAvailable = quotePubliclyAvailable(row);
  const accepted = quoteAccepted(row);
  const workflowComplete = isPublicDepositWorkflowComplete(row);
  const needsDeposit = depositRequiredPositive(row);
  const alreadyRecorded = isNonEmpty(row?.deposit_paid_at);
  const paymentLinkConfigured = Boolean(payment && payment.payment_link_configured);
  const stripeChargesEnabled = Boolean(payment && payment.stripe_connect_charges_enabled);
  const stripeConfigured = Boolean(payment && payment.stripe_connect_configured);
  const paymentPathReady = paymentLinkConfigured || (stripeConfigured && stripeChargesEnabled);
  const ctaExpected = workflowComplete && needsDeposit && paymentPathReady && !alreadyRecorded;
  const flags = {
    quote_publicly_available: publiclyAvailable,
    quote_accepted: accepted,
    workflow_complete: workflowComplete,
    deposit_required_positive: needsDeposit,
    deposit_already_recorded: alreadyRecorded,
    payment_path_ready: paymentPathReady,
    deposit_cta_visible_expected: ctaExpected,
  };
  return {
    quote_publicly_available: publiclyAvailable,
    quote_accepted: accepted,
    workflow_complete: workflowComplete,
    deposit_required_positive: needsDeposit,
    deposit_already_recorded: alreadyRecorded,
    payment_link_configured: paymentLinkConfigured,
    stripe_connect_charges_enabled: stripeChargesEnabled,
    deposit_payment_available: paymentPathReady,
    deposit_cta_visible_expected: ctaExpected,
    reason: deriveReason(flags),
  };
}

function buildQuoteQueryPath(tenantId, identifier) {
  const tid = String(tenantId || "").trim();
  const params = new URLSearchParams();
  params.set("tenant_id", `eq.${tid}`);
  params.set("select", QUOTE_SELECT);
  params.set("limit", "2");
  if (identifier.type === "id") {
    params.set("id", `eq.${identifier.value}`);
  } else {
    params.set("quote_number_display", `eq.${identifier.value}`);
  }
  return `quotes?${params.toString()}`;
}

function buildOwnerSettingsQueryPath(tenantId) {
  const params = new URLSearchParams();
  params.set("tenant_id", `eq.${tenantId}`);
  params.set("select", "deposit_payment_link");
  params.set("limit", "1");
  return `owner_settings?${params.toString()}`;
}

function buildTenantStripeQueryPath(tenantId) {
  const params = new URLSearchParams();
  params.set("id", `eq.${tenantId}`);
  params.set("select", "stripe_account_id,stripe_charges_enabled");
  params.set("limit", "1");
  return `tenants?${params.toString()}`;
}

async function defaultGet(path) {
  return supabaseRequest(path, { method: "GET" });
}

async function readPaymentPath(tenantId, get, queryPaths) {
  const tid = String(tenantId || "").trim();
  let paymentLinkConfigured = false;
  let stripeConnectConfigured = false;
  let stripeConnectChargesEnabled = false;

  const settingsPath = buildOwnerSettingsQueryPath(tid);
  queryPaths.push(settingsPath);
  try {
    const settingsRows = await get(settingsPath);
    const settingsRow = Array.isArray(settingsRows) ? settingsRows[0] : null;
    paymentLinkConfigured = isNonEmpty(settingsRow && settingsRow.deposit_payment_link);
  } catch (_err) {
    return null;
  }

  const tenantPath = buildTenantStripeQueryPath(tid);
  queryPaths.push(tenantPath);
  try {
    const tenantRows = await get(tenantPath);
    const row = Array.isArray(tenantRows)
      ? tenantRows.find((item) => normId(item?.id) === tid) || tenantRows[0]
      : null;
    if (row && normId(row.id) && normId(row.id) !== tid) {
      return {
        payment_link_configured: paymentLinkConfigured,
        stripe_connect_configured: false,
        stripe_connect_charges_enabled: false,
      };
    }
    stripeConnectConfigured = isNonEmpty(row?.stripe_account_id);
    stripeConnectChargesEnabled = Boolean(row?.stripe_charges_enabled);
  } catch (_err) {
    return null;
  }

  return {
    payment_link_configured: paymentLinkConfigured,
    stripe_connect_configured: stripeConnectConfigured,
    stripe_connect_charges_enabled: stripeConnectChargesEnabled,
  };
}

/**
 * @returns {Promise<{ outcome: "ok"|"not_found"|"ambiguous"|"status_unverified", facts?: object, queryPaths: string[] }>}
 */
async function readDepositCtaDiagnostic(tenantId, identifier, deps = {}) {
  const tid = String(tenantId || "").trim();
  const queryPaths = [];
  if (!tid || !identifier || !identifier.type || !identifier.value) {
    return { outcome: "not_found", queryPaths };
  }
  if (identifier.type === "id" && !isUuid(identifier.value)) {
    return { outcome: "not_found", queryPaths };
  }
  if (identifier.type === "quote_number_display" && !isEstimateDisplayNumber(identifier.value)) {
    return { outcome: "not_found", queryPaths };
  }

  const get = deps.supabaseGet || defaultGet;
  const queryPath = buildQuoteQueryPath(tid, identifier);
  queryPaths.push(queryPath);

  let rows;
  try {
    rows = await get(queryPath);
  } catch (_err) {
    return { outcome: "status_unverified", queryPaths };
  }
  if (!Array.isArray(rows)) {
    return { outcome: "status_unverified", queryPaths };
  }

  const list = rows.filter((row) => normId(row?.tenant_id) === tid);
  if (list.length === 0) {
    return { outcome: "not_found", queryPaths };
  }
  if (list.length > 1) {
    return { outcome: "ambiguous", queryPaths };
  }

  const payment = await readPaymentPath(tid, get, queryPaths);
  if (!payment) {
    return { outcome: "status_unverified", queryPaths };
  }

  return {
    outcome: "ok",
    queryPaths,
    facts: toModelFacts(list[0], payment),
  };
}

module.exports = {
  QUOTE_SELECT_FIELDS,
  QUOTE_SELECT,
  extractQuoteIdentifier,
  toModelFacts,
  buildQuoteQueryPath,
  readDepositCtaDiagnostic,
};
