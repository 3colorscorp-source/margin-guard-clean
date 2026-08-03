/**
 * CH-010B — Read-only Payment Intent list (Owner/Admin).
 * GET /.netlify/functions/project-payment-intents?project_id=...
 *
 * No writes. No invoice generation. No ledger. No Stripe.
 * Money: authoritative exact decimal strings + integer cents only.
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

const API_VERSION = "ch-010b-v1";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const OWNER_ADMIN_ROLES = new Set(["owner", "admin"]);

const PAYMENT_TYPES = new Set([
  "initial_scheduling_payment",
  "start_payment",
  "progress_payment",
  "material_cost",
  "change_order",
  "remaining_balance",
  "final_payment",
  "custom",
]);

const INTENT_STATUSES = new Set(["draft", "ready", "cancelled", "voided"]);

/** Legacy schedule / ledger / Hub labels → canonical payment_type. */
const LEGACY_PAYMENT_TYPE_MAP = Object.freeze({
  deposit: "initial_scheduling_payment",
  start: "start_payment",
  progress: "progress_payment",
  material: "material_cost",
  completion: "final_payment",
  final: "final_payment",
  custom: "custom",
  adjustment: "custom",
  INITIAL_SCHEDULING_PAYMENT: "initial_scheduling_payment",
  START_PAYMENT: "start_payment",
  PROGRESS_PAYMENT: "progress_payment",
  MATERIAL_COST: "material_cost",
  CHANGE_ORDER: "change_order",
  REMAINING_BALANCE: "remaining_balance",
  FINAL_PAYMENT: "final_payment",
  CUSTOM: "custom",
});

const ALLOWED_QUERY_KEYS = new Set(["project_id", "status", "payment_type"]);

const SELECT_COLS = [
  "id",
  "tenant_id",
  "project_id",
  "quote_id",
  "schedule_id",
  "schedule_item_id",
  "change_order_id",
  "payment_type",
  "title",
  "description",
  "amount",
  "currency",
  "status",
  "sequence_number",
  "due_date",
  "created_by",
  "created_at",
  "updated_at",
  "cancelled_at",
  "voided_at",
  "metadata",
].join(",");

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function trimField(value) {
  return String(value ?? "").trim();
}

function validUuid(value) {
  return UUID_RE.test(trimField(value));
}

function unknownKeys(input, allowed) {
  return Object.keys(input || {}).filter((key) => !allowed.has(key));
}

/**
 * Netlify may pass multiValueQueryStringParameters as arrays.
 * Reject repeated keys to avoid ambiguous filters.
 */
function singleQueryValue(event, key) {
  const multi = event.multiValueQueryStringParameters || {};
  if (Object.prototype.hasOwnProperty.call(multi, key)) {
    const arr = multi[key];
    if (Array.isArray(arr) && arr.length > 1) {
      return { error: "repeated_query_param", key };
    }
    if (Array.isArray(arr) && arr.length === 1) {
      return { value: arr[0] };
    }
  }
  const q = event.queryStringParameters || {};
  if (!Object.prototype.hasOwnProperty.call(q, key)) {
    return { value: undefined };
  }
  return { value: q[key] };
}

function toMoneyCents(value) {
  if (value == null || value === "") return null;
  let s;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    // Reject non-integral cent representations from float input.
    s = value.toFixed(2);
    if (Number(s) !== value && Math.abs(value - Number(s)) > 1e-9) {
      /* still accept finite numbers via fixed(2) for DB numeric JSON */
    }
  } else if (typeof value === "string") {
    s = value.trim();
  } else {
    return null;
  }
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  const cents = Number(whole) * 100 + Number((frac + "00").slice(0, 2));
  return Number.isSafeInteger(cents) ? cents : null;
}

function centsToMoney(cents) {
  return (Number(cents || 0) / 100).toFixed(2);
}

function mapLegacyPaymentType(value) {
  const raw = trimField(value);
  if (!raw) return null;
  if (PAYMENT_TYPES.has(raw)) return raw;
  const mapped = LEGACY_PAYMENT_TYPE_MAP[raw] || LEGACY_PAYMENT_TYPE_MAP[raw.toLowerCase()];
  return mapped && PAYMENT_TYPES.has(mapped) ? mapped : null;
}

/**
 * Deterministic sort: sequence_number ASC NULLS LAST, due_date ASC NULLS LAST,
 * created_at ASC, id ASC.
 */
