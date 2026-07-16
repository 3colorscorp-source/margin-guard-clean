/**
 * CH-001A — Canonical Contract Source assembler (read-only interface).
 * Future contract generators must use this interface — not ad-hoc multi-table queries.
 */

const { getTradeModule } = require("./contract-trade-modules");

const SOURCE_VERSION = 1;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const APPROVED_QUOTE_STATUSES = new Set(["accepted", "approved"]);

const LEGAL_READINESS_REQUIRED = [
  "legal_business_name",
  "business_address_line1",
  "business_city",
  "business_state",
  "business_postal_code",
  "business_phone",
  "business_email",
  "authorized_signer_name",
  "authorized_signer_title",
  "primary_service_state",
  "timezone",
];

const PREFERENCES_READINESS_REQUIRED = [
  "primary_trade_module",
  "default_contract_name",
  "default_contract_language",
  "change_order_requirement",
  "default_signer_mode",
  "default_signature_order",
];

const QUOTE_SOURCE_SELECT = [
  "id",
  "tenant_id",
  "project_name",
  "title",
  "client_name",
  "client_email",
  "client_phone",
  "project_address",
  "job_site",
  "status",
  "total",
  "currency",
  "deposit_required",
  "issue_date",
  "accepted_at",
  "expiration_date",
  "start_date",
  "due_date",
  "notes",
  "terms",
  "quote_number_display",
].join(",");

function trimField(value, maxLen) {
  const s = String(value ?? "").trim();
  if (!maxLen) return s;
  return s.slice(0, maxLen);
}

function hasValue(row, key) {
  if (!row || typeof row !== "object") return false;
  return trimField(row[key]) !== "";
}

function evaluateLegalProfileReadiness(profile) {
  const missing = [];
  if (!profile || typeof profile !== "object") {
    return { status: "incomplete", missing: [...LEGAL_READINESS_REQUIRED] };
  }
  for (const key of LEGAL_READINESS_REQUIRED) {
    if (!hasValue(profile, key)) missing.push(key);
  }
  const licenseStatus = trimField(profile.contractor_license_status).toLowerCase();
  if (licenseStatus === "licensed") {
    if (!hasValue(profile, "contractor_license_number")) missing.push("contractor_license_number");
    if (!hasValue(profile, "contractor_license_state")) missing.push("contractor_license_state");
  }
  return {
    status: missing.length === 0 ? "ready" : "incomplete",
    missing,
  };
}

function evaluateContractPreferencesReadiness(preferences) {
  const missing = [];
  if (!preferences || typeof preferences !== "object") {
    return { status: "incomplete", missing: [...PREFERENCES_READINESS_REQUIRED, "custom_trade_label"] };
  }
  for (const key of PREFERENCES_READINESS_REQUIRED) {
    if (!hasValue(preferences, key)) missing.push(key);
  }
  const tradeCode = trimField(preferences.primary_trade_module).toLowerCase();
  if (tradeCode === "custom" && !hasValue(preferences, "custom_trade_label")) {
    missing.push("custom_trade_label");
  }
  return {
    status: missing.length === 0 ? "ready" : "incomplete",
    missing,
  };
}

function serializeLegalProfileForApi(row) {
  if (!row || typeof row !== "object") return null;
  return {
    id: row.id,
    legal_business_name: trimField(row.legal_business_name, 200),
    dba_name: trimField(row.dba_name, 200),
    entity_type: trimField(row.entity_type, 120),
    business_address_line1: trimField(row.business_address_line1, 200),
    business_address_line2: trimField(row.business_address_line2, 200),
    business_city: trimField(row.business_city, 120),
    business_state: trimField(row.business_state, 80),
    business_postal_code: trimField(row.business_postal_code, 32),
    mailing_same_as_business: row.mailing_same_as_business !== false,
    mailing_address_line1: trimField(row.mailing_address_line1, 200),
    mailing_address_line2: trimField(row.mailing_address_line2, 200),
    mailing_city: trimField(row.mailing_city, 120),
    mailing_state: trimField(row.mailing_state, 80),
    mailing_postal_code: trimField(row.mailing_postal_code, 32),
    business_phone: trimField(row.business_phone, 120),
    business_email: trimField(row.business_email, 200),
    contractor_license_status: trimField(row.contractor_license_status, 32) || "unknown",
    contractor_license_number: trimField(row.contractor_license_number, 100),
    contractor_license_classification: trimField(row.contractor_license_classification, 120),
    contractor_license_state: trimField(row.contractor_license_state, 80),
    contractor_license_expiration: row.contractor_license_expiration || null,
    bond_company: trimField(row.bond_company, 200),
    bond_number: trimField(row.bond_number, 100),
    general_liability_carrier: trimField(row.general_liability_carrier, 200),
    general_liability_policy_number: trimField(row.general_liability_policy_number, 100),
    workers_comp_status: trimField(row.workers_comp_status, 80),
    workers_comp_carrier: trimField(row.workers_comp_carrier, 200),
    workers_comp_policy_number: trimField(row.workers_comp_policy_number, 100),
    authorized_signer_name: trimField(row.authorized_signer_name, 200),
    authorized_signer_title: trimField(row.authorized_signer_title, 120),
    primary_service_state: trimField(row.primary_service_state, 80),
    timezone: trimField(row.timezone, 80),
    default_contract_language: trimField(row.default_contract_language, 16) || "en",
    updated_at: row.updated_at || null,
  };
}

