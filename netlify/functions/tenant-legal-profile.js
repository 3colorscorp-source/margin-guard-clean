/**
 * CH-001A — Tenant legal profile (Owner/Admin, session-scoped).
 * GET + POST. Separate from tenant branding / snapshot.
 */

const { supabaseRequest } = require("./_lib/supabase-admin");
const { readSessionFromEvent } = require("./_lib/session");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");
const {
  resolveMembershipByEmail,
  membershipRole,
  membershipIsActive,
} = require("./_lib/membership-resolve");
const { throwGuard } = require("./_lib/tenant-device-guard");
const {
  evaluateLegalProfileReadiness,
  serializeLegalProfileForApi,
} = require("./_lib/contract-source-assembler");

const OWNER_ADMIN_ROLES = new Set(["owner", "admin"]);

const LICENSE_STATUSES = new Set(["licensed", "not_required", "exempt", "unknown"]);
const CONTRACT_LANGUAGES = new Set(["en", "es", "bilingual"]);

const ALLOWED_BODY_KEYS = new Set([
  "legal_business_name",
  "dba_name",
  "entity_type",
  "business_address_line1",
  "business_address_line2",
  "business_city",
  "business_state",
  "business_postal_code",
  "mailing_same_as_business",
  "mailing_address_line1",
  "mailing_address_line2",
  "mailing_city",
  "mailing_state",
  "mailing_postal_code",
  "business_phone",
  "business_email",
  "contractor_license_status",
  "contractor_license_number",
  "contractor_license_classification",
  "contractor_license_state",
  "contractor_license_expiration",
  "bond_company",
  "bond_number",
  "general_liability_carrier",
  "general_liability_policy_number",
  "workers_comp_status",
  "workers_comp_carrier",
  "workers_comp_policy_number",
  "authorized_signer_name",
  "authorized_signer_title",
  "primary_service_state",
  "timezone",
  "default_contract_language",
]);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function trimField(value, maxLen) {
  const s = String(value ?? "").trim();
  if (!maxLen) return s;
  return s.slice(0, maxLen);
}

function parseBody(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return null;
  }
}

function findUnknownBodyKeys(body) {
  const unknown = [];
  if (!body || typeof body !== "object") return unknown;
  for (const key of Object.keys(body)) {
    if (!ALLOWED_BODY_KEYS.has(key)) unknown.push(key);
  }
  return unknown;
}

