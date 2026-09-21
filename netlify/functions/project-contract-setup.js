/**
 * CH-004A1 — Per-project contract setup (Owner/Admin, session-scoped).
 * GET + POST. Confirmation timestamps and state-module metadata are server-controlled.
 */

const { supabaseRequest } = require("./_lib/supabase-admin");
const { requireOwnerOrAdmin } = require("./_lib/require-owner-or-admin");
const {
  evaluatePersistedScheduleConfirmation,
  normIsoDate,
} = require("./_lib/contract-schedule");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const WARRANTY_UNITS = new Set(["days", "months", "years"]);
const SIGNATURE_METHODS = new Set([
  "sign_on_device",
  "email_link",
  "both",
  "not_configured",
]);

const IDS = new Set(["project_id", "quote_id"]);
const PROPERTY_FIELDS = new Set([
  "property_address_line1",
  "property_address_line2",
  "property_city",
  "property_state",
  "property_postal_code",
]);
const WARRANTY_FIELDS = new Set([
  "warranty_duration_value",
  "warranty_duration_unit",
  "warranty_summary",
  "warranty_exclusions",
]);
const WARRANTY_LOCK_PACKAGE_STATUSES = new Set([
  "ready",
  "executed",
  "superseded",
  "frozen",
]);
const WARRANTY_RPC_UPDATE_KEYS = new Set([
  "warranty_duration_value",
  "warranty_duration_unit",
  "warranty_summary",
  "warranty_exclusions",
  "warranty_confirmed_at",
]);
const CONFIRMATION_FIELDS = new Set([
  "confirm_property_address",
  "confirm_warranty",
  "confirm_estimated_schedule",
]);
const CONFIG_FIELDS = new Set([
  ...PROPERTY_FIELDS,
  ...WARRANTY_FIELDS,
  "signature_method",
]);
const ALLOWED_BODY_KEYS = new Set([
  ...IDS,
  ...CONFIG_FIELDS,
  ...CONFIRMATION_FIELDS,
]);
const ALLOWED_QUERY_KEYS = new Set(["project_id", "quote_id"]);

const STRING_LIMITS = Object.freeze({
  property_address_line1: 200,
  property_address_line2: 200,
  property_city: 120,
  property_state: 80,
  property_postal_code: 32,
  warranty_summary: 4000,
  warranty_exclusions: 4000,
});

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
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

function trimField(value) {
  return String(value ?? "").trim();
}

function unknownKeys(input, allowed) {
  return Object.keys(input || {}).filter((key) => !allowed.has(key));
}

function validUuid(value) {
  return UUID_RE.test(trimField(value));
}

function normalizeString(body, field) {
  if (!Object.prototype.hasOwnProperty.call(body, field)) return {};
  if (body[field] != null && typeof body[field] !== "string") {
    return { error: `${field} must be a string` };
  }
  const value = trimField(body[field]);
  if (value.length > STRING_LIMITS[field]) {
    return { error: `${field} exceeds ${STRING_LIMITS[field]} characters` };
  }
  return { value };
}

function normalizeBoolean(body, field) {
  if (!Object.prototype.hasOwnProperty.call(body, field)) return {};
  if (typeof body[field] !== "boolean") {
    return { error: `${field} must be a boolean` };
  }
  return { value: body[field] };
}

