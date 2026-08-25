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
];

const PROJECT_DIAGNOSTIC_SELECT = PROJECT_DIAGNOSTIC_SELECT_FIELDS.join(",");

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

function toModelFacts(row, identifier) {
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

async function defaultProjectGet(path) {
  return supabaseRequest(path, { method: "GET" });
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

  return {
    outcome: "ok",
    facts: toModelFacts(list[0], identifier),
    queryPath,
  };
}

module.exports = {
  UUID_RE,
  PROJECT_DIAGNOSTIC_SELECT,
  PROJECT_DIAGNOSTIC_SELECT_FIELDS,
  extractProjectIdentifier,
  isProjectDiagnosticQuestion,
  isProjectSqlOrListAllProbe,
  normalizeProjectLifecycleStatus,
  isArchivedStatus,
  toModelFacts,
  buildProjectQueryPath,
  readProjectDiagnostic,
};
