/**
 * Step 3E-C17-C — tenant contact field normalization (shared by contact CRUD handlers).
 */

const CONTACT_TYPES = new Set([
  "homeowner",
  "general_contractor",
  "designer",
  "property_manager",
  "business",
  "supplier",
  "other",
]);

const CONTACT_SOURCES = new Set(["manual", "quote", "invoice", "import", "public_form"]);
const CONTACT_STATUSES = new Set(["active", "archived"]);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function trimStr(value, maxLen) {
  const s = String(value ?? "").trim();
  if (!maxLen) return s;
  return s.slice(0, maxLen);
}

function normalizePhoneDigits(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

function deriveDisplayName(fields) {
  const company = trimStr(fields.company_name);
  if (company) return company.slice(0, 500);
  const first = trimStr(fields.first_name);
  const last = trimStr(fields.last_name);
  const full = [first, last].filter(Boolean).join(" ").trim();
  if (full) return full.slice(0, 500);
  const email = trimStr(fields.email);
  if (email) return email.slice(0, 500);
  const phone = trimStr(fields.phone);
  if (phone) return phone.slice(0, 500);
  return "Unnamed Contact";
}

function normalizeContactInput(body, { isInsert } = {}) {
  const first_name = trimStr(body?.first_name, 200) || null;
  const last_name = trimStr(body?.last_name, 200) || null;
  const company_name = trimStr(body?.company_name, 300) || null;
  const emailRaw = trimStr(body?.email, 320);
  const email = emailRaw ? emailRaw.toLowerCase() : null;
  const phone = trimStr(body?.phone, 40) || null;
  const phone_normalized = phone ? normalizePhoneDigits(phone) || null : null;
  let state = trimStr(body?.state, 32) || null;
  if (state && state.length === 2) state = state.toUpperCase();

  let contact_type = trimStr(body?.contact_type, 64).toLowerCase() || "homeowner";
  if (!CONTACT_TYPES.has(contact_type)) contact_type = "homeowner";

  let status = trimStr(body?.status, 32).toLowerCase() || "active";
  if (!CONTACT_STATUSES.has(status)) status = "active";

  const displayInput = trimStr(body?.display_name, 500);
  const display_name = displayInput || deriveDisplayName({ company_name, first_name, last_name, email, phone });

  const row = {
    display_name,
    first_name,
    last_name,
    company_name,
    contact_type,
    email,
    phone,
    phone_normalized: phone_normalized || null,
    address_line1: trimStr(body?.address_line1, 300) || null,
    address_line2: trimStr(body?.address_line2, 300) || null,
    city: trimStr(body?.city, 120) || null,
    state,
    postal_code: trimStr(body?.postal_code, 20) || null,
    country: trimStr(body?.country, 2).toUpperCase() || "US",
    notes: trimStr(body?.notes, 4000) || null,
    status,
  };

  if (isInsert) {
    row.source = "manual";
  }

  return row;
}

function serializeContact(row) {
  if (!row || typeof row !== "object") return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    display_name: row.display_name || "",
    first_name: row.first_name || null,
    last_name: row.last_name || null,
    company_name: row.company_name || null,
    contact_type: row.contact_type || "homeowner",
    email: row.email || null,
    phone: row.phone || null,
    address_line1: row.address_line1 || null,
    address_line2: row.address_line2 || null,
    city: row.city || null,
    state: row.state || null,
    postal_code: row.postal_code || null,
    country: row.country || "US",
    notes: row.notes || null,
    source: row.source || "manual",
    status: row.status || "active",
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
    last_activity_at: row.last_activity_at || null,
  };
}

module.exports = {
  CONTACT_TYPES,
  CONTACT_SOURCES,
  CONTACT_STATUSES,
  UUID_RE,
  trimStr,
  normalizePhoneDigits,
  deriveDisplayName,
  normalizeContactInput,
  serializeContact,
};
