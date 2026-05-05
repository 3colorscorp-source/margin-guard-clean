/**
 * Upserts public.tenant_projects for the session tenant (never trusts client tenant_id).
 * Primary production trigger: Sales "Firmar proyecto" after publish (see public/sales.html).
 *
 * Not yet wired: public customer accept flow (update-public-estimate-status.js) — add a call
 * there when a quote becomes accepted if you want tenant_projects from that path too.
 */

const { readSessionFromEvent } = require("./_lib/session");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");
const { supabaseRequest } = require("./_lib/supabase-admin");

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

/** Persist Sales signing labor lines: [{ name, type, days }]. */
function normalizeQuotedLaborPlan(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const maxRows = 50;
  for (let i = 0; i < raw.length && out.length < maxRows; i++) {
    const w = raw[i];
    if (!w || typeof w !== "object") continue;
    const t = str(w.type, 32).toLowerCase();
    out.push({
      name: str(w.name, 200),
      type: t === "helper" ? "helper" : "installer",
      days: num(w.days, 0),
    });
  }
  return out;
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
      `quotes?id=eq.${encodeURIComponent(quoteId)}&tenant_id=eq.${tid}&select=id`
    );
    const quoteOk = Array.isArray(quoteRows) ? quoteRows[0] : null;
    if (!quoteOk?.id) {
      return json(403, { error: "Quote not found for this tenant" });
    }

    const nowIso = new Date().toISOString();
    const signedAt = str(body.signed_at, 64) || nowIso;
    const quotedLaborPlan = normalizeQuotedLaborPlan(body.workers);
    const row = {
      tenant_id: tenant.id,
      quote_id: quoteId,
      project_name: str(body.project_name, 2000),
      client_name: str(body.client_name, 500),
      client_email: str(body.client_email, 320),
      status: normStatus(body.status),
      signed_at: signedAt,
      deposit_paid: Boolean(body.deposit_paid),
      estimated_days: num(body.estimated_days, 0),
      labor_budget: num(body.labor_budget, 0),
      sale_price: num(body.sale_price, 0),
      recommended_price: num(body.recommended_price, 0),
      minimum_price: num(body.minimum_price, 0),
      due_date: normDate(body.due_date),
      notes: str(body.notes, 8000),
      quoted_labor_plan: quotedLaborPlan,
      updated_at: nowIso,
    };

    const existing = await supabaseRequest(
      `tenant_projects?tenant_id=eq.${tid}&quote_id=eq.${encodeURIComponent(quoteId)}&select=id`
    );
    const hit = Array.isArray(existing) ? existing[0] : null;

    if (hit?.id) {
      const { tenant_id: _t, quote_id: _q, ...patch } = row;
      await supabaseRequest(`tenant_projects?id=eq.${encodeURIComponent(hit.id)}&tenant_id=eq.${tid}`, {
        method: "PATCH",
        body: patch,
      });
      return json(200, { ok: true, id: hit.id, updated: true });
    }

    const inserted = await supabaseRequest("tenant_projects", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: {
        ...row,
        created_at: nowIso,
      },
    });
    const ins = Array.isArray(inserted) ? inserted[0] : inserted;
    return json(200, { ok: true, id: ins?.id, updated: false });
  } catch (err) {
    return json(500, { error: err.message || "Unexpected error" });
  }
};
