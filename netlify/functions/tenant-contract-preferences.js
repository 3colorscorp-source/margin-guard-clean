/**
 * CH-001A — Tenant contract preferences (Owner/Admin, session-scoped).
 * GET + POST. Universal defaults only — no clauses generated.
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
const { getTradeModule, isValidTradeModule } = require("./_lib/contract-trade-modules");
const {
  evaluateContractPreferencesReadiness,
  serializePreferencesForApi,
} = require("./_lib/contract-source-assembler");

const OWNER_ADMIN_ROLES = new Set(["owner", "admin"]);

const WARRANTY_UNITS = new Set(["days", "months", "years"]);
const CHANGE_ORDER_REQ = new Set(["always", "price_change_only", "optional"]);
const SIGNER_MODES = new Set(["one_customer", "all_property_owners", "custom"]);
const CONTRACT_LANGUAGES = new Set(["en", "es", "bilingual"]);
const DISPUTE_PREFS = new Set(["court", "mediation", "arbitration", "unset"]);
const SIGNATURE_ORDERS = new Set(["customer_first", "contractor_first", "any_order"]);

const ALLOWED_BODY_KEYS = new Set([
  "primary_trade_module",
  "custom_trade_label",
  "default_contract_name",
  "default_warranty_duration_value",
  "default_warranty_duration_unit",
  "change_order_requirement",
  "require_customer_initials",
  "default_signer_mode",
  "default_contract_language",
  "dispute_resolution_preference",
  "default_signature_order",
  "automatically_attach_warranty",
  "automatically_attach_completion_certificate",
]);

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function trimField(value, maxLen) {
  const s = String(value ?? "").trim();
  if (!maxLen) return s;
  return s.slice(0, maxLen);
}

function parseBody(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return null;
  }
}

function findUnknownBodyKeys(body) {
  const unknown = [];
  if (!body || typeof body !== "object") return unknown;
  for (const key of Object.keys(body)) {
    if (!ALLOWED_BODY_KEYS.has(key)) unknown.push(key);
  }
  return unknown;
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
  const membership = await resolveMembershipByEmail(supabaseRequest, tenant.id, session.e);
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

async function loadPreferencesRow(tenantId) {
  const rows = await supabaseRequest(
    `tenant_contract_preferences?tenant_id=eq.${encodeURIComponent(tenantId)}&select=*&limit=1`,
    { method: "GET" }
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

function buildTradeModuleResponse(preferences) {
  if (!preferences) return null;
  const mod = getTradeModule(preferences.primary_trade_module);
  if (!mod) return null;
  return {
    code: mod.code,
    name: mod.name,
    category: mod.category,
    version: mod.version,
    active: mod.active,
    custom_display_label:
      mod.code === "custom" ? trimField(preferences.custom_trade_label, 200) : "",
  };
}

function normalizePreferencesInput(body) {
  const tradeCode = trimField(body.primary_trade_module, 64).toLowerCase() || "custom";
  if (!isValidTradeModule(tradeCode)) {
    return { error: "Invalid primary_trade_module", code: "invalid_trade_module" };
  }

  const warrantyUnit = trimField(body.default_warranty_duration_unit, 16).toLowerCase() || "months";
  if (!WARRANTY_UNITS.has(warrantyUnit)) {
    return { error: "Invalid default_warranty_duration_unit", code: "invalid_enum" };
  }

  const changeOrder = trimField(body.change_order_requirement, 32).toLowerCase() || "price_change_only";
  if (!CHANGE_ORDER_REQ.has(changeOrder)) {
    return { error: "Invalid change_order_requirement", code: "invalid_enum" };
  }

  const signerMode = trimField(body.default_signer_mode, 32).toLowerCase() || "one_customer";
  if (!SIGNER_MODES.has(signerMode)) {
    return { error: "Invalid default_signer_mode", code: "invalid_enum" };
  }

  const lang = trimField(body.default_contract_language, 16).toLowerCase() || "en";
  if (!CONTRACT_LANGUAGES.has(lang)) {
    return { error: "Invalid default_contract_language", code: "invalid_enum" };
  }

  const dispute = trimField(body.dispute_resolution_preference, 32).toLowerCase() || "unset";
  if (!DISPUTE_PREFS.has(dispute)) {
    return { error: "Invalid dispute_resolution_preference", code: "invalid_enum" };
  }

  const sigOrder = trimField(body.default_signature_order, 32).toLowerCase() || "customer_first";
  if (!SIGNATURE_ORDERS.has(sigOrder)) {
    return { error: "Invalid default_signature_order", code: "invalid_enum" };
  }

  let warrantyValue = null;
  if (body.default_warranty_duration_value != null && body.default_warranty_duration_value !== "") {
    const n = Number(body.default_warranty_duration_value);
    if (!Number.isFinite(n) || n < 0) {
      return { error: "Invalid default_warranty_duration_value", code: "invalid_warranty_value" };
    }
    warrantyValue = Math.floor(n);
  }

  const preferences = {
    primary_trade_module: tradeCode,
    custom_trade_label: trimField(body.custom_trade_label, 200),
    default_contract_name: trimField(body.default_contract_name, 200),
    default_warranty_duration_value: warrantyValue,
    default_warranty_duration_unit: warrantyUnit,
    change_order_requirement: changeOrder,
    require_customer_initials: body.require_customer_initials !== false,
    default_signer_mode: signerMode,
    default_contract_language: lang,
    dispute_resolution_preference: dispute,
    default_signature_order: sigOrder,
    automatically_attach_warranty: Boolean(body.automatically_attach_warranty),
    automatically_attach_completion_certificate: Boolean(
      body.automatically_attach_completion_certificate
    ),
  };

  if (tradeCode === "custom" && !preferences.custom_trade_label) {
    return {
      error: "custom_trade_label is required when primary_trade_module is custom",
      code: "custom_trade_label_required",
    };
  }

  return { preferences };
}

async function upsertPreferences(tenantId, preferences) {
  const existing = await loadPreferencesRow(tenantId);
  const payload = { ...preferences, tenant_id: tenantId };

  if (existing?.id) {
    const rows = await supabaseRequest(
      `tenant_contract_preferences?id=eq.${encodeURIComponent(existing.id)}&tenant_id=eq.${encodeURIComponent(tenantId)}`,
      { method: "PATCH", body: preferences }
    );
    return Array.isArray(rows) && rows[0] ? rows[0] : { ...existing, ...preferences };
  }

  const rows = await supabaseRequest("tenant_contract_preferences", {
    method: "POST",
    body: payload,
  });
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

exports.handler = async (event) => {
  try {
    const method = event.httpMethod;
    if (method !== "GET" && method !== "POST") {
      return json(405, { ok: false, error: "Method not allowed" });
    }

    const { tenant } = await requireOwnerOrAdmin(event);
    const tenantId = String(tenant.id);

    if (method === "GET") {
      const row = await loadPreferencesRow(tenantId);
      const preferences = serializePreferencesForApi(row);
      const trade_module = buildTradeModuleResponse(preferences);
      const readiness = evaluateContractPreferencesReadiness(preferences);
      return json(200, { ok: true, preferences, trade_module, readiness });
    }

    const body = parseBody(event.body);
    if (body == null) {
      return json(400, { ok: false, error: "Invalid JSON", code: "invalid_json" });
    }
    if (body.tenant_id != null) {
      return json(400, {
        ok: false,
        error: "tenant_id must not be sent by client",
        code: "tenant_id_forbidden",
      });
    }

    const unknown = findUnknownBodyKeys(body);
    if (unknown.length) {
      return json(400, {
        ok: false,
        error: "Unknown fields rejected",
        code: "unknown_fields",
        fields: unknown,
      });
    }

    const normalized = normalizePreferencesInput(body);
    if (normalized.error) {
      return json(400, {
        ok: false,
        error: normalized.error,
        code: normalized.code || "validation_failed",
        ...(normalized.missing ? { missing: normalized.missing } : {}),
      });
    }

    const saved = await upsertPreferences(tenantId, normalized.preferences);
    if (!saved) {
      return json(500, { ok: false, error: "Preferences save failed", code: "save_failed" });
    }

    const preferences = serializePreferencesForApi(saved);
    const trade_module = buildTradeModuleResponse(preferences);
    const readiness = evaluateContractPreferencesReadiness(preferences);
    return json(200, { ok: true, preferences, trade_module, readiness });
  } catch (err) {
    if (err?.isGuardError) {
      return json(err.statusCode || 403, { ok: false, error: err.message, code: err.code });
    }
    return json(500, { ok: false, error: err.message || "Server error" });
  }
};
