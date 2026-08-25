/**
 * Closed Support Admin case reads/writes for MG-SUPPORT-003C.
 * Fixed table, select, filters, and PATCH fields. No OpenAI. No DELETE.
 */
"use strict";

const { supabaseRequest, getSupabaseConfig } = require("../supabase-admin");
const { formatCaseRef, sanitizeExcerpt } = require("./case-intake");

const CASE_TABLE = "tenant_support_cases";
const TENANT_TABLE = "tenants";
const CASE_LIST_SELECT =
  "id,tenant_id,status,category,subject,question_excerpt,page_path,support_module,related_entity_type,related_entity_ref,created_at,updated_at,resolved_at";
const CASE_GET_SELECT = "id,status";
const TENANT_SELECT = "id,name";
const COUNT_SELECT = "id";
const COUNT_METHOD = "HEAD";
const COUNT_KINDS = new Set(["open", "resolved"]);

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 50;
const UNKNOWN_BUSINESS = "Unknown business";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

const LIST_QUERY_KEYS = new Set([
  "status",
  "category",
  "limit",
  "before_created_at",
  "before_id",
]);
const UPDATE_BODY_KEYS = new Set(["case_id", "action"]);
const STATUS_FILTERS = new Set(["open", "resolved", "all"]);
const CATEGORIES = new Set([
  "unresolved_question",
  "diagnostic_unavailable",
  "possible_bug",
  "other",
]);
const ACTIONS = new Set(["resolve", "reopen"]);
const CATEGORY_LABELS = {
  unresolved_question: "Unresolved question",
  diagnostic_unavailable: "Diagnostic unavailable",
  possible_bug: "Possible bug",
  other: "Other",
};

function isUuid(value) {
  return UUID_RE.test(String(value || "").trim());
}

function isIsoTimestamp(value) {
  const text = String(value || "").trim();
  if (!ISO_RE.test(text)) return false;
  const ms = Date.parse(text);
  return Number.isFinite(ms);
}

function categoryLabel(category) {
  return CATEGORY_LABELS[category] || "Other";
}

function nowIso(deps = {}) {
  if (typeof deps.nowIso === "function") return String(deps.nowIso());
  return new Date().toISOString();
}

function defaultGet(path) {
  return supabaseRequest(path, { method: "GET" });
}

function defaultPatch(path, body) {
  return supabaseRequest(path, {
    method: "PATCH",
    body,
    headers: { Prefer: "return=representation" },
  });
}

function queryGetter(deps = {}) {
  return deps.supabaseGet || defaultGet;
}

function queryPatcher(deps = {}) {
  return deps.supabasePatch || defaultPatch;
}

function parseLimit(raw) {
  if (raw == null || raw === "") return { ok: true, value: DEFAULT_LIMIT };
  const text = String(raw).trim();
  if (!/^[1-9]\d*$/.test(text)) return { ok: false };
  const value = Number(text);
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) return { ok: false };
  return { ok: true, value };
}

function parseListQuery(query) {
  const raw = query && typeof query === "object" && !Array.isArray(query) ? query : {};
  const keys = Object.keys(raw);
  if (keys.some((k) => !LIST_QUERY_KEYS.has(k))) {
    return { ok: false, result: "invalid_request" };
  }

  const statusRaw = raw.status == null || raw.status === "" ? "open" : String(raw.status).trim();
  if (!STATUS_FILTERS.has(statusRaw)) {
    return { ok: false, result: "invalid_request" };
  }

  let category = null;
  if (raw.category != null && String(raw.category).trim() !== "") {
    category = String(raw.category).trim();
    if (!CATEGORIES.has(category)) {
      return { ok: false, result: "invalid_request" };
    }
  }

  const limitParsed = parseLimit(raw.limit);
  if (!limitParsed.ok) return { ok: false, result: "invalid_request" };

  const hasBeforeTs = raw.before_created_at != null && String(raw.before_created_at).trim() !== "";
  const hasBeforeId = raw.before_id != null && String(raw.before_id).trim() !== "";
  if (hasBeforeTs !== hasBeforeId) {
    return { ok: false, result: "invalid_request" };
  }

  let cursor = null;
  if (hasBeforeTs && hasBeforeId) {
    const beforeCreatedAt = String(raw.before_created_at).trim();
    const beforeId = String(raw.before_id).trim();
    if (!isIsoTimestamp(beforeCreatedAt) || !isUuid(beforeId)) {
      return { ok: false, result: "invalid_request" };
    }
    cursor = { before_created_at: beforeCreatedAt, before_id: beforeId };
  }

  return {
    ok: true,
    filters: {
      status: statusRaw,
      category,
      limit: limitParsed.value,
      cursor,
    },
  };
}

function parseUpdateBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, result: "invalid_request" };
  }
  const keys = Object.keys(body);
  if (keys.length !== 2 || keys.some((k) => !UPDATE_BODY_KEYS.has(k))) {
    return { ok: false, result: "invalid_request" };
  }
  const caseId = String(body.case_id || "").trim();
  const action = String(body.action || "").trim();
  if (!isUuid(caseId) || !ACTIONS.has(action)) {
    return { ok: false, result: "invalid_request" };
  }
  return { ok: true, case_id: caseId, action };
}