function normalizeInput(body) {
  const changes = {};

  for (const field of Object.keys(STRING_LIMITS)) {
    const normalized = normalizeString(body, field);
    if (normalized.error) return { error: normalized.error, code: "invalid_field" };
    if (Object.prototype.hasOwnProperty.call(normalized, "value")) {
      changes[field] = normalized.value;
    }
  }

  if (Object.prototype.hasOwnProperty.call(body, "warranty_duration_value")) {
    if (body.warranty_duration_value == null || body.warranty_duration_value === "") {
      changes.warranty_duration_value = null;
    } else {
      const value = Number(body.warranty_duration_value);
      if (
        !Number.isSafeInteger(value) ||
        value < 0 ||
        value > 2147483647
      ) {
        return {
          error: "warranty_duration_value must be a non-negative integer",
          code: "invalid_warranty_duration",
        };
      }
      changes.warranty_duration_value = value;
    }
  }

  if (Object.prototype.hasOwnProperty.call(body, "warranty_duration_unit")) {
    const unit = trimField(body.warranty_duration_unit).toLowerCase();
    if (!WARRANTY_UNITS.has(unit)) {
      return { error: "Invalid warranty_duration_unit", code: "invalid_enum" };
    }
    changes.warranty_duration_unit = unit;
  }

  if (Object.prototype.hasOwnProperty.call(body, "signature_method")) {
    const method = trimField(body.signature_method).toLowerCase();
    if (!SIGNATURE_METHODS.has(method)) {
      return { error: "Invalid signature_method", code: "invalid_enum" };
    }
    changes.signature_method = method;
  }

  const propertyConfirmation = normalizeBoolean(body, "confirm_property_address");
  if (propertyConfirmation.error) {
    return { error: propertyConfirmation.error, code: "invalid_confirmation" };
  }
  const warrantyConfirmation = normalizeBoolean(body, "confirm_warranty");
  if (warrantyConfirmation.error) {
    return { error: warrantyConfirmation.error, code: "invalid_confirmation" };
  }
  const scheduleConfirmation = normalizeBoolean(body, "confirm_estimated_schedule");
  if (scheduleConfirmation.error) {
    return { error: scheduleConfirmation.error, code: "invalid_confirmation" };
  }
  if (scheduleConfirmation.value === false) {
    return {
      error: "confirm_estimated_schedule can only be true",
      code: "invalid_confirmation",
    };
  }

  return {
    changes,
    confirmProperty: propertyConfirmation.value,
    confirmWarranty: warrantyConfirmation.value,
    confirmEstimatedSchedule: scheduleConfirmation.value,
  };
}

async function verifyProjectAndQuote(tenantId, projectId, quoteId) {
  const tid = encodeURIComponent(tenantId);
  const pid = encodeURIComponent(projectId);
  const qid = encodeURIComponent(quoteId);

  const projects = await supabaseRequest(
    `tenant_projects?id=eq.${pid}&tenant_id=eq.${tid}&select=id,quote_id&limit=1`,
    { method: "GET" }
  );
  const project = Array.isArray(projects) && projects[0] ? projects[0] : null;
  if (!project?.id) return { unavailable: true };

  const projectQuoteId = trimField(project.quote_id);
  if (!projectQuoteId || projectQuoteId.toLowerCase() !== quoteId.toLowerCase()) {
    return { mismatch: true };
  }

  const quotes = await supabaseRequest(
    `quotes?id=eq.${qid}&tenant_id=eq.${tid}&select=id,project_address,job_site,start_date,due_date&limit=1`,
    { method: "GET" }
  );
  const quote = Array.isArray(quotes) && quotes[0] ? quotes[0] : null;
  if (!quote?.id) return { unavailable: true };

  return { project, quote };
}

