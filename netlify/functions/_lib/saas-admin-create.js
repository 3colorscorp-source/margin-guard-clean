/**
 * Platform-admin pending SaaS customer create.
 * Inserts a tenant without writing plan_status so the database default (pending) applies.
 * Activation remains the trusted Square path only.
 */
"use strict";

const crypto = require("crypto");
const { supabaseRequest, toSlug } = require("./supabase-admin");
const { resolveMembershipByEmail } = require("./membership-resolve");
const { ANNUAL_AMOUNT_CENTS, ANNUAL_CURRENCY } = require("./square-saas-policy");
const { registerSquareInvoiceForPendingTenant } = require("./saas-square-register");
const { listSaasCustomers, serializeCustomer, pendingCreateEnvelope } = require("./saas-admin-customers");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CREATE_ALLOWED = new Set([
  "business_name",
  "owner_name",
  "owner_email",
  "business_slug",
  "square_invoice_id",
  "terms_confirmed",
]);
const TENANT_SELECT = "id,slug,name,owner_email,plan_status,created_at,updated_at";
const OWNER_SELECT = "id,tenant_id,email,role,status,auth_user_id,invited_at,display_name,full_name";

function normEmail(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function normText(value, maxLen) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, maxLen || 200);
}

function hasExtraKeys(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return true;
  return Object.keys(body).some((key) => !CREATE_ALLOWED.has(key));
}

function newId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (ch) {
    const n = (Math.random() * 16) | 0;
    const v = ch === "x" ? n : (n & 0x3) | 0x8;
    return v.toString(16);
  });
}

function isPendingPlan(tenant) {
  return String((tenant && tenant.plan_status) || "pending").toLowerCase() === "pending";
}

async function getTenantBySlug(slug, requestFn) {
  const req = requestFn || supabaseRequest;
  const rows = await req(
    `tenants?slug=eq.${encodeURIComponent(slug)}&select=${TENANT_SELECT}&limit=1`
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function listOwnerProfilesByEmail(email, requestFn) {
  const req = requestFn || supabaseRequest;
  const em = normEmail(email);
  const rows = await req(
    `profiles?email=eq.${encodeURIComponent(em)}&role=eq.owner&select=${OWNER_SELECT}`
  );
  return Array.isArray(rows) ? rows : [];
}

async function createPendingSaasCustomer(body, deps = {}) {
  if (hasExtraKeys(body)) {
    return { statusCode: 400, body: { ok: false, error: "invalid_request" } };
  }
  if (body.terms_confirmed !== true) {
    return { statusCode: 400, body: { ok: false, error: "terms_required" } };
  }

  const businessName = normText(body.business_name, 120);
  const ownerName = normText(body.owner_name, 120);
  const ownerEmail = normEmail(body.owner_email);
  const slug = toSlug(body.business_slug || businessName);
  if (businessName.length < 2) return { statusCode: 400, body: { ok: false, error: "invalid_business_name" } };
  if (ownerName.length < 2) return { statusCode: 400, body: { ok: false, error: "invalid_owner_name" } };
  if (!EMAIL_RE.test(ownerEmail)) return { statusCode: 400, body: { ok: false, error: "invalid_owner_email" } };
  if (!slug || slug.length < 3 || !SLUG_RE.test(slug)) {
    return { statusCode: 400, body: { ok: false, error: "invalid_slug" } };
  }

  const req = deps.supabaseRequest || supabaseRequest;
  const existingSlug = await getTenantBySlug(slug, req);
  const ownerProfiles = await listOwnerProfilesByEmail(ownerEmail, req);

  if (ownerProfiles.length > 1) {
    return { statusCode: 409, body: { ok: false, error: "ambiguous_owner" } };
  }

  let tenant = existingSlug;
  if (existingSlug) {
    if (normEmail(existingSlug.owner_email) !== ownerEmail) {
      return { statusCode: 409, body: { ok: false, error: "duplicate_slug" } };
    }
    if (!isPendingPlan(existingSlug)) {
      return { statusCode: 409, body: { ok: false, error: "duplicate_slug" } };
    }
  }

  if (ownerProfiles.length === 1) {
    const existingOwner = ownerProfiles[0];
    if (tenant && String(existingOwner.tenant_id) !== String(tenant.id)) {
      return { statusCode: 409, body: { ok: false, error: "ambiguous_owner" } };
    }
    if (!tenant) {
      return { statusCode: 409, body: { ok: false, error: "ambiguous_owner" } };
    }
  }

  if (!tenant) {
    const inserted = await req("tenants", {
      method: "POST",
      body: {
        id: newId(),
        slug,
        name: businessName,
        owner_email: ownerEmail,
      },
    });
    tenant = Array.isArray(inserted) ? inserted[0] : inserted;
  }
  if (!tenant?.id) return { statusCode: 500, body: { ok: false, error: "tenant_create_failed" } };
  if (!isPendingPlan(tenant)) {
    return { statusCode: 409, body: { ok: false, error: "tenant_not_pending" } };
  }

  let profile = await resolveMembershipByEmail(req, tenant.id, ownerEmail);
  if (profile && (profile.role !== "owner" || String(profile.email || "").toLowerCase() !== ownerEmail)) {
    return { statusCode: 409, body: { ok: false, error: "ambiguous_owner" } };
  }
  if (!profile) {
    const created = await req("profiles", {
      method: "POST",
      body: {
        tenant_id: tenant.id,
        email: ownerEmail,
        role: "owner",
        status: "active",
        display_name: ownerName,
        full_name: ownerName,
      },
    });
    profile = Array.isArray(created) ? created[0] : created;
  }
  if (!profile?.id) return { statusCode: 500, body: { ok: false, error: "owner_profile_failed" } };

  const register = deps.registerSquareInvoiceForPendingTenant || registerSquareInvoiceForPendingTenant;
  const registered = await register(
    {
      tenantId: tenant.id,
      squareInvoiceId: body.square_invoice_id,
      termsConfirmed: true,
    },
    deps
  );

  const customers = await listSaasCustomers(deps);
  const customer = customers.find((row) => row.tenant_id === tenant.id) || serializeCustomer(tenant, null, profile);

  return {
    statusCode: registered.statusCode === 200 ? 200 : registered.statusCode,
    body: pendingCreateEnvelope({
      ok: registered.body && registered.body.ok === true,
      customer,
      register: registered.body || registered,
    }),
  };
}

module.exports = {
  CREATE_ALLOWED,
  createPendingSaasCustomer,
};
