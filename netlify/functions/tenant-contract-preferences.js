/**
 * CH-001A / CH-082 — Tenant contract preferences (Owner/Admin, session-scoped).
 * GET + POST replace-all + PATCH warranty-only. Universal defaults only — no clauses generated.
 */

const { requireOwnerOrAdmin } = require("./_lib/require-owner-or-admin");
const { supabaseRequest } = require("./_lib/supabase-admin");
const { getTradeModule, isValidTradeModule } = require("./_lib/contract-trade-modules");
const {
  evaluateContractPreferencesReadiness,
  serializePreferencesForApi,
} = require("./_lib/contract-source-assembler");

const WARRANTY_UNITS = new Set(["days", "months", "years"]);
const CHANGE_ORDER_REQ = new Set(["always", "price_change_only", "optional"]);
const SIGNER_MODES = new Set(["one_customer", "all_property_owners", "custom"]);
const CONTRACT_LANGUAGES = new Set(["en", "es", "bilingual"]);
const DISPUTE_PREFS = new Set(["court", "mediation", "arbitration", "unset"]);
const SIGNATURE_ORDERS = new Set(["customer_first", "contractor_first", "any_order"]);

const WARRANTY_TEXT_MAX = 4000;

const WARRANTY_PATCH_KEYS = [
  "default_warranty_enabled",
  "default_warranty_duration_value",
  "default_warranty_duration_unit",
  "default_warranty_summary",
  "default_warranty_exclusions",
];

const ALLOWED_PATCH_KEYS = new Set(WARRANTY_PATCH_KEYS);
const SIGNING_PATCH_KEYS = ["require_contractor_signature"];
const SIGNING_PATCH_KEY_SET = new Set(SIGNING_PATCH_KEYS);