async function loadSetup(tenantId, projectId, quoteId) {
  const rows = await supabaseRequest(
    `project_contract_setups?tenant_id=eq.${encodeURIComponent(tenantId)}` +
      `&project_id=eq.${encodeURIComponent(projectId)}` +
      `&quote_id=eq.${encodeURIComponent(quoteId)}&select=*&limit=1`,
    { method: "GET" }
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

function propertyComplete(setup) {
  return Boolean(
    trimField(setup?.property_address_line1) &&
      trimField(setup?.property_city) &&
      trimField(setup?.property_state) &&
      trimField(setup?.property_postal_code)
  );
}

function warrantyComplete(setup) {
  return Boolean(
    setup?.warranty_duration_value != null &&
      WARRANTY_UNITS.has(trimField(setup?.warranty_duration_unit)) &&
      trimField(setup?.warranty_summary) &&
      trimField(setup?.warranty_exclusions)
  );
}

function serializeSetup(row) {
  if (!row?.id) return null;
  return {
    id: row.id,
    project_id: row.project_id,
    quote_id: row.quote_id,
    tenant_id: row.tenant_id || null,
    property_address_line1: trimField(row.property_address_line1),
    property_address_line2: trimField(row.property_address_line2),
    property_city: trimField(row.property_city),
    property_state: trimField(row.property_state),
    property_postal_code: trimField(row.property_postal_code),
    property_confirmed_at: row.property_confirmed_at || null,
    warranty_duration_value:
      row.warranty_duration_value == null
        ? null
        : Number(row.warranty_duration_value),
    warranty_duration_unit: trimField(row.warranty_duration_unit) || "months",
    warranty_summary: trimField(row.warranty_summary),
    warranty_exclusions: trimField(row.warranty_exclusions),
    warranty_confirmed_at: row.warranty_confirmed_at || null,
    signature_method:
      trimField(row.signature_method) || "not_configured",
    state_module_code: trimField(row.state_module_code),
    state_notice_pack_status:
      trimField(row.state_notice_pack_status) || "unsupported",
    state_notice_pack_version: trimField(row.state_notice_pack_version),
    schedule_confirmed_at: row.schedule_confirmed_at || null,
    schedule_confirmed_start_date: row.schedule_confirmed_start_date
      ? normIsoDate(row.schedule_confirmed_start_date)
      : null,
    schedule_confirmed_due_date: row.schedule_confirmed_due_date
      ? normIsoDate(row.schedule_confirmed_due_date)
      : null,
    schedule_confirmed_by: row.schedule_confirmed_by || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

function evaluateReadiness(setup, quote, ids = {}) {
  const estimated = evaluatePersistedScheduleConfirmation({
    setup,
    quote,
    tenantId: ids.tenantId,
    projectId: ids.projectId || setup?.project_id,
    quoteId: ids.quoteId || setup?.quote_id,
  });
  const hasProperty = [...PROPERTY_FIELDS].some((field) =>
    trimField(setup?.[field])
  );
  const hasWarranty = [...WARRANTY_FIELDS].some((field) => {
    const value = setup?.[field];
    return value != null && trimField(value) !== "";
  });
  const propertyStatus =
    propertyComplete(setup) && setup?.property_confirmed_at
      ? "confirmed"
      : hasProperty
        ? "needs_confirmation"
        : "missing";
  const warrantyStatus =
    warrantyComplete(setup) && setup?.warranty_confirmed_at
      ? "configured"
      : hasWarranty
        ? "needs_confirmation"
        : "missing";
  const signatureMethodStatus =
    setup?.signature_method &&
    setup.signature_method !== "not_configured"
      ? "configured"
      : "missing";

  return {
    project_address: propertyStatus,
    warranty: warrantyStatus,
    signature_method: signatureMethodStatus,
    state_notice_module:
      trimField(setup?.state_notice_pack_status) || "unsupported",
    actual_signature_status: "not_requested",
    signature_ready: false,
    estimated_schedule: estimated.readiness_status,
    estimated_schedule_caption: estimated.readiness_caption,
  };
}

function parseMgRpcError(err) {
  const text = [err?.message, err?.supabaseRaw, err?.details]
    .filter(Boolean)
    .join(" ");
  const match = String(text).match(/MG_ERR:([a-z0-9_]+):([^|]*)/i);
  if (!match) return null;
  return { code: match[1], message: trimField(match[2]) };
}

function mapScheduleConfirmFailure(err) {
  const parsed = parseMgRpcError(err) || parseMgError(err);
  if (parsed?.code === "schedule_start_missing") {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: parsed.message || "Estimated start date is required.",
        code: "schedule_start_missing",
      },
    };
  }
  if (parsed?.code === "schedule_completion_missing") {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: parsed.message || "Estimated completion date is required.",
        code: "schedule_completion_missing",
      },
    };
  }
  if (parsed?.code === "schedule_completion_before_start") {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error:
          parsed.message || "Completion date must be on or after the start date.",
        code: "schedule_completion_before_start",
      },
    };
  }
  if (parsed?.code === "project_quote_mismatch") {
    return {
      statusCode: 409,
      body: {
        ok: false,
        error: "Quote does not belong to this project",
        code: "project_quote_mismatch",
      },
    };
  }
  if (parsed?.code === "setup_unavailable") {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: "Project contract setup unavailable",
        code: "setup_unavailable",
      },
    };
  }
  if (parsed?.code === "invalid_id") {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: parsed.message || "Invalid project_id or quote_id",
        code: "invalid_id",
      },
    };
  }
  return {
    statusCode: 500,
    body: {
      ok: false,
      error: "Project contract setup is temporarily unavailable",
      code: "server_error",
    },
  };
}

