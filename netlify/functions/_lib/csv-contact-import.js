/**
 * Step 3E-C17-I — CSV contact import parse/map/classify (owner import v1).
 */

const {
  CONTACT_TYPES,
  trimStr,
  normalizePhoneDigits,
  deriveDisplayName,
  normalizeContactInput,
} = require("./tenant-contact-normalize");

const MAX_CSV_BYTES = 1024 * 1024;
const MAX_DATA_ROWS = 500;
const PREVIEW_ROW_LIMIT = 50;

const FORMULA_PREFIX_RE = /^[=+\-@]/;

const EXACT_HEADER_MAP = {
  name: "display_name",
  "full name": "display_name",
  "display name": "display_name",
  "given name": "first_name",
  "first name": "first_name",
  "family name": "last_name",
  "last name": "last_name",
  "organization name": "company_name",
  company: "company_name",
  "company name": "company_name",
  "e-mail address": "email",
  "email address": "email",
  email: "email",
  "mobile phone": "phone",
  phone: "phone",
  "phone number": "phone",
  "address 1 - street": "address_line1",
  street: "address_line1",
  address: "address_line1",
  "address 1 - extended address": "address_line2",
  "address 2": "address_line2",
  "address 1 - city": "city",
  city: "city",
  "address 1 - region": "state",
  state: "state",
  "address 1 - postal code": "postal_code",
  zip: "postal_code",
  "postal code": "postal_code",
  "address 1 - country": "country",
  country: "country",
  notes: "notes",
  note: "notes",
  "address 1 - formatted": "address_formatted",
};

