/**
 * Owner/seller GET/POST for quote_internal_operational_plans.
 * Tenant-scoped. Never writes quotes.notes. Never creates a project or calendar reservation.
 * Confirm applies quote scope/dates/legacy plan only after evaluateQuoteEditGuard.
 */

const { supabaseRequest } = require("./_lib/supabase-admin");
const {
  assertSellerOwnQuote,
  resolveOwnerOrSellerContext,
} = require("./_lib/tenant-device-guard");
const { evaluateQuoteEditGuard } = require("./_lib/quote-edit-guard");
const voice = require("./_lib/voice-operational-plan");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const QUOTE_SELECT =
  "id,tenant_id,seller_membership_id,status,start_date,due_date,estimated_days,scope_of_work,operational_plan";

const INTERNAL_TABLE = "quote_internal_operational_plans";

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
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (_e) {
    return null;
  }
}

function isMissingInternalPlanTable(text) {
  const t = String(text || "").toLowerCase();
  if (!/quote_internal_operational_plans/.test(t)) return false;
  return /42p01|does not exist|schema cache|42703|could not find/i.test(t);
}

function extractSettingsFromSnapshotPayload(payload) {
  if (!payload || typeof payload !== "object") return {};
  const storage = payload.storage && typeof payload.storage === "object" ? payload.storage : {};
  return storage.mg_settings_v2 && typeof storage.mg_settings_v2 === "object"
    ? storage.mg_settings_v2
    : {};
}

async function loadTenantSettings(supabaseReq, tenantId) {
  try {
    const rows = await supabaseReq(
      `tenant_snapshots?tenant_id=eq.${encodeURIComponent(tenantId)}&select=payload&order=created_at.desc&limit=1`
    );
    const row = Array.isArray(rows) ? rows[0] : null;
    return extractSettingsFromSnapshotPayload(row && row.payload);
  } catch (_e) {
    return {};
  }
}

function quotePath(quoteId, tenantId, select) {
  return (
    `quotes?id=eq.${encodeURIComponent(quoteId)}` +
    `&tenant_id=eq.${encodeURIComponent(tenantId)}` +
    `&select=${select || "id,tenant_id,seller_membership_id"}&limit=1`
  );
}

function membershipIdFromCtx(ctx) {
  const id = String((ctx && ctx.membership && ctx.membership.id) || "").trim();
  return UUID_RE.test(id) ? id : null;
}

function publicResponse(doc, settings) {
  const publicScope = voice.buildPublicClientScope(doc);
  return {
    ok: true,
    document: doc,
    public_client_scope: publicScope,
    estimated_days: doc.estimated_days,
    start_date: doc.start_date,
    due_date: doc.due_date,
    labor_preview: {
      hours: doc.estimated_hours,
      derived_cost: voice.previewLaborCost(doc.days, settings),
    },
  };
}

async function loadOwnedQuote(supabaseReq, ctx, quoteId) {
  const tenantId = String((ctx.tenant && ctx.tenant.id) || "").trim();
  if (!UUID_RE.test(quoteId) || !UUID_RE.test(tenantId)) {
    const err = new Error("Quote not found");
    err.statusCode = 404;
    err.code = "quote_not_found";
    err.isGuardError = true;
    throw err;
  }
  const rows = await supabaseReq(quotePath(quoteId, tenantId, QUOTE_SELECT), { method: "GET" });
  const quote = Array.isArray(rows) ? rows[0] : null;
  if (!quote) {
    const err = new Error("Quote not found");
    err.statusCode = 404;
    err.code = "quote_not_found";
    err.isGuardError = true;
    throw err;
  }
  assertSellerOwnQuote(ctx, quote);
  return quote;
}

async function loadInternalPlanRow(supabaseReq, tenantId, quoteId) {
  const rows = await supabaseReq(
    `${INTERNAL_TABLE}?quote_id=eq.${encodeURIComponent(quoteId)}` +
      `&tenant_id=eq.${encodeURIComponent(tenantId)}` +
      `&select=id,quote_id,tenant_id,document,schema_version,updated_at&limit=1`,
    { method: "GET" }
  );
  return Array.isArray(rows) ? rows[0] : null;
}

