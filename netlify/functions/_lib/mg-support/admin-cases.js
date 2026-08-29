/**
 * Closed Support Admin case reads/writes for MG-SUPPORT-003C / 003E.2B / 003E.2D1.
 * Real transitions use atomic RPC mg_support_transition_case. No OpenAI. No DELETE.
 * No email. No outbound notification delivery in D1.
 */
"use strict";

const { supabaseRequest, getSupabaseConfig } = require("../supabase-admin");
const { formatCaseRef, sanitizeExcerpt } = require("./case-intake");
const { kickSupportCaseNotificationDispatch } = require("./notification-delivery");

const CASE_TABLE = "tenant_support_cases";
const TENANT_TABLE = "tenants";
const CASE_LIST_SELECT =
  "id,tenant_id,status,category,subject,question_excerpt,page_path,support_module,related_entity_type,related_entity_ref,created_at,updated_at,resolved_at,customer_resolution,tenant_action_message,status_version";
const CASE_GET_SELECT =
  "id,status,customer_resolution,tenant_action_message,status_version,resolved_at";
const TENANT_SELECT = "id,name";
const COUNT_SELECT = "id";
const COUNT_METHOD = "HEAD";
const COUNT_KINDS = new Set([
  "open",
  "in_review",
  "waiting_on_customer",
  "resolved",
  "all",
]);
const ACTIVE_STATUSES = ["open", "in_review", "waiting_on_customer"];
const CASE_STATUSES = new Set(["open", "in_review", "waiting_on_customer", "resolved"]);

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 50;
const VISIBLE_TEXT_MAX = 400;
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
const UPDATE_BODY_KEYS = new Set([
  "case_id",
  "action",
  "customer_resolution",
  "tenant_action_message",
]);
const STATUS_FILTERS = new Set([
  "active",
  "open",
  "in_review",
  "waiting_on_customer",
  "resolved",
  "all",
]);
const CATEGORIES = new Set([
  "unresolved_question",
  "diagnostic_unavailable",
  "possible_bug",
  "other",
]);
const ACTIONS = new Set([
  "mark_in_review",
  "request_customer_action",
  "resolve",
  "reopen",
  "return_to_open",
]);
const CATEGORY_LABELS = {
  unresolved_question: "Unresolved question",
  diagnostic_unavailable: "Diagnostic unavailable",
  possible_bug: "Possible bug",
  other: "Other",
};
const STATUS_LABELS = {
  open: "Open",
  in_review: "In Review",
  waiting_on_customer: "Waiting on You",
  resolved: "Resolved",
};

const TRANSITION_RPC = "mg_support_transition_case";
const EVENT_TYPE_BY_ACTION = {
  mark_in_review: "case_in_review",
  request_customer_action: "case_waiting_on_customer",
  resolve: "case_resolved",
  reopen: "case_reopened",
  return_to_open: null,
};

const ACTION_PLAN = {
  mark_in_review: {
    to: "in_review",
    from: new Set(["open", "waiting_on_customer", "resolved"]),
    already: "already_in_review",
    success: "in_review",
  },
  request_customer_action: {
    to: "waiting_on_customer",
    from: new Set(["open", "in_review"]),
    already: "already_waiting_on_customer",
    success: "waiting_on_customer",
  },
  resolve: {
    to: "resolved",
    from: new Set(["open", "in_review", "waiting_on_customer"]),
    already: "already_resolved",
    success: "resolved",
  },
  reopen: {
    to: "open",
    from: new Set(["resolved"]),
    already: "already_open",
    success: "reopened",
  },
  return_to_open: {
    to: "open",
    from: new Set(["in_review"]),
    already: "already_open",
    success: "returned_to_open",
  },
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

function statusLabel(status) {
  return STATUS_LABELS[status] || "Unknown";
}

function defaultGet(path) {
  return supabaseRequest(path, { method: "GET" });
}

function queryGetter(deps = {}) {
  return deps.supabaseGet || defaultGet;
}

function queryRpc(deps = {}) {
  if (typeof deps.supabaseRpc === "function") return deps.supabaseRpc;
  return function defaultRpc(name, args) {
    return supabaseRequest("rpc/" + name, { method: "POST", body: args });
  };
}

function rpcResultRow(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
  if (Array.isArray(raw) && raw[0] && typeof raw[0] === "object") return raw[0];
  return null;
}

function parseLimit(raw) {
  if (raw == null || raw === "") return { ok: true, value: DEFAULT_LIMIT };
  const text = String(raw).trim();
  if (!/^[1-9]\d*$/.test(text)) return { ok: false };
  const value = Number(text);
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) return { ok: false };
  return { ok: true, value };
}