async function confirmEstimatedScheduleAtomically(
  tenantId,
  projectId,
  quoteId,
  confirmedBy
) {
  const raw = await supabaseRequest("rpc/confirm_project_estimated_schedule", {
    method: "POST",
    body: {
      p_tenant_id: tenantId,
      p_project_id: projectId,
      p_quote_id: quoteId,
      p_confirmed_by: confirmedBy,
    },
  });
  if (raw && typeof raw === "object" && !Array.isArray(raw) && raw.setup) {
    return raw;
  }
  if (Array.isArray(raw) && raw[0] && typeof raw[0] === "object") {
    return raw[0].confirm_project_estimated_schedule || raw[0];
  }
  return raw;
}

function requestTouchesWarranty(normalized) {
  if (!normalized) return false;
  if (normalized.confirmWarranty !== undefined) return true;
  return Object.keys(normalized.changes || {}).some((key) => WARRANTY_FIELDS.has(key));
}

function findWarrantyLockingPackage(packages) {
  const list = Array.isArray(packages) ? packages : [];
  return (
    list.find((pkg) =>
      WARRANTY_LOCK_PACKAGE_STATUSES.has(trimField(pkg?.status).toLowerCase())
    ) || null
  );
}

function parseMgError(err) {
  const text = [err?.message, err?.supabaseRaw, err?.details]
    .filter(Boolean)
    .join(" ");
  const match = String(text).match(/MG_ERR:([a-z0-9_]+):([^|]*)/i);
  if (!match) return null;
  const detailId = String(text).match(/"package_id"\s*:\s*"([^"]+)"/i);
  const detailStatus = String(text).match(/"package_status"\s*:\s*"([^"]+)"/i);
  return {
    code: match[1],
    message: trimField(match[2]),
    packageId: detailId ? detailId[1] : null,
    packageStatus: detailStatus ? detailStatus[1] : null,
  };
}

function pickWarrantyRpcUpdates(updates) {
  const body = {};
  Object.keys(updates || {}).forEach((key) => {
    if (WARRANTY_RPC_UPDATE_KEYS.has(key)) body[key] = updates[key];
  });
  return body;
}

function omitWarrantyRpcUpdates(updates) {
  const body = {};
  Object.keys(updates || {}).forEach((key) => {
    if (!WARRANTY_RPC_UPDATE_KEYS.has(key)) body[key] = updates[key];
  });
  return body;
}

async function saveWarrantyAtomically(tenantId, projectId, quoteId, updates) {
  const raw = await supabaseRequest("rpc/save_project_contract_warranty", {
    method: "POST",
    body: {
      p_tenant_id: tenantId,
      p_project_id: projectId,
      p_quote_id: quoteId,
      p_updates: pickWarrantyRpcUpdates(updates),
    },
  });
  if (Array.isArray(raw) && raw[0] && typeof raw[0] === "object") {
    return raw[0].save_project_contract_warranty || raw[0];
  }
  return raw;
}