function parseContentRangeTotal(header) {
  const text = String(header || "").trim().replace(/^items\s+/i, "");
  if (!text) return null;
  const matched = /^(?:\*|\d+-\d+)\/(0|[1-9]\d*)$/.exec(text);
  if (!matched) return null;
  const total = Number(matched[1]);
  if (!Number.isInteger(total) || total < 0) return null;
  return total;
}

function buildCountPath(kind) {
  if (!COUNT_KINDS.has(kind)) return null;
  const params = new URLSearchParams();
  params.set("status", `eq.${kind}`);
  params.set("select", COUNT_SELECT);
  return `${CASE_TABLE}?${params.toString()}`;
}

/**
 * Exact open/resolved Support Inbox counts via PostgREST Prefer: count=exact
 * and Content-Range. Isolated fetch: supabaseRequest does not expose headers.
 * Caller cannot supply table, select, or filter. Fail closed on bad totals.
 */
async function getExactSupportCaseCount(kind, deps = {}) {
  if (!COUNT_KINDS.has(kind)) return null;
  if (typeof deps.countCases === "function") {
    try {
      const n = await deps.countCases(kind);
      if (n == null) return null;
      const num = Number(n);
      if (!Number.isInteger(num) || num < 0) return null;
      return num;
    } catch (_err) {
      return null;
    }
  }

  const path = buildCountPath(kind);
  if (!path) return null;
  try {
    const cfgFn = deps.getSupabaseConfig || getSupabaseConfig;
    const { url, key } = cfgFn();
    if (!url || !key) return null;
    const fetchImpl = deps.countFetch || deps.fetch || globalThis.fetch;
    if (typeof fetchImpl !== "function") return null;
    const res = await fetchImpl(`${url}/rest/v1/${path}`, {
      method: COUNT_METHOD,
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
        Prefer: "count=exact",
        Range: "0-0",
      },
    });
    const status = Number(res && res.status);
    if (status !== 200 && status !== 206 && status !== 416) return null;
    const header =
      (res.headers && typeof res.headers.get === "function" &&
        (res.headers.get("content-range") || res.headers.get("Content-Range"))) ||
      "";
    return parseContentRangeTotal(header);
  } catch (_err) {
    return null;
  }
}

function buildListCasesPath(filters) {
  const params = new URLSearchParams();
  params.set("select", CASE_LIST_SELECT);
  params.set("order", "created_at.desc,id.desc");
  params.set("limit", String(filters.limit + 1));
  if (filters.status === "open" || filters.status === "resolved") {
    params.set("status", `eq.${filters.status}`);
  }
  if (filters.category) {
    params.set("category", `eq.${filters.category}`);
  }
  if (filters.cursor) {
    const ts = filters.cursor.before_created_at;
    const id = filters.cursor.before_id;
    params.set(
      "or",
      `(created_at.lt."${ts}",and(created_at.eq."${ts}",id.lt.${id}))`
    );
  }
  return `${CASE_TABLE}?${params.toString()}`;
}

function buildTenantNamesPath(ids) {
  const unique = [];
  const seen = new Set();
  for (const id of ids) {
    const value = String(id || "").trim();
    if (!isUuid(value) || seen.has(value)) continue;
    seen.add(value);
    unique.push(value);
    if (unique.length >= MAX_LIMIT) break;
  }
  if (!unique.length) return null;
  const params = new URLSearchParams();
  params.set("select", TENANT_SELECT);
  params.set("id", `in.(${unique.join(",")})`);
  params.set("limit", String(unique.length));
  return `${TENANT_TABLE}?${params.toString()}`;
}

function buildExactCasePath(caseId) {
  const params = new URLSearchParams();
  params.set("id", `eq.${caseId}`);
  params.set("select", CASE_GET_SELECT);
  params.set("limit", "1");
  return `${CASE_TABLE}?${params.toString()}`;
}

function buildPatchPath(caseId) {
  const params = new URLSearchParams();
  params.set("id", `eq.${caseId}`);
  params.set("select", CASE_GET_SELECT);
  return `${CASE_TABLE}?${params.toString()}`;
}

function mapSafeCase(row, tenantName) {
  const id = String(row?.id || "").trim();
  return {
    case_id: id,
    case_ref: formatCaseRef(id),
    tenant_business_name: tenantName || UNKNOWN_BUSINESS,
    status: String(row?.status || ""),
    category: String(row?.category || ""),
    subject: String(row?.subject || ""),
    question_excerpt: sanitizeExcerpt(row?.question_excerpt || ""),
    page_path: row?.page_path == null ? null : String(row.page_path),
    support_module: String(row?.support_module || ""),
    related_entity_type: String(row?.related_entity_type || "none"),
    related_entity_ref: row?.related_entity_ref == null ? null : String(row.related_entity_ref),
    created_at: row?.created_at == null ? null : String(row.created_at),
    updated_at: row?.updated_at == null ? null : String(row.updated_at),
    resolved_at: row?.resolved_at == null ? null : String(row.resolved_at),
  };
}