function sanitizeVisibleText(raw) {
  if (raw == null) return { omitted: true };
  if (typeof raw !== "string") return { ok: false };
  if (raw.trim().length > VISIBLE_TEXT_MAX) return { ok: false };
  const value = sanitizeExcerpt(raw);
  return { omitted: false, value };
}

function parseListQuery(query) {
  const raw = query && typeof query === "object" && !Array.isArray(query) ? query : {};
  const keys = Object.keys(raw);
  if (keys.some((k) => !LIST_QUERY_KEYS.has(k))) {
    return { ok: false, result: "invalid_request" };
  }

  const statusRaw = raw.status == null || raw.status === "" ? "active" : String(raw.status).trim();
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
  if (!keys.includes("case_id") || !keys.includes("action")) {
    return { ok: false, result: "invalid_request" };
  }
  if (keys.some((k) => !UPDATE_BODY_KEYS.has(k))) {
    return { ok: false, result: "invalid_request" };
  }

  const caseId = String(body.case_id || "").trim();
  const action = String(body.action || "").trim();
  if (!isUuid(caseId) || !ACTIONS.has(action)) {
    return { ok: false, result: "invalid_request" };
  }

  const hasResolution = Object.prototype.hasOwnProperty.call(body, "customer_resolution");
  const hasActionMsg = Object.prototype.hasOwnProperty.call(body, "tenant_action_message");
  if (hasResolution && action !== "resolve") {
    return { ok: false, result: "invalid_request" };
  }
  if (hasActionMsg && action !== "request_customer_action") {
    return { ok: false, result: "invalid_request" };
  }
  if (action === "request_customer_action" && !hasActionMsg) {
    return { ok: false, result: "invalid_request" };
  }

  let has_customer_resolution = false;
  let customer_resolution;
  if (hasResolution) {
    const parsed = sanitizeVisibleText(body.customer_resolution);
    if (parsed.ok === false) return { ok: false, result: "invalid_request" };
    if (!parsed.omitted && parsed.value && parsed.value.length >= 1) {
      has_customer_resolution = true;
      customer_resolution = parsed.value;
    }
  }

  let tenant_action_message;
  if (action === "request_customer_action") {
    const parsed = sanitizeVisibleText(body.tenant_action_message);
    if (parsed.ok === false || parsed.omitted || !parsed.value || parsed.value.length < 1) {
      return { ok: false, result: "invalid_request" };
    }
    tenant_action_message = parsed.value;
  }

  return {
    ok: true,
    case_id: caseId,
    action,
    has_customer_resolution,
    customer_resolution,
    tenant_action_message,
  };
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
  if (kind !== "all") {
    params.set("status", `eq.${kind}`);
  }
  params.set("select", COUNT_SELECT);
  return `${CASE_TABLE}?${params.toString()}`;
}

