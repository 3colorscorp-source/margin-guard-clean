const { supabaseRequest } = require("./_lib/supabase-admin");

const LAB_TENANT_SLUG_FALLBACK = "three-colors-corp";

const STRIPPED_INTERNAL_KEYS = new Set([
  "internalCost",
  "margin",
  "overhead",
  "laborRate",
  "protectedInternalCost",
  "costPerDay",
  "trueCost",
  "profit",
  "markup",
  "baseAmount",
  "protectedPublicCrewDayPrice",
  "salesCommissionPct",
  "laborBudget",
]);

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function trimStr(value, maxLen) {
  const s = String(value ?? "").trim();
  if (!s) return "";
  return maxLen && s.length > maxLen ? s.slice(0, maxLen) : s;
}

function isValidEmail(email) {
  const s = String(email || "").trim();
  if (!s || s.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function stripInternalKeys(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  const out = {};
  for (const [key, val] of Object.entries(obj)) {
    if (STRIPPED_INTERNAL_KEYS.has(key)) continue;
    out[key] = val;
  }
  return out;
}

function computeBudgetSignal(budgetMin, budgetMax, rangeLow, rangeHigh) {
  const min = finiteNumber(budgetMin);
  const max = finiteNumber(budgetMax);
  const low = finiteNumber(rangeLow);
  const high = finiteNumber(rangeHigh);
  if (min == null || max == null || low == null || high == null) return "";
  if (max >= low && min <= high) return "overlaps_range";
  if (max < low) return "below_range";
  return "above_range";
}

async function resolveTenant({ tenantSlug, tenantId }) {
  const id = trimStr(tenantId, 80);
  if (id) {
    const rows = await supabaseRequest(
      `tenants?id=eq.${encodeURIComponent(id)}&select=id,slug&limit=1`
    );
    if (Array.isArray(rows) && rows[0]?.id) return rows[0];
    return null;
  }

  let slug = trimStr(tenantSlug, 120).toLowerCase();
  if (!slug) slug = LAB_TENANT_SLUG_FALLBACK;

  const rows = await supabaseRequest(
    `tenants?slug=eq.${encodeURIComponent(slug)}&select=id,slug&limit=1`
  );
  if (Array.isArray(rows) && rows[0]?.id) return rows[0];
  return null;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "Method not allowed" });
    }

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch (_err) {
      return json(400, { ok: false, error: "Invalid JSON body" });
    }

    const sanitized = stripInternalKeys(body);

    const projectName = trimStr(body.projectName ?? body.project_name, 500);
    const workType = trimStr(body.workType ?? body.work_type, 300);
    const scopeSize = finiteNumber(body.scopeSize ?? body.scope_size);
    const rangeLow = finiteNumber(body.rangeLow ?? body.range_low);
    const rangeHigh = finiteNumber(body.rangeHigh ?? body.range_high);
    const clientName = trimStr(body.clientName ?? body.client_name, 300);
    const clientEmail = trimStr(body.clientEmail ?? body.client_email, 320).toLowerCase();

    if (!projectName) return json(400, { ok: false, error: "projectName is required" });
    if (!workType) return json(400, { ok: false, error: "workType is required" });
    if (scopeSize == null || scopeSize <= 0) {
      return json(400, { ok: false, error: "scopeSize is required" });
    }
    if (rangeLow == null || rangeHigh == null) {
      return json(400, { ok: false, error: "rangeLow and rangeHigh are required" });
    }
    if (!clientName) return json(400, { ok: false, error: "clientName is required" });
    if (!isValidEmail(clientEmail)) {
      return json(400, { ok: false, error: "A valid clientEmail is required" });
    }

    let tenant;
    try {
      tenant = await resolveTenant({
        tenantSlug: body.tenantSlug ?? body.tenant_slug,
        tenantId: body.tenantId ?? body.tenant_id,
      });
    } catch (_err) {
      return json(502, { ok: false, error: "Unable to resolve tenant" });
    }

    if (!tenant?.id) {
      return json(400, { ok: false, error: "Tenant not found" });
    }

    const budgetMin = finiteNumber(body.budgetMin ?? body.budget_min);
    const budgetMax = finiteNumber(body.budgetMax ?? body.budget_max);
    const clientBudget =
      trimStr(body.clientBudget ?? body.client_budget, 120) ||
      (budgetMin != null && budgetMax != null ? `${budgetMin} – ${budgetMax}` : "");

    const insertRow = {
      tenant_id: tenant.id,
      tenant_slug: tenant.slug || trimStr(body.tenantSlug ?? body.tenant_slug, 120),
      source: trimStr(body.source, 80) || "ai_closer_client",
      status: "new",
      project_name: projectName,
      work_type: workType,
      unit_type: trimStr(body.unitType ?? body.unit_type, 80) || null,
      scope_size: scopeSize,
      estimated_crew_days: finiteNumber(body.estimatedCrewDays ?? body.estimated_crew_days),
      range_low: rangeLow,
      range_high: rangeHigh,
      client_budget: clientBudget || null,
      budget_signal: computeBudgetSignal(budgetMin, budgetMax, rangeLow, rangeHigh) || null,
      zoom_slot: trimStr(body.zoomSlot ?? body.zoom_slot, 200) || null,
      target_date: trimStr(body.targetDate ?? body.target_date, 120) || null,
      scope_notes: trimStr(body.scopeNotes ?? body.scope_notes, 4000) || null,
      plan_file_name: trimStr(body.planFileName ?? body.plan_file_name, 300) || null,
      current_photo_name: trimStr(body.currentPhotoName ?? body.current_photo_name, 300) || null,
      inspiration_photo_name:
        trimStr(body.inspirationPhotoName ?? body.inspiration_photo_name, 300) || null,
      client_name: clientName,
      client_email: clientEmail,
      client_phone: trimStr(body.clientPhone ?? body.client_phone, 80) || null,
      preferred_contact: trimStr(body.preferredContact ?? body.preferred_contact, 80) || null,
      client_notes: trimStr(body.clientNotes ?? body.client_notes, 4000) || null,
      raw_payload: sanitized,
    };

    let inserted;
    try {
      inserted = await supabaseRequest("ai_closer_prequotes", {
        method: "POST",
        body: insertRow,
      });
    } catch (_err) {
      return json(502, { ok: false, error: "Unable to save starter pre-quote" });
    }

    const row = Array.isArray(inserted) ? inserted[0] : inserted;
    const prequoteId = row?.id ? String(row.id) : null;
    if (!prequoteId) {
      return json(502, { ok: false, error: "Unable to save starter pre-quote" });
    }

    return json(200, { ok: true, prequoteId, status: "new" });
  } catch (_err) {
    return json(500, { ok: false, error: "Unexpected server error" });
  }
};