function serializePreferencesForApi(row) {
  if (!row || typeof row !== "object") return null;
  return {
    id: row.id,
    primary_trade_module: trimField(row.primary_trade_module, 64) || "custom",
    custom_trade_label: trimField(row.custom_trade_label, 200),
    default_contract_name: trimField(row.default_contract_name, 200),
    default_warranty_duration_value:
      row.default_warranty_duration_value == null ? null : Number(row.default_warranty_duration_value),
    default_warranty_duration_unit: trimField(row.default_warranty_duration_unit, 16) || "months",
    change_order_requirement: trimField(row.change_order_requirement, 32) || "price_change_only",
    require_customer_initials: row.require_customer_initials !== false,
    default_signer_mode: trimField(row.default_signer_mode, 32) || "one_customer",
    default_contract_language: trimField(row.default_contract_language, 16) || "en",
    dispute_resolution_preference: trimField(row.dispute_resolution_preference, 32) || "unset",
    default_signature_order: trimField(row.default_signature_order, 32) || "customer_first",
    automatically_attach_warranty: Boolean(row.automatically_attach_warranty),
    automatically_attach_completion_certificate: Boolean(row.automatically_attach_completion_certificate),
    updated_at: row.updated_at || null,
  };
}

function buildEmptyContractSource({ tenantId, projectId, quoteId, mode }) {
  return {
    source_version: SOURCE_VERSION,
    tenant: { id: tenantId },
    contractor: null,
    customer: null,
    property: null,
    project: null,
    quote: null,
    scope: null,
    pricing: null,
    schedule: null,
    preferences: null,
    trade: null,
    state: { module_loaded: false, code: null },
    readiness: {
      ready_for_draft_preparation: false,
      checks: [],
      missing: [],
    },
    source_metadata: {
      tenant_id: tenantId,
      project_id: projectId || null,
      quote_id: quoteId || null,
      assembled_at: new Date().toISOString(),
      mode: mode || "readiness",
    },
  };
}

function serializeQuoteForSource(row) {
  if (!row || typeof row !== "object") return null;
  return {
    id: row.id,
    quote_number_display: trimField(row.quote_number_display, 80),
    status: trimField(row.status, 40),
    currency: trimField(row.currency, 8) || "USD",
    deposit_required: row.deposit_required == null ? null : Number(row.deposit_required),
    issue_date: row.issue_date || null,
    accepted_at: row.accepted_at || null,
    expiration_date: row.expiration_date || null,
    start_date: row.start_date || null,
    due_date: row.due_date || null,
    client_phone: trimField(row.client_phone, 120),
    project_address: trimField(row.project_address, 255) || trimField(row.job_site, 255),
    job_site: trimField(row.job_site, 255),
    notes: trimField(row.notes, 8000),
    terms: trimField(row.terms, 8000),
    project_name: trimField(row.project_name, 255),
    title: trimField(row.title, 255),
  };
}

function resolveContractTotal(projectRow, quoteRow) {
  const sale = Number(projectRow?.sale_price);
  if (Number.isFinite(sale) && sale > 0) return sale;
  const total = Number(quoteRow?.total);
  if (Number.isFinite(total) && total > 0) return total;
  return null;
}

