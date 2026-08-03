/**
 * CH-011C — Contract Signer helpers (create / update / delete / list).
 * Draft-envelope roster only. No email, tokens, PDF, or signature capture.
 */

"use strict";

const { supabaseRequest } = require("./supabase-admin");

const API_VERSION = "ch-011c-v1";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const SIGNER_ROLES = new Set(["owner", "customer", "additional"]);
const SIGNER_STATUSES = new Set(["pending"]);
const AUTH_METHODS = new Set(["email_link", "in_app"]);

function trimField(value) {
  return String(value ?? "").trim();
}

function validUuid(value) {
  return UUID_RE.test(trimField(value));
}

function unknownKeys(input, allowed) {
  return Object.keys(input || {}).filter((key) => !allowed.has(key));
}

function normalizeEmail(value) {
  return trimField(value).toLowerCase();
}

function validEmail(value) {
  const email = normalizeEmail(value);
  return Boolean(email) && email.length <= 320 && EMAIL_RE.test(email);
}

function serializeSigner(row) {
  if (!row?.id) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    envelope_id: row.envelope_id,
    package_id: row.package_id,
    project_id: row.project_id,
    role: trimField(row.role),
    party_name: trimField(row.party_name),
    email: normalizeEmail(row.email),
    phone: trimField(row.phone),
    sign_order: Number(row.sign_order),
    status: trimField(row.status) || "pending",
    auth_method: trimField(row.auth_method),
    is_required: row.is_required !== false,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

async function loadEnvelopeForTenant(tenantId, envelopeId) {
  const rows = await supabaseRequest(
    `tenant_contract_envelopes?tenant_id=eq.${encodeURIComponent(tenantId)}` +
      `&id=eq.${encodeURIComponent(envelopeId)}` +
      `&select=id,tenant_id,package_id,project_id,quote_id,status,created_at,updated_at` +
      `&limit=1`,
    { method: "GET" }
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function loadSignerForTenant(tenantId, signerId) {
  const rows = await supabaseRequest(
    `tenant_contract_signers?tenant_id=eq.${encodeURIComponent(tenantId)}` +
      `&id=eq.${encodeURIComponent(signerId)}` +
      `&select=*` +
      `&limit=1`,
    { method: "GET" }
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function listSignersForEnvelope(tenantId, envelopeId) {
  const rows = await supabaseRequest(
    `tenant_contract_signers?tenant_id=eq.${encodeURIComponent(tenantId)}` +
      `&envelope_id=eq.${encodeURIComponent(envelopeId)}` +
      `&select=*` +
      `&order=sign_order.asc,created_at.asc,id.asc`,
    { method: "GET" }
  );
  return (Array.isArray(rows) ? rows : []).map(serializeSigner).filter(Boolean);
}

function validateSignerFields(input, { partial = false } = {}) {
  const out = {};

  if (!partial || Object.prototype.hasOwnProperty.call(input, "role")) {
    const role = trimField(input.role).toLowerCase();
    if (!SIGNER_ROLES.has(role)) {
      return { error: "Invalid role", code: "invalid_role" };
    }
    out.role = role;
  }

  if (!partial || Object.prototype.hasOwnProperty.call(input, "party_name")) {
    const partyName = trimField(input.party_name);
    if (!partyName) {
      return { error: "party_name is required", code: "blank_name" };
    }
    if (partyName.length > 200) {
      return { error: "party_name is too long", code: "invalid_name" };
    }
    out.party_name = partyName;
  }

  if (!partial || Object.prototype.hasOwnProperty.call(input, "email")) {
    if (!validEmail(input.email)) {
      return { error: "Valid email is required", code: "invalid_email" };
    }
    out.email = normalizeEmail(input.email);
  }

  if (!partial || Object.prototype.hasOwnProperty.call(input, "phone")) {
    const phone = trimField(input.phone);
    if (phone.length > 40) {
      return { error: "phone is too long", code: "invalid_phone" };
    }
    out.phone = phone;
  }

  if (!partial || Object.prototype.hasOwnProperty.call(input, "sign_order")) {
    const order = Number(input.sign_order);
    if (!Number.isSafeInteger(order) || order < 1) {
      return { error: "sign_order must be an integer >= 1", code: "invalid_sign_order" };
    }
    out.sign_order = order;
  }

  if (!partial || Object.prototype.hasOwnProperty.call(input, "auth_method")) {
    const method = trimField(input.auth_method).toLowerCase();
    if (!AUTH_METHODS.has(method)) {
      return { error: "Invalid auth_method", code: "invalid_auth_method" };
    }
    out.auth_method = method;
  }

  if (!partial || Object.prototype.hasOwnProperty.call(input, "is_required")) {
    if (typeof input.is_required !== "boolean") {
      return { error: "is_required must be a boolean", code: "invalid_is_required" };
    }
    out.is_required = input.is_required;
  }

  return { fields: out };
}

async function createSigner({ tenantId, envelopeId, input }) {
  const envelope = await loadEnvelopeForTenant(tenantId, envelopeId);
  if (!envelope?.id) {
    return {
      ok: false,
      status: 404,
      error: "Envelope not found",
      code: "not_found",
    };
  }
  if (trimField(envelope.status).toLowerCase() !== "draft") {
    return {
      ok: false,
      status: 409,
      error: "Signers can only be added to draft envelopes",
      code: "envelope_not_draft",
      envelope_status: envelope.status,
    };
  }

  const validated = validateSignerFields(input, { partial: false });
  if (validated.error) {
    return {
      ok: false,
      status: 400,
      error: validated.error,
      code: validated.code,
    };
  }

  let inserted = null;
  try {
    const rows = await supabaseRequest(`tenant_contract_signers`, {
      method: "POST",
      body: {
        tenant_id: tenantId,
        envelope_id: envelopeId,
        package_id: envelope.package_id,
        project_id: envelope.project_id,
        role: validated.fields.role,
        party_name: validated.fields.party_name,
        email: validated.fields.email,
        phone: validated.fields.phone || "",
        sign_order: validated.fields.sign_order,
        status: "pending",
        auth_method: validated.fields.auth_method,
        is_required:
          validated.fields.is_required != null
            ? validated.fields.is_required
            : validated.fields.role === "customer",
      },
    });
    inserted = Array.isArray(rows) ? rows[0] : rows;
  } catch (err) {
    const text = String(err?.message || err?.supabaseRaw || "");
    if (/duplicate|unique|23505/i.test(text)) {
      return {
        ok: false,
        status: 409,
        error: "Duplicate email for this envelope",
        code: "duplicate_email",
      };
    }
    throw err;
  }

  if (!inserted?.id) {
    return {
      ok: false,
      status: 500,
      error: "Could not create signer",
      code: "insert_failed",
    };
  }

  return { ok: true, signer: serializeSigner(inserted) };
}

async function updateSigner({ tenantId, signerId, expectedUpdatedAt, input }) {
  const existing = await loadSignerForTenant(tenantId, signerId);
  if (!existing?.id) {
    return {
      ok: false,
      status: 404,
      error: "Signer not found",
      code: "not_found",
    };
  }

  const envelope = await loadEnvelopeForTenant(tenantId, existing.envelope_id);
  if (!envelope?.id) {
    return {
      ok: false,
      status: 404,
      error: "Envelope not found",
      code: "not_found",
    };
  }
  if (trimField(envelope.status).toLowerCase() !== "draft") {
    return {
      ok: false,
      status: 409,
      error: "Signers can only be updated on draft envelopes",
      code: "envelope_not_draft",
      envelope_status: envelope.status,
    };
  }

  const expected = trimField(expectedUpdatedAt);
  if (!expected || expected !== trimField(existing.updated_at)) {
    return {
      ok: false,
      status: 409,
      error: "Signer changed. Reload before updating.",
      code: "stale_updated_at",
    };
  }

  const validated = validateSignerFields(input, { partial: true });
  if (validated.error) {
    return {
      ok: false,
      status: 400,
      error: validated.error,
      code: validated.code,
    };
  }
  if (!Object.keys(validated.fields).length) {
    return {
      ok: false,
      status: 400,
      error: "No editable fields supplied",
      code: "no_fields",
    };
  }

  let updated = null;
  try {
    const rows = await supabaseRequest(
      `tenant_contract_signers?tenant_id=eq.${encodeURIComponent(tenantId)}` +
        `&id=eq.${encodeURIComponent(signerId)}`,
      {
        method: "PATCH",
        body: validated.fields,
      }
    );
    updated = Array.isArray(rows) ? rows[0] : rows;
  } catch (err) {
    const text = String(err?.message || err?.supabaseRaw || "");
    if (/duplicate|unique|23505/i.test(text)) {
      return {
        ok: false,
        status: 409,
        error: "Duplicate email for this envelope",
        code: "duplicate_email",
      };
    }
    throw err;
  }

  if (!updated?.id) {
    return {
      ok: false,
      status: 500,
      error: "Could not update signer",
      code: "update_failed",
    };
  }

  return { ok: true, signer: serializeSigner(updated) };
}

async function deleteSigner({ tenantId, signerId, expectedUpdatedAt }) {
  const existing = await loadSignerForTenant(tenantId, signerId);
  if (!existing?.id) {
    return {
      ok: false,
      status: 404,
      error: "Signer not found",
      code: "not_found",
    };
  }

  const envelope = await loadEnvelopeForTenant(tenantId, existing.envelope_id);
  if (!envelope?.id) {
    return {
      ok: false,
      status: 404,
      error: "Envelope not found",
      code: "not_found",
    };
  }
  if (trimField(envelope.status).toLowerCase() !== "draft") {
    return {
      ok: false,
      status: 409,
      error: "Signers can only be removed from draft envelopes",
      code: "envelope_not_draft",
      envelope_status: envelope.status,
    };
  }

  const expected = trimField(expectedUpdatedAt);
  if (!expected || expected !== trimField(existing.updated_at)) {
    return {
      ok: false,
      status: 409,
      error: "Signer changed. Reload before deleting.",
      code: "stale_updated_at",
    };
  }

  await supabaseRequest(
    `tenant_contract_signers?tenant_id=eq.${encodeURIComponent(tenantId)}` +
      `&id=eq.${encodeURIComponent(signerId)}`,
    {
      method: "DELETE",
      headers: { Prefer: "return=minimal" },
    }
  );

  return {
    ok: true,
    deleted_id: signerId,
    envelope_id: existing.envelope_id,
  };
}

module.exports = {
  API_VERSION,
  SIGNER_ROLES,
  SIGNER_STATUSES,
  AUTH_METHODS,
  validUuid,
  unknownKeys,
  trimField,
  normalizeEmail,
  validEmail,
  serializeSigner,
  validateSignerFields,
  loadEnvelopeForTenant,
  loadSignerForTenant,
  listSignersForEnvelope,
  createSigner,
  updateSigner,
  deleteSigner,
};