/**
 * Exact Support Inbox counts via PostgREST Prefer: count=exact
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
  if (filters.status === "active") {
    params.set("status", `in.(${ACTIVE_STATUSES.join(",")})`);
  } else if (CASE_STATUSES.has(filters.status)) {
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

function buildPatchPath(caseId, guards) {
  const params = new URLSearchParams();
  params.set("id", `eq.${caseId}`);
  if (guards && CASE_STATUSES.has(String(guards.status || ""))) {
    params.set("status", `eq.${guards.status}`);
  }
  if (guards && Number.isInteger(guards.status_version) && guards.status_version >= 1) {
    params.set("status_version", `eq.${guards.status_version}`);
  }
  params.set("select", CASE_GET_SELECT);
  return `${CASE_TABLE}?${params.toString()}`;
}

function mapSafeCase(row, tenantName) {
  const id = String(row?.id || "").trim();
  const status = String(row?.status || "");
  const versionRaw = Number(row?.status_version);
  const statusVersion = Number.isInteger(versionRaw) && versionRaw >= 1 ? versionRaw : 1;
  const resolutionRaw = row?.customer_resolution;
  const actionRaw = row?.tenant_action_message;
  return {
    case_id: id,
    case_ref: formatCaseRef(id),
    tenant_business_name: tenantName || UNKNOWN_BUSINESS,
    status,
    status_label: statusLabel(status),
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
    customer_resolution:
      resolutionRaw == null || String(resolutionRaw).trim() === ""
        ? null
        : sanitizeExcerpt(resolutionRaw),
    tenant_action_message:
      actionRaw == null || String(actionRaw).trim() === ""
        ? null
        : sanitizeExcerpt(actionRaw),
    status_version: statusVersion,
  };
}

async function listAdminCases(filters, deps = {}) {
  const get = queryGetter(deps);
  const listPath = buildListCasesPath(filters);
  const openCountPath = buildCountPath("open");
  const inReviewCountPath = buildCountPath("in_review");
  const waitingCountPath = buildCountPath("waiting_on_customer");
  const resolvedCountPath = buildCountPath("resolved");
  const totalCountPath = buildCountPath("all");

  let rows;
  let openCount;
  let inReviewCount;
  let waitingCount;
  let resolvedCount;
  let totalCount;
  try {
    rows = await get(listPath);
    openCount = await getExactSupportCaseCount("open", deps);
    inReviewCount = await getExactSupportCaseCount("in_review", deps);
    waitingCount = await getExactSupportCaseCount("waiting_on_customer", deps);
    resolvedCount = await getExactSupportCaseCount("resolved", deps);
    totalCount = await getExactSupportCaseCount("all", deps);
  } catch (_err) {
    return { ok: false, result: "read_failed" };
  }
  if (
    !Array.isArray(rows) ||
    openCount == null ||
    inReviewCount == null ||
    waitingCount == null ||
    resolvedCount == null ||
    totalCount == null
  ) {
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
      active: openCount + inReviewCount + waitingCount,
      open: openCount,
      in_review: inReviewCount,
      waiting_on_customer: waitingCount,
      resolved: resolvedCount,
      total: totalCount,
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
      inReviewCount: inReviewCountPath,
      waitingCount: waitingCountPath,
      resolvedCount: resolvedCountPath,
      totalCount: totalCountPath,
    },
  };
}

function currentVersion(row) {
  const n = Number(row?.status_version);
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
}

function alreadyResult(result, row, caseId) {
  const id = String(row?.id || caseId);
  return {
    ok: true,
    result,
    case_id: id,
    case_ref: formatCaseRef(id),
    status: String(row?.status || ""),
    resolved_at: row?.resolved_at == null ? null : String(row.resolved_at),
    updated_at: row?.updated_at == null ? null : String(row.updated_at),
    customer_resolution: row?.customer_resolution == null ? null : String(row.customer_resolution),
    tenant_action_message: row?.tenant_action_message == null ? null : String(row.tenant_action_message),
    status_version: currentVersion(row),
  };
}

async function updateAdminCase(parsed, deps = {}) {
  const caseId = parsed && parsed.case_id;
  const action = parsed && parsed.action;
  const plan = ACTION_PLAN[action];
  if (!caseId || !plan) {
    return { ok: false, result: "invalid_request" };
  }

  const get = queryGetter(deps);
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

  const row = rows[0];
  const current = String(row.status || "");
  const version = currentVersion(row);
  if (!CASE_STATUSES.has(current) || version == null) {
    return { ok: false, result: "write_failed" };
  }

  if (current === plan.to) {
    return alreadyResult(plan.already, row, caseId);
  }
  if (!plan.from.has(current)) {
    return { ok: false, result: "invalid_transition" };
  }

  if (action === "request_customer_action") {
    const msg = String(parsed.tenant_action_message || "").trim();
    if (!msg || msg.length > VISIBLE_TEXT_MAX) {
      return { ok: false, result: "invalid_request" };
    }
  }

  const rpc = queryRpc(deps);
  let rpcRaw;
  try {
    rpcRaw = await rpc(TRANSITION_RPC, {
      p_case_id: caseId,
      p_expected_status: current,
      p_expected_status_version: version,
      p_action: action,
      p_customer_resolution: parsed.has_customer_resolution ? parsed.customer_resolution : null,
      p_has_customer_resolution: parsed.has_customer_resolution === true,
      p_tenant_action_message: action === "request_customer_action" ? parsed.tenant_action_message : null,
    });
  } catch (_err) {
    return { ok: false, result: "write_failed" };
  }

  const rpcRow = rpcResultRow(rpcRaw);
  const code = String(rpcRow?.result_code || "");
  if (code === "stale_state") {
    return {
      ok: false,
      result: "stale_state",
      case_id: String(rpcRow.case_id || caseId),
      case_ref: formatCaseRef(String(rpcRow.case_id || caseId)),
      status: rpcRow.status == null ? null : String(rpcRow.status),
      resolved_at: rpcRow.resolved_at == null ? null : String(rpcRow.resolved_at),
      updated_at: rpcRow.updated_at == null ? null : String(rpcRow.updated_at),
      customer_resolution: rpcRow.customer_resolution == null ? null : String(rpcRow.customer_resolution),
      tenant_action_message: rpcRow.tenant_action_message == null ? null : String(rpcRow.tenant_action_message),
      status_version: currentVersion({ status_version: rpcRow.status_version }),
    };
  }
  if (code === "invalid_transition") {
    return { ok: false, result: "invalid_transition" };
  }
  if (code === "already_target_state") {
    return alreadyResult(plan.already, {
      id: rpcRow.case_id || caseId,
      status: rpcRow.status || plan.to,
      status_version: rpcRow.status_version,
      resolved_at: rpcRow.resolved_at,
      updated_at: rpcRow.updated_at,
      customer_resolution: rpcRow.customer_resolution,
      tenant_action_message: rpcRow.tenant_action_message,
    }, caseId);
  }
  if (code === "invalid_request") {
    return { ok: false, result: "invalid_request" };
  }
  if (code !== "transitioned") {
    return { ok: false, result: "write_failed" };
  }

  const nextStatus = String(rpcRow.status || "");
  const nextVersion = currentVersion({ status_version: rpcRow.status_version });
  if (nextStatus !== plan.to || nextVersion == null) {
    return { ok: false, result: "write_failed" };
  }
  const expectsEvent = EVENT_TYPE_BY_ACTION[action] != null;
  if (expectsEvent && rpcRow.event_queued !== true) {
    return { ok: false, result: "write_failed" };
  }
  if (!expectsEvent && rpcRow.event_queued === true) {
    return { ok: false, result: "write_failed" };
  }

  if (expectsEvent && rpcRow.event_id) {
    try {
      const kick = deps.kickSupportCaseNotificationDispatch || kickSupportCaseNotificationDispatch;
      await kick(String(rpcRow.event_id), deps);
    } catch (_err) {
      // Best-effort only. Case transition already committed.
    }
  }

  return {
    ok: true,
    result: plan.success,
    case_id: String(rpcRow.case_id || caseId),
    case_ref: formatCaseRef(String(rpcRow.case_id || caseId)),
    status: nextStatus,
    resolved_at: action === "resolve" ? (rpcRow.resolved_at == null ? null : String(rpcRow.resolved_at)) : null,
    updated_at: rpcRow.updated_at == null ? null : String(rpcRow.updated_at),
    customer_resolution: rpcRow.customer_resolution == null ? null : String(rpcRow.customer_resolution),
    tenant_action_message: rpcRow.tenant_action_message == null ? null : String(rpcRow.tenant_action_message),
    status_version: nextVersion,
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
  ACTIVE_STATUSES,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  VISIBLE_TEXT_MAX,
  LIST_QUERY_KEYS,
  UPDATE_BODY_KEYS,
  STATUS_FILTERS,
  ACTIONS,
  TRANSITION_RPC,
  ACTION_PLAN,
  EVENT_TYPE_BY_ACTION,
  UNKNOWN_BUSINESS,
  isUuid,
  isIsoTimestamp,
  categoryLabel,
  statusLabel,
  sanitizeVisibleText,
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
