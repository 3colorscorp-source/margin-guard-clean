/**
 * CH-011B — Contract Envelope helpers (create + list).
 * Envelope = signing process for one immutable Contract Package.
 * No signers, email, PDF, Stripe, invoices, or Payment Intents.
 */

"use strict";

const { supabaseRequest } = require("./supabase-admin");

const API_VERSION = "ch-011b-v1";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ENVELOPE_STATUSES = new Set([
  "draft",
  "sent",
  "opened",
  "completed",
  "declined",
  "expired",
  "cancelled",
]);

const ACTIVE_ENVELOPE_STATUSES = new Set(["draft", "sent", "opened"]);

const DEFAULT_EXPIRES_DAYS = 30;

function trimField(value) {
  return String(value ?? "").trim();
}

function validUuid(value) {
  return UUID_RE.test(trimField(value));
}

function unknownKeys(input, allowed) {
  return Object.keys(input || {}).filter((key) => !allowed.has(key));
}

function isActiveEnvelopeStatus(status) {
  return ACTIVE_ENVELOPE_STATUSES.has(trimField(status).toLowerCase());
}

function serializeEnvelope(row) {
  if (!row?.id) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    package_id: row.package_id,
    project_id: row.project_id,
    quote_id: row.quote_id,
    status: trimField(row.status),
    created_by: row.created_by || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
    expires_at: row.expires_at || null,
    completed_at: row.completed_at || null,
    cancelled_at: row.cancelled_at || null,
    declined_at: row.declined_at || null,
    metadata:
      row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
        ? row.metadata
        : {},
  };
}

async function loadPackageForTenant(tenantId, packageId) {
  const rows = await supabaseRequest(
    `tenant_contract_packages?tenant_id=eq.${encodeURIComponent(tenantId)}` +
      `&id=eq.${encodeURIComponent(packageId)}` +
      `&select=id,tenant_id,project_id,quote_id,version,status,created_at,updated_at` +
      `&limit=1`,
    { method: "GET" }
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function listActiveEnvelopes(tenantId, packageId) {
  const rows = await supabaseRequest(
    `tenant_contract_envelopes?tenant_id=eq.${encodeURIComponent(tenantId)}` +
      `&package_id=eq.${encodeURIComponent(packageId)}` +
      `&status=in.(draft,sent,opened)` +
      `&select=id,status,created_at` +
      `&order=created_at.desc`,
    { method: "GET" }
  );
  return Array.isArray(rows) ? rows : [];
}

async function listCompletedEnvelopes(tenantId, packageId) {
  const rows = await supabaseRequest(
    `tenant_contract_envelopes?tenant_id=eq.${encodeURIComponent(tenantId)}` +
      `&package_id=eq.${encodeURIComponent(packageId)}` +
      `&status=eq.completed` +
      `&select=id,status,completed_at` +
      `&limit=1`,
    { method: "GET" }
  );
  return Array.isArray(rows) ? rows : [];
}

async function listEnvelopesForPackage(tenantId, packageId) {
  const rows = await supabaseRequest(
    `tenant_contract_envelopes?tenant_id=eq.${encodeURIComponent(tenantId)}` +
      `&package_id=eq.${encodeURIComponent(packageId)}` +
      `&select=id,tenant_id,package_id,project_id,quote_id,status,created_by,created_at,updated_at,expires_at,completed_at,cancelled_at,declined_at,metadata` +
      `&order=created_at.desc`,
    { method: "GET" }
  );
  return (Array.isArray(rows) ? rows : []).map(serializeEnvelope).filter(Boolean);
}

function defaultExpiresAt(from = new Date()) {
  const d = new Date(from.getTime());
  d.setUTCDate(d.getUTCDate() + DEFAULT_EXPIRES_DAYS);
  return d.toISOString();
}

/**
 * Create a draft envelope for a ready package.
 * Blocks: missing package, package not ready, active envelope exists,
 * completed envelope already exists for package.
 */
async function createDraftEnvelope({ tenantId, packageId, createdBy }) {
  const pkg = await loadPackageForTenant(tenantId, packageId);
  if (!pkg?.id) {
    return {
      ok: false,
      status: 404,
      error: "Contract package not found",
      code: "not_found",
    };
  }

  const pkgStatus = trimField(pkg.status).toLowerCase();
  if (pkgStatus !== "ready") {
    return {
      ok: false,
      status: 422,
      error: "Package must be ready to create an envelope",
      code: "package_not_ready",
      package_status: pkgStatus,
    };
  }

  const completed = await listCompletedEnvelopes(tenantId, packageId);
  if (completed.length) {
    return {
      ok: false,
      status: 409,
      error: "Package already has a completed envelope",
      code: "package_envelope_completed",
    };
  }

  const active = await listActiveEnvelopes(tenantId, packageId);
  if (active.length) {
    return {
      ok: false,
      status: 409,
      error: "An active envelope already exists for this package",
      code: "active_envelope_exists",
      active_envelope_id: active[0].id,
      active_status: active[0].status,
    };
  }

  let inserted = null;
  try {
    const rows = await supabaseRequest(`tenant_contract_envelopes`, {
      method: "POST",
      body: {
        tenant_id: tenantId,
        package_id: packageId,
        project_id: pkg.project_id,
        quote_id: pkg.quote_id,
        status: "draft",
        created_by: createdBy || null,
        expires_at: defaultExpiresAt(),
        metadata: {},
      },
    });
    inserted = Array.isArray(rows) ? rows[0] : rows;
  } catch (err) {
    const text = String(err?.message || err?.supabaseRaw || "");
    if (/duplicate|unique|23505/i.test(text)) {
      return {
        ok: false,
        status: 409,
        error: "An active envelope already exists for this package",
        code: "active_envelope_exists",
      };
    }
    throw err;
  }

  if (!inserted?.id) {
    return {
      ok: false,
      status: 500,
      error: "Could not create envelope",
      code: "insert_failed",
    };
  }

  return {
    ok: true,
    envelope: serializeEnvelope(inserted),
  };
}

module.exports = {
  API_VERSION,
  ENVELOPE_STATUSES,
  ACTIVE_ENVELOPE_STATUSES,
  validUuid,
  unknownKeys,
  trimField,
  isActiveEnvelopeStatus,
  serializeEnvelope,
  loadPackageForTenant,
  listEnvelopesForPackage,
  listActiveEnvelopes,
  createDraftEnvelope,
  defaultExpiresAt,
};