function buildReadinessChecks({
  legalReadiness,
  preferencesReadiness,
  projectRow,
  quoteRow,
  propertyPresent,
}) {
  const checks = [];
  const missing = [];

  const legalStatus = legalReadiness.status === "ready" ? "ready" : "missing";
  checks.push({ key: "tenant_legal_profile", status: legalStatus, label: "Tenant legal profile" });
  if (legalStatus !== "ready") missing.push("tenant_legal_profile");

  const prefStatus = preferencesReadiness.status === "ready" ? "ready" : "missing";
  checks.push({ key: "tenant_contract_preferences", status: prefStatus, label: "Tenant contract preferences" });
  if (prefStatus !== "ready") missing.push("tenant_contract_preferences");

  const tradeCode = trimField(preferencesReadiness._tradeCode || "");
  const tradeStatus = tradeCode ? "ready" : "missing";
  checks.push({ key: "primary_trade_module", status: tradeStatus, label: "Primary trade module" });
  if (tradeStatus !== "ready") missing.push("primary_trade_module");

  checks.push({
    key: "project_property",
    status: propertyPresent ? "ready" : "missing",
    label: "Project property address",
  });
  if (!propertyPresent) missing.push("project_property");

  const quoteApproved =
    quoteRow && APPROVED_QUOTE_STATUSES.has(trimField(quoteRow.status).toLowerCase());
  checks.push({
    key: "approved_quote",
    status: quoteApproved ? "ready" : "missing",
    label: "Approved quote",
  });
  if (!quoteApproved) missing.push("approved_quote");

  const customerOk =
    hasValue(projectRow, "client_name") && hasValue(projectRow, "client_email");
  checks.push({
    key: "customer_identity",
    status: customerOk ? "ready" : "missing",
    label: "Customer identity",
  });
  if (!customerOk) missing.push("customer_identity");

  const contractTotal = resolveContractTotal(projectRow, quoteRow);
  checks.push({
    key: "contract_total",
    status: contractTotal != null && contractTotal > 0 ? "ready" : "missing",
    label: "Contract total",
  });
  if (!(contractTotal != null && contractTotal > 0)) missing.push("contract_total");

  const signerOk =
    legalReadiness.status === "ready" &&
    hasValue({ authorized_signer_name: legalReadiness._signerName }, "authorized_signer_name");
  checks.push({
    key: "authorized_signer",
    status: signerOk ? "ready" : "missing",
    label: "Authorized signer",
  });
  if (!signerOk) missing.push("authorized_signer");

  checks.push({
    key: "property_state",
    status: "missing",
    label: "Property state",
  });
  missing.push("property_state");

  const scopeText = trimField(quoteRow?.notes) || trimField(quoteRow?.terms);
  checks.push({
    key: "scope_availability",
    status: scopeText ? "ready" : "missing",
    label: "Scope availability",
  });
  if (!scopeText) missing.push("scope_availability");

  const readyForDraft =
    missing.length === 0 && legalReadiness.status === "ready" && preferencesReadiness.status === "ready";

  return {
    ready_for_draft_preparation: readyForDraft,
    checks,
    missing: [...new Set(missing)],
  };
}

