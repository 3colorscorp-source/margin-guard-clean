/**
 * CH-011A — Contract Package freeze/read helpers.
 * Immutable snapshot of confirmed Contract Builder + Business Settings.
 * No envelopes, PDF, Stripe, invoices, ledger, or Payment Intents.
 */

"use strict";

const crypto = require("crypto");
const { supabaseRequest } = require("./supabase-admin");
const {
  serializeLegalProfileForApi,
  evaluateLegalProfileReadiness,
} = require("./contract-source-assembler");
const {
  buildEffectiveForContracts,
} = require("../tenant-contract-legal-notices")._test;

const API_VERSION = "ch-011a-v1";
const SNAPSHOT_SCHEMA = "ch-011a-v1";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const APPROVED_QUOTE_STATUSES = new Set(["accepted", "approved"]);
const PACKAGE_STATUSES = new Set(["ready", "superseded", "executed", "void"]);

const QUOTE_SELECT = [
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
  "updated_at",
].join(",");

const PROJECT_SELECT =
  "id,tenant_id,quote_id,project_name,status,updated_at,created_at";

function trimField(value) {
  return String(value ?? "").trim();
}

function validUuid(value) {
  return UUID_RE.test(trimField(value));
}

function unknownKeys(input, allowed) {
  return Object.keys(input || {}).filter((key) => !allowed.has(key));
}

