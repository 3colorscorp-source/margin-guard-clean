/**
 * Shared Square invoice registration for a pending tenant.
 * Amount, currency, provider, and activation remain server-owned.
 */
"use strict";

const { getSquareInvoice, safeInvoiceId } = require("./square-saas-api");
const { activateTenantFromVerifiedSquareInvoice } = require("./saas-square-activate");
const db = require("./saas-square-db");
const {
  ANNUAL_AMOUNT_CENTS,
  ANNUAL_CURRENCY,
  evaluateFullyPaidAnnualInvoice,
  invoiceStatus,
  isAcceptablePrepaymentInvoice,
  isAutoActivationEnabled,
  planStatusNorm,
} = require("./square-saas-policy");
const { logSquareSaas } = require("./square-saas-log");

async function registerSquareInvoiceForPendingTenant(input, deps = {}) {
  const tenantId = String(input?.tenantId || "").trim();
  const invoiceId = safeInvoiceId(input?.squareInvoiceId);
  if (!tenantId || !invoiceId) {
    return { statusCode: 400, body: { ok: false, error: "invalid_request" } };
  }
  if (input?.termsConfirmed !== true) {
    return { statusCode: 400, body: { ok: false, error: "terms_required" } };
  }

  const getInvoice = deps.getSquareInvoice || getSquareInvoice;
  const activate = deps.activateTenantFromVerifiedSquareInvoice || activateTenantFromVerifiedSquareInvoice;

  const tenant = await db.getTenantById(tenantId, deps.supabaseRequest);
  if (!tenant?.id) return { statusCode: 404, body: { ok: false, error: "tenant_not_found" } };
  if (planStatusNorm(tenant) !== "pending") {
    return { statusCode: 409, body: { ok: false, error: "tenant_not_pending" } };
  }

  const fetched = await getInvoice(invoiceId, deps);
  if (!fetched.ok) {
    return { statusCode: 502, body: { ok: false, error: fetched.code || "invoice_get_failed" } };
  }
  const invoice = fetched.invoice;
  if (String(invoice.id || "").trim() !== invoiceId) {
    return { statusCode: 409, body: { ok: false, error: "invoice_id_mismatch" } };
  }

  const status = invoiceStatus(invoice);
  const prepay = isAcceptablePrepaymentInvoice(invoice, deps.env || process.env);
  const paid = evaluateFullyPaidAnnualInvoice(invoice, deps.env || process.env);
  if (status === "PAID") {
    if (!paid.ok) return { statusCode: 409, body: { ok: false, error: paid.code } };
  } else if (!prepay.ok) {
    return { statusCode: 409, body: { ok: false, error: prepay.code } };
  }

  const existingInvoice = await db.getOnboardingByInvoice(invoiceId, deps.supabaseRequest);
  if (existingInvoice && String(existingInvoice.tenant_id) !== tenantId) {
    return { statusCode: 409, body: { ok: false, error: "invoice_used_by_other_tenant" } };
  }
  if (existingInvoice && String(existingInvoice.tenant_id) === tenantId) {
    if (status === "PAID") {
      const activated = await activate(
        { onboardingId: existingInvoice.id },
        { ...deps, getSquareInvoice: getInvoice }
      );
      logSquareSaas({
        processing_status: activated.ok ? "activated" : "ignored",
        onboarding_id: existingInvoice.id,
        error_code: activated.code,
      });
      return {
        statusCode: 200,
        body: {
          ok: true,
          registered: true,
          activated: activated.activated === true,
          reason: activated.code,
          onboarding_id: existingInvoice.id,
          kill_switch: isAutoActivationEnabled(deps.env || process.env),
        },
      };
    }
    return {
      statusCode: 200,
      body: {
        ok: true,
        registered: true,
        activated: false,
        reason: "already_registered",
        onboarding_id: existingInvoice.id,
      },
    };
  }

  const open = await db.listOpenOnboardingForTenant(tenantId, deps.supabaseRequest);
  const conflict = open.find((row) => String(row.external_invoice_id) !== invoiceId);
  if (conflict) {
    return { statusCode: 409, body: { ok: false, error: "tenant_has_open_onboarding" } };
  }

  const now = new Date().toISOString();
  const inserted = await db.insertOnboarding(
    {
      tenant_id: tenantId,
      provider: "square",
      external_invoice_id: invoiceId,
      expected_amount_cents: ANNUAL_AMOUNT_CENTS,
      currency: ANNUAL_CURRENCY,
      status: "registered",
      terms_accepted_at: now,
      registered_at: now,
      updated_at: now,
    },
    deps.supabaseRequest
  );
  if (!inserted.ok) {
    return { statusCode: 409, body: { ok: false, error: inserted.code || "duplicate_onboarding" } };
  }

  let activated = { ok: true, activated: false, code: "registered" };
  if (status === "PAID") {
    activated = await activate(
      { onboardingId: inserted.row.id },
      { ...deps, getSquareInvoice: getInvoice }
    );
  }

  logSquareSaas({
    processing_status: activated.activated ? "activated" : "registered",
    onboarding_id: inserted.row.id,
    error_code: activated.code,
  });

  return {
    statusCode: 200,
    body: {
      ok: true,
      registered: true,
      activated: activated.activated === true,
      reason: activated.code,
      onboarding_id: inserted.row.id,
      kill_switch: isAutoActivationEnabled(deps.env || process.env),
    },
  };
}

module.exports = {
  registerSquareInvoiceForPendingTenant,
};
