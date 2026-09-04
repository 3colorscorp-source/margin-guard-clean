/**
 * service_role access to saas_onboarding and saas_square_webhook_events.
 */
"use strict";

const { supabaseRequest } = require("./supabase-admin");

function isUniqueViolation(err) {
  const msg = String(err && (err.message || err.supabaseRaw) || "");
  return /23505|duplicate key/i.test(msg);
}

async function getTenantById(tenantId, requestFn) {
  const req = requestFn || supabaseRequest;
  const rows = await req(
    `tenants?id=eq.${encodeURIComponent(tenantId)}&select=id,slug,name,plan_status,owner_email&limit=1`
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function getOnboardingById(id, requestFn) {
  const req = requestFn || supabaseRequest;
  const rows = await req(`saas_onboarding?id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function getOnboardingByInvoice(invoiceId, requestFn) {
  const req = requestFn || supabaseRequest;
  const rows = await req(
    `saas_onboarding?provider=eq.square&external_invoice_id=eq.${encodeURIComponent(
      invoiceId
    )}&select=*&limit=1`
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function getOnboardingByPayment(paymentId, requestFn) {
  const req = requestFn || supabaseRequest;
  if (!paymentId) return null;
  const rows = await req(
    `saas_onboarding?provider=eq.square&external_payment_id=eq.${encodeURIComponent(
      paymentId
    )}&select=*&limit=1`
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function getLatestOnboardingForTenant(tenantId, requestFn) {
  const req = requestFn || supabaseRequest;
  const rows = await req(
    `saas_onboarding?tenant_id=eq.${encodeURIComponent(
      tenantId
    )}&provider=eq.square&select=*&order=registered_at.desc&limit=1`
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function listOpenOnboardingForTenant(tenantId, requestFn) {
  const req = requestFn || supabaseRequest;
  const rows = await req(
    `saas_onboarding?tenant_id=eq.${encodeURIComponent(
      tenantId
    )}&provider=eq.square&status=in.(registered,paid_verified,failed,admin_review)&select=id,status,external_invoice_id`
  );
  return Array.isArray(rows) ? rows : [];
}

async function insertOnboarding(row, requestFn) {
  const req = requestFn || supabaseRequest;
  try {
    const inserted = await req("saas_onboarding", { method: "POST", body: row });
    return { ok: true, row: Array.isArray(inserted) ? inserted[0] : inserted };
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, code: "duplicate_onboarding" };
    throw err;
  }
}

async function patchOnboarding(id, body, requestFn) {
  const req = requestFn || supabaseRequest;
  const rows = await req(`saas_onboarding?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    body,
  });
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function patchTenant(tenantId, filters, body, requestFn) {
  const req = requestFn || supabaseRequest;
  const parts = [`id=eq.${encodeURIComponent(tenantId)}`];
  if (filters && filters.plan_status != null) {
    parts.push(`plan_status=eq.${encodeURIComponent(filters.plan_status)}`);
  }
  const rows = await req(`tenants?${parts.join("&")}`, {
    method: "PATCH",
    body,
  });
  return Array.isArray(rows) ? rows : [];
}

async function insertWebhookEvent(row, requestFn) {
  const req = requestFn || supabaseRequest;
  try {
    const inserted = await req("saas_square_webhook_events", { method: "POST", body: row });
    return {
      ok: true,
      duplicate: false,
      row: Array.isArray(inserted) ? inserted[0] : inserted,
    };
  } catch (err) {
    if (isUniqueViolation(err)) {
      const existing = await req(
        `saas_square_webhook_events?event_id=eq.${encodeURIComponent(row.event_id)}&select=*&limit=1`
      );
      return {
        ok: true,
        duplicate: true,
        row: Array.isArray(existing) ? existing[0] : existing,
      };
    }
    throw err;
  }
}

async function patchWebhookEvent(eventId, body, requestFn) {
  const req = requestFn || supabaseRequest;
  const rows = await req(
    `saas_square_webhook_events?event_id=eq.${encodeURIComponent(eventId)}`,
    { method: "PATCH", body }
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

module.exports = {
  patchTenant,
  getOnboardingById,
  getOnboardingByInvoice,
  getOnboardingByPayment,
  getLatestOnboardingForTenant,
  getTenantById,
  insertOnboarding,
  insertWebhookEvent,
  isUniqueViolation,
  listOpenOnboardingForTenant,
  patchOnboarding,
  patchWebhookEvent,
};
