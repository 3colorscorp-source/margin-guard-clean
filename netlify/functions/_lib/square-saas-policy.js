/**
 * Server policy for Square SaaS annual billing.
 * Amount/currency are not caller-supplied authority.
 */
"use strict";

const ANNUAL_AMOUNT_CENTS = 200000;
const ANNUAL_CURRENCY = "USD";
const SQUARE_API_VERSION = "2026-08-19";
const SQUARE_PRODUCTION_BASE = "https://connect.squareup.com";
const SQUARE_SANDBOX_BASE = "https://connect.squareupsandbox.com";

const INELIGIBLE_INVOICE_STATUSES = new Set([
  "PARTIALLY_PAID",
  "PAYMENT_PENDING",
  "UNPAID",
  "SCHEDULED",
  "CANCELED",
  "FAILED",
  "REFUNDED",
  "PARTIALLY_REFUNDED",
  "DRAFT",
]);

const PREPAY_REGISTER_STATUSES = new Set(["UNPAID", "SCHEDULED"]);

function envVal(name, env) {
  const src = env && typeof env === "object" ? env : process.env;
  return String(src[name] || "").trim();
}

function isAutoActivationEnabled(env) {
  return envVal("SQUARE_SAAS_AUTO_ACTIVATION_ENABLED", env) === "true";
}

function isSandboxAllowed(env) {
  return envVal("SQUARE_SAAS_ALLOW_SANDBOX", env) === "true";
}

function configuredSquareEnvironment(env) {
  const raw = envVal("SQUARE_ENVIRONMENT", env).toLowerCase();
  if (raw === "sandbox") return "sandbox";
  return "production";
}

function squareApiBase(env) {
  if (configuredSquareEnvironment(env) === "sandbox" && isSandboxAllowed(env)) {
    return SQUARE_SANDBOX_BASE;
  }
  return SQUARE_PRODUCTION_BASE;
}

function expectedAmountCents(env) {
  const raw = envVal("SQUARE_SAAS_EXPECTED_AMOUNT_CENTS", env);
  if (!raw) return ANNUAL_AMOUNT_CENTS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n !== ANNUAL_AMOUNT_CENTS) return null;
  return ANNUAL_AMOUNT_CENTS;
}

function expectedCurrency(env) {
  const raw = envVal("SQUARE_SAAS_CURRENCY", env).toUpperCase();
  if (!raw) return ANNUAL_CURRENCY;
  if (raw !== ANNUAL_CURRENCY) return null;
  return ANNUAL_CURRENCY;
}

function moneyOf(obj) {
  if (!obj || typeof obj !== "object") return null;
  const amount = obj.amount;
  if (typeof amount !== "number" || !Number.isFinite(amount) || !Number.isInteger(amount)) {
    return null;
  }
  const currency = String(obj.currency || "")
    .trim()
    .toUpperCase();
  if (!currency) return null;
  return { amount, currency };
}

function invoiceStatus(invoice) {
  return String(invoice?.status || "")
    .trim()
    .toUpperCase();
}

function summarizeSquareInvoice(invoice) {
  if (!invoice || typeof invoice !== "object") return null;
  const reqs = Array.isArray(invoice.payment_requests) ? invoice.payment_requests : [];
  const first = reqs[0] || null;
  const computed = first ? moneyOf(first.computed_amount_money) : null;
  const completed = first ? moneyOf(first.total_completed_amount_money) : null;
  const currency =
    (computed && computed.currency) || (completed && completed.currency) || null;
  const numberRaw = invoice.invoice_number;
  const titleRaw = invoice.title;
  return {
    id: String(invoice.id || "").trim() || null,
    status: invoiceStatus(invoice) || null,
    invoice_number: numberRaw == null || numberRaw === "" ? null : String(numberRaw),
    title: titleRaw == null || titleRaw === "" ? null : String(titleRaw),
    amount_cents: computed ? computed.amount : null,
    completed_amount_cents: completed ? completed.amount : null,
    currency,
    payment_request_count: reqs.length,
    tipping_enabled: invoice.tipping_enabled === true,
  };
}

function evaluateFullyPaidAnnualInvoice(invoice, env) {
  const cents = expectedAmountCents(env);
  const currency = expectedCurrency(env);
  if (cents == null || currency == null) {
    return { ok: false, code: "policy_misconfigured" };
  }
  const status = invoiceStatus(invoice);
  if (status !== "PAID") {
    if (INELIGIBLE_INVOICE_STATUSES.has(status)) {
      return { ok: false, code: "invoice_" + status.toLowerCase() };
    }
    return { ok: false, code: "invoice_status_ineligible" };
  }
  const reqs = invoice.payment_requests;
  if (!Array.isArray(reqs) || reqs.length !== 1) {
    return { ok: false, code: "invoice_structure_ambiguous" };
  }
  if (invoice.tipping_enabled === true) {
    return { ok: false, code: "invoice_structure_ambiguous" };
  }
  const computed = moneyOf(reqs[0].computed_amount_money);
  const completed = moneyOf(reqs[0].total_completed_amount_money);
  if (!computed || !completed) {
    return { ok: false, code: "invoice_amount_missing" };
  }
  if (computed.currency !== currency || completed.currency !== currency) {
    return { ok: false, code: "wrong_currency" };
  }
  if (computed.amount !== cents || completed.amount !== cents) {
    return { ok: false, code: "wrong_amount" };
  }
  const next = moneyOf(invoice.next_payment_amount_money);
  if (next && next.amount !== 0) {
    return { ok: false, code: "invoice_structure_ambiguous" };
  }
  return { ok: true, amount_cents: cents, currency };
}

function isAcceptablePrepaymentInvoice(invoice, env) {
  const cents = expectedAmountCents(env);
  const currency = expectedCurrency(env);
  if (cents == null || currency == null) {
    return { ok: false, code: "policy_misconfigured" };
  }
  const status = invoiceStatus(invoice);
  if (!PREPAY_REGISTER_STATUSES.has(status)) {
    return { ok: false, code: "invoice_status_ineligible" };
  }
  const reqs = invoice.payment_requests;
  if (!Array.isArray(reqs) || reqs.length !== 1) {
    return { ok: false, code: "invoice_structure_ambiguous" };
  }
  if (invoice.tipping_enabled === true) {
    return { ok: false, code: "invoice_structure_ambiguous" };
  }
  const computed = moneyOf(reqs[0].computed_amount_money);
  if (!computed) return { ok: false, code: "invoice_amount_missing" };
  if (computed.currency !== currency) return { ok: false, code: "wrong_currency" };
  if (computed.amount !== cents) return { ok: false, code: "wrong_amount" };
  return { ok: true, amount_cents: cents, currency };
}

function addOneYearIso(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d.toISOString();
}

function planStatusNorm(tenant) {
  return String(tenant?.plan_status || "")
    .trim()
    .toLowerCase();
}

module.exports = {
  ANNUAL_AMOUNT_CENTS,
  ANNUAL_CURRENCY,
  INELIGIBLE_INVOICE_STATUSES,
  PREPAY_REGISTER_STATUSES,
  SQUARE_API_VERSION,
  SQUARE_PRODUCTION_BASE,
  SQUARE_SANDBOX_BASE,
  addOneYearIso,
  configuredSquareEnvironment,
  envVal,
  evaluateFullyPaidAnnualInvoice,
  expectedAmountCents,
  expectedCurrency,
  invoiceStatus,
  isAcceptablePrepaymentInvoice,
  summarizeSquareInvoice,
  isAutoActivationEnabled,
  isSandboxAllowed,
  planStatusNorm,
  squareApiBase,
};
