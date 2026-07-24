/**
 * CH-004A7B — Tenant contract legal notices (Owner/Admin).
 * Working draft + confirmed snapshot. GET/POST only.
 * Contract Builder consumes effective_for_contracts (confirmed snapshot) only.
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
const {
  NOTICE_FIELD_KEYS,
  cloneDefaults,
  normalizeForCompare,
} = require("./_lib/legal-notice-defaults");

const OWNER_ADMIN_ROLES = new Set(["owner", "admin"]);
const NOTICE_MAX_LEN = 4000;
const MAX_RAW_BODY_BYTES = 120000;

const NOTICE_FIELDS = NOTICE_FIELD_KEYS;

const ENABLED_KEYS = NOTICE_FIELDS.map((k) => `${k}_enabled`);

const ALLOWED_BODY_KEYS = new Set([
  ...NOTICE_FIELDS,
  ...ENABLED_KEYS,
  "confirm_notices",
  "expected_updated_at",
]);

const FORBIDDEN_BODY_KEYS = new Set([
  "tenant_id",
  "id",
  "confirmed_at",
  "confirmed_notices",
  "confirmed_enabled",
  "created_at",
  "updated_at",
]);

const RPC_ERROR_MAP = Object.freeze({
  notices_version_conflict: {
    status: 409,
    error:
      "Someone updated these legal notices. Reload the page before editing again.",
  },
  notices_unavailable: {
    status: 404,
    error: "Tenant legal notices unavailable",
  },
  invalid_notices: {
    status: 400,
    error: "notices must be a JSON object",
  },
  invalid_enabled: {
    status: 400,
    error: "Enabled flags must be booleans",
  },
  unknown_fields: {
    status: 400,
    error: "Unknown fields rejected",
  },
  invalid_notice: {
    status: 400,
    error: "Notice fields must be strings",
  },
  notice_too_long: {
    status: 400,
    error: "Notice exceeds 4000 characters",
  },
  enabled_notice_empty: {
    status: 400,
    error: "enabled_notice_empty",
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
  if (!Number.isFinite(Date.parse(s))) {
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

function readEnabled(row, key) {
  const col = `${key}_enabled`;
  if (row && Object.prototype.hasOwnProperty.call(row, col)) {
    return row[col] !== false;
  }
  return true;
}

function serializeWorkingNotices(row) {
  if (!row) return null;
  // Omit id / tenant_id from browser responses — tenant is session-derived only.
  const out = {};
  for (const key of NOTICE_FIELDS) {
    out[key] = trimField(row[key]);
    out[`${key}_enabled`] = readEnabled(row, key);
  }
  out.confirmed_at = row.confirmed_at || null;
  out.created_at = row.created_at || null;
  out.updated_at = row.updated_at || null;
  return out;
}

function parseSnapshotObject(raw) {
  if (raw == null) return null;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw;
}

/**
 * Fail-closed: returns null if snapshot cannot be used for contracts.
 */
function buildEffectiveForContracts(row) {
  if (!row || !row.confirmed_at) return null;
  const noticesRaw = parseSnapshotObject(row.confirmed_notices);
  const enabledRaw = parseSnapshotObject(row.confirmed_enabled);
  if (!noticesRaw || !enabledRaw) return null;

  const notices = {};
  const enabled = {};
  let hasEnabledPopulated = false;

  for (const key of NOTICE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(noticesRaw, key)) return null;
    if (!Object.prototype.hasOwnProperty.call(enabledRaw, key)) return null;
    const text = trimField(noticesRaw[key]);
    const en = enabledRaw[key];
    if (typeof en !== "boolean") return null;
    notices[key] = text;
    enabled[key] = en;
    if (en && text) hasEnabledPopulated = true;
  }

  if (!hasEnabledPopulated) return null;

  return {
    notices,
    enabled,
    confirmed_at: row.confirmed_at,
  };
}

function workingMatchesSnapshot(working, effective) {
  if (!working || !effective) return false;
  for (const key of NOTICE_FIELDS) {
    if (normalizeForCompare(working[key]) !== normalizeForCompare(effective.notices[key])) {
      return false;
    }
    if (Boolean(working[`${key}_enabled`]) !== Boolean(effective.enabled[key])) {
      return false;
    }
  }
  return true;
}

function evaluateReadiness(working, effective) {
  if (!working && !effective) {
    return {
      readiness: { status: "missing", confirmed_at: null },
      has_unconfirmed_changes: false,
    };
  }
  if (!effective) {
    return {
      readiness: { status: "draft", confirmed_at: working?.confirmed_at || null },
      has_unconfirmed_changes: true,
    };
  }
  if (working && workingMatchesSnapshot(working, effective)) {
    return {
      readiness: { status: "configured", confirmed_at: effective.confirmed_at },
      has_unconfirmed_changes: false,
    };
  }
  return {
    readiness: { status: "draft", confirmed_at: effective.confirmed_at },
    has_unconfirmed_changes: true,
  };
}