function sortPaymentIntents(rows) {
  const list = Array.isArray(rows) ? rows.slice() : [];
  list.sort((a, b) => {
    const sa = a.sequence_number == null ? Number.POSITIVE_INFINITY : Number(a.sequence_number);
    const sb = b.sequence_number == null ? Number.POSITIVE_INFINITY : Number(b.sequence_number);
    if (sa !== sb) return sa - sb;
    const da = a.due_date == null || a.due_date === "" ? "\uffff" : String(a.due_date);
    const db = b.due_date == null || b.due_date === "" ? "\uffff" : String(b.due_date);
    if (da !== db) return da < db ? -1 : 1;
    const ca = String(a.created_at || "");
    const cb = String(b.created_at || "");
    if (ca !== cb) return ca < cb ? -1 : 1;
    return String(a.id || "").localeCompare(String(b.id || ""));
  });
  return list;
}

function serializeIntent(row) {
  const amountCents = toMoneyCents(row.amount);
  return {
    id: row.id,
    project_id: row.project_id,
    quote_id: row.quote_id || null,
    schedule_id: row.schedule_id || null,
    schedule_item_id: row.schedule_item_id || null,
    change_order_id: row.change_order_id || null,
    payment_type: row.payment_type,
    title: row.title,
    description: row.description == null || row.description === "" ? null : String(row.description),
    // Authoritative money: exact decimal string + integer cents (no float dollars).
    amount: amountCents == null ? null : centsToMoney(amountCents),
    amount_cents: amountCents,
    currency: trimField(row.currency) || "USD",
    status: row.status,
    sequence_number: row.sequence_number == null ? null : Number(row.sequence_number),
    due_date: row.due_date || null,
    created_by: row.created_by || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
    cancelled_at: row.cancelled_at || null,
    voided_at: row.voided_at || null,
    metadata:
      row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
        ? row.metadata
        : {},
  };
}

/**
 * Active intent totals exclude cancelled/voided.
 * All totals are exact strings + integer cents.
 */
function summarizeIntents(serialized) {
  let draftCents = 0;
  let readyCents = 0;
  let cancelledCents = 0;
  let voidedCents = 0;
  for (const row of serialized) {
    const cents =
      typeof row.amount_cents === "number" && Number.isSafeInteger(row.amount_cents)
        ? row.amount_cents
        : toMoneyCents(row.amount) || 0;
    if (row.status === "draft") draftCents += cents;
    else if (row.status === "ready") readyCents += cents;
    else if (row.status === "cancelled") cancelledCents += cents;
    else if (row.status === "voided") voidedCents += cents;
  }
  const intentCents = draftCents + readyCents;
  return {
    count: serialized.length,
    draft_count: serialized.filter((r) => r.status === "draft").length,
    ready_count: serialized.filter((r) => r.status === "ready").length,
    cancelled_count: serialized.filter((r) => r.status === "cancelled").length,
    voided_count: serialized.filter((r) => r.status === "voided").length,
    intent_total: centsToMoney(intentCents),
    intent_total_cents: intentCents,
    draft_total: centsToMoney(draftCents),
    draft_total_cents: draftCents,
    ready_total: centsToMoney(readyCents),
    ready_total_cents: readyCents,
    cancelled_total: centsToMoney(cancelledCents),
    cancelled_total_cents: cancelledCents,
    voided_total: centsToMoney(voidedCents),
    voided_total_cents: voidedCents,
  };
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
  const membership = await resolveMembershipByEmail(
    supabaseRequest,
    tenant.id,
    session.e
  );
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
  return { tenant, membership, session };
}