function mapWarrantyRpcFailure(err) {
  const parsed = parseMgError(err);
  if (parsed?.code === "warranty_locked_by_package") {
    return {
      statusCode: 409,
      body: {
        ok: false,
        error:
          "Warranty terms cannot be changed after the contract package is frozen.",
        code: "warranty_locked_by_package",
        package_id: parsed.packageId || null,
        package_status: parsed.packageStatus || null,
      },
    };
  }
  if (parsed?.code === "setup_unavailable") {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: parsed.message || "Project contract setup unavailable",
        code: "setup_unavailable",
      },
    };
  }
  if (parsed?.code === "unknown_fields") {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: parsed.message || "Unknown fields rejected",
        code: "unknown_fields",
      },
    };
  }
  return {
    statusCode: 500,
    body: {
      ok: false,
      error: "Project contract setup is temporarily unavailable",
      code: "server_error",
    },
  };
}

function applyConfirmationRules(existing, normalized) {
  const merged = {
    ...(existing || {}),
    ...normalized.changes,
  };
  const updates = { ...normalized.changes };
  const propertyChanged = Object.keys(normalized.changes).some(
    (key) =>
      PROPERTY_FIELDS.has(key) &&
      trimField(normalized.changes[key]) !== trimField(existing?.[key])
  );
  const warrantyChanged = Object.keys(normalized.changes).some((key) => {
    if (!WARRANTY_FIELDS.has(key)) return false;
    if (key === "warranty_duration_value") {
      return normalized.changes[key] !== (existing?.[key] ?? null);
    }
    return trimField(normalized.changes[key]) !== trimField(existing?.[key]);
  });

  if (propertyChanged || normalized.confirmProperty === false) {
    updates.property_confirmed_at = null;
    merged.property_confirmed_at = null;
  }
  if (warrantyChanged || normalized.confirmWarranty === false) {
    updates.warranty_confirmed_at = null;
    merged.warranty_confirmed_at = null;
  }

  const now = new Date().toISOString();
  if (normalized.confirmProperty === true) {
    if (!propertyComplete(merged)) {
      return {
        error:
          "Address, city, state, and postal code are required to confirm the project address",
        code: "property_confirmation_incomplete",
      };
    }
    updates.property_confirmed_at = now;
    merged.property_confirmed_at = now;
  }
  if (normalized.confirmWarranty === true) {
    if (!warrantyComplete(merged)) {
      return {
        error:
          "Warranty duration, coverage summary, and exclusions are required to confirm warranty terms",
        code: "warranty_confirmation_incomplete",
      };
    }
    updates.warranty_confirmed_at = now;
    merged.warranty_confirmed_at = now;
  }

  return { updates };
}

