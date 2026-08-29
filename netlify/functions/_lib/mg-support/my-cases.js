/**
 * Closed tenant-owner My Cases reads for MG-SUPPORT-003E.1 / 003E.2C.
 * GET only. Trusted tenant_id from the signed owner session.
 * Does not reuse the platform-admin list. No writes. No OpenAI.
 */
"use strict";

const { supabaseRequest } = require("../supabase-admin");
const { formatCaseRef, sanitizeExcerpt } = require("./case-intake");

const CASE_TABLE = "tenant_support_cases";
const LIST_LIMIT = 25;
const CASE_SELECT_FIELDS = [
  "id",
  "tenant_id",
  "status",
  "category",
  "subject",
  "question_excerpt",
  "support_module",
  "related_entity_type",
  "related_entity_ref",
  "created_at",
  "updated_at",
  "resolved_at",
  "customer_resolution",
  "tenant_action_message",
];
const CASE_SELECT = CASE_SELECT_FIELDS.join(",");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const CATEGORY_LABELS = {
  unresolved_question: "Unresolved question",
  diagnostic_unavailable: "Diagnostic unavailable",
  possible_bug: "Possible bug",
  other: "Other",
};

const MODULE_LABELS = {
  invoice_hub: "Invoice Hub",
  quote: "Quote Builder",
  project_control: "Project Control",
  contract_hub: "Contract Hub",
  documentation: "Documentation",
  unknown: "Support",
};

const OPEN_COPY = "Your support case is open and has been received.";
const IN_REVIEW_COPY = "Your support case is currently being reviewed.";
const WAITING_COPY = "Support needs something from you before this case can continue.";
const RESOLVED_COPY = "This case has been resolved.";
const UNVERIFIED_COPY = "Margin Guard could not verify the current support case status.";
const ZERO_CASES_COPY = "There are no support cases in your account yet.";
const NOT_FOUND_COPY = "No support case matching that reference was found in your account.";
const NO_TENANT_COPY = "Support cases can be checked only for the signed-in owner.";

const ALLOWED_QUERY_KEYS = new Set(["case_ref"]);

function isUuid(value) {
  return UUID_RE.test(String(value || "").trim());
}

function normId(value) {
  return String(value || "").trim();
}

function isNonEmpty(value) {
  return String(value ?? "").trim() !== "";
}

function categoryLabel(category) {
  return CATEGORY_LABELS[category] || "Support";
}

function moduleLabel(mod) {
  return MODULE_LABELS[mod] || "Support";
}

function parseCaseRef(raw) {
  const text = String(raw || "").trim();
  const match = /^MG-SUP-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(
    text
  );
  if (!match) return null;
  return { case_ref: "MG-SUP-" + match[1], id: match[1] };
}

function extractSupportCaseRef(message) {
  const text = String(message || "");
  const match = /\bMG-SUP-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\b/i.exec(
    text
  );
  if (!match) return null;
  return parseCaseRef("MG-SUP-" + match[1]);
}

function serializeVisibleText(raw) {
  const text = sanitizeExcerpt(raw || "");
  return text ? text : null;
}

function mapStatus(raw) {
  const status = String(raw || "")
    .trim()
    .toLowerCase();
  if (status === "open") {
    return { status: "open", status_label: "Open", status_copy: OPEN_COPY };
  }
  if (status === "in_review") {
    return { status: "in_review", status_label: "In Review", status_copy: IN_REVIEW_COPY };
  }
  if (status === "waiting_on_customer") {
    return {
      status: "waiting_on_customer",
      status_label: "Waiting on You",
      status_copy: WAITING_COPY,
    };
  }
  if (status === "resolved") {
    return { status: "resolved", status_label: "Resolved", status_copy: RESOLVED_COPY };
  }
  return { status: "unverified", status_label: "Unavailable", status_copy: UNVERIFIED_COPY };
}

function safeTimestamp(value) {
  return isNonEmpty(value) ? String(value).trim() : null;
}

function toListItem(row) {
  const mapped = mapStatus(row?.status);
  const entityType = String(row?.related_entity_type || "none");
  return {
    case_ref: formatCaseRef(row?.id),
    subject: String(row?.subject || "").trim() || "Support case",
    category_label: categoryLabel(row?.category),
    status: mapped.status,
    status_label: mapped.status_label,
    created_at: safeTimestamp(row?.created_at),
    updated_at: safeTimestamp(row?.updated_at),
    resolved_at: safeTimestamp(row?.resolved_at),
    related_entity_type: entityType,
    related_entity_ref: row?.related_entity_ref == null ? null : String(row.related_entity_ref),
  };
}

function toDetail(row) {
  const mapped = mapStatus(row?.status);
  const waiting = mapped.status === "waiting_on_customer";
  const resolved = mapped.status === "resolved";
  const entityType = String(row?.related_entity_type || "none");
  return {
    case_ref: formatCaseRef(row?.id),
    subject: String(row?.subject || "").trim() || "Support case",
    category_label: categoryLabel(row?.category),
    status: mapped.status,
    status_label: mapped.status_label,
    status_copy: mapped.status_copy,
    created_at: safeTimestamp(row?.created_at),
    updated_at: safeTimestamp(row?.updated_at),
    resolved_at: safeTimestamp(row?.resolved_at),
    question_excerpt: sanitizeExcerpt(row?.question_excerpt || ""),
    support_module_label: moduleLabel(row?.support_module),
    related_entity_type: entityType,
    related_entity_ref: row?.related_entity_ref == null ? null : String(row.related_entity_ref),
    customer_resolution: resolved ? serializeVisibleText(row?.customer_resolution) : null,
    tenant_action_required: waiting,
    tenant_action_message: waiting ? serializeVisibleText(row?.tenant_action_message) : null,
  };
}