function moneyNumber(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

/** Deterministic JSON canonicalize (sorted object keys, array order preserved). */
function canonicalize(value) {
  if (value === null || typeof value !== "object") {
    return value === undefined ? null : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  const out = {};
  for (const key of Object.keys(value).sort()) {
    const v = value[key];
    if (v === undefined) continue;
    out[key] = canonicalize(v);
  }
  return out;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256Hex(text) {
  return crypto.createHash("sha256").update(String(text), "utf8").digest("hex");
}

/**
 * Hash input = authoritative contract content only.
 * Excludes freeze-time / package metadata (frozen_at, package ids, versions, etc.).
 */
function authoritativeContentForHash(snapshot) {
  const raw = snapshot && typeof snapshot === "object" ? snapshot : {};
  const {
    frozen_at: _frozenAt,
    package_id: _packageId,
    package_version: _packageVersion,
    package_status: _packageStatus,
    created_at: _createdAt,
    updated_at: _updatedAt,
    created_by: _createdBy,
    supersedes_package_id: _supersedes,
    ...rest
  } = raw;

  let content = rest;
  const payment = content.payment_schedule;
  if (payment && Array.isArray(payment.items)) {
    content = {
      ...content,
      payment_schedule: {
        ...payment,
        items: [...payment.items].sort((a, b) => {
          const seqA = Number(a?.sequence_number) || 0;
          const seqB = Number(b?.sequence_number) || 0;
          if (seqA !== seqB) return seqA - seqB;
          return trimField(a?.id).localeCompare(trimField(b?.id));
        }),
      },
    };
  }

  return content;
}

function contentHashForSnapshot(snapshot) {
  return sha256Hex(canonicalJson(authoritativeContentForHash(snapshot)));
}

function evaluateFreezeHashDecision(latestReady, contentHash) {
  const hash = trimField(contentHash);
  if (!latestReady?.id || !hash) {
    return {
      idempotent: false,
      createVersion: true,
      supersedeId: latestReady?.id || null,
    };
  }
  // Recompute from stored snapshot so legacy hashes that included frozen_at still match.
  const fromSnapshot = latestReady.snapshot_json
    ? contentHashForSnapshot(latestReady.snapshot_json)
    : "";
  const fromColumn = trimField(latestReady.content_hash);
  if (fromSnapshot === hash || fromColumn === hash) {
    return {
      idempotent: true,
      createVersion: false,
      supersedeId: null,
    };
  }
  return {
    idempotent: false,
    createVersion: true,
    supersedeId: latestReady.id,
  };
}

function toMoneyCents(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function centsToNumber(cents) {
  if (cents == null) return null;
  return Math.round(Number(cents)) / 100;
}

function itemCents(row) {
  return toMoneyCents(row?.amount) || 0;
}

function totalItemsCents(items) {
  return (items || []).reduce((sum, item) => sum + itemCents(item), 0);
}

function serializeSetup(row) {
  if (!row?.id) return null;
  return {
    id: row.id,
    project_id: row.project_id,
    quote_id: row.quote_id,
    property_address_line1: trimField(row.property_address_line1),
    property_address_line2: trimField(row.property_address_line2),
    property_city: trimField(row.property_city),
    property_state: trimField(row.property_state),
    property_postal_code: trimField(row.property_postal_code),
    property_confirmed_at: row.property_confirmed_at || null,
    warranty_duration_value:
      row.warranty_duration_value == null ? null : Number(row.warranty_duration_value),
    warranty_duration_unit: trimField(row.warranty_duration_unit) || "months",
    warranty_summary: trimField(row.warranty_summary),
    warranty_exclusions: trimField(row.warranty_exclusions),
    warranty_confirmed_at: row.warranty_confirmed_at || null,
    signature_method: trimField(row.signature_method) || "not_configured",
    state_module_code: trimField(row.state_module_code),
    state_notice_pack_status: trimField(row.state_notice_pack_status) || "unsupported",
    state_notice_pack_version: trimField(row.state_notice_pack_version),
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

function evaluateSetupReadiness(setup) {
  const propertyComplete = Boolean(
    trimField(setup?.property_address_line1) &&
      trimField(setup?.property_city) &&
      trimField(setup?.property_state) &&
      trimField(setup?.property_postal_code)
  );
  const warrantyComplete = Boolean(
    setup?.warranty_duration_value != null &&
      trimField(setup?.warranty_duration_unit) &&
      trimField(setup?.warranty_summary) &&
      trimField(setup?.warranty_exclusions)
  );
  return {
    project_address:
      propertyComplete && setup?.property_confirmed_at ? "confirmed" : "incomplete",
    warranty:
      warrantyComplete && setup?.warranty_confirmed_at ? "configured" : "incomplete",
    signature_method:
      setup?.signature_method && setup.signature_method !== "not_configured"
        ? "configured"
        : "incomplete",
  };
}

function serializeSchedule(row) {
  if (!row?.id) return null;
  return {
    id: row.id,
    project_id: row.project_id,
    quote_id: row.quote_id,
    currency: trimField(row.currency) || "USD",
    contract_total: row.contract_total == null ? null : Number(row.contract_total),
    status: trimField(row.status) || "draft",
    confirmed_at: row.confirmed_at || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

function serializeScheduleItem(row, contractTotalCents) {
  const amountCents = itemCents(row);
  const pct =
    contractTotalCents > 0
      ? Math.round((amountCents / contractTotalCents) * 10000) / 100
      : null;
  return {
    id: row.id || null,
    sequence_number: Number(row.sequence_number) || 0,
    label: trimField(row.label),
    payment_type: trimField(row.payment_type),
    amount: centsToNumber(amountCents),
    percentage: row.percentage == null ? pct : Number(row.percentage),
    due_rule: trimField(row.due_rule),
    milestone_description: trimField(row.milestone_description),
    fixed_due_date: row.fixed_due_date || null,
    item_role: trimField(row.item_role) || "future_obligation",
  };
}

function evaluatePaymentReadiness(schedule, items, contractTotalCents) {
  const itemCount = Array.isArray(items) ? items.length : 0;
  const scheduledTotalCents = totalItemsCents(items);
  const confirmed = Boolean(
    schedule &&
      schedule.status === "confirmed" &&
      schedule.confirmed_at &&
      itemCount > 0 &&
      scheduledTotalCents === contractTotalCents
  );
  return {
    status: !schedule ? "missing" : confirmed ? "configured" : "draft",
    contract_total: centsToNumber(contractTotalCents),
    scheduled_total: centsToNumber(scheduledTotalCents),
    remaining_difference: centsToNumber(contractTotalCents - scheduledTotalCents),
    item_count: itemCount,
    confirmed_at: schedule?.confirmed_at || null,
  };
}

async function verifyProjectAndQuote(tenantId, projectId, quoteId) {
  const tid = encodeURIComponent(tenantId);
  const pid = encodeURIComponent(projectId);
  const qid = encodeURIComponent(quoteId);

  const projects = await supabaseRequest(
    `tenant_projects?id=eq.${pid}&tenant_id=eq.${tid}&select=${PROJECT_SELECT}&limit=1`,
    { method: "GET" }
  );
  const project = Array.isArray(projects) && projects[0] ? projects[0] : null;
  if (!project?.id) return { unavailable: true };

  const projectQuoteId = trimField(project.quote_id);
  if (!projectQuoteId || projectQuoteId.toLowerCase() !== quoteId.toLowerCase()) {
    return { mismatch: true };
  }

  const quotes = await supabaseRequest(
    `quotes?id=eq.${qid}&tenant_id=eq.${tid}&select=${QUOTE_SELECT}&limit=1`,
    { method: "GET" }
  );
  const quote = Array.isArray(quotes) && quotes[0] ? quotes[0] : null;
  if (!quote?.id) return { unavailable: true };

  return { project, quote };
}

async function loadAuthoritativeSources(tenantId, projectId, quoteId) {
  const tid = encodeURIComponent(tenantId);
  const pid = encodeURIComponent(projectId);
  const qid = encodeURIComponent(quoteId);

  const [setupRows, scheduleRows, noticeRows, profileRows, brandingRows] =
    await Promise.all([
      supabaseRequest(
        `project_contract_setups?tenant_id=eq.${tid}&project_id=eq.${pid}&quote_id=eq.${qid}&select=*&limit=1`,
        { method: "GET" }
      ),
      supabaseRequest(
        `project_contract_payment_schedules?tenant_id=eq.${tid}&project_id=eq.${pid}&quote_id=eq.${qid}&select=*&limit=1`,
        { method: "GET" }
      ),
      supabaseRequest(
        `tenant_contract_legal_notices?tenant_id=eq.${tid}&select=*&limit=1`,
        { method: "GET" }
      ),
      supabaseRequest(
        `tenant_legal_profiles?tenant_id=eq.${tid}&select=*&limit=1`,
        { method: "GET" }
      ),
      supabaseRequest(
        `tenant_branding?tenant_id=eq.${tid}&select=business_name,business_email,business_phone,business_address,logo_url,updated_at&limit=1`,
        { method: "GET" }
      ).catch(() => []),
    ]);

  const setupRow = Array.isArray(setupRows) && setupRows[0] ? setupRows[0] : null;
  const scheduleRow =
    Array.isArray(scheduleRows) && scheduleRows[0] ? scheduleRows[0] : null;
  const noticeRow = Array.isArray(noticeRows) && noticeRows[0] ? noticeRows[0] : null;
  const profileRow =
    Array.isArray(profileRows) && profileRows[0] ? profileRows[0] : null;
  const brandingRow =
    Array.isArray(brandingRows) && brandingRows[0] ? brandingRows[0] : null;

  let items = [];
  if (scheduleRow?.id) {
    const itemRows = await supabaseRequest(
      `project_contract_payment_schedule_items?tenant_id=eq.${tid}` +
        `&schedule_id=eq.${encodeURIComponent(scheduleRow.id)}` +
        `&select=*&order=sequence_number.asc`,
      { method: "GET" }
    );
    items = Array.isArray(itemRows) ? itemRows : [];
  }

  return {
    setupRow,
    scheduleRow,
    items,
    noticeRow,
    profileRow,
    brandingRow,
  };
}

function buildFreezeGate({
  project,
  quote,
  setup,
  setupReadiness,
  paymentReadiness,
  legalEffective,
  legalProfile,
  legalProfileReadiness,
}) {
  const missing = [];
  const status = trimField(quote?.status).toLowerCase();
  if (!APPROVED_QUOTE_STATUSES.has(status)) missing.push("quote_not_approved");
  if (!project?.id) missing.push("project_missing");
  if (setupReadiness.project_address !== "confirmed") missing.push("property");
  if (setupReadiness.warranty !== "configured") missing.push("warranty");
  if (setupReadiness.signature_method !== "configured") {
    missing.push("signature_method");
  }
  if (paymentReadiness.status !== "configured") missing.push("payment_schedule");
  if (!legalEffective) missing.push("legal_notices");
  if (!legalProfile || legalProfileReadiness.status !== "ready") {
    missing.push("business_settings");
  }

  return {
    ok: missing.length === 0,
    missing,
    setup,
    paymentReadiness,
    legalEffective,
  };
}

function buildSnapshot({
  tenantId,
  project,
  quote,
  setup,
  setupReadiness,
  schedule,
  items,
  paymentReadiness,
  legalEffective,
  legalProfile,
  brandingRow,
  frozenAt,
}) {
  const contractTotal = moneyNumber(quote.total);
  const scopeText = trimField(quote.notes);
  const termsText = trimField(quote.terms);

  // Business Settings SoT: freeze legal profile (+ branding columns as currently stored).
  // Do not invent a second business identity schema.
  const businessSettings = {
    source: "business_settings",
    legal_profile: legalProfile,
    branding: brandingRow
      ? {
          business_name: trimField(brandingRow.business_name),
          business_email: trimField(brandingRow.business_email),
          business_phone: trimField(brandingRow.business_phone),
          business_address: trimField(brandingRow.business_address),
          logo_url: trimField(brandingRow.logo_url),
          updated_at: brandingRow.updated_at || null,
        }
      : null,
  };

  return {
    schema: SNAPSHOT_SCHEMA,
    frozen_at: frozenAt,
    tenant: { id: tenantId },
    source_ids: {
      project_id: project.id,
      quote_id: quote.id,
      setup_id: setup?.id || null,
      schedule_id: schedule?.id || null,
      legal_profile_id: legalProfile?.id || null,
    },
    source_timestamps: {
      project_updated_at: project.updated_at || null,
      quote_updated_at: quote.updated_at || null,
      setup_updated_at: setup?.updated_at || null,
      schedule_updated_at: schedule?.updated_at || null,
      schedule_confirmed_at: schedule?.confirmed_at || null,
      legal_notices_confirmed_at: legalEffective?.confirmed_at || null,
      legal_profile_updated_at: legalProfile?.updated_at || null,
    },
    business_settings: businessSettings,
    customer: {
      name: trimField(quote.client_name),
      email: trimField(quote.client_email),
      phone: trimField(quote.client_phone),
    },
    project: {
      id: project.id,
      name: trimField(project.project_name || quote.project_name),
      status: trimField(project.status),
    },
    property: {
      address_line1: setup?.property_address_line1 || "",
      address_line2: setup?.property_address_line2 || "",
      city: setup?.property_city || "",
      state: setup?.property_state || "",
      postal_code: setup?.property_postal_code || "",
      confirmed_at: setup?.property_confirmed_at || null,
      quote_project_address: trimField(quote.project_address),
      quote_job_site: trimField(quote.job_site),
    },
    quote: {
      id: quote.id,
      number: trimField(quote.quote_number_display),
      title: trimField(quote.title),
      status: trimField(quote.status),
      total: contractTotal,
      currency: trimField(quote.currency) || "USD",
      deposit_required: moneyNumber(quote.deposit_required),
      issue_date: quote.issue_date || null,
      accepted_at: quote.accepted_at || null,
      expiration_date: quote.expiration_date || null,
      start_date: quote.start_date || null,
      due_date: quote.due_date || null,
    },
    scope: {
      text: scopeText,
    },
    price: {
      contract_total: contractTotal,
      currency: trimField(quote.currency) || "USD",
      deposit_required: moneyNumber(quote.deposit_required),
    },
    payment_schedule: {
      schedule,
      items: (items || [])
        .map((row) => serializeScheduleItem(row, toMoneyCents(contractTotal) || 0))
        .sort((a, b) => {
          const seqA = Number(a?.sequence_number) || 0;
          const seqB = Number(b?.sequence_number) || 0;
          if (seqA !== seqB) return seqA - seqB;
          return trimField(a?.id).localeCompare(trimField(b?.id));
        }),
      readiness: paymentReadiness,
    },
    warranty: {
      duration_value: setup?.warranty_duration_value ?? null,
      duration_unit: setup?.warranty_duration_unit || null,
      summary: setup?.warranty_summary || "",
      exclusions: setup?.warranty_exclusions || "",
      confirmed_at: setup?.warranty_confirmed_at || null,
    },
    terms: {
      quote_terms: termsText,
    },
    legal_notices: {
      confirmed_at: legalEffective?.confirmed_at || null,
      notices: legalEffective?.notices || {},
      enabled: legalEffective?.enabled || {},
    },
    signature_method_preference: setup?.signature_method || "not_configured",
    readiness: {
      project_address: setupReadiness.project_address,
      warranty: setupReadiness.warranty,
      signature_method: setupReadiness.signature_method,
      payment_schedule: paymentReadiness.status,
      legal_notices: legalEffective ? "configured" : "missing",
    },
  };
}

function serializePackageRow(row) {
  if (!row?.id) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    project_id: row.project_id,
    quote_id: row.quote_id,
    version: Number(row.version),
    status: trimField(row.status),
    content_hash: trimField(row.content_hash),
    source_readiness: row.source_readiness || null,
    supersedes_package_id: row.supersedes_package_id || null,
    created_by: row.created_by || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

async function listPackagesForProject(tenantId, projectId) {
  const rows = await supabaseRequest(
    `tenant_contract_packages?tenant_id=eq.${encodeURIComponent(tenantId)}` +
      `&project_id=eq.${encodeURIComponent(projectId)}` +
      `&select=id,tenant_id,project_id,quote_id,version,status,content_hash,source_readiness,supersedes_package_id,created_by,created_at,updated_at` +
      `&order=version.desc`,
    { method: "GET" }
  );
  return (Array.isArray(rows) ? rows : []).map(serializePackageRow).filter(Boolean);
}

async function loadLatestReadyPackage(tenantId, projectId) {
  const rows = await supabaseRequest(
    `tenant_contract_packages?tenant_id=eq.${encodeURIComponent(tenantId)}` +
      `&project_id=eq.${encodeURIComponent(projectId)}` +
      `&status=eq.ready` +
      `&select=*` +
      `&order=version.desc&limit=1`,
    { method: "GET" }
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function nextPackageVersion(tenantId, projectId) {
  try {
    const result = await supabaseRequest(
      `rpc/tenant_contract_packages_next_version`,
      {
        method: "POST",
        body: { p_tenant_id: tenantId, p_project_id: projectId },
      }
    );
    const n = Number(result);
    if (Number.isSafeInteger(n) && n >= 1) return n;
  } catch (_err) {
    /* fall through to client-side max+1 */
  }
  const rows = await supabaseRequest(
    `tenant_contract_packages?tenant_id=eq.${encodeURIComponent(tenantId)}` +
      `&project_id=eq.${encodeURIComponent(projectId)}` +
      `&select=version&order=version.desc&limit=1`,
    { method: "GET" }
  );
  const max = Array.isArray(rows) && rows[0] ? Number(rows[0].version) || 0 : 0;
  return max + 1;
}

async function markPackageSuperseded(tenantId, packageId) {
  if (!packageId) return;
  await supabaseRequest(
    `tenant_contract_packages?tenant_id=eq.${encodeURIComponent(tenantId)}` +
      `&id=eq.${encodeURIComponent(packageId)}`,
    {
      method: "PATCH",
      body: { status: "superseded" },
      headers: { Prefer: "return=minimal" },
    }
  );
}

/**
 * Freeze a package. Policy A: identical content_hash on latest ready → return it.
 */
async function freezeContractPackage({
  tenantId,
  projectId,
  quoteId,
  createdBy,
  expectedSetupUpdatedAt,
  expectedScheduleUpdatedAt,
}) {
  const verified = await verifyProjectAndQuote(tenantId, projectId, quoteId);
  if (verified.unavailable) {
    return { error: "Project or quote not found", code: "not_found", status: 404 };
  }
  if (verified.mismatch) {
    return {
      error: "Quote does not match project",
      code: "quote_project_mismatch",
      status: 404,
    };
  }

  const { project, quote } = verified;
  const sources = await loadAuthoritativeSources(tenantId, projectId, quoteId);
  const setup = serializeSetup(sources.setupRow);
  const setupReadiness = evaluateSetupReadiness(setup);
  const schedule = serializeSchedule(sources.scheduleRow);
  const contractTotalCents =
    toMoneyCents(quote.total) ?? toMoneyCents(schedule?.contract_total) ?? 0;
  const paymentReadiness = evaluatePaymentReadiness(
    sources.scheduleRow,
    sources.items,
    contractTotalCents
  );
  const legalEffective = buildEffectiveForContracts(sources.noticeRow || {});
  const legalProfile = serializeLegalProfileForApi(sources.profileRow);
  const legalProfileReadiness = evaluateLegalProfileReadiness(sources.profileRow);

  if (
    expectedSetupUpdatedAt &&
    trimField(setup?.updated_at) &&
    trimField(expectedSetupUpdatedAt) !== trimField(setup.updated_at)
  ) {
    return {
      error: "Contract setup changed. Reload before freezing.",
      code: "setup_version_conflict",
      status: 409,
    };
  }
  if (
    expectedScheduleUpdatedAt &&
    trimField(schedule?.updated_at) &&
    trimField(expectedScheduleUpdatedAt) !== trimField(schedule.updated_at)
  ) {
    return {
      error: "Payment schedule changed. Reload before freezing.",
      code: "schedule_version_conflict",
      status: 409,
    };
  }

  const gate = buildFreezeGate({
    project,
    quote,
    setup,
    setupReadiness,
    paymentReadiness,
    legalEffective,
    legalProfile,
    legalProfileReadiness,
  });
  if (!gate.ok) {
    return {
      error: "Contract is not ready to freeze",
      code: "readiness_incomplete",
      status: 422,
      missing: gate.missing,
    };
  }

  const frozenAt = new Date().toISOString();
  const snapshot = buildSnapshot({
    tenantId,
    project,
    quote,
    setup,
    setupReadiness,
    schedule,
    items: sources.items,
    paymentReadiness,
    legalEffective,
    legalProfile,
    brandingRow: sources.brandingRow,
    frozenAt,
  });
  const contentHash = contentHashForSnapshot(snapshot);
  const sourceReadiness = snapshot.readiness;

  const latestReady = await loadLatestReadyPackage(tenantId, projectId);
  const decision = evaluateFreezeHashDecision(latestReady, contentHash);
  if (decision.idempotent) {
    return {
      ok: true,
      idempotent: true,
      package: {
        ...serializePackageRow(latestReady),
        snapshot_json: latestReady.snapshot_json,
      },
    };
  }

  let version = await nextPackageVersion(tenantId, projectId);
  let inserted = null;
  let attempts = 0;
  while (attempts < 3 && !inserted) {
    attempts += 1;
    try {
      const rows = await supabaseRequest(`tenant_contract_packages`, {
        method: "POST",
        body: {
          tenant_id: tenantId,
          project_id: projectId,
          quote_id: quoteId,
          version,
          status: "ready",
          snapshot_json: snapshot,
          content_hash: contentHash,
          source_readiness: sourceReadiness,
          supersedes_package_id: decision.supersedeId || null,
          created_by: createdBy || null,
        },
      });
      inserted = Array.isArray(rows) ? rows[0] : rows;
    } catch (err) {
      const text = String(err?.message || err?.supabaseRaw || "");
      if (/duplicate|unique|23505/i.test(text)) {
        const again = await loadLatestReadyPackage(tenantId, projectId);
        const againDecision = evaluateFreezeHashDecision(again, contentHash);
        if (againDecision.idempotent) {
          return {
            ok: true,
            idempotent: true,
            package: {
              ...serializePackageRow(again),
              snapshot_json: again.snapshot_json,
            },
          };
        }
        version = await nextPackageVersion(tenantId, projectId);
        continue;
      }
      throw err;
    }
  }

  if (!inserted?.id) {
    return {
      error: "Could not create contract package",
      code: "insert_failed",
      status: 500,
    };
  }

  if (decision.supersedeId) {
    try {
      await markPackageSuperseded(tenantId, decision.supersedeId);
    } catch (_err) {
      /* new package exists; supersede best-effort */
    }
  }

  return {
    ok: true,
    idempotent: false,
    package: {
      ...serializePackageRow(inserted),
      snapshot_json: inserted.snapshot_json,
    },
  };
}

module.exports = {
  API_VERSION,
  SNAPSHOT_SCHEMA,
  PACKAGE_STATUSES,
  PROJECT_SELECT,
  validUuid,
  unknownKeys,
  canonicalize,
  canonicalJson,
  authoritativeContentForHash,
  contentHashForSnapshot,
  evaluateFreezeHashDecision,
  sha256Hex,
  serializePackageRow,
  verifyProjectAndQuote,
  loadAuthoritativeSources,
  buildFreezeGate,
  buildSnapshot,
  evaluateSetupReadiness,
  evaluatePaymentReadiness,
  serializeSetup,
  serializeSchedule,
  listPackagesForProject,
  freezeContractPackage,
  trimField,
};
