/**
 * Upserts public.tenant_projects for the session tenant (never trusts client tenant_id).
 * Primary production trigger: Sales "Firmar proyecto" after publish (see public/sales.html).
 */

const { readSessionFromEvent } = require("./_lib/session");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");
const { supabaseRequest } = require("./_lib/supabase-admin");
const {
  DEFAULT_HOURS_PER_DAY,
  buildEstimateEconomics,
  mayWriteLaborPlan,
  shouldLockLaborPlan,
  isPlanEffectivelyEmpty,
  planHasRows,
} = require("./_lib/project-labor-plan");
const {
  normalizeOperationalPlan,
  computeOperationalPlanMetrics,
  planHasDays,
} = require("./_lib/operational-plan");
const { persistOperationalSnapshot } = require("./_lib/persist-operational-snapshot");

const ALLOWED_STATUS = new Set([
  "signed",
  "deposit_paid",
  "assigned",
  "in_progress",
  "completed",
  "cancelled",
]);

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  };
}

function parseBody(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function str(v, max = 5000) {
  return String(v == null ? "" : v)
    .trim()
    .slice(0, max);
}

function normStatus(s) {
  const x = str(s, 64).toLowerCase();
  if (x === "sold") return "signed";
  if (ALLOWED_STATUS.has(x)) return x;
  return "signed";
}

function normDate(d) {
  const t = str(d, 32);
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  return null;
}

function pickFinite(body, keys) {
  for (const key of keys) {
    if (body[key] == null || body[key] === "") continue;
    const n = Number(body[key]);
    if (Number.isFinite(n)) return n;
  }
  return NaN;
}

function incomingPlanIsValid(plan) {
  return planHasRows(plan) && !isPlanEffectivelyEmpty(plan);
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { error: "Method not allowed" });
    }

    const session = readSessionFromEvent(event);
    if (!session?.e || !session?.c) {
      return json(401, { error: "Unauthorized" });
    }

    const tenant = await resolveTenantFromSession(session);
    if (!tenant?.id) {
      return json(404, { error: "Tenant not found" });
    }

    const body = parseBody(event.body);
    const quoteId = str(body.quote_id, 128);
    if (!quoteId) {
      return json(400, { error: "quote_id is required" });
    }

    const tid = encodeURIComponent(tenant.id);
    const quoteRows = await supabaseRequest(
      `quotes?id=eq.${encodeURIComponent(quoteId)}&tenant_id=eq.${tid}&select=id,total`
    );
    const quoteOk = Array.isArray(quoteRows) ? quoteRows[0] : null;
    if (!quoteOk?.id) {
      return json(403, { error: "Quote not found for this tenant" });
    }

    const existingRows = await supabaseRequest(
      `tenant_projects?tenant_id=eq.${tid}&quote_id=eq.${encodeURIComponent(quoteId)}&select=id,quoted_labor_plan,quoted_labor_plan_locked_at`
    );
    const existing = Array.isArray(existingRows) ? existingRows[0] : null;
    const locked = Boolean(existing?.quoted_labor_plan_locked_at);

    const hoursPerDay = Math.max(num(body.hours_per_day, DEFAULT_HOURS_PER_DAY), 0.25);
    const salePrice = num(body.sale_price, num(quoteOk.total, 0));
    const workersRaw = body.workers ?? body.quoted_labor_plan ?? [];

    const economics = buildEstimateEconomics({
      workers: workersRaw,
      settings:
        body.pricing_settings && typeof body.pricing_settings === "object"
          ? body.pricing_settings
          : {},
      salePrice,
      hoursPerDay,
      estimatedLaborCost: pickFinite(body, ["estimated_labor_cost", "estimatedLaborCost"]),
      estimatedMaterialCost: pickFinite(body, ["estimated_material_cost", "estimatedMaterialCost"]),
      estimatedProfit: pickFinite(body, ["estimated_profit", "estimatedProfit"]),
      estimatedProfitMargin: pickFinite(body, ["estimated_profit_margin", "estimatedProfitMargin"]),
    });

    const nowIso = new Date().toISOString();
    const signedAt = str(body.signed_at, 64) || nowIso;
    const incomingPlan = economics.quotedLaborPlan;

    const opOverrideRaw = pickFinite(body, [
      "operational_estimated_days_override",
      "estimated_days_override",
    ]);
    const opHoursOverrideRaw = pickFinite(body, [
      "operational_estimated_hours_override",
      "estimated_hours_override",
    ]);
    const opOverride = Number.isFinite(opOverrideRaw) ? opOverrideRaw : null;
    const opHoursOverride = Number.isFinite(opHoursOverrideRaw) ? opHoursOverrideRaw : null;
    const opNormalized = normalizeOperationalPlan(
      body.operational_plan,
      opOverride,
      hoursPerDay
    );
    const opMetrics = planHasDays(opNormalized)
      ? computeOperationalPlanMetrics(
          opNormalized,
          opOverride,
          opHoursOverride,
          hoursPerDay
        )
      : null;

    const row = {
      tenant_id: tenant.id,
      quote_id: quoteId,
      project_name: str(body.project_name, 2000),
      client_name: str(body.client_name, 500),
      client_email: str(body.client_email, 320),
      status: normStatus(body.status),
      signed_at: signedAt,
      deposit_paid: Boolean(body.deposit_paid),
      estimated_days: opMetrics
        ? opMetrics.estimated_days
        : num(body.estimated_days, 0),
      labor_budget: num(body.labor_budget, economics.estimatedLaborCost),
      sale_price: salePrice,
      recommended_price: num(body.recommended_price, 0),
      minimum_price: num(body.minimum_price, 0),
      due_date: normDate(body.due_date),
      notes: str(body.notes, 8000),
      updated_at: nowIso,
    };

    if (!locked) {
      row.estimated_labor_cost = economics.estimatedLaborCost;
      row.estimated_material_cost = economics.estimatedMaterialCost;
      row.estimated_profit = economics.estimatedProfit;
      row.estimated_profit_margin = economics.estimatedProfitMargin;
    }

    if (!locked && mayWriteLaborPlan(existing, incomingPlan)) {
      row.quoted_labor_plan = incomingPlan;
      if (shouldLockLaborPlan(existing, incomingPlan)) {
        row.quoted_labor_plan_locked_at = nowIso;
      }
    } else if (!existing && incomingPlanIsValid(incomingPlan)) {
      row.quoted_labor_plan = incomingPlan;
      if (shouldLockLaborPlan(null, incomingPlan)) {
        row.quoted_labor_plan_locked_at = nowIso;
      }
    }

    if (existing?.id) {
      const { tenant_id: _t, quote_id: _q, ...patch } = row;
      await supabaseRequest(
        `tenant_projects?id=eq.${encodeURIComponent(existing.id)}&tenant_id=eq.${tid}`,
        {
          method: "PATCH",
          body: patch,
        }
      );
      if (planHasDays(opNormalized)) {
        await persistOperationalSnapshot({
          tenantId: tenant.id,
          projectId: existing.id,
          quoteId,
          operationalPlan: opNormalized,
          estimatedDaysOverride: opOverride,
          estimatedHoursOverride: opHoursOverride,
          hoursPerDay,
          due_date: row.due_date,
          source: "mark_sold",
        });
      }
      return json(200, {
        ok: true,
        id: existing.id,
        updated: true,
        labor_plan_locked: locked || Boolean(patch.quoted_labor_plan_locked_at),
        operational_snapshot: planHasDays(opNormalized),
      });
    }

    const insertBody = {
      ...row,
      quoted_labor_plan: row.quoted_labor_plan ?? [],
      created_at: nowIso,
    };

    const inserted = await supabaseRequest("tenant_projects", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: insertBody,
    });
    const ins = Array.isArray(inserted) ? inserted[0] : inserted;
    if (ins?.id && planHasDays(opNormalized)) {
      await persistOperationalSnapshot({
        tenantId: tenant.id,
        projectId: ins.id,
        quoteId,
        operationalPlan: opNormalized,
        estimatedDaysOverride: opOverride,
        estimatedHoursOverride: opHoursOverride,
        hoursPerDay,
        due_date: row.due_date,
        source: "mark_sold",
      });
    }
    return json(200, {
      ok: true,
      id: ins?.id,
      updated: false,
      labor_plan_locked: Boolean(insertBody.quoted_labor_plan_locked_at),
      operational_snapshot: planHasDays(opNormalized),
    });
  } catch (err) {
    return json(500, { error: err.message || "Unexpected error" });
  }
};
