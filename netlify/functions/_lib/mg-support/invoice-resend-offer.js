/**
 * MG-SUPPORT-003D.C2 — server-owned invoice resend confirmation offer.
 * Mints the existing C1 token only. Does not INSERT the action ledger.
 * Does not PATCH invoices. Does not call Zapier. Does not call OpenAI.
 */
"use strict";

const { hasOwnerEmailAndCustomer } = require("./require-owner-session");
const { isUuid, mintInvoiceResendToken } = require("./action-token");
const { reloadInvoiceForResend } = require("./invoice-resend-eligibility");
const { isExplicitInvoiceResendIntent } = require("./invoice-resend-intent");

const INVOICE_RESEND_ACTION_TYPE = "invoice_resend";
const INVOICE_RESEND_BUTTON_LABEL = "Resend invoice";

const INVOICE_RESEND_CONFIRMATION_COPY =
  "I can resend this invoice to its currently saved delivery email. This sends an email to the customer. Confirm below if you want to resend it.";

const INVOICE_RESEND_PAID_COPY =
  "This invoice is currently paid, so Margin Guard will not resend it as a payment request.";

const INVOICE_RESEND_VOID_COPY = "This invoice is no longer eligible to be sent.";

const INVOICE_RESEND_ARCHIVED_COPY = "This archived invoice is not eligible for resend.";

const INVOICE_RESEND_MISSING_EMAIL_COPY =
  "This invoice does not currently have a valid saved delivery email. Update the client contact in Invoice Hub before sending it.";

const INVOICE_RESEND_MISSING_PUBLIC_COPY =
  "This invoice is not currently ready for resend because its public invoice reference is missing.";

const INVOICE_RESEND_NEEDS_IDENTIFIER_COPY =
  "Please provide the exact invoice number, such as INV-123, if you want to resend it.";

function emptyOffer(explicit) {
  return {
    explicit: Boolean(explicit),
    action: null,
    copy: "",
    skipEscalation: false,
  };
}

function invoiceResendDenialCopy(reason) {
  const code = String(reason || "").trim();
  if (code === "paid") return INVOICE_RESEND_PAID_COPY;
  if (code === "void" || code === "cancelled" || code === "canceled") return INVOICE_RESEND_VOID_COPY;
  if (code === "archived") return INVOICE_RESEND_ARCHIVED_COPY;
  if (code === "missing_email") return INVOICE_RESEND_MISSING_EMAIL_COPY;
  if (code === "missing_public_token") return INVOICE_RESEND_MISSING_PUBLIC_COPY;
  if (code === "ineligible_amount" || code === "ineligible_status") return INVOICE_RESEND_VOID_COPY;
  return "";
}

function closedInvoiceResendAction(minted) {
  if (!minted || typeof minted !== "object" || !minted.token) return null;
  return {
    type: INVOICE_RESEND_ACTION_TYPE,
    label: INVOICE_RESEND_BUTTON_LABEL,
    confirmation_token: String(minted.token),
    expires_at: String(minted.expires_at || ""),
  };
}

async function maybeOfferInvoiceResend({
  message,
  intent,
  diagnostic,
  session,
  trustedTenantId,
  deps = {},
}) {
  const detect = deps.isExplicitInvoiceResendIntent || isExplicitInvoiceResendIntent;
  const explicit = detect(message);
  if (!explicit) return emptyOffer(false);
  if (intent !== "invoice_diagnostic") return emptyOffer(true);

  if (!hasOwnerEmailAndCustomer(session)) return emptyOffer(true);

  const outcome = diagnostic && diagnostic.outcome;
  if (outcome === "needs_identifier") {
    return {
      explicit: true,
      action: null,
      copy: INVOICE_RESEND_NEEDS_IDENTIFIER_COPY,
      skipEscalation: false,
    };
  }

  const tenantId = String(trustedTenantId || "").trim();
  if (!isUuid(tenantId)) return emptyOffer(true);

  if (outcome !== "ok") return emptyOffer(true);

  const invoiceId = String(diagnostic.invoice_id || "").trim();
  if (!isUuid(invoiceId)) return emptyOffer(true);

  const reload = deps.reloadInvoiceForResend || reloadInvoiceForResend;
  let loaded;
  try {
    loaded = await reload(tenantId, invoiceId, deps);
  } catch (_err) {
    return emptyOffer(true);
  }

  const eligibility = loaded && loaded.eligibility;
  if (!eligibility || eligibility.ok !== true) {
    const reason = (eligibility && eligibility.reason) || (loaded && loaded.outcome) || "";
    return {
      explicit: true,
      action: null,
      copy: invoiceResendDenialCopy(reason),
      skipEscalation: false,
    };
  }

  const mint = deps.mintInvoiceResendToken || mintInvoiceResendToken;
  const minted = mint({ session, tenantId, invoice: loaded.invoice }, deps);
  const action = closedInvoiceResendAction(minted);
  if (!action) return emptyOffer(true);

  return {
    explicit: true,
    action,
    copy: INVOICE_RESEND_CONFIRMATION_COPY,
    skipEscalation: true,
  };
}

module.exports = {
  INVOICE_RESEND_ACTION_TYPE,
  INVOICE_RESEND_BUTTON_LABEL,
  INVOICE_RESEND_CONFIRMATION_COPY,
  INVOICE_RESEND_PAID_COPY,
  INVOICE_RESEND_VOID_COPY,
  INVOICE_RESEND_ARCHIVED_COPY,
  INVOICE_RESEND_MISSING_EMAIL_COPY,
  INVOICE_RESEND_MISSING_PUBLIC_COPY,
  INVOICE_RESEND_NEEDS_IDENTIFIER_COPY,
  invoiceResendDenialCopy,
  maybeOfferInvoiceResend,
};
