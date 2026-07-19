/**
 * CH-004A4 — Tenant contract legal notices (Owner/Admin, session-scoped).
 * GET: read-only PostgREST.
 * POST: exactly one transactional RPC write (atomic replace).
 * No Contract Builder wiring in this phase.
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

const OWNER_ADMIN_ROLES = new Set(["owner", "admin"]);
const NOTICE_MAX_LEN = 4000;
const MAX_RAW_BODY_BYTES = 120000;

const NOTICE_FIELDS = [
  "contract_notice",
  "payment_notice",
  "change_order_notice",
  "cancellation_notice",
  "warranty_notice",
  "limitation_of_liability",
  "permit_notice",
  "site_conditions_notice",
  "cleanup_notice",
  "material_notice",
  "dispute_notice",
  "force_majeure_notice",
  "governing_law_notice",
  "additional_terms",
];

const NOTICE_FIELD_SET = new Set(NOTICE_FIELDS);

const ALLOWED_BODY_KEYS = new Set([
  ...NOTICE_FIELDS,
  "confirm_notices",
  "expected_updated_at",
]);

const FORBIDDEN_BODY_KEYS = new Set([
  "tenant_id",
  "id",
  "confirmed_at",
  "created_at",
  "updated_at",
]);

const RPC_ERROR_MAP = Object.freeze({
  notices_version_conflict: {
    status: 409,
    error: "These legal notices changed in another session. Reload before saving.",
  },
  notices_unavailable: {
    status: 404,
    error: "Tenant legal notices unavailable",
  },
  invalid_notices: {
    status: 400,
    error: "notices must be a JSON object",
  },
  unknown_fields: {
    status: 400,
    error: "Unknown notice fields rejected",
  },
  invalid_notice: {
    status: 400,
    error: "Notice fields must be strings",
  },
  notice_too_long: {
    status: 400,
    error: "Notice exceeds 4000 characters",
  },
  invalid_confirmation: {
    status: 400,
    error: "confirm_notices must be a boolean",
  },
  notices_required: {
    status: 400,
    error: "notices_required",
  },
  invalid_id: {
    status: 400,
    error: "Invalid tenant_id",
  },
  save_failed: {
    status: 500,
    error: "Legal notices save failed",
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
  return { tenant, membership };
}

function serializeNotices(row) {
  if (!row) return null;
  const out = {
    id: row.id || null,
    tenant_id: row.tenant_id || null,
  };
  for (const key of NOTICE_FIELDS) {
    out[key] = trimField(row[key]);
  }
  out.confirmed_at = row.confirmed_at || null;
  out.created_at = row.created_at || null;
  out.updated_at = row.updated_at || null;
  return out;
}

function evaluateReadiness(notices) {
  if (!notices) {
    return { status: "missing", confirmed_at: null };
  }
  if (notices.confirmed_at) {
    return { status: "configured", confirmed_at: notices.confirmed_at };
  }
  return { status: "draft", confirmed_at: null };
}

function normalizeNoticesInput(body) {
  const notices = {};
  for (const key of NOTICE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) {
      notices[key] = "";
      continue;
    }
    const raw = body[key];
    if (raw == null) {
      notices[key] = "";
      continue;
    }
    if (typeof raw !== "string") {
      return {
        error: `${key} must be a string`,
        code: "invalid_notice",
        field: key,
      };
    }
    const value = raw.trim();
    if (value.length > NOTICE_MAX_LEN) {
      return {
        error: `${key} exceeds ${NOTICE_MAX_LEN} characters`,
        code: "notice_too_long",
        field: key,
        max_length: NOTICE_MAX_LEN,
        length: value.length,
      };
    }
    notices[key] = value;
  }
  return { notices };
}

function hasNonEmptyNotice(notices) {
  return NOTICE_FIELDS.some((key) => String(notices?.[key] ?? "").trim() !== "");
}

function noticesRequiredResponse() {
  return json(400, {
    ok: false,
    error: "notices_required",
    message: "At least one legal notice is required before confirmation.",
  });
}

async function loadNoticesRow(tenantId) {
  const rows = await supabaseRequest(
    `tenant_contract_legal_notices?tenant_id=eq.${encodeURIComponent(
      tenantId
    )}&select=*&limit=1`,
    { method: "GET" }
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
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
    if (parsed.code === "notices_required") {
      return noticesRequiredResponse();
    }
    const payload = {
      ok: false,
      error: mapped.error,
      code: parsed.code,
    };
    if (parsed.code === "notice_too_long" && parsed.message) {
      payload.error = parsed.message.includes("exceeds")
        ? parsed.message
        : mapped.error;
    }
    return json(mapped.status, payload);
  }
  return json(500, {
    ok: false,
    error: "Tenant legal notices are temporarily unavailable",
    code: "server_error",
  });
}

function normalizeRpcResult(raw) {
  const payload =
    Array.isArray(raw) && raw[0] && typeof raw[0] === "object"
      ? raw[0].replace_tenant_contract_legal_notices || raw[0]
      : raw;
  if (!payload || typeof payload !== "object") return null;
  const notices = serializeNotices(payload.notices);
  const readiness = payload.readiness
    ? {
        status: trimField(payload.readiness.status) || "draft",
        confirmed_at: payload.readiness.confirmed_at || null,
      }
    : evaluateReadiness(notices);
  return { notices, readiness };
}

async function replaceNoticesAtomically({
  tenantId,
  notices,
  confirmNotices,
  expectedUpdatedAt,
}) {
  return supabaseRequest("rpc/replace_tenant_contract_legal_notices", {
    method: "POST",
    body: {
      p_tenant_id: tenantId,
      p_notices: notices,
      p_confirm_notices: confirmNotices,
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
    const badQueryKeys = unknownKeys(query, new Set());
    if (badQueryKeys.length) {
      return json(400, {
        ok: false,
        error: "Unknown query fields rejected",
        code: "unknown_fields",
        fields: badQueryKeys,
      });
    }

    if (method === "GET") {
      const row = await loadNoticesRow(tenantId);
      const notices = serializeNotices(row);
      return json(200, {
        ok: true,
        notices,
        readiness: evaluateReadiness(notices),
      });
    }

    const rawBody = event.body == null ? "" : String(event.body);
    if (Buffer.byteLength(rawBody, "utf8") > MAX_RAW_BODY_BYTES) {
      return json(400, {
        ok: false,
        error: "Payload too large",
        code: "payload_too_large",
      });
    }

    const body = parseBody(rawBody);
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

    if (
      Object.prototype.hasOwnProperty.call(body, "confirm_notices") &&
      typeof body.confirm_notices !== "boolean"
    ) {
      return json(400, {
        ok: false,
        error: "confirm_notices must be a boolean",
        code: "invalid_confirmation",
      });
    }
    const confirmNotices = body.confirm_notices === true;

    const expectedParsed = parseExpectedUpdatedAt(body.expected_updated_at);
    if (expectedParsed.error) {
      return json(400, {
        ok: false,
        error: expectedParsed.error,
        code: "invalid_expected_updated_at",
      });
    }

    const normalized = normalizeNoticesInput(body);
    if (normalized.error) {
      return json(400, {
        ok: false,
        error: normalized.error,
        code: normalized.code || "validation_failed",
        ...(normalized.field ? { field: normalized.field } : {}),
        ...(normalized.max_length ? { max_length: normalized.max_length } : {}),
        ...(normalized.length ? { length: normalized.length } : {}),
      });
    }

    if (confirmNotices && !hasNonEmptyNotice(normalized.notices)) {
      return noticesRequiredResponse();
    }

    let rpcResult;
    try {
      rpcResult = await replaceNoticesAtomically({
        tenantId,
        notices: normalized.notices,
        confirmNotices,
        expectedUpdatedAt: expectedParsed.value,
      });
    } catch (err) {
      return mapRpcFailure(err);
    }

    const normalizedResult = normalizeRpcResult(rpcResult);
    if (!normalizedResult?.notices?.id) {
      return json(500, {
        ok: false,
        error: "Legal notices save failed",
        code: "save_failed",
      });
    }

    return json(200, {
      ok: true,
      notices: normalizedResult.notices,
      readiness: normalizedResult.readiness,
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
      error: "Tenant legal notices are temporarily unavailable",
      code: "server_error",
    });
  }
};

// Exported for mocked QA only.
exports._test = {
  NOTICE_FIELDS,
  NOTICE_FIELD_SET,
  NOTICE_MAX_LEN,
  ALLOWED_BODY_KEYS,
  FORBIDDEN_BODY_KEYS,
  normalizeNoticesInput,
  hasNonEmptyNotice,
  serializeNotices,
  evaluateReadiness,
  parseExpectedUpdatedAt,
  parseMgError,
  mapRpcFailure,
  normalizeRpcResult,
};