async function loadRowByTenant(supabaseRequest, table, tenantId) {
  const tid = encodeURIComponent(tenantId);
  const rows = await supabaseRequest(`${table}?tenant_id=eq.${tid}&select=*&limit=1`, { method: "GET" });
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function loadProjectForTenant(supabaseRequest, tenantId, projectId) {
  if (!UUID_RE.test(String(projectId || ""))) return null;
  const tid = encodeURIComponent(tenantId);
  const pid = encodeURIComponent(projectId);
  const rows = await supabaseRequest(
    `tenant_projects?id=eq.${pid}&tenant_id=eq.${tid}&select=*&limit=1`,
    { method: "GET" }
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function loadQuoteForTenant(supabaseRequest, tenantId, quoteId) {
  if (!UUID_RE.test(String(quoteId || ""))) return null;
  const tid = encodeURIComponent(tenantId);
  const qid = encodeURIComponent(quoteId);
  const rows = await supabaseRequest(
    `quotes?id=eq.${qid}&tenant_id=eq.${tid}&select=${QUOTE_SOURCE_SELECT}&limit=1`,
    { method: "GET" }
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

/**
 * @param {object} opts
 * @param {string} opts.tenantId — from authenticated server context only
 * @param {string} [opts.projectId]
 * @param {string} [opts.quoteId]
 * @param {Function} opts.supabaseRequest
 * @param {string} [opts.mode]
 */
async function assembleContractSource({ tenantId, projectId, quoteId, supabaseRequest, mode }) {
  const tid = String(tenantId || "").trim();
  if (!UUID_RE.test(tid)) {
    throw new Error("Invalid tenant context");
  }

  const out = buildEmptyContractSource({
    tenantId: tid,
    projectId: projectId || null,
    quoteId: quoteId || null,
    mode: mode || "readiness",
  });

  const legalRow = await loadRowByTenant(supabaseRequest, "tenant_legal_profiles", tid);
  const prefsRow = await loadRowByTenant(supabaseRequest, "tenant_contract_preferences", tid);

  const legalProfile = serializeLegalProfileForApi(legalRow);
  const preferences = serializePreferencesForApi(prefsRow);

  const legalReadiness = evaluateLegalProfileReadiness(legalProfile);
  legalReadiness._signerName = legalProfile?.authorized_signer_name || "";

  const preferencesReadiness = evaluateContractPreferencesReadiness(preferences);
  preferencesReadiness._tradeCode = preferences?.primary_trade_module || "";

  out.contractor = legalProfile;
  out.preferences = preferences;

  const tradeMod = preferences ? getTradeModule(preferences.primary_trade_module) : null;
  out.trade = tradeMod
    ? {
        code: tradeMod.code,
        name: tradeMod.name,
        category: tradeMod.category,
        version: tradeMod.version,
        custom_display_label:
          tradeMod.code === "custom" ? trimField(preferences.custom_trade_label, 200) : "",
      }
    : null;

  let projectRow = null;
  let quoteRow = null;
  const resolvedProjectId = trimField(projectId);
  const resolvedQuoteId = trimField(quoteId);

  if (resolvedProjectId) {
    projectRow = await loadProjectForTenant(supabaseRequest, tid, resolvedProjectId);
    if (!projectRow) {
      out.readiness.missing.push("project_not_found");
      return out;
    }
    out.project = {
      id: projectRow.id,
      quote_id: projectRow.quote_id || null,
      project_name: trimField(projectRow.project_name, 255),
      client_name: trimField(projectRow.client_name, 255),
      client_email: trimField(projectRow.client_email, 255),
      status: trimField(projectRow.status, 40),
      sale_price: Number(projectRow.sale_price) || 0,
    };
    out.customer = {
      name: out.project.client_name,
      email: out.project.client_email,
    };

    const projectQuoteId = trimField(projectRow.quote_id);
    const qid = resolvedQuoteId || projectQuoteId;
    if (qid) {
      if (resolvedQuoteId && projectQuoteId && resolvedQuoteId !== projectQuoteId) {
        quoteRow = null;
      } else {
        quoteRow = await loadQuoteForTenant(supabaseRequest, tid, qid);
      }
    }
  } else if (resolvedQuoteId) {
    quoteRow = await loadQuoteForTenant(supabaseRequest, tid, resolvedQuoteId);
  }

  out.quote = serializeQuoteForSource(quoteRow);
  out.scope = quoteRow
    ? {
        notes: trimField(quoteRow.notes, 8000),
        terms: trimField(quoteRow.terms, 8000),
        legacy_project_address:
          trimField(quoteRow.project_address, 255) || trimField(quoteRow.job_site, 255) || null,
      }
    : null;

  const contractTotal = resolveContractTotal(projectRow, quoteRow);
  out.pricing = contractTotal != null
    ? {
        contract_total: contractTotal,
        currency: trimField(quoteRow?.currency, 8) || "USD",
        deposit_required: quoteRow?.deposit_required == null ? null : Number(quoteRow.deposit_required),
        source: "quote_or_project",
      }
    : null;

  out.schedule = quoteRow
    ? {
        start_date: quoteRow.start_date || null,
        due_date: quoteRow.due_date || null,
      }
    : null;

  out.property = null;

  out.readiness = buildReadinessChecks({
    legalReadiness,
    preferencesReadiness,
    projectRow,
    quoteRow,
    propertyPresent: false,
  });

  return out;
}

module.exports = {
  SOURCE_VERSION,
  UUID_RE,
  LEGAL_READINESS_REQUIRED,
  PREFERENCES_READINESS_REQUIRED,
  evaluateLegalProfileReadiness,
  evaluateContractPreferencesReadiness,
  serializeLegalProfileForApi,
  serializePreferencesForApi,
  serializeQuoteForSource,
  resolveContractTotal,
  buildEmptyContractSource,
  assembleContractSource,
};
