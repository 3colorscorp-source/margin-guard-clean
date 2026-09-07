/**
 * Owner/seller GET/POST for quotes.internal_operational_plan.
 * Tenant-scoped. Never writes quotes.notes. Never creates a project or calendar reservation.
 */

const { supabaseRequest } = require("./_lib/supabase-admin");
const {
  assertSellerOwnQuote,
  resolveOwnerOrSellerContext,
} = require("./_lib/tenant-device-guard");
const voice = require("./_lib/voice-operational-plan");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const QUOTE_SELECT =
  "id,tenant_id,seller_membership_id,status,start_date,due_date,estimated_days,scope_of_work,internal_operational_plan,operational_plan";

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

function isMissingInternalPlanColumn(text) {
  const t = String(text || "").toLowerCase();
  if (!/42703|column|schema cache|could not find/i.test(t)) return false;
  return /internal_operational_plan/i.test(t);
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
  const tenantId = String(ctx.tenant && ctx.tenant.id || "").trim();
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

async function handleQuoteInternalOperationalPlan(event, deps) {
  try {
    return await handleQuoteInternalOperationalPlanInner(event, deps);
  } catch (err) {
    if (err && err.isGuardError) {
      return json(err.statusCode || 403, { error: err.message, code: err.code });
    }
    if (isMissingInternalPlanColumn(err && err.message)) {
      return json(200, {
        ok: true,
        document: null,
        column_missing: true,
        persisted: false,
      });
    }
    return json(500, { ok: false, error: (err && err.message) || "Unexpected error" });
  }
}

async function handleQuoteInternalOperationalPlanInner(event, deps) {
  const d = deps && typeof deps === "object" ? deps : {};
  const resolveCtx = d.resolveOwnerOrSellerContext || resolveOwnerOrSellerContext;
  const supabaseReq = d.supabaseRequest || supabaseRequest;
  const loadSettings = d.loadTenantSettings || loadTenantSettings;

  if (event.httpMethod !== "GET" && event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  const ctx = await resolveCtx(event);
  const tenant = ctx.tenant;
  if (!tenant || !tenant.id) {
    return json(404, { error: "Tenant not found" });
  }

  const qs = event.queryStringParameters || {};
  const body = event.httpMethod === "POST" ? parseBody(event.body) : {};
  if (event.httpMethod === "POST" && !body) {
    return json(400, { error: "Invalid JSON" });
  }

  const quoteId = String((body && body.quote_id) || qs.quote_id || "").trim();
  const settings = await loadSettings(supabaseReq, tenant.id);
  const startDate = (body && (body.start_date || body.startDate)) || "";
  const options = {
    startDate: startDate,
    settings: settings,
    hoursPerDay: settings.hoursPerDay,
  };

  if (event.httpMethod === "GET") {
    if (!quoteId) return json(400, { error: "quote_id is required" });
    try {
      const quote = await loadOwnedQuote(supabaseReq, ctx, quoteId);
      const raw = quote.internal_operational_plan;
      const doc = voice.normalizeDocument(raw && typeof raw === "object" ? raw : { days: [] }, {
        startDate: startDate || quote.start_date,
        settings: settings,
        hoursPerDay: settings.hoursPerDay,
      });
      return json(200, publicResponse(doc, settings));
    } catch (err) {
      if (isMissingInternalPlanColumn(err && err.message)) {
        return json(200, {
          ok: true,
          document: null,
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
  const draft = voice.normalizeDocument(incoming, {
    startDate: startDate || incoming.start_date,
    settings: settings,
    hoursPerDay: settings.hoursPerDay,
  });

  if (action !== "confirm") {
    return json(200, Object.assign({ persisted: false, action: "preview" }, publicResponse(draft, options.settings)));
  }

  if (!quoteId) {
    return json(200, Object.assign({ persisted: false, action: "confirm_local" }, publicResponse(draft, settings)));
  }

  const quote = await loadOwnedQuote(supabaseReq, ctx, quoteId);
  const publicScope = voice.buildPublicClientScope(draft);
  const patch = {
    internal_operational_plan: draft,
    operational_plan: voice.deriveLegacyOperationalPlan(draft),
    estimated_days: draft.estimated_days,
    estimated_hours: draft.estimated_hours,
  };
  if (draft.start_date) patch.start_date = draft.start_date;
  if (draft.due_date) patch.due_date = draft.due_date;
  if (publicScope.narrative) patch.scope_of_work = publicScope.narrative;

  try {
    const rows = await supabaseReq(
      `quotes?id=eq.${encodeURIComponent(quote.id)}&tenant_id=eq.${encodeURIComponent(tenant.id)}`,
      { method: "PATCH", body: patch }
    );
    const saved = Array.isArray(rows) ? rows[0] : quote;
    return json(
      200,
      Object.assign({ persisted: true, action: "confirm", quote_id: quote.id }, publicResponse(draft, settings), {
        row_id: saved && saved.id ? saved.id : quote.id,
      })
    );
  } catch (err) {
    if (isMissingInternalPlanColumn(err && (err.message || err.text))) {
      return json(200, Object.assign({ persisted: false, column_missing: true, action: "confirm" }, publicResponse(draft, settings)));
    }
    throw err;
  }
}

exports.handler = async (event) => handleQuoteInternalOperationalPlan(event);

exports._test = {
  handleQuoteInternalOperationalPlan,
  isMissingInternalPlanColumn,
};
