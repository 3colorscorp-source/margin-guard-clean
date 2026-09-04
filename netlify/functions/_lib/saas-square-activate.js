/**
 * ONLY automatic Square SaaS activation writer.
 * Kill switch is enforced here, not only in the webhook handler.
 */
"use strict";

const { getSquareInvoice, getSquarePayment, safeInvoiceId } = require("./square-saas-api");
const {
  addOneYearIso,
  evaluateFullyPaidAnnualInvoice,
  isAutoActivationEnabled,
  planStatusNorm,
} = require("./square-saas-policy");
const db = require("./saas-square-db");

function nowIso() {
  return new Date().toISOString();
}

function paymentMatchesInvoice(payment, invoice) {
  if (!payment || !invoice) return false;
  const payOrder = String(payment.order_id || "").trim();
  const invOrder = String(invoice.order_id || "").trim();
  if (payOrder && invOrder && payOrder === invOrder) return true;
  const payInvoice = String(payment.invoice_id || payment.invoiceId || "").trim();
  if (payInvoice && payInvoice === String(invoice.id || "").trim()) return true;
  return false;
}

async function bindPaymentIfPresent(onboarding, paymentId, invoice, deps) {
  const id = safeInvoiceId(paymentId);
  if (!id) return { ok: true, paymentId: onboarding.external_payment_id || null };
  const getPayment = deps.getSquarePayment || getSquarePayment;
  const paid = await getPayment(id, deps);
  if (!paid.ok) return { ok: false, code: paid.code || "square_payment_unverified" };
  if (!paymentMatchesInvoice(paid.payment, invoice)) {
    return { ok: false, code: "payment_invoice_mismatch" };
  }
  const requestFn = deps.supabaseRequest;
  const existing = await db.getOnboardingByPayment(id, requestFn);
  if (existing && String(existing.id) !== String(onboarding.id)) {
    return { ok: false, code: "payment_used_by_other_tenant" };
  }
  if (String(onboarding.external_payment_id || "") !== id) {
    try {
      await db.patchOnboarding(
        onboarding.id,
        { external_payment_id: id, updated_at: nowIso() },
        requestFn
      );
    } catch (err) {
      if (db.isUniqueViolation(err)) {
        return { ok: false, code: "payment_used_by_other_tenant" };
      }
      throw err;
    }
  }
  return { ok: true, paymentId: id };
}

/**
 * @returns {Promise<{ ok: boolean, code: string, activated?: boolean, idempotent?: boolean }>}
 */
async function activateTenantFromVerifiedSquareInvoice(input, deps = {}) {
  const env = deps.env || process.env;
  if (!isAutoActivationEnabled(env)) {
    return { ok: false, code: "activation_disabled", activated: false };
  }

  const requestFn = deps.supabaseRequest;
  const getInvoice = deps.getSquareInvoice || getSquareInvoice;
  const onboardingId = String(input?.onboardingId || "").trim();
  if (!onboardingId) return { ok: false, code: "onboarding_required" };

  let onboarding = await db.getOnboardingById(onboardingId, requestFn);
  if (!onboarding || String(onboarding.provider || "") !== "square") {
    return { ok: false, code: "onboarding_not_found" };
  }
  if (!onboarding.terms_accepted_at) {
    return { ok: false, code: "terms_required" };
  }

  const tenant = await db.getTenantById(onboarding.tenant_id, requestFn);
  if (!tenant?.id) return { ok: false, code: "tenant_not_found" };

  const invoiceId = String(onboarding.external_invoice_id || "").trim();
  const fetched = await getInvoice(invoiceId, deps);
  if (!fetched.ok) return { ok: false, code: fetched.code || "invoice_get_failed" };
  const invoice = fetched.invoice;
  if (String(invoice.id || "").trim() !== invoiceId) {
    return { ok: false, code: "invoice_id_mismatch" };
  }

  const paidCheck = evaluateFullyPaidAnnualInvoice(invoice, env);
  if (!paidCheck.ok) return { ok: false, code: paidCheck.code };

  const paymentHint = String(input?.paymentId || onboarding.external_payment_id || "").trim();
  if (
    onboarding.external_payment_id &&
    paymentHint &&
    String(onboarding.external_payment_id) !== paymentHint
  ) {
    return { ok: false, code: "active_conflict_different_payment" };
  }
  const bound = await bindPaymentIfPresent(onboarding, paymentHint, invoice, deps);
  if (!bound.ok) return bound;
  onboarding = (await db.getOnboardingById(onboardingId, requestFn)) || onboarding;

  const otherInvoice = await db.getOnboardingByInvoice(invoiceId, requestFn);
  if (otherInvoice && String(otherInvoice.tenant_id) !== String(tenant.id)) {
    return { ok: false, code: "invoice_used_by_other_tenant" };
  }

  const status = planStatusNorm(tenant);
  if (status === "canceled") return { ok: false, code: "tenant_canceled" };
  if (status === "expired") return { ok: false, code: "tenant_expired" };

  if (status === "active") {
    if (String(onboarding.external_invoice_id) !== invoiceId) {
      return { ok: false, code: "active_conflict_different_payment" };
    }
    if (String(onboarding.status) !== "activated" || !onboarding.activated_at) {
      const paidAt = onboarding.paid_at || invoice.updated_at || nowIso();
      const termStart = onboarding.term_start_at || paidAt;
      const termExpires = onboarding.term_expires_at || addOneYearIso(termStart);
      await db.patchOnboarding(
        onboardingId,
        {
          status: "activated",
          paid_at: onboarding.paid_at || paidAt,
          activated_at: onboarding.activated_at || nowIso(),
          term_start_at: termStart,
          term_expires_at: termExpires,
          last_error_code: null,
          updated_at: nowIso(),
        },
        requestFn
      );
    }
    return { ok: true, code: "already_active_same_payment", activated: false, idempotent: true };
  }

  if (status !== "pending") {
    return { ok: false, code: "tenant_not_pending" };
  }

  const now = nowIso();
  const updated = await db.patchTenant(
    tenant.id,
    { plan_status: tenant.plan_status },
    { plan_status: "active", updated_at: now },
    requestFn
  );
  const changed = updated.length;
  if (changed !== 1) {
    const again = await db.getTenantById(tenant.id, requestFn);
    const onb2 = await db.getOnboardingById(onboardingId, requestFn);
    if (planStatusNorm(again) === "active") {
      const same =
        onb2 &&
        String(onb2.status || "") === "activated" &&
        String(onb2.external_invoice_id) === invoiceId;
      if (same) {
        return { ok: true, code: "already_active_same_payment", activated: false, idempotent: true };
      }
      return { ok: false, code: "active_conflict_different_payment" };
    }
    if (planStatusNorm(again) === "canceled") return { ok: false, code: "tenant_canceled" };
    if (planStatusNorm(again) === "expired") return { ok: false, code: "tenant_expired" };
    return { ok: false, code: "cas_failed" };
  }

  const paidAt = invoice.updated_at || nowIso();
  const termStart = paidAt;
  const termExpires = addOneYearIso(termStart);
  await db.patchOnboarding(
    onboardingId,
    {
      status: "activated",
      paid_at: paidAt,
      activated_at: nowIso(),
      term_start_at: termStart,
      term_expires_at: termExpires,
      last_error_code: null,
      updated_at: nowIso(),
    },
    requestFn
  );

  return { ok: true, code: "activated", activated: true, idempotent: false };
}

module.exports = {
  activateTenantFromVerifiedSquareInvoice,
};