const ALLOWED_BODY_KEYS = new Set([
  "primary_trade_module",
  "custom_trade_label",
  "default_contract_name",
  "default_warranty_duration_value",
  "default_warranty_duration_unit",
  "default_warranty_enabled",
  "default_warranty_summary",
  "default_warranty_exclusions",
  "change_order_requirement",
  "require_customer_initials",
  "default_signer_mode",
  "default_contract_language",
  "dispute_resolution_preference",
  "default_signature_order",
  "automatically_attach_warranty",
  "automatically_attach_completion_certificate",
  "require_contractor_signature",
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

function findUnknownBodyKeys(body, allowed) {
  const allowedSet = allowed || ALLOWED_BODY_KEYS;
  const unknown = [];
  if (!body || typeof body !== "object") return unknown;
  for (const key of Object.keys(body)) {
    if (!allowedSet.has(key)) unknown.push(key);
  }
  return unknown;
}

function missingWarrantyPatchKeys(body) {
  const missing = [];
  if (!body || typeof body !== "object") return [...WARRANTY_PATCH_KEYS];
  for (const key of WARRANTY_PATCH_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) missing.push(key);
  }
  return missing;
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

function normalizeWarrantyFields(body) {
  const warrantyUnit = trimField(body.default_warranty_duration_unit, 16).toLowerCase() || "months";
  if (!WARRANTY_UNITS.has(warrantyUnit)) {
    return { error: "Invalid default_warranty_duration_unit", code: "invalid_enum" };
  }

  let warrantyValue = null;
  if (body.default_warranty_duration_value != null && body.default_warranty_duration_value !== "") {
    const n = Number(body.default_warranty_duration_value);
    if (!Number.isFinite(n) || n < 0) {
      return { error: "Invalid default_warranty_duration_value", code: "invalid_warranty_value" };
    }
    warrantyValue = Math.floor(n);
  }

  const warrantyEnabled = Boolean(body.default_warranty_enabled);
  const warrantySummary = String(body.default_warranty_summary ?? "").trim();
  const warrantyExclusions = String(body.default_warranty_exclusions ?? "").trim();
  if (warrantySummary.length > WARRANTY_TEXT_MAX) {
    return { error: "Warranty summary exceeds 4000 characters", code: "warranty_text_too_long" };
  }
  if (warrantyExclusions.length > WARRANTY_TEXT_MAX) {
    return { error: "Warranty exclusions exceed 4000 characters", code: "warranty_text_too_long" };
  }

  if (warrantyEnabled) {
    if (warrantyValue == null || warrantyValue < 1) {
      return {
        error: "Standard warranty requires a duration greater than 0",
        code: "warranty_preset_incomplete",
      };
    }
    if (!warrantySummary) {
      return {
        error: "Standard warranty requires a coverage summary",
        code: "warranty_preset_incomplete",
      };
    }
    if (!warrantyExclusions) {
      return {
        error: "Standard warranty requires exclusions",
        code: "warranty_preset_incomplete",
      };
    }
  }

  return {
    warranty: {
      default_warranty_duration_value: warrantyValue,
      default_warranty_duration_unit: warrantyUnit,
      default_warranty_enabled: warrantyEnabled,
      default_warranty_summary: warrantySummary,
      default_warranty_exclusions: warrantyExclusions,
    },
  };
}

function normalizePreferencesInput(body) {
  const tradeCode = trimField(body.primary_trade_module, 64).toLowerCase() || "custom";
  if (!isValidTradeModule(tradeCode)) {
    return { error: "Invalid primary_trade_module", code: "invalid_trade_module" };
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

  const warrantyNorm = normalizeWarrantyFields(body);
  if (warrantyNorm.error) return warrantyNorm;

  const preferences = {
    primary_trade_module: tradeCode,
    custom_trade_label: trimField(body.custom_trade_label, 200),
    default_contract_name: trimField(body.default_contract_name, 200),
    ...warrantyNorm.warranty,
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
    require_contractor_signature: body.require_contractor_signature === true,
  };

  if (tradeCode === "custom" && !preferences.custom_trade_label) {
    return {
      error: "custom_trade_label is required when primary_trade_module is custom",
      code: "custom_trade_label_required",
    };
  }

  return { preferences };
}

function normalizeWarrantyPatchInput(body) {
  return normalizeWarrantyFields(body);
}

function isSigningPolicyPatch(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const keys = Object.keys(body);
  return keys.length > 0 && keys.every((key) => SIGNING_PATCH_KEY_SET.has(key));
}

function normalizeSigningPolicyPatchInput(body) {
  if (typeof body.require_contractor_signature !== "boolean") {
    return {
      error: "require_contractor_signature must be a boolean",
      code: "invalid_require_contractor_signature",
    };
  }
  return {
    signing: {
      require_contractor_signature: body.require_contractor_signature,
    },
  };
}

function isMissingContractorColumn(err) {
  return /require_contractor_signature/i.test(
    String(err?.message || err?.supabaseRaw || err)
  );
}

async function patchSigningPolicyPreferences(tenantId, signing) {
  const existing = await loadPreferencesRow(tenantId);

  if (existing?.id) {
    const rows = await supabaseRequest(
      `tenant_contract_preferences?id=eq.${encodeURIComponent(existing.id)}` +
        `&tenant_id=eq.${encodeURIComponent(tenantId)}`,
      { method: "PATCH", body: signing }
    );
    return Array.isArray(rows) && rows[0] ? rows[0] : { ...existing, ...signing };
  }

  const payload = { tenant_id: tenantId, ...signing };
  const rows = await supabaseRequest(
    "tenant_contract_preferences?on_conflict=tenant_id",
    {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      body: payload,
    }
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : payload;
}

function successPayload(row) {
  const preferences = serializePreferencesForApi(row);
  const trade_module = buildTradeModuleResponse(preferences);
  const readiness = evaluateContractPreferencesReadiness(preferences);
  return { ok: true, preferences, trade_module, readiness };
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

async function patchWarrantyPreferences(tenantId, warranty) {
  const existing = await loadPreferencesRow(tenantId);

  if (existing?.id) {
    const rows = await supabaseRequest(
      `tenant_contract_preferences?id=eq.${encodeURIComponent(existing.id)}` +
        `&tenant_id=eq.${encodeURIComponent(tenantId)}`,
      { method: "PATCH", body: warranty }
    );
    return Array.isArray(rows) && rows[0] ? rows[0] : { ...existing, ...warranty };
  }

  const payload = { tenant_id: tenantId, ...warranty };
  const rows = await supabaseRequest(
    "tenant_contract_preferences?on_conflict=tenant_id",
    {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      body: payload,
    }
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : payload;
}

function rejectUnknownAndTenantId(body, allowed) {
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
  const unknown = findUnknownBodyKeys(body, allowed);
  if (unknown.length) {
    return json(400, {
      ok: false,
      error: "Unknown fields rejected",
      code: "unknown_fields",
      fields: unknown,
    });
  }
  return null;
}

exports.handler = async (event) => {
  try {
    const method = event.httpMethod;
    if (method !== "GET" && method !== "POST" && method !== "PATCH") {
      return json(405, { ok: false, error: "Method not allowed" });
    }

    const { tenant } = await requireOwnerOrAdmin(event);
    const tenantId = String(tenant.id);

    if (method === "GET") {
      const row = await loadPreferencesRow(tenantId);
      return json(200, successPayload(row));
    }

    const body = parseBody(event.body);

    if (method === "PATCH") {
      if (isSigningPolicyPatch(body)) {
        const rejected = rejectUnknownAndTenantId(body, SIGNING_PATCH_KEY_SET);
        if (rejected) return rejected;
        const normalized = normalizeSigningPolicyPatchInput(body);
        if (normalized.error) {
          return json(400, {
            ok: false,
            error: normalized.error,
            code: normalized.code || "validation_failed",
          });
        }
        try {
          const saved = await patchSigningPolicyPreferences(tenantId, normalized.signing);
          if (!saved) {
            return json(500, {
              ok: false,
              error: "Signing policy save failed",
              code: "save_failed",
            });
          }
          return json(200, successPayload(saved));
        } catch (err) {
          if (isMissingContractorColumn(err)) {
            return json(503, {
              ok: false,
              error: "Signing policy SQL is not applied",
              code: "sql_not_applied",
            });
          }
          throw err;
        }
      }

      const rejected = rejectUnknownAndTenantId(body, ALLOWED_PATCH_KEYS);
      if (rejected) return rejected;
      const missing = missingWarrantyPatchKeys(body);
      if (missing.length) {
        return json(400, {
          ok: false,
          error: "Warranty PATCH requires all warranty fields",
          code: "warranty_patch_fields_required",
          fields: missing,
        });
      }
      const normalized = normalizeWarrantyPatchInput(body);
      if (normalized.error) {
        return json(400, {
          ok: false,
          error: normalized.error,
          code: normalized.code || "validation_failed",
        });
      }
      const saved = await patchWarrantyPreferences(tenantId, normalized.warranty);
      if (!saved) {
        return json(500, { ok: false, error: "Warranty preset save failed", code: "save_failed" });
      }
      return json(200, successPayload(saved));
    }

    const rejected = rejectUnknownAndTenantId(body, ALLOWED_BODY_KEYS);
    if (rejected) return rejected;

    const normalized = normalizePreferencesInput(body);
    if (normalized.error) {
      return json(400, {
        ok: false,
        error: normalized.error,
        code: normalized.code || "validation_failed",
        ...(normalized.missing ? { missing: normalized.missing } : {}),
      });
    }

    try {
      const saved = await upsertPreferences(tenantId, normalized.preferences);
      if (!saved) {
        return json(500, { ok: false, error: "Preferences save failed", code: "save_failed" });
      }
      return json(200, successPayload(saved));
    } catch (err) {
      if (isMissingContractorColumn(err)) {
        return json(503, {
          ok: false,
          error: "Signing policy SQL is not applied",
          code: "sql_not_applied",
        });
      }
      throw err;
    }
  } catch (err) {
    if (err?.isGuardError) {
      return json(err.statusCode || 403, { ok: false, error: err.message, code: err.code });
    }
    return json(500, { ok: false, error: err.message || "Server error" });
  }
};

exports._test = {
  ALLOWED_BODY_KEYS,
  ALLOWED_PATCH_KEYS,
  WARRANTY_PATCH_KEYS,
  SIGNING_PATCH_KEYS,
  SIGNING_PATCH_KEY_SET,
  WARRANTY_TEXT_MAX,
  WARRANTY_UNITS,
  normalizePreferencesInput,
  normalizeWarrantyPatchInput,
  normalizeSigningPolicyPatchInput,
  isSigningPolicyPatch,
  findUnknownBodyKeys,
  missingWarrantyPatchKeys,
  patchWarrantyPreferences,
  patchSigningPolicyPreferences,
};