function normalizeHeaderName(header) {
  return String(header || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function resolveHeaderField(header) {
  const normalized = normalizeHeaderName(header);
  if (!normalized) return null;
  if (EXACT_HEADER_MAP[normalized]) return EXACT_HEADER_MAP[normalized];
  if (/^e-?mail(\s+\d+)?\s*-\s*value$/.test(normalized)) return "email";
  if (/^phone(\s+\d+)?\s*-\s*value$/.test(normalized)) return "phone";
  return null;
}

function stripUtf8Bom(text) {
  const s = String(text ?? "");
  if (s.charCodeAt(0) === 0xfeff) return s.slice(1);
  if (s.startsWith("\uFEFF")) return s.slice(1);
  return s;
}

function sanitizeCellValue(value) {
  let s = String(value ?? "").trim();
  if (!s) return "";
  while (FORMULA_PREFIX_RE.test(s)) {
    s = s.slice(1).trimStart();
  }
  return s;
}

function parseCsvRecords(text) {
  const input = stripUtf8Bom(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const records = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      field = "";
      if (row.length > 1 || (row.length === 1 && row[0] !== "")) {
        records.push(row);
      }
      row = [];
      continue;
    }
    field += ch;
  }

  row.push(field);
  if (row.length > 1 || (row.length === 1 && row[0] !== "")) {
    records.push(row);
  }

  return records;
}

function buildHeaderMap(headers) {
  const map = {};
  headers.forEach((header, index) => {
    const field = resolveHeaderField(header);
    if (!field) return;
    if (map[field] == null) map[field] = index;
  });
  return map;
}

function pickField(row, headerMap, field) {
  const index = headerMap[field];
  if (index == null) return "";
  return sanitizeCellValue(row[index]);
}

function mapCsvRowToInput(row, headerMap, defaultContactType) {
  const raw = {
    display_name: pickField(row, headerMap, "display_name"),
    first_name: pickField(row, headerMap, "first_name"),
    last_name: pickField(row, headerMap, "last_name"),
    company_name: pickField(row, headerMap, "company_name"),
    email: pickField(row, headerMap, "email"),
    phone: pickField(row, headerMap, "phone"),
    address_line1: pickField(row, headerMap, "address_line1"),
    address_line2: pickField(row, headerMap, "address_line2"),
    city: pickField(row, headerMap, "city"),
    state: pickField(row, headerMap, "state"),
    postal_code: pickField(row, headerMap, "postal_code"),
    country: pickField(row, headerMap, "country"),
    notes: pickField(row, headerMap, "notes"),
    contact_type: defaultContactType,
  };

  const formatted = pickField(row, headerMap, "address_formatted");
  if (!raw.address_line1 && formatted) {
    raw.address_line1 = formatted;
  }

  return raw;
}

function hasUsefulIdentity(normalized, rawMapped) {
  const email = trimStr(normalized.email);
  const phone = trimStr(normalized.phone);
  if (email || phone) return true;
  const displayInput = trimStr(rawMapped?.display_name);
  const first = trimStr(normalized.first_name);
  const last = trimStr(normalized.last_name);
  const company = trimStr(normalized.company_name);
  return !!(displayInput || first || last || company);
}

function hasStoredContactIdentity(contact) {
  if (trimStr(contact?.email) || trimStr(contact?.phone)) return true;
  if (trimStr(contact?.first_name) || trimStr(contact?.last_name) || trimStr(contact?.company_name)) {
    return true;
  }
  const displayName = trimStr(contact?.display_name);
  return !!(displayName && displayName !== "Unnamed Contact");
}

function buildDuplicateIndex(activeContacts) {
  const byEmail = new Map();
  const byPhone = new Map();
  for (const contact of Array.isArray(activeContacts) ? activeContacts : []) {
    const email = trimStr(contact.email).toLowerCase();
    if (email) {
      byEmail.set(email, contact);
    }
    const phoneNorm = trimStr(contact.phone_normalized) || normalizePhoneDigits(contact.phone);
    if (phoneNorm) {
      byPhone.set(phoneNorm, contact);
    }
  }
  return { byEmail, byPhone };
}

function findDuplicateMatch(normalized, duplicateIndex, seenInCsv) {
  const email = trimStr(normalized.email).toLowerCase();
  if (email) {
    if (duplicateIndex.byEmail.has(email)) {
      return {
        type: "email",
        message: `Active contact with same email: ${duplicateIndex.byEmail.get(email).display_name || email}`,
        contact_id: duplicateIndex.byEmail.get(email).id || null,
      };
    }
    if (seenInCsv.emails.has(email)) {
      return { type: "email_csv", message: "Duplicate email within CSV file", contact_id: null };
    }
  }

  const phoneNorm = trimStr(normalized.phone_normalized) || normalizePhoneDigits(normalized.phone);
  if (phoneNorm) {
    if (duplicateIndex.byPhone.has(phoneNorm)) {
      const existing = duplicateIndex.byPhone.get(phoneNorm);
      return {
        type: "phone",
        message: `Active contact with same phone: ${existing.display_name || existing.phone || phoneNorm}`,
        contact_id: existing.id || null,
      };
    }
    if (seenInCsv.phones.has(phoneNorm)) {
      return { type: "phone_csv", message: "Duplicate phone within CSV file", contact_id: null };
    }
  }

  return null;
}

function trackCsvIdentity(normalized, seenInCsv) {
  const email = trimStr(normalized.email).toLowerCase();
  if (email) seenInCsv.emails.add(email);
  const phoneNorm = trimStr(normalized.phone_normalized) || normalizePhoneDigits(normalized.phone);
  if (phoneNorm) seenInCsv.phones.add(phoneNorm);
}

function toPreviewRow(classified) {
  const contact = classified.contact || {};
  return {
    row_index: classified.row_index,
    action: classified.action,
    reason: classified.reason || null,
    display_name: contact.display_name || "",
    email: contact.email || null,
    phone: contact.phone || null,
    city: contact.city || null,
    company_name: contact.company_name || null,
    duplicate_contact_id: classified.duplicate_contact_id || null,
  };
}

function parseAndClassifyContactImport(csvText, options = {}) {
  const byteLength = Buffer.byteLength(String(csvText ?? ""), "utf8");
  if (!String(csvText ?? "").trim()) {
    return { ok: false, code: "csv_text_required", error: "csv_text is required" };
  }
  if (byteLength > MAX_CSV_BYTES) {
    return {
      ok: false,
      code: "csv_too_large",
      error: `CSV exceeds maximum size of ${MAX_CSV_BYTES} bytes`,
    };
  }

  let defaultContactType = trimStr(options.defaultContactType, 64).toLowerCase() || "homeowner";
  if (!CONTACT_TYPES.has(defaultContactType)) {
    defaultContactType = "homeowner";
  }

  const records = parseCsvRecords(csvText);
  if (!records.length) {
    return { ok: false, code: "csv_empty", error: "CSV has no rows" };
  }

  const headers = records[0].map((h) => sanitizeCellValue(h));
  const headerMap = buildHeaderMap(headers);
  const dataRows = records.slice(1).filter((row) => row.some((cell) => sanitizeCellValue(cell)));

  if (dataRows.length > MAX_DATA_ROWS) {
    return {
      ok: false,
      code: "too_many_rows",
      error: `CSV exceeds maximum of ${MAX_DATA_ROWS} data rows`,
      total_rows: dataRows.length,
    };
  }

  const duplicateIndex = buildDuplicateIndex(options.activeContacts || []);
  const seenInCsv = { emails: new Set(), phones: new Set() };
  const classified = [];
  const counts = { create: 0, skip_duplicate: 0, skip_invalid: 0 };
  const importRows = [];
  const warnings = [];

  dataRows.forEach((row, index) => {
    const rowIndex = index + 1;
    const mapped = mapCsvRowToInput(row, headerMap, defaultContactType);
    const normalized = normalizeContactInput(mapped, { isInsert: true });

    if (!hasUsefulIdentity(normalized, mapped)) {
      counts.skip_invalid += 1;
      classified.push({
        row_index: rowIndex,
        action: "skip_invalid",
        reason: "no_identity",
        contact: normalized,
      });
      return;
    }

    const duplicate = findDuplicateMatch(normalized, duplicateIndex, seenInCsv);
    if (duplicate) {
      counts.skip_duplicate += 1;
      classified.push({
        row_index: rowIndex,
        action: "skip_duplicate",
        reason: duplicate.type,
        message: duplicate.message,
        duplicate_contact_id: duplicate.contact_id,
        contact: normalized,
      });
      warnings.push({ row_index: rowIndex, type: duplicate.type, message: duplicate.message });
      return;
    }

    trackCsvIdentity(normalized, seenInCsv);
    counts.create += 1;
    const duplicateKey = normalized.email
      ? normalized.email.toLowerCase()
      : normalized.phone_normalized || null;

    const importRow = {
      row_index: rowIndex,
      action: "create",
      contact: normalized,
      duplicate_key: duplicateKey,
    };
    classified.push(importRow);
    importRows.push(importRow);
  });

  return {
    ok: true,
    filename: trimStr(options.filename, 300) || null,
    default_contact_type: defaultContactType,
    header_map: headerMap,
    total_rows: dataRows.length,
    counts,
    classified,
    import_rows: importRows,
    preview_rows: classified.slice(0, PREVIEW_ROW_LIMIT).map(toPreviewRow),
    warnings: warnings.slice(0, 100),
  };
}

module.exports = {
  MAX_CSV_BYTES,
  MAX_DATA_ROWS,
  PREVIEW_ROW_LIMIT,
  stripUtf8Bom,
  sanitizeCellValue,
  parseCsvRecords,
  resolveHeaderField,
  buildHeaderMap,
  mapCsvRowToInput,
  buildDuplicateIndex,
  findDuplicateMatch,
  parseAndClassifyContactImport,
  toPreviewRow,
  hasUsefulIdentity,
  hasStoredContactIdentity,
};