async function listAdminCases(filters, deps = {}) {
  const get = queryGetter(deps);
  const listPath = buildListCasesPath(filters);
  const openCountPath = buildCountPath("open");
  const resolvedCountPath = buildCountPath("resolved");

  let rows;
  let openCount;
  let resolvedCount;
  try {
    rows = await get(listPath);
    openCount = await getExactSupportCaseCount("open", deps);
    resolvedCount = await getExactSupportCaseCount("resolved", deps);
  } catch (_err) {
    return { ok: false, result: "read_failed" };
  }
  if (!Array.isArray(rows) || openCount == null || resolvedCount == null) {
    return { ok: false, result: "read_failed" };
  }

  const hasMore = rows.length > filters.limit;
  const pageRows = rows.slice(0, filters.limit);
  const tenantIds = pageRows.map((row) => row && row.tenant_id).filter(Boolean);
  const namesById = new Map();
  const tenantPath = buildTenantNamesPath(tenantIds);
  if (tenantPath) {
    let tenants;
    try {
      tenants = await get(tenantPath);
    } catch (_err) {
      return { ok: false, result: "read_failed" };
    }
    if (!Array.isArray(tenants)) {
      return { ok: false, result: "read_failed" };
    }
    for (const tenant of tenants) {
      const id = String(tenant?.id || "").trim();
      const name = String(tenant?.name || "").trim();
      if (isUuid(id)) namesById.set(id, name || UNKNOWN_BUSINESS);
    }
  }

  const cases = pageRows.map((row) => {
    const tenantId = String(row?.tenant_id || "").trim();
    const name = namesById.get(tenantId);
    return mapSafeCase(row, name);
  });

  const last = cases.length ? cases[cases.length - 1] : null;
  return {
    ok: true,
    result: "ok",
    filters: {
      status: filters.status,
      category: filters.category,
    },
    counts: {
      open: openCount,
      resolved: resolvedCount,
      total: openCount + resolvedCount,
    },
    cases,
    page: {
      has_more: hasMore,
      next_cursor:
        hasMore && last
          ? { before_created_at: last.created_at, before_id: last.case_id }
          : null,
    },
    paths: {
      list: listPath,
      tenants: tenantPath,
      openCount: openCountPath,
      resolvedCount: resolvedCountPath,
    },
  };
}

async function updateAdminCase({ case_id: caseId, action }, deps = {}) {
  const get = queryGetter(deps);
  const patch = queryPatcher(deps);
  const getPath = buildExactCasePath(caseId);

  let rows;
  try {
    rows = await get(getPath);
  } catch (_err) {
    return { ok: false, result: "write_failed" };
  }
  if (!Array.isArray(rows) || !rows.length || !rows[0]?.id) {
    return { ok: true, result: "not_found" };
  }

  const current = String(rows[0].status || "");
  if (action === "resolve" && current === "resolved") {
    return { ok: true, result: "already_resolved" };
  }
  if (action === "reopen" && current === "open") {
    return { ok: true, result: "already_open" };
  }
  if (action === "resolve" && current !== "open") {
    return { ok: false, result: "write_failed" };
  }
  if (action === "reopen" && current !== "resolved") {
    return { ok: false, result: "write_failed" };
  }

  const stamp = nowIso(deps);
  const body =
    action === "resolve"
      ? { status: "resolved", resolved_at: stamp, updated_at: stamp }
      : { status: "open", resolved_at: null, updated_at: stamp };
  const patchPath = buildPatchPath(caseId);

  let patched;
  try {
    patched = await patch(patchPath, body);
  } catch (_err) {
    return { ok: false, result: "write_failed" };
  }
  const row = Array.isArray(patched) ? patched[0] : patched;
  const nextStatus = String(row?.status || "");
  if (action === "resolve" && nextStatus !== "resolved") {
    return { ok: false, result: "write_failed" };
  }
  if (action === "reopen" && nextStatus !== "open") {
    return { ok: false, result: "write_failed" };
  }

  return {
    ok: true,
    result: action === "resolve" ? "resolved" : "reopened",
    case_id: String(row?.id || caseId),
    case_ref: formatCaseRef(String(row?.id || caseId)),
    status: nextStatus,
    resolved_at: action === "resolve" ? stamp : null,
    updated_at: stamp,
  };
}

module.exports = {
  CASE_TABLE,
  TENANT_TABLE,
  CASE_LIST_SELECT,
  CASE_GET_SELECT,
  TENANT_SELECT,
  COUNT_SELECT,
  COUNT_METHOD,
  COUNT_KINDS,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  LIST_QUERY_KEYS,
  UPDATE_BODY_KEYS,
  UNKNOWN_BUSINESS,
  isUuid,
  isIsoTimestamp,
  categoryLabel,
  parseListQuery,
  parseUpdateBody,
  parseContentRangeTotal,
  getExactSupportCaseCount,
  buildCountPath,
  buildListCasesPath,
  buildTenantNamesPath,
  buildExactCasePath,
  buildPatchPath,
  mapSafeCase,
  listAdminCases,
  updateAdminCase,
};