function parseOptionalDate(raw) {
  if (raw == null || raw === "") return null;
  const s = String(raw).trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return { error: "contractor_license_expiration must be YYYY-MM-DD" };
  const d = new Date(`${s}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return { error: "contractor_license_expiration is invalid" };
  return { value: s };
}

async function requireOwnerOrAdmin(event) {
  const session = readSessionFromEvent(event);
  if (!session?.e || !session?.c) {
    throwGuard(401, "Unauthorized", "no_session");
  }
  const tenant = await resolveTenantFromSession(session);
  if (!tenant?.id) {
    throwGuard(422, "Tenant not found for this session.", "tenant_not_found");
  }
  const membership = await resolveMembershipByEmail(supabaseRequest, tenant.id, session.e);
  if (!membership?.id) {
    throwGuard(403, "Membership not found", "membership_not_found");
  }
  if (!membershipIsActive(membership)) {
    throwGuard(403, "Membership is not active", "membership_inactive");
  }
  const role = membershipRole(membership);
  if (!OWNER_ADMIN_ROLES.has(role)) {
    throwGuard(403, "Owner or admin membership required", "owner_required");
  }
  return { tenant, membership };
}

async function loadBrandingHints(tenantId) {
  try {
    const rows = await supabaseRequest(
      `tenant_branding?tenant_id=eq.${encodeURIComponent(tenantId)}&select=business_name,business_email,business_phone,business_address&limit=1`,
      { method: "GET" }
    );
    const row = Array.isArray(rows) && rows[0] ? rows[0] : null;
    if (!row) return {};
    return {
      business_name: trimField(row.business_name, 200),
      business_email: trimField(row.business_email, 200),
      business_phone: trimField(row.business_phone, 120),
      business_address: trimField(row.business_address, 200),
    };
  } catch (_err) {
    return {};
  }
}

async function loadProfileRow(tenantId) {
  const rows = await supabaseRequest(
    `tenant_legal_profiles?tenant_id=eq.${encodeURIComponent(tenantId)}&select=*&limit=1`,
    { method: "GET" }
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

function normalizeLegalProfileInput(body) {
  const licenseStatus = trimField(body.contractor_license_status, 32).toLowerCase() || "unknown";
  if (!LICENSE_STATUSES.has(licenseStatus)) {
    return { error: "Invalid contractor_license_status", code: "invalid_enum" };
  }

  const lang = trimField(body.default_contract_language, 16).toLowerCase() || "en";
  if (!CONTRACT_LANGUAGES.has(lang)) {
    return { error: "Invalid default_contract_language", code: "invalid_enum" };
  }

  const email = trimField(body.business_email, 200);
  if (email && !EMAIL_RE.test(email)) {
    return { error: "Invalid business_email", code: "invalid_email" };
  }

  const dateParsed = parseOptionalDate(body.contractor_license_expiration);
  if (dateParsed && dateParsed.error) {
    return { error: dateParsed.error, code: "invalid_date" };
  }

  const profile = {
    legal_business_name: trimField(body.legal_business_name, 200),
    dba_name: trimField(body.dba_name, 200),
    entity_type: trimField(body.entity_type, 120),
    business_address_line1: trimField(body.business_address_line1, 200),
    business_address_line2: trimField(body.business_address_line2, 200),
    business_city: trimField(body.business_city, 120),
    business_state: trimField(body.business_state, 80),
    business_postal_code: trimField(body.business_postal_code, 32),
    mailing_same_as_business: body.mailing_same_as_business !== false,
    mailing_address_line1: trimField(body.mailing_address_line1, 200),
    mailing_address_line2: trimField(body.mailing_address_line2, 200),
    mailing_city: trimField(body.mailing_city, 120),
    mailing_state: trimField(body.mailing_state, 80),
    mailing_postal_code: trimField(body.mailing_postal_code, 32),
    business_phone: trimField(body.business_phone, 120),
    business_email: email,
    contractor_license_status: licenseStatus,
    contractor_license_number: trimField(body.contractor_license_number, 100),
    contractor_license_classification: trimField(body.contractor_license_classification, 120),
    contractor_license_state: trimField(body.contractor_license_state, 80),
    contractor_license_expiration: dateParsed ? dateParsed.value : null,
    bond_company: trimField(body.bond_company, 200),
    bond_number: trimField(body.bond_number, 100),
    general_liability_carrier: trimField(body.general_liability_carrier, 200),
    general_liability_policy_number: trimField(body.general_liability_policy_number, 100),
    workers_comp_status: trimField(body.workers_comp_status, 80),
    workers_comp_carrier: trimField(body.workers_comp_carrier, 200),
    workers_comp_policy_number: trimField(body.workers_comp_policy_number, 100),
    authorized_signer_name: trimField(body.authorized_signer_name, 200),
    authorized_signer_title: trimField(body.authorized_signer_title, 120),
    primary_service_state: trimField(body.primary_service_state, 80),
    timezone: trimField(body.timezone, 80),
    default_contract_language: lang,
  };

  if (licenseStatus === "licensed") {
    if (!profile.contractor_license_number || !profile.contractor_license_state) {
      return {
        error: "Licensed status requires contractor_license_number and contractor_license_state",
        code: "license_fields_required",
      };
    }
  }

  return { profile };
}

async function upsertProfile(tenantId, profile) {
  const existing = await loadProfileRow(tenantId);
  const payload = { ...profile, tenant_id: tenantId };

  if (existing?.id) {
    const rows = await supabaseRequest(
      `tenant_legal_profiles?id=eq.${encodeURIComponent(existing.id)}&tenant_id=eq.${encodeURIComponent(tenantId)}`,
      { method: "PATCH", body: profile }
    );
    return Array.isArray(rows) && rows[0] ? rows[0] : { ...existing, ...profile };
  }

  const rows = await supabaseRequest("tenant_legal_profiles", {
    method: "POST",
    body: payload,
  });
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

exports.handler = async (event) => {
  try {
    const method = event.httpMethod;
    if (method !== "GET" && method !== "POST") {
      return json(405, { ok: false, error: "Method not allowed" });
    }

    const { tenant } = await requireOwnerOrAdmin(event);
    const tenantId = String(tenant.id);

    if (method === "GET") {
      const row = await loadProfileRow(tenantId);
      const profile = serializeLegalProfileForApi(row);
      const readiness = evaluateLegalProfileReadiness(profile);
      const hints = await loadBrandingHints(tenantId);
      const prefill_hints = {
        dba_name: hints.business_name || "",
        legal_business_name: hints.business_name || "",
        business_phone: hints.business_phone || "",
        business_email: hints.business_email || "",
        business_address_line1: hints.business_address || "",
      };
      return json(200, { ok: true, profile, readiness, prefill_hints });
    }

    const body = parseBody(event.body);
    if (body == null) {
      return json(400, { ok: false, error: "Invalid JSON", code: "invalid_json" });
    }
    if (body.tenant_id != null) {
      return json(400, {
        ok: false,
        error: "tenant_id must not be sent by client",
        code: "tenant_id_forbidden",
      });
    }

    const unknown = findUnknownBodyKeys(body);
    if (unknown.length) {
      return json(400, {
        ok: false,
        error: "Unknown fields rejected",
        code: "unknown_fields",
        fields: unknown,
      });
    }

    const normalized = normalizeLegalProfileInput(body);
    if (normalized.error) {
      return json(400, {
        ok: false,
        error: normalized.error,
        code: normalized.code || "validation_failed",
        ...(normalized.missing ? { missing: normalized.missing } : {}),
      });
    }

    const saved = await upsertProfile(tenantId, normalized.profile);
    if (!saved) {
      return json(500, { ok: false, error: "Profile save failed", code: "save_failed" });
    }

    const profile = serializeLegalProfileForApi(saved);
    const readiness = evaluateLegalProfileReadiness(profile);
    return json(200, { ok: true, profile, readiness });
  } catch (err) {
    if (err?.isGuardError) {
      return json(err.statusCode || 403, { ok: false, error: err.message, code: err.code });
    }
    return json(500, { ok: false, error: err.message || "Server error" });
  }
};