async function loadTenantProject(tenantId, projectId) {
  const rows = await supabaseRequest(
    `tenant_projects?id=eq.${encodeURIComponent(projectId)}` +
      `&tenant_id=eq.${encodeURIComponent(tenantId)}` +
      `&select=id,quote_id&limit=1`,
    { method: "GET" }
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function listPaymentIntents(tenantId, projectId, filters) {
  let path =
    `tenant_project_payment_intents?tenant_id=eq.${encodeURIComponent(tenantId)}` +
    `&project_id=eq.${encodeURIComponent(projectId)}` +
    `&select=${SELECT_COLS}` +
    `&order=sequence_number.asc.nullslast,due_date.asc.nullslast,created_at.asc,id.asc`;

  if (filters.status) {
    path += `&status=eq.${encodeURIComponent(filters.status)}`;
  }
  if (filters.payment_type) {
    path += `&payment_type=eq.${encodeURIComponent(filters.payment_type)}`;
  }

  const rows = await supabaseRequest(path, { method: "GET" });
  return Array.isArray(rows) ? rows : [];
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") {
      return json(204, { ok: true });
    }
    if (event.httpMethod !== "GET") {
      return json(405, {
        ok: false,
        error: "Method not allowed",
        code: "method_not_allowed",
      });
    }

    const { tenant } = await requireOwnerOrAdmin(event);
    const tenantId = trimField(tenant.id);

    const query = event.queryStringParameters || {};
    if (query.tenant_id != null) {
      return json(400, {
        ok: false,
        error: "tenant_id must not be sent by client",
        code: "tenant_id_forbidden",
      });
    }
    const multi = event.multiValueQueryStringParameters || {};
    if (multi.tenant_id != null) {
      return json(400, {
        ok: false,
        error: "tenant_id must not be sent by client",
        code: "tenant_id_forbidden",
      });
    }

    const badQueryKeys = unknownKeys(query, ALLOWED_QUERY_KEYS);
    if (badQueryKeys.length) {
      return json(400, {
        ok: false,
        error: "Unknown query fields rejected",
        code: "unknown_fields",
        fields: badQueryKeys,
      });
    }

    const projectQ = singleQueryValue(event, "project_id");
    if (projectQ.error === "repeated_query_param") {
      return json(400, {
        ok: false,
        error: "Repeated query parameters are not allowed",
        code: "repeated_query_param",
        field: "project_id",
      });
    }
    const projectId = trimField(projectQ.value);
    if (!projectId) {
      return json(400, {
        ok: false,
        error: "project_id is required",
        code: "project_id_required",
      });
    }
    if (!validUuid(projectId)) {
      return json(400, {
        ok: false,
        error: "Invalid project_id",
        code: "invalid_project_id",
      });
    }

    let statusFilter = "";
    const statusQ = singleQueryValue(event, "status");
    if (statusQ.error === "repeated_query_param") {
      return json(400, {
        ok: false,
        error: "Repeated query parameters are not allowed",
        code: "repeated_query_param",
        field: "status",
      });
    }
    if (statusQ.value != null && trimField(statusQ.value) !== "") {
      statusFilter = trimField(statusQ.value).toLowerCase();
      if (!INTENT_STATUSES.has(statusFilter)) {
        return json(400, {
          ok: false,
          error: "Invalid status filter",
          code: "invalid_status",
        });
      }
    }

    let typeFilter = "";
    const typeQ = singleQueryValue(event, "payment_type");
    if (typeQ.error === "repeated_query_param") {
      return json(400, {
        ok: false,
        error: "Repeated query parameters are not allowed",
        code: "repeated_query_param",
        field: "payment_type",
      });
    }
    if (typeQ.value != null && trimField(typeQ.value) !== "") {
      typeFilter = trimField(typeQ.value);
      if (!PAYMENT_TYPES.has(typeFilter)) {
        return json(400, {
          ok: false,
          error: "Invalid payment_type filter",
          code: "invalid_payment_type",
        });
      }
    }

    const project = await loadTenantProject(tenantId, projectId);
    if (!project?.id) {
      return json(404, {
        ok: false,
        error: "Project not found",
        code: "project_not_found",
      });
    }

    const rows = await listPaymentIntents(tenantId, projectId, {
      status: statusFilter || null,
      payment_type: typeFilter || null,
    });
    const ordered = sortPaymentIntents(rows);
    const payments = ordered.map(serializeIntent);
    const summary = summarizeIntents(payments);

    return json(200, {
      ok: true,
      version: API_VERSION,
      project_id: projectId,
      summary,
      payments,
    });
  } catch (err) {
    if (err && err.statusCode) {
      return json(err.statusCode, {
        ok: false,
        error: err.message || "Forbidden",
        code: err.code || "forbidden",
      });
    }
    console.error("[project-payment-intents]", err);
    return json(500, {
      ok: false,
      error: "Server error",
      code: "server_error",
    });
  }
};

exports._test = {
  API_VERSION,
  PAYMENT_TYPES,
  INTENT_STATUSES,
  LEGACY_PAYMENT_TYPE_MAP,
  ALLOWED_QUERY_KEYS,
  toMoneyCents,
  centsToMoney,
  mapLegacyPaymentType,
  sortPaymentIntents,
  serializeIntent,
  summarizeIntents,
  validUuid,
  unknownKeys,
  singleQueryValue,
};