async function upsertInternalPlan(supabaseReq, { tenantId, quoteId, document, membershipId }) {
  const nowIso = new Date().toISOString();
  const existing = await loadInternalPlanRow(supabaseReq, tenantId, quoteId);
  const payload = {
    quote_id: quoteId,
    tenant_id: tenantId,
    document,
    schema_version: Number(document && document.schema_version) || voice.SCHEMA_VERSION,
    last_updated_by_membership_id: membershipId,
    updated_at: nowIso,
  };
  if (existing && existing.id) {
    return supabaseReq(
      `${INTERNAL_TABLE}?id=eq.${encodeURIComponent(existing.id)}&tenant_id=eq.${encodeURIComponent(tenantId)}`,
      { method: "PATCH", body: payload }
    );
  }
  return supabaseReq(INTERNAL_TABLE, {
    method: "POST",
    body: { ...payload, created_at: nowIso },
  });
}

function assertConfirmAllowed(guard, body) {
  if (guard.notFound) {
    return json(404, { ok: false, persisted: false, error: "Quote not found", code: "quote_not_found" });
  }
  if (guard.invalidQuoteId) {
    return json(400, { ok: false, persisted: false, error: "Invalid quote_id", code: "invalid_quote_id" });
  }
  if (guard.edit && (guard.edit.locked || !guard.edit.is_editable)) {
    return json(422, {
      ok: false,
      persisted: false,
      error: "Quote is locked and cannot be edited.",
      code: "quote_locked",
      lock_reasons: (guard.edit && guard.edit.lock_reasons) || [],
    });
  }
  const warnings = (guard.edit && guard.edit.warnings) || [];
  if (warnings.includes("quote_viewed_or_sent") && body.confirm_sent_update !== true) {
    return json(409, {
      ok: false,
      persisted: false,
      error: "This quote was already sent or viewed. Set confirm_sent_update to true to proceed.",
      code: "sent_quote_confirmation_required",
      warnings,
    });
  }
  return null;
}

async function handleQuoteInternalOperationalPlan(event, deps) {
  try {
    return await handleQuoteInternalOperationalPlanInner(event, deps);
  } catch (err) {
    if (err && err.isGuardError) {
      return json(err.statusCode || 403, { ok: false, persisted: false, error: err.message, code: err.code });
    }
    if (isMissingInternalPlanTable(err && err.message)) {
      return json(503, {
        ok: false,
        persisted: false,
        column_missing: true,
        error: "Internal operational plan table is not installed.",
        code: "internal_plan_table_missing",
      });
    }
    return json(500, { ok: false, persisted: false, error: (err && err.message) || "Unexpected error" });
  }
}