async function saveSetup(tenantId, projectId, quoteId, existing, updates) {
  if (existing?.id) {
    const rows = await supabaseRequest(
      `project_contract_setups?id=eq.${encodeURIComponent(existing.id)}` +
        `&tenant_id=eq.${encodeURIComponent(tenantId)}` +
        `&project_id=eq.${encodeURIComponent(projectId)}` +
        `&quote_id=eq.${encodeURIComponent(quoteId)}`,
      { method: "PATCH", body: updates }
    );
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  }

  const payload = {
    tenant_id: tenantId,
    project_id: projectId,
    quote_id: quoteId,
    state_module_code: "",
    state_notice_pack_status: "unsupported",
    state_notice_pack_version: "",
    ...updates,
  };
  const rows = await supabaseRequest(
    "project_contract_setups?on_conflict=tenant_id,project_id,quote_id",
    {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      body: payload,
    }
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

function requestIds(method, event, body) {
  const source =
    method === "GET" ? event.queryStringParameters || {} : body || {};
  return {
    projectId: trimField(source.project_id).toLowerCase(),
    quoteId: trimField(source.quote_id).toLowerCase(),
  };
}

exports.handler = async (event) => {
  try {
    const method = event.httpMethod;
    if (method !== "GET" && method !== "POST") {
      return json(405, { ok: false, error: "Method not allowed" });
    }

    const { tenant, membership } = await requireOwnerOrAdmin(event);
    const tenantId = trimField(tenant.id);
    const confirmedBy = trimField(membership?.id);

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
      if (body.tenant_id != null) {
        return json(400, {
          ok: false,
          error: "tenant_id must not be sent by client",
          code: "tenant_id_forbidden",
        });
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
        error: "Project contract setup unavailable",
        code: "setup_unavailable",
      });
    }
    if (relation.mismatch) {
      return json(409, {
        ok: false,
        error: "Quote does not belong to this project",
        code: "project_quote_mismatch",
      });
    }

    const existing = await loadSetup(tenantId, projectId, quoteId);
    const readinessIds = { tenantId, projectId, quoteId };
    if (method === "GET") {
      const setup = serializeSetup(existing);
      const legacyAddress = trimField(
        relation.quote.project_address || relation.quote.job_site
      );
      return json(200, {
        ok: true,
        setup,
        readiness: evaluateReadiness(setup, relation.quote, readinessIds),
        suggestions: { legacy_quote_address: legacyAddress },
      });
    }

    const normalized = normalizeInput(body);
    if (normalized.error) {
      return json(400, {
        ok: false,
        error: normalized.error,
        code: normalized.code || "validation_failed",
      });
    }
    const hasChanges =
      Object.keys(normalized.changes).length > 0 ||
      normalized.confirmProperty !== undefined ||
      normalized.confirmWarranty !== undefined ||
      normalized.confirmEstimatedSchedule === true;
    if (!hasChanges) {
      return json(400, {
        ok: false,
        error: "No setup fields supplied",
        code: "no_changes",
      });
    }

    const confirmation = applyConfirmationRules(existing, normalized);
    if (confirmation.error) {
      return json(400, {
        ok: false,
        error: confirmation.error,
        code: confirmation.code,
      });
    }

    let saved = existing;
    if (requestTouchesWarranty(normalized)) {
      try {
        saved = await saveWarrantyAtomically(
          tenantId,
          projectId,
          quoteId,
          confirmation.updates
        );
      } catch (err) {
        const mapped = mapWarrantyRpcFailure(err);
        return json(mapped.statusCode, mapped.body);
      }
      if (!saved) {
        return json(500, {
          ok: false,
          error: "Project contract setup save failed",
          code: "save_failed",
        });
      }
    }

    const otherUpdates = requestTouchesWarranty(normalized)
      ? omitWarrantyRpcUpdates(confirmation.updates)
      : confirmation.updates;
    if (Object.keys(otherUpdates).length) {
      saved = await saveSetup(
        tenantId,
        projectId,
        quoteId,
        saved,
        otherUpdates
      );
      if (!saved) {
        return json(500, {
          ok: false,
          error: "Project contract setup save failed",
          code: "save_failed",
        });
      }
    }

    if (normalized.confirmEstimatedSchedule === true) {
      if (!confirmedBy) {
        return json(403, {
          ok: false,
          error: "Owner or admin membership required",
          code: "owner_required",
        });
      }
      try {
        const confirmed = await confirmEstimatedScheduleAtomically(
          tenantId,
          projectId,
          quoteId,
          confirmedBy
        );
        saved = confirmed?.setup || confirmed || saved;
      } catch (err) {
        const mapped = mapScheduleConfirmFailure(err);
        return json(mapped.statusCode, mapped.body);
      }
    }

    if (!saved && normalized.confirmEstimatedSchedule !== true) {
      return json(500, {
        ok: false,
        error: "Project contract setup save failed",
        code: "save_failed",
      });
    }

    const setup = serializeSetup(saved);
    return json(200, {
      ok: true,
      setup,
      readiness: evaluateReadiness(setup, relation.quote, readinessIds),
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
      error: "Project contract setup is temporarily unavailable",
      code: "server_error",
    });
  }
};

exports._test = {
  WARRANTY_FIELDS,
  WARRANTY_LOCK_PACKAGE_STATUSES,
  WARRANTY_RPC_UPDATE_KEYS,
  requestTouchesWarranty,
  findWarrantyLockingPackage,
  parseMgError,
  pickWarrantyRpcUpdates,
  saveWarrantyAtomically,
  evaluateReadiness,
  serializeSetup,
  confirmEstimatedScheduleAtomically,
  mapScheduleConfirmFailure,
};
