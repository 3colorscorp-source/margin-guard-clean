/**
 * Closed read-only project lifecycle diagnostic for Support AI Stage 2D.
 * Fixed tenant_projects table, fixed select, GET only, trusted tenant_id filter, max 2 rows.
 * Never send raw rows, PII, money, supervisor identity, or operational/financial badges
 * to OpenAI. Owner-visible lifecycle status is normalized tenant_projects.status only.
 */
"use strict";

const { supabaseRequest } = require("../supabase-admin");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const PROJECT_DIAGNOSTIC_SELECT_FIELDS = [
  "id",
  "tenant_id",
  "project_name",
  "status",
  "supervisor_user_id",
  "created_at",
  "due_date",
  "quote_id",
];

const PROJECT_DIAGNOSTIC_SELECT = PROJECT_DIAGNOSTIC_SELECT_FIELDS.join(",");

/** Canonical supervisor portal list — tenant_projects.status allow-list. */
const SUPERVISOR_PORTAL_PROJECT_STATUSES = [
  "signed",
  "deposit_paid",
  "assigned",
  "in_progress",
  "completed",
];
const SUPERVISOR_PORTAL_PROJECT_STATUS_SET = new Set(SUPERVISOR_PORTAL_PROJECT_STATUSES);

/** Canonical supervisor portal list — linked quote status allow-list. */
const SUPERVISOR_PORTAL_QUOTE_STATUSES = ["accepted", "approved"];
const SUPERVISOR_PORTAL_QUOTE_STATUS_SET = new Set(SUPERVISOR_PORTAL_QUOTE_STATUSES);

const LINKED_QUOTE_STATUS_SELECT = "id,status";

const IDENTIFIER_STOPWORDS = new Set([
  "hub",
  "status",
  "control",
  "id",
  "the",
  "my",
  "this",
  "that",
  "a",
  "an",
  "still",
  "was",
  "is",
  "are",
  "been",
  "due",
  "start",
  "started",
  "end",
  "completed",
  "archived",
  "cancelled",
  "canceled",
  "assigned",
  "supervisor",
  "named",
  "called",
  "name",
]);

const TRAILING_NAME_CLAUSE =
  /\s+(?:is|has|have|was|does|do|with|and)\s+.+$/i;
const TRAILING_STATUS_WORDS =
  /\s+(?:completed|archived|cancelled|canceled|assigned|status|due|start|started|end|ending|supervisor|control).*$/i;

function isUuid(value) {
  return UUID_RE.test(String(value || "").trim());
}

function isNonEmpty(value) {
  return String(value ?? "").trim() !== "";
}

function isProjectSqlOrListAllProbe(message) {
  const text = String(message || "").toLowerCase();
  return (
    /\blist all projects\b/.test(text) ||
    /\blist my projects\b/.test(text) ||
    /\bshow (me )?(my |every |all )?projects\b/.test(text) ||
    /\bwhat projects do i have\b/.test(text) ||
    /\bevery project\b/.test(text) ||
    /\bfrom tenant_projects\b/.test(text) ||
    /\brun sql\b/.test(text) && /\bprojects?\b/.test(text)
  );
}

function hasFinancialProjectQuestion(text) {
  return /\b(balance due|remaining balance|profit|margin|labor budget|sale price|cost|costs|payment|payments|financial|invoices?)\b/.test(
    text
  );
}

function normalizeProjectLifecycleStatus(value) {
  return String(value || "").trim().toLowerCase();
}

function isArchivedStatus(status) {
  return status === "archived" || status === "cancelled";
}

function stripProjectNameTail(raw) {
  let name = String(raw || "").trim();
  name = name.replace(/[?!.]+$/g, "").trim();
  name = name.replace(TRAILING_NAME_CLAUSE, "").trim();
  name = name.replace(TRAILING_STATUS_WORDS, "").trim();
  name = name.replace(/[?!.]+$/g, "").trim();
  return name;
}