function buildResponse(row) {
  const working = serializeWorkingNotices(row);
  const effective = buildEffectiveForContracts(row || {});
  const { readiness, has_unconfirmed_changes } = evaluateReadiness(working, effective);
  return {
    ok: true,
    notices: working,
    readiness,
    defaults: cloneDefaults(),
    effective_for_contracts: effective,
    has_unconfirmed_changes,
  };
}

function normalizeWorkingInput(body) {
  const notices = {};
  const enabled = {};
  const emptyEnabled = [];

  for (const key of NOTICE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) {
      notices[key] = "";
    } else {
      const raw = body[key];
      if (raw == null) {
        notices[key] = "";
      } else if (typeof raw !== "string") {
        return {
          error: `${key} must be a string`,
          code: "invalid_notice",
          field: key,
        };
      } else {
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
    }

    const enKey = `${key}_enabled`;
    if (!Object.prototype.hasOwnProperty.call(body, enKey)) {
      enabled[key] = true;
    } else if (typeof body[enKey] !== "boolean") {
      return {
        error: `${enKey} must be a boolean`,
        code: "invalid_enabled",
        field: enKey,
      };
    } else {
      enabled[key] = body[enKey];
    }

    if (enabled[key] && !notices[key]) {
      emptyEnabled.push(key);
    }
  }

  return { notices, enabled, emptyEnabled };
}

function noticesRequiredResponse(message) {
  return json(400, {
    ok: false,
    error: "notices_required",
    message:
      message ||
      "At least one enabled legal notice with text is required before confirmation.",
  });
}

function enabledEmptyResponse(emptyEnabled) {
  return json(400, {
    ok: false,
    error: "enabled_notice_empty",
    message:
      "Enabled notices require text before confirmation: " +
      emptyEnabled.join(", "),
    fields: emptyEnabled,
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
      return noticesRequiredResponse(parsed.message || undefined);
    }
    if (parsed.code === "enabled_notice_empty") {
      return json(400, {
        ok: false,
        error: "enabled_notice_empty",
        message:
          parsed.message ||
          "Enabled notices require text before confirmation.",
      });
    }
    if (parsed.code === "notices_version_conflict") {
      return json(409, {
        ok: false,
        error:
          "Someone updated these legal notices. Reload the page before editing again.",
        code: "notices_version_conflict",
      });
    }
    return json(mapped.status, {
      ok: false,
      error: mapped.error,
      code: parsed.code,
    });
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
  const notices = payload.notices || null;
  if (!notices || !notices.id) return null;
  return {
    row: {
      ...notices,
      confirmed_notices: payload.confirmed_notices ?? null,
      confirmed_enabled: payload.confirmed_enabled ?? null,
    },
  };
}

async function replaceNoticesAtomically({
  tenantId,
  notices,
  enabled,
  confirmNotices,
  expectedUpdatedAt,
}) {
  return supabaseRequest("rpc/replace_tenant_contract_legal_notices", {
    method: "POST",
    body: {
      p_tenant_id: tenantId,
      p_notices: notices,
      p_enabled: enabled,
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
      return json(200, buildResponse(row));
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

    const normalized = normalizeWorkingInput(body);
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

    if (confirmNotices) {
      const anyEnabled = NOTICE_FIELDS.some((k) => normalized.enabled[k]);
      if (!anyEnabled) {
        return noticesRequiredResponse(
          "At least one notice must be enabled before confirmation."
        );
      }
      if (normalized.emptyEnabled.length) {
        return enabledEmptyResponse(normalized.emptyEnabled);
      }
      const anyPopulated = NOTICE_FIELDS.some(
        (k) => normalized.enabled[k] && normalized.notices[k]
      );
      if (!anyPopulated) {
        return noticesRequiredResponse();
      }
    }

    let rpcResult;
    try {
      rpcResult = await replaceNoticesAtomically({
        tenantId,
        notices: normalized.notices,
        enabled: normalized.enabled,
        confirmNotices,
        expectedUpdatedAt: expectedParsed.value,
      });
    } catch (err) {
      return mapRpcFailure(err);
    }

    const normalizedResult = normalizeRpcResult(rpcResult);
    if (!normalizedResult?.row?.id) {
      return json(500, {
        ok: false,
        error: "Legal notices save failed",
        code: "save_failed",
      });
    }

    return json(200, buildResponse(normalizedResult.row));
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

exports._test = {
  NOTICE_FIELDS,
  ENABLED_KEYS,
  ALLOWED_BODY_KEYS,
  FORBIDDEN_BODY_KEYS,
  normalizeWorkingInput,
  buildEffectiveForContracts,
  evaluateReadiness,
  serializeWorkingNotices,
  workingMatchesSnapshot,
  buildResponse,
};