async function handleQuoteInternalOperationalPlanInner(event, deps) {
  const d = deps && typeof deps === "object" ? deps : {};
  const resolveCtx = d.resolveOwnerOrSellerContext || resolveOwnerOrSellerContext;
  const supabaseReq = d.supabaseRequest || supabaseRequest;
  const loadSettings = d.loadTenantSettings || loadTenantSettings;
  const evalGuard = d.evaluateQuoteEditGuard || evaluateQuoteEditGuard;

  if (event.httpMethod !== "GET" && event.httpMethod !== "POST") {
    return json(405, { ok: false, error: "Method not allowed" });
  }

  const ctx = await resolveCtx(event);
  const tenant = ctx.tenant;
  if (!tenant || !tenant.id) {
    return json(404, { ok: false, error: "Tenant not found" });
  }

  const qs = event.queryStringParameters || {};
  const body = event.httpMethod === "POST" ? parseBody(event.body) : {};
  if (event.httpMethod === "POST" && !body) {
    return json(400, { ok: false, persisted: false, error: "Invalid JSON", code: "invalid_json" });
  }

  const quoteId = String((body && body.quote_id) || qs.quote_id || "").trim();
  const settings = await loadSettings(supabaseReq, tenant.id);
  const hoursPerDay = voice.resolveHoursPerDayFromSettings(settings);
  const startDate = (body && (body.start_date || body.startDate)) || "";

  if (event.httpMethod === "GET") {
    if (!quoteId) return json(400, { ok: false, error: "quote_id is required", code: "quote_id_required" });
    const quote = await loadOwnedQuote(supabaseReq, ctx, quoteId);
    try {
      const row = await loadInternalPlanRow(supabaseReq, tenant.id, quote.id);
      const raw = row && row.document && typeof row.document === "object" ? row.document : { days: [] };
      const doc = voice.normalizeDocument(raw, {
        startDate: startDate || quote.start_date,
        settings,
        hoursPerDay,
      });
      return json(200, publicResponse(doc, settings));
    } catch (err) {
      if (isMissingInternalPlanTable(err && err.message)) {
        return json(200, {
          ok: true,
          document: null,
          persisted: false,
          column_missing: true,
          public_client_scope: voice.buildPublicClientScope({ days: [] }),
        });
      }
      throw err;
    }
  }

  const action = String((body && body.action) || "preview").trim().toLowerCase();
  const incoming = voice.stripRateFields(
    (body && (body.document || body.internal_operational_plan)) || { days: [] }
  );
  const validated = voice.validateIncomingDocument(incoming);
  if (!validated.ok) {
    return json(400, {
      ok: false,
      persisted: false,
      error: validated.errors[0] ? validated.errors[0].message : "Invalid operational plan.",
      code: "document_invalid",
      errors: validated.errors,
    });
  }
  const draft = voice.normalizeDocument(incoming, {
    startDate: startDate || incoming.start_date,
    settings,
    hoursPerDay,
  });

  if (action !== "confirm") {
    return json(200, Object.assign({ persisted: false, action: "preview" }, publicResponse(draft, settings)));
  }

  if (!quoteId) {
    return json(400, {
      ok: false,
      persisted: false,
      error: "quote_id is required to persist the operational plan.",
      code: "quote_id_required",
    });
  }

  const quote = await loadOwnedQuote(supabaseReq, ctx, quoteId);
  const guard = await evalGuard(tenant.id, quote.id);
  const blocked = assertConfirmAllowed(guard, body);
  if (blocked) return blocked;

  const publicScope = voice.buildPublicClientScope(draft);
  const quotePatch = {
    operational_plan: voice.deriveLegacyOperationalPlan(draft),
    estimated_days: draft.estimated_days,
    estimated_hours: draft.estimated_hours,
    updated_at: new Date().toISOString(),
  };
  if (draft.start_date) quotePatch.start_date = draft.start_date;
  if (draft.due_date) quotePatch.due_date = draft.due_date;
  if (publicScope.narrative) quotePatch.scope_of_work = publicScope.narrative;

  try {
    await upsertInternalPlan(supabaseReq, {
      tenantId: tenant.id,
      quoteId: quote.id,
      document: draft,
      membershipId: membershipIdFromCtx(ctx),
    });
  } catch (err) {
    if (isMissingInternalPlanTable(err && (err.message || err.text))) {
      return json(503, {
        ok: false,
        persisted: false,
        column_missing: true,
        action: "confirm",
        error: "Internal operational plan table is not installed.",
        code: "internal_plan_table_missing",
      });
    }
    throw err;
  }

  await supabaseReq(
    `quotes?id=eq.${encodeURIComponent(quote.id)}&tenant_id=eq.${encodeURIComponent(tenant.id)}`,
    { method: "PATCH", body: quotePatch }
  );

  return json(
    200,
    Object.assign({ persisted: true, action: "confirm", quote_id: quote.id, ok: true }, publicResponse(draft, settings))
  );
}

exports.handler = async (event) => handleQuoteInternalOperationalPlan(event);

exports._test = {
  handleQuoteInternalOperationalPlan,
  isMissingInternalPlanTable,
  upsertInternalPlan,
};
