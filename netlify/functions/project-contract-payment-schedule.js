/**
 * CH-004A2 — Per-project contract payment schedule (Owner/Admin, session-scoped).
 * GET: read-only PostgREST.
 * POST: exactly one transactional RPC write.
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

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const APPROVED_QUOTE_STATUSES = new Set(["accepted", "approved"]);
const OWNER_ADMIN_ROLES = new Set(["owner", "admin"]);
const PAYMENT_TYPES = new Set([
  "deposit",
  "start",
  "progress",
  "material",
  "completion",
  "final",
  "custom",
]);
const DUE_RULES = new Set([
  "on_signature",
  "before_start",
  "on_start",
  "milestone",
  "on_completion",
  "fixed_date",
  "custom",
]);

const ALLOWED_QUERY_KEYS = new Set(["project_id", "quote_id"]);
const ALLOWED_BODY_KEYS = new Set([
  "project_id",
  "quote_id",
  "items",
  "confirm_schedule",
  "expected_updated_at",
]);
const ALLOWED_ITEM_KEYS = new Set([
  "sequence_number",
  "label",
  "payment_type",
  "amount",
  "due_rule",
  "milestone_description",
  "fixed_due_date",
]);
const FORBIDDEN_BODY_KEYS = new Set([
  "tenant_id",
  "contract_total",
  "currency",
  "confirmed_at",
  "schedule_id",
  "id",
  "status",
]);

const RPC_ERROR_MAP = Object.freeze({
  schedule_version_conflict: {
    status: 409,
    error: "This payment schedule changed in another session. Reload before saving.",
  },
  schedule_unavailable: {
    status: 404,
    error: "Project payment schedule unavailable",
  },
  project_quote_mismatch: {
    status: 409,
    error: "Quote does not belong to this project",
  },
  contract_total_unavailable: {
    status: 409,
    error: "Authoritative contract total is unavailable",
  },
  contract_total_changed: {
    status: 409,
    error: "Authoritative contract total changed. Reload before saving.",
  },
  currency_mismatch: {
    status: 409,
    error: "Currency does not match the authoritative quote currency",
  },
  schedule_total_mismatch: {
    status: 400,
    error: "Payment schedule total must equal the contract total before confirmation",
  },
  items_required: {
    status: 400,
    error: "At least one payment stage is required to confirm a schedule",
  },
  invalid_items: { status: 400, error: "items must be an array" },
  invalid_item: { status: 400, error: "Invalid payment schedule item" },
  unknown_item_fields: { status: 400, error: "Unknown item fields rejected" },
  invalid_sequence: {
    status: 400,
    error: "sequence_number must be an integer >= 1",
  },
  duplicate_sequence: { status: 400, error: "Duplicate sequence_number" },
  invalid_label: { status: 400, error: "label exceeds 160 characters" },
  invalid_enum: { status: 400, error: "Invalid enum value" },
  invalid_amount: {
    status: 400,
    error: "amount must be a non-negative amount with up to 2 decimals",
  },
  invalid_milestone: {
    status: 400,
    error: "milestone_description exceeds 1000 characters",
  },
  invalid_fixed_due_date: {
    status: 400,
    error: "fixed_due_date must be YYYY-MM-DD",
  },
  fixed_date_required: {
    status: 400,
    error: "fixed_due_date is required for fixed_date due_rule",
  },
  fixed_date_not_allowed: {
    status: 400,
    error: "fixed_due_date must be null unless due_rule is fixed_date",
  },
  invalid_confirmation: {
    status: 400,
    error: "confirm_schedule must be a boolean",
  },
  invalid_id: {
    status: 400,
    error: "Invalid project_id or quote_id",
  },
  save_failed: {
    status: 500,
    error: "Payment schedule save failed",
  },
});

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

function parseBody(raw) {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function unknownKeys(input, allowed) {
  return Object.keys(input || {}).filter((key) => !allowed.has(key));
}

function validUuid(value) {
  return UUID_RE.test(trimField(value));
}

function normStatus(value) {
  return trimField(value).toLowerCase();
}

function toMoneyCents(value) {
  if (value == null || value === "") return null;
  let s;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    s = value.toFixed(2);
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

function centsToNumber(cents) {
  return Number(centsToMoney(cents));
}

function moneyToNumber(value) {
  const cents = toMoneyCents(value);
  return cents == null ? null : centsToNumber(cents);
}

function percentageFor(amountCents, contractTotalCents) {
  if (!(contractTotalCents > 0)) return null;
  return Number(((amountCents * 100) / contractTotalCents).toFixed(4));
}

function parseOptionalDate(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") return { error: "fixed_due_date must be YYYY-MM-DD" };
  const s = value.trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return { error: "fixed_due_date must be YYYY-MM-DD" };
  }
  const d = new Date(`${s}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return { error: "fixed_due_date is invalid" };
  if (d.toISOString().slice(0, 10) !== s) return { error: "fixed_due_date is invalid" };
  return { value: s };
}

function parseExpectedUpdatedAt(value) {
  if (value == null || value === "") return { value: null };
  if (typeof value !== "string") {
    return { error: "expected_updated_at must be an ISO timestamp string" };
  }
  const s = value.trim();
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) {
    return { error: "expected_updated_at must be an ISO timestamp string" };
  }
  return { value: s };
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
  return { tenant };
}

async function verifyProjectAndQuote(tenantId, projectId, quoteId) {
  const tid = encodeURIComponent(tenantId);
  const pid = encodeURIComponent(projectId);
  const qid = encodeURIComponent(quoteId);

  const projects = await supabaseRequest(
    `tenant_projects?id=eq.${pid}&tenant_id=eq.${tid}&select=id,quote_id,sale_price&limit=1`,
    { method: "GET" }
  );
  const project = Array.isArray(projects) && projects[0] ? projects[0] : null;
  if (!project?.id) return { unavailable: true };

  const projectQuoteId = trimField(project.quote_id);
  if (!projectQuoteId || projectQuoteId.toLowerCase() !== quoteId.toLowerCase()) {
    return { mismatch: true };
  }

  const quotes = await supabaseRequest(
    `quotes?id=eq.${qid}&tenant_id=eq.${tid}&select=id,total,currency,status&limit=1`,
    { method: "GET" }
  );
  const quote = Array.isArray(quotes) && quotes[0] ? quotes[0] : null;
  if (!quote?.id) return { unavailable: true };

  const saleCents = toMoneyCents(project.sale_price);
  const quoteCents = toMoneyCents(quote.total);
  let contractTotalCents = null;
  let totalSource = "";
  if (saleCents != null && saleCents > 0) {
    contractTotalCents = saleCents;
    totalSource = "tenant_projects.sale_price";
  } else if (
    APPROVED_QUOTE_STATUSES.has(normStatus(quote.status)) &&
    quoteCents != null &&
    quoteCents > 0
  ) {
    contractTotalCents = quoteCents;
    totalSource = "approved_quote.total";
  }
  if (!(contractTotalCents > 0)) {
    return { invalidTotal: true };
  }

  return {
    project,
    quote,
    contractTotalCents,
    currency: trimField(quote.currency).slice(0, 12) || "USD",
    totalSource,
  };
}

async function loadSchedule(tenantId, projectId, quoteId) {
  const rows = await supabaseRequest(
    `project_contract_payment_schedules?tenant_id=eq.${encodeURIComponent(tenantId)}` +
      `&project_id=eq.${encodeURIComponent(projectId)}` +
      `&quote_id=eq.${encodeURIComponent(quoteId)}&select=*&limit=1`,
    { method: "GET" }
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function loadItems(tenantId, scheduleId) {
  if (!scheduleId) return [];
  const rows = await supabaseRequest(
    `project_contract_payment_schedule_items?tenant_id=eq.${encodeURIComponent(tenantId)}` +
      `&schedule_id=eq.${encodeURIComponent(scheduleId)}` +
      `&select=*&order=sequence_number.asc`,
    { method: "GET" }
  );
  return Array.isArray(rows) ? rows : [];
}

function normalizeItem(raw, index) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: `items[${index}] must be an object`, code: "invalid_item" };
  }
  const unknown = unknownKeys(raw, ALLOWED_ITEM_KEYS);
  if (unknown.length) {
    return {
      error: "Unknown item fields rejected",
      code: "unknown_item_fields",
      fields: unknown,
    };
  }

  const sequence = Number(raw.sequence_number);
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    return { error: "sequence_number must be an integer >= 1", code: "invalid_sequence" };
  }

  const label = trimField(raw.label);
  if (label.length > 160) {
    return { error: "label exceeds 160 characters", code: "invalid_label" };
  }

  const paymentType = trimField(raw.payment_type).toLowerCase();
  if (!PAYMENT_TYPES.has(paymentType)) {
    return { error: "Invalid payment_type", code: "invalid_enum" };
  }

  const amountCents = toMoneyCents(raw.amount);
  if (amountCents == null) {
    return {
      error: "amount must be a non-negative amount with up to 2 decimals",
      code: "invalid_amount",
    };
  }

  const dueRule = trimField(raw.due_rule).toLowerCase();
  if (!DUE_RULES.has(dueRule)) {
    return { error: "Invalid due_rule", code: "invalid_enum" };
  }

  const milestone = trimField(raw.milestone_description);
  if (milestone.length > 1000) {
    return {
      error: "milestone_description exceeds 1000 characters",
      code: "invalid_milestone",
    };
  }

  const dateParsed = parseOptionalDate(raw.fixed_due_date);
  if (dateParsed?.error) {
    return { error: dateParsed.error, code: "invalid_fixed_due_date" };
  }
  const fixedDueDate = dateParsed?.value || null;
  if (dueRule === "fixed_date" && !fixedDueDate) {
    return {
      error: "fixed_due_date is required for fixed_date due_rule",
      code: "fixed_date_required",
    };
  }
  if (dueRule !== "fixed_date" && fixedDueDate) {
    return {
      error: "fixed_due_date must be null unless due_rule is fixed_date",
      code: "fixed_date_not_allowed",
    };
  }

  return {
    item: {
      sequence_number: sequence,
      label,
      payment_type: paymentType,
      amount: centsToMoney(amountCents),
      due_rule: dueRule,
      milestone_description: milestone,
      fixed_due_date: fixedDueDate,
    },
  };
}

function normalizeItems(items) {
  if (!Array.isArray(items)) {
    return { error: "items must be an array", code: "invalid_items" };
  }

  const seen = new Set();
  const out = [];
  for (let i = 0; i < items.length; i += 1) {
    const normalized = normalizeItem(items[i], i);
    if (normalized.error) return normalized;
    const seq = normalized.item.sequence_number;
    if (seen.has(seq)) {
      return { error: "Duplicate sequence_number", code: "duplicate_sequence" };
    }
    seen.add(seq);
    out.push(normalized.item);
  }
  out.sort((a, b) => a.sequence_number - b.sequence_number);
  return { items: out };
}

function itemCents(row) {
  return toMoneyCents(row?.amount) || 0;
}

function totalItemsCents(items) {
  return (items || []).reduce((sum, item) => sum + itemCents(item), 0);
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

function serializeItem(row, contractTotalCents) {
  const amountCents = itemCents(row);
  return {
    id: row.id || null,
    sequence_number: Number(row.sequence_number) || 0,
    label: trimField(row.label),
    payment_type: trimField(row.payment_type),
    amount: centsToNumber(amountCents),
    percentage:
      row.percentage == null
        ? percentageFor(amountCents, contractTotalCents)
        : Number(row.percentage),
    due_rule: trimField(row.due_rule),
    milestone_description: trimField(row.milestone_description),
    fixed_due_date: row.fixed_due_date || null,
  };
}

function evaluateReadiness(schedule, items, contractTotalCents) {
  const itemCount = Array.isArray(items) ? items.length : 0;
  const scheduledTotalCents = totalItemsCents(items);
  const confirmed = Boolean(
    schedule &&
      schedule.status === "confirmed" &&
      schedule.confirmed_at &&
      itemCount > 0 &&
      scheduledTotalCents === contractTotalCents
  );
  const status = !schedule ? "missing" : confirmed ? "configured" : "draft";
  return {
    status,
    contract_total: centsToNumber(contractTotalCents),
    scheduled_total: centsToNumber(scheduledTotalCents),
    remaining_difference: centsToNumber(contractTotalCents - scheduledTotalCents),
    item_count: itemCount,
    confirmed_at: schedule?.confirmed_at || null,
  };
}

function requestIds(method, event, body) {
  const source =
    method === "GET" ? event.queryStringParameters || {} : body || {};
  return {
    projectId: trimField(source.project_id).toLowerCase(),
    quoteId: trimField(source.quote_id).toLowerCase(),
  };
}

function parseMgError(err) {
  const text = [
    err?.message,
    err?.supabaseRaw,
    typeof err?.supabaseRaw === "string" ? err.supabaseRaw : "",
  ]
    .filter(Boolean)
    .join(" ");
  const match = text.match(/MG_ERR:([a-z0-9_]+):([^|]*)/i);
  if (!match) return null;
  return {
    code: match[1],
    message: trimField(match[2]),
  };
}

function mapRpcFailure(err) {
  const parsed = parseMgError(err);
  if (parsed?.code && RPC_ERROR_MAP[parsed.code]) {
    const mapped = RPC_ERROR_MAP[parsed.code];
    return json(mapped.status, {
      ok: false,
      error: mapped.error,
      code: parsed.code,
    });
  }
  return json(500, {
    ok: false,
    error: "Project payment schedule is temporarily unavailable",
    code: "server_error",
  });
}

function normalizeRpcResult(raw, fallbackTotalCents, fallbackCurrency, fallbackSource) {
  const payload =
    Array.isArray(raw) && raw[0] && typeof raw[0] === "object"
      ? raw[0].replace_project_contract_payment_schedule || raw[0]
      : raw;
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const schedule = serializeSchedule(payload.schedule);
  const contractTotalCents =
    toMoneyCents(payload.readiness?.contract_total) ??
    toMoneyCents(schedule?.contract_total) ??
    fallbackTotalCents;
  const items = Array.isArray(payload.items)
    ? payload.items.map((item) => serializeItem(item, contractTotalCents))
    : [];
  const readiness = payload.readiness
    ? {
        status: trimField(payload.readiness.status) || "draft",
        contract_total: moneyToNumber(payload.readiness.contract_total),
        scheduled_total: moneyToNumber(payload.readiness.scheduled_total),
        remaining_difference: moneyToNumber(payload.readiness.remaining_difference),
        item_count: Number(payload.readiness.item_count) || items.length,
        confirmed_at: payload.readiness.confirmed_at || null,
      }
    : evaluateReadiness(schedule, items, contractTotalCents);

  return {
    schedule,
    items,
    readiness,
    source: {
      contract_total_source:
        trimField(payload.source?.contract_total_source) || fallbackSource,
      currency: trimField(payload.source?.currency) || fallbackCurrency,
    },
  };
}

async function replaceScheduleAtomically({
  tenantId,
  projectId,
  quoteId,
  contractTotalCents,
  currency,
  confirmSchedule,
  items,
  expectedUpdatedAt,
}) {
  return supabaseRequest("rpc/replace_project_contract_payment_schedule", {
    method: "POST",
    body: {
      p_tenant_id: tenantId,
      p_project_id: projectId,
      p_quote_id: quoteId,
      p_contract_total: centsToMoney(contractTotalCents),
      p_currency: currency,
      p_confirm_schedule: confirmSchedule,
      p_items: items,
      p_expected_updated_at: expectedUpdatedAt,
    },
  });
}

exports.handler = async (event) => {
  try {
    const method = event.httpMethod;
    if (method !== "GET" && method !== "POST") {
      return json(405, { ok: false, error: "Method not allowed" });
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
    const badQueryKeys = unknownKeys(
      query,
      method === "GET" ? ALLOWED_QUERY_KEYS : new Set()
    );
    if (badQueryKeys.length) {
      return json(400, {
        ok: false,
        error: "Unknown query fields rejected",
        code: "unknown_fields",
        fields: badQueryKeys,
      });
    }

    let body = null;
    if (method === "POST") {
      body = parseBody(event.body);
      if (body == null) {
        return json(400, {
          ok: false,
          error: "Invalid JSON object",
          code: "invalid_json",
        });
      }
      for (const key of FORBIDDEN_BODY_KEYS) {
        if (Object.prototype.hasOwnProperty.call(body, key)) {
          return json(400, {
            ok: false,
            error: `${key} must not be sent by client`,
            code: `${key}_forbidden`,
          });
        }
      }
      const badBodyKeys = unknownKeys(body, ALLOWED_BODY_KEYS);
      if (badBodyKeys.length) {
        return json(400, {
          ok: false,
          error: "Unknown fields rejected",
          code: "unknown_fields",
          fields: badBodyKeys,
        });
      }
    }

    const { projectId, quoteId } = requestIds(method, event, body);
    if (!projectId || !quoteId) {
      return json(400, {
        ok: false,
        error: "project_id and quote_id are required",
        code: "project_quote_required",
      });
    }
    if (!validUuid(projectId) || !validUuid(quoteId)) {
      return json(400, {
        ok: false,
        error: "Invalid project_id or quote_id",
        code: "invalid_id",
      });
    }

    const relation = await verifyProjectAndQuote(
      tenantId,
      projectId,
      quoteId
    );
    if (relation.unavailable) {
      return json(404, {
        ok: false,
        error: "Project payment schedule unavailable",
        code: "schedule_unavailable",
      });
    }
    if (relation.mismatch) {
      return json(409, {
        ok: false,
        error: "Quote does not belong to this project",
        code: "project_quote_mismatch",
      });
    }
    if (relation.invalidTotal) {
      return json(409, {
        ok: false,
        error: "Authoritative contract total is unavailable",
        code: "contract_total_unavailable",
      });
    }

    if (method === "GET") {
      const existing = await loadSchedule(tenantId, projectId, quoteId);
      const items = await loadItems(tenantId, existing?.id);
      const schedule = serializeSchedule(existing);
      const serializedItems = items.map((item) =>
        serializeItem(item, relation.contractTotalCents)
      );
      return json(200, {
        ok: true,
        schedule,
        items: serializedItems,
        readiness: evaluateReadiness(
          schedule,
          serializedItems,
          relation.contractTotalCents
        ),
        source: {
          contract_total_source: relation.totalSource,
          currency: relation.currency,
        },
      });
    }

    const confirmSchedule = body.confirm_schedule === true;
    if (
      Object.prototype.hasOwnProperty.call(body, "confirm_schedule") &&
      typeof body.confirm_schedule !== "boolean"
    ) {
      return json(400, {
        ok: false,
        error: "confirm_schedule must be a boolean",
        code: "invalid_confirmation",
      });
    }

    const expectedParsed = parseExpectedUpdatedAt(body.expected_updated_at);
    if (expectedParsed.error) {
      return json(400, {
        ok: false,
        error: expectedParsed.error,
        code: "invalid_expected_updated_at",
      });
    }

    const normalized = normalizeItems(body.items);
    if (normalized.error) {
      return json(400, {
        ok: false,
        error: normalized.error,
        code: normalized.code || "validation_failed",
        ...(normalized.fields ? { fields: normalized.fields } : {}),
      });
    }

    const scheduledTotalCents = totalItemsCents(normalized.items);
    const exactTotal = scheduledTotalCents === relation.contractTotalCents;
    if (confirmSchedule && normalized.items.length < 1) {
      return json(400, {
        ok: false,
        error: "At least one payment stage is required to confirm a schedule",
        code: "items_required",
      });
    }
    if (confirmSchedule && !exactTotal) {
      return json(400, {
        ok: false,
        error: "Payment schedule total must equal the contract total before confirmation",
        code: "schedule_total_mismatch",
        contract_total: centsToNumber(relation.contractTotalCents),
        scheduled_total: centsToNumber(scheduledTotalCents),
        remaining_difference: centsToNumber(
          relation.contractTotalCents - scheduledTotalCents
        ),
      });
    }

    let rpcResult;
    try {
      rpcResult = await replaceScheduleAtomically({
        tenantId,
        projectId,
        quoteId,
        contractTotalCents: relation.contractTotalCents,
        currency: relation.currency,
        confirmSchedule,
        items: normalized.items,
        expectedUpdatedAt: expectedParsed.value,
      });
    } catch (err) {
      return mapRpcFailure(err);
    }

    const normalizedResult = normalizeRpcResult(
      rpcResult,
      relation.contractTotalCents,
      relation.currency,
      relation.totalSource
    );
    if (!normalizedResult?.schedule?.id) {
      return json(500, {
        ok: false,
        error: "Payment schedule save failed",
        code: "save_failed",
      });
    }

    return json(200, {
      ok: true,
      schedule: normalizedResult.schedule,
      items: normalizedResult.items,
      readiness: normalizedResult.readiness,
      source: normalizedResult.source,
    });
  } catch (err) {
    if (err?.isGuardError) {
      return json(err.statusCode || 403, {
        ok: false,
        error: err.message,
        code: err.code,
      });
    }
    return json(500, {
      ok: false,
      error: "Project payment schedule is temporarily unavailable",
      code: "server_error",
    });
  }
};