function parseMyCasesQuery(query) {
  const raw = query && typeof query === "object" && !Array.isArray(query) ? query : {};
  const keys = Object.keys(raw).filter((k) => raw[k] != null && String(raw[k]).trim() !== "");
  if (keys.some((k) => !ALLOWED_QUERY_KEYS.has(k))) {
    return { ok: false, result: "invalid_request" };
  }
  if (!keys.length) {
    return { ok: true, mode: "list", caseRef: null };
  }
  const parsed = parseCaseRef(raw.case_ref);
  if (!parsed) {
    return { ok: false, result: "invalid_request" };
  }
  return { ok: true, mode: "detail", caseRef: parsed };
}

function buildListPath(tenantId) {
  const params = new URLSearchParams();
  params.set("tenant_id", `eq.${tenantId}`);
  params.set("select", CASE_SELECT);
  params.set("order", "created_at.desc,id.desc");
  params.set("limit", String(LIST_LIMIT));
  return `${CASE_TABLE}?${params.toString()}`;
}

function buildDetailPath(tenantId, caseId) {
  const params = new URLSearchParams();
  params.set("tenant_id", `eq.${tenantId}`);
  params.set("id", `eq.${caseId}`);
  params.set("select", CASE_SELECT);
  params.set("limit", "1");
  return `${CASE_TABLE}?${params.toString()}`;
}

async function defaultGet(path) {
  return supabaseRequest(path, { method: "GET" });
}

function sameTenantRows(rows, tenantId) {
  const tid = normId(tenantId);
  return (Array.isArray(rows) ? rows : []).filter((row) => normId(row?.tenant_id) === tid);
}

async function readMyCasesList(tenantId, deps = {}) {
  const tid = normId(tenantId);
  if (!tid || !isUuid(tid)) {
    return { ok: false, result: "read_failed" };
  }
  const get = deps.supabaseGet || defaultGet;
  const path = buildListPath(tid);
  let rows;
  try {
    rows = await get(path);
  } catch (_err) {
    return { ok: false, result: "read_failed", path };
  }
  if (!Array.isArray(rows)) {
    return { ok: false, result: "read_failed", path };
  }
  const list = sameTenantRows(rows, tid).slice(0, LIST_LIMIT);
  return {
    ok: true,
    result: "ok",
    path,
    cases: list.map(toListItem),
  };
}

async function readMyCasesDetail(tenantId, caseRef, deps = {}) {
  const tid = normId(tenantId);
  const parsed = typeof caseRef === "object" && caseRef ? caseRef : parseCaseRef(caseRef);
  if (!tid || !isUuid(tid) || !parsed) {
    return { ok: false, result: "invalid_request" };
  }
  const get = deps.supabaseGet || defaultGet;
  const path = buildDetailPath(tid, parsed.id);
  let rows;
  try {
    rows = await get(path);
  } catch (_err) {
    return { ok: false, result: "read_failed", path };
  }
  if (!Array.isArray(rows)) {
    return { ok: false, result: "read_failed", path };
  }
  const list = sameTenantRows(rows, tid);
  if (!list.length || !list[0]?.id) {
    return { ok: true, result: "not_found", path };
  }
  return {
    ok: true,
    result: "ok",
    path,
    case: toDetail(list[0]),
  };
}

function buildListChatAnswer(cases) {
  const list = Array.isArray(cases) ? cases : [];
  if (!list.length) return ZERO_CASES_COPY;
  const lines = list.map((row) => "• " + row.case_ref + " — " + row.status_label);
  return (
    "You have " +
    list.length +
    " support case" +
    (list.length === 1 ? "" : "s") +
    ":\n" +
    lines.join("\n") +
    "\nOpen My Cases to view the details."
  );
}

function myCasesChatAnswer(lookedUp) {
  if (!lookedUp) return UNVERIFIED_COPY;
  if (lookedUp.result === "no_tenant_context") return NO_TENANT_COPY;
  if (lookedUp.result === "read_failed") return UNVERIFIED_COPY;
  if (lookedUp.result === "invalid_request") return NOT_FOUND_COPY;
  if (lookedUp.result === "not_found") return NOT_FOUND_COPY;
  if (lookedUp.case && lookedUp.case.status_copy) {
    const row = lookedUp.case;
    const lines = [row.status_copy];
    if (row.status === "waiting_on_customer" && row.tenant_action_message) {
      lines.push("What we need from you: " + row.tenant_action_message);
    }
    if (row.status === "resolved" && row.customer_resolution) {
      lines.push("Resolution: " + row.customer_resolution);
    }
    return lines.join("\n");
  }
  if (Array.isArray(lookedUp.cases)) return buildListChatAnswer(lookedUp.cases);
  return UNVERIFIED_COPY;
}

module.exports = {
  CASE_TABLE,
  CASE_SELECT,
  LIST_LIMIT,
  OPEN_COPY,
  IN_REVIEW_COPY,
  WAITING_COPY,
  RESOLVED_COPY,
  UNVERIFIED_COPY,
  ZERO_CASES_COPY,
  NOT_FOUND_COPY,
  NO_TENANT_COPY,
  parseCaseRef,
  extractSupportCaseRef,
  categoryLabel,
  moduleLabel,
  mapStatus,
  toListItem,
  toDetail,
  parseMyCasesQuery,
  buildListPath,
  buildDetailPath,
  readMyCasesList,
  readMyCasesDetail,
  buildListChatAnswer,
  myCasesChatAnswer,
};