function extractProjectIdentifier(message) {
  const text = String(message || "").trim();
  if (!text) return null;

  const afterProjectUuid = text.match(
    /\bprojects?\s+(?:id\s+)?(?:#|number|no\.?)?\s*:?\s*([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/i
  );
  if (afterProjectUuid) {
    return { type: "id", value: afterProjectUuid[1] };
  }

  const anyUuid = text.match(
    /\b([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\b/i
  );
  if (anyUuid && /\bprojects?\b/i.test(text)) {
    return { type: "id", value: anyUuid[1] };
  }

  if (/\bprojects?\s*#?\s*\d+\b/i.test(text)) {
    return null;
  }
  if (/\bprojects?\s+for\b/i.test(text)) {
    return null;
  }

  const afterProject = text.match(/\bprojects?\s+(?:named\s+|called\s+|name\s+)?(.+)$/i);
  if (!afterProject) return null;
  const name = stripProjectNameTail(afterProject[1]);
  if (!name || IDENTIFIER_STOPWORDS.has(name.toLowerCase())) return null;
  if (/^#?\d+$/.test(name)) return null;
  if (isUuid(name)) return { type: "id", value: name };
  if (!/[A-Za-z]/.test(name)) return null;
  if (name.length < 2 || name.length > 200) return null;
  if (/^(for|the|a|an|my|our)\b/i.test(name)) return null;
  return { type: "project_name", value: name };
}

function isProjectDiagnosticQuestion(message) {
  const text = String(message || "").toLowerCase();
  if (!/\bprojects?\b/.test(text)) return false;
  if (/\binvoices?\b/.test(text)) return false;
  if (/\b(quotes?|estimates?)\b/.test(text)) return false;
  if (/\bcontracts?\b/.test(text)) return false;
  if (hasFinancialProjectQuestion(text)) return false;
  if (isProjectSqlOrListAllProbe(text)) return false;
  if (/\bhow (do|can|to|does)\b/.test(text) && !extractProjectIdentifier(message)) {
    return false;
  }
  if (/\bprojects?\s+for\b/.test(text)) {
    return true;
  }
  const numberedBare = /\bprojects?\s*#?\s*\d+\b/.test(text);
  const hasIdentifier = Boolean(extractProjectIdentifier(message));
  return (
    hasIdentifier ||
    numberedBare ||
    /\b(status|completed|archived|cancelled|canceled|assigned|supervisor|due|start|started|end)\b/.test(
      text
    ) ||
    /\bwas project\b/.test(text) ||
    /\bis project\b/.test(text)
  );
}

function isoDateOnly(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const day = raw.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  return day;
}

function isSupervisorPortalLifecycleStatus(status) {
  return SUPERVISOR_PORTAL_PROJECT_STATUS_SET.has(normalizeProjectLifecycleStatus(status));
}

function isSupervisorPortalQuoteStatus(status) {
  return SUPERVISOR_PORTAL_QUOTE_STATUS_SET.has(normalizeProjectLifecycleStatus(status));
}

/**
 * Device-mode supervisor portal eligibility from the current supervisor project list:
 * 1) project status in signed|deposit_paid|assigned|in_progress|completed
 * 2) linked quote_id present and that quote status in accepted|approved
 * 3) supervisor_user_id assigned (device list additionally matches the signed-in supervisor)
 * Owner-mode list omits (3). Support has no trusted supervisor identity. Positive
 * facts mean eligible for THE SUPERVISOR CURRENTLY ASSIGNED TO THIS PROJECT.
 */
function deriveSupervisorVisibility(row, quoteGate = {}) {
  const lifecycleAllows = isSupervisorPortalLifecycleStatus(row?.status);
  const supervisorAssigned = isNonEmpty(row?.supervisor_user_id);
  const quoteUnverified = quoteGate.unverified === true;
  const quotePresent = quoteUnverified ? null : quoteGate.allowed === true;
  const eligibleForAssigned =
    quoteUnverified === false && lifecycleAllows && quotePresent === true && supervisorAssigned;

  let visibilityReason = "eligible_for_assigned_supervisor";
  if (quoteUnverified) {
    visibilityReason = "status_unverified";
  } else {
    const missingCount = [!lifecycleAllows, quotePresent !== true, !supervisorAssigned].filter(
      Boolean
    ).length;
    if (missingCount === 0) visibilityReason = "eligible_for_assigned_supervisor";
    else if (missingCount > 1) visibilityReason = "multiple_requirements_missing";
    else if (!lifecycleAllows) visibilityReason = "lifecycle_not_eligible";
    else if (quotePresent !== true) visibilityReason = "quote_not_approved_or_accepted";
    else visibilityReason = "supervisor_not_assigned";
  }

  return {
    eligible_for_assigned_supervisor: eligibleForAssigned,
    lifecycle_allows_supervisor_visibility: lifecycleAllows,
    approved_or_accepted_quote_present: quotePresent,
    supervisor_assigned: supervisorAssigned,
    visibility_reason: visibilityReason,
  };
}

function toModelFacts(row, identifier, quoteGate = {}) {
  const status = normalizeProjectLifecycleStatus(row?.status);
  const createdAt = isNonEmpty(row?.created_at) ? String(row.created_at).trim() : null;
  const dueDate = isoDateOnly(row?.due_date);
  const projectRef = identifier && identifier.value ? String(identifier.value).trim() : null;
  const facts = {
    result: "found",
    project_ref: projectRef,
    status,
    archived: isArchivedStatus(status),
    completed: status === "completed",
    supervisor_assigned: isNonEmpty(row?.supervisor_user_id),
    supervisor_visibility: deriveSupervisorVisibility(row, quoteGate),
  };
  if (createdAt) facts.created_at = createdAt;
  if (dueDate) facts.due_date = dueDate;
  return facts;
}

function buildProjectQueryPath(tenantId, identifier) {
  const tid = String(tenantId || "").trim();
  const params = new URLSearchParams();
  params.set("tenant_id", `eq.${tid}`);
  params.set("select", PROJECT_DIAGNOSTIC_SELECT);
  params.set("limit", "2");
  if (identifier.type === "id") {
    params.set("id", `eq.${identifier.value}`);
  } else {
    params.set("project_name", `eq.${identifier.value}`);
  }
  return `tenant_projects?${params.toString()}`;
}

function buildLinkedQuoteStatusQueryPath(tenantId, quoteId) {
  const tid = String(tenantId || "").trim();
  const qid = String(quoteId || "").trim();
  const params = new URLSearchParams();
  params.set("tenant_id", `eq.${tid}`);
  params.set("id", `eq.${qid}`);
  params.set("select", LINKED_QUOTE_STATUS_SELECT);
  params.set("limit", "1");
  return `quotes?${params.toString()}`;
}

async function defaultProjectGet(path) {
  return supabaseRequest(path, { method: "GET" });
}

async function readLinkedQuoteGate(tenantId, quoteId, get) {
  const qid = String(quoteId || "").trim();
  if (!qid) {
    return { allowed: false, unverified: false };
  }
  const quoteQueryPath = buildLinkedQuoteStatusQueryPath(tenantId, qid);
  try {
    const qRows = await get(quoteQueryPath);
    if (!Array.isArray(qRows)) {
      return { allowed: false, unverified: true };
    }
    if (qRows.length === 0) {
      return { allowed: false, unverified: false };
    }
    return {
      allowed: isSupervisorPortalQuoteStatus(qRows[0] && qRows[0].status),
      unverified: false,
    };
  } catch (_err) {
    return { allowed: false, unverified: true };
  }
}

/**
 * @returns {Promise<{ outcome: "ok"|"not_found"|"ambiguous"|"status_unverified", facts?: object, queryPath: string }>}
 */
async function readProjectDiagnostic(tenantId, identifier, deps = {}) {
  const tid = String(tenantId || "").trim();
  if (!tid || !identifier || !identifier.type || !identifier.value) {
    return { outcome: "not_found", queryPath: "" };
  }
  if (identifier.type === "id" && !isUuid(identifier.value)) {
    return { outcome: "not_found", queryPath: "" };
  }
  if (identifier.type !== "id" && identifier.type !== "project_name") {
    return { outcome: "not_found", queryPath: "" };
  }

  const queryPath = buildProjectQueryPath(tid, identifier);
  const get = deps.supabaseGet || defaultProjectGet;
  let rows;
  try {
    rows = await get(queryPath);
  } catch (_err) {
    return { outcome: "status_unverified", queryPath };
  }
  if (!Array.isArray(rows)) {
    return { outcome: "status_unverified", queryPath };
  }

  const list = rows.filter((row) => String(row?.tenant_id || "").trim() === tid);
  if (list.length === 0) {
    return { outcome: "not_found", queryPath };
  }
  if (list.length > 1) {
    return { outcome: "ambiguous", queryPath };
  }

  const quoteId = list[0] && list[0].quote_id != null ? String(list[0].quote_id).trim() : "";
  const quoteGate = await readLinkedQuoteGate(tid, quoteId, get);

  return {
    outcome: "ok",
    facts: toModelFacts(list[0], identifier, quoteGate),
    queryPath,
  };
}

module.exports = {
  UUID_RE,
  PROJECT_DIAGNOSTIC_SELECT,
  PROJECT_DIAGNOSTIC_SELECT_FIELDS,
  SUPERVISOR_PORTAL_PROJECT_STATUSES,
  SUPERVISOR_PORTAL_QUOTE_STATUSES,
  LINKED_QUOTE_STATUS_SELECT,
  extractProjectIdentifier,
  isProjectDiagnosticQuestion,
  isProjectSqlOrListAllProbe,
  normalizeProjectLifecycleStatus,
  isArchivedStatus,
  isSupervisorPortalLifecycleStatus,
  isSupervisorPortalQuoteStatus,
  deriveSupervisorVisibility,
  toModelFacts,
  buildProjectQueryPath,
  buildLinkedQuoteStatusQueryPath,
  readProjectDiagnostic,
};
