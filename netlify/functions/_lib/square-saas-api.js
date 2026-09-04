/**
 * Server-only Square REST reads for SaaS onboarding.
 * Never logs or returns the access token.
 */
"use strict";

const {
  SQUARE_API_VERSION,
  configuredSquareEnvironment,
  envVal,
  isSandboxAllowed,
  squareApiBase,
} = require("./square-saas-policy");

function safeInvoiceId(value) {
  const id = String(value || "").trim();
  if (!id || id.length > 200) return "";
  if (!/^[A-Za-z0-9:_-]+$/.test(id)) return "";
  return id;
}

function classifySquareHttp(status) {
  if (status === 404) return "square_not_found";
  if (status === 401 || status === 403) return "square_auth_failed";
  if (status >= 500) return "square_unavailable";
  return "square_request_failed";
}

async function squareGet(path, env, fetchFn) {
  const token = envVal("SQUARE_ACCESS_TOKEN", env);
  if (!token) {
    return { ok: false, code: "square_token_missing" };
  }
  const environment = configuredSquareEnvironment(env);
  if (environment === "sandbox" && !isSandboxAllowed(env)) {
    return { ok: false, code: "sandbox_not_allowed" };
  }
  const base = squareApiBase(env);
  const doFetch = typeof fetchFn === "function" ? fetchFn : fetch;
  let res;
  try {
    res = await doFetch(base + path, {
      method: "GET",
      headers: {
        Authorization: "Bearer " + token,
        "Square-Version": SQUARE_API_VERSION,
        "Content-Type": "application/json",
      },
    });
  } catch (_err) {
    return { ok: false, code: "square_unavailable" };
  }
  let data = null;
  try {
    data = await res.json();
  } catch (_err) {
    data = null;
  }
  if (!res.ok) {
    return { ok: false, code: classifySquareHttp(res.status) };
  }
  return { ok: true, data };
}

async function getSquareInvoice(invoiceId, deps = {}) {
  const id = safeInvoiceId(invoiceId);
  if (!id) return { ok: false, code: "invalid_invoice_id" };
  const got = await squareGet(`/v2/invoices/${encodeURIComponent(id)}`, deps.env, deps.fetch);
  if (!got.ok) return got;
  const invoice = got.data && got.data.invoice ? got.data.invoice : got.data;
  if (!invoice || typeof invoice !== "object" || !invoice.id) {
    return { ok: false, code: "square_not_found" };
  }
  return { ok: true, invoice };
}

async function getSquarePayment(paymentId, deps = {}) {
  const id = safeInvoiceId(paymentId);
  if (!id) return { ok: false, code: "invalid_payment_id" };
  const got = await squareGet(`/v2/payments/${encodeURIComponent(id)}`, deps.env, deps.fetch);
  if (!got.ok) return got;
  const payment = got.data && got.data.payment ? got.data.payment : got.data;
  if (!payment || typeof payment !== "object" || !payment.id) {
    return { ok: false, code: "square_not_found" };
  }
  return { ok: true, payment };
}

module.exports = {
  getSquareInvoice,
  getSquarePayment,
  safeInvoiceId,
};
