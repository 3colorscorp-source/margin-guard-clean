const { readSessionFromEvent } = require("./_lib/session");
const { supabaseRequest } = require("./_lib/supabase-admin");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function optionalUuidParam(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  if (!UUID_RE.test(s)) {
    throw new Error(`Invalid UUID: ${s.slice(0, 40)}`);
  }
  return s;
}

/**
 * GET — list tenant_project_payments for the signed-in tenant (mg_session scope).
 * Query: invoice_id, project_id, quote_id (optional filters), limit (default 100, max 500).
 * Order: paid_at desc
 */
exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "GET") {
      return json(405, { error: "Method Not Allowed" });
    }

    const session = readSessionFromEvent(event);
    if (!session?.e || !session?.c) {
      return json(401, { error: "Unauthorized" });
    }

    const tenant = await resolveTenantFromSession(session);
    if (!tenant?.id) {
      return json(422, {
        error: "Cannot list payments: tenant not found for this session. Run bootstrap-tenant first."
      });
    }

    const tenantId = String(tenant.id);
    const qs = event.queryStringParameters || {};
    let invoiceId = "";
    let projectId = "";
    let quoteId = "";
    try {
      invoiceId = qs.invoice_id || qs.invoiceId ? optionalUuidParam(qs.invoice_id || qs.invoiceId) : "";
      projectId = qs.project_id || qs.projectId ? optionalUuidParam(qs.project_id || qs.projectId) : "";
      quoteId = qs.quote_id || qs.quoteId ? optionalUuidParam(qs.quote_id || qs.quoteId) : "";
    } catch (e) {
      return json(400, { error: e.message || "Invalid query" });
    }

    const limit = clampInt(qs.limit, 1, 500, 100);

    const params = new URLSearchParams();
    params.set("tenant_id", `eq.${tenantId}`);
    params.set("order", "paid_at.desc");
    params.set("limit", String(limit));

    if (invoiceId) {
      params.set("invoice_id", `eq.${encodeURIComponent(invoiceId)}`);
    }
    if (projectId) {
      params.set("project_id", `eq.${encodeURIComponent(projectId)}`);
    }
    if (quoteId) {
      params.set("quote_id", `eq.${encodeURIComponent(quoteId)}`);
    }

    const path = `tenant_project_payments?${params.toString()}`;
    const rows = await supabaseRequest(path, { method: "GET" });
    let payments = Array.isArray(rows) ? rows : [];
    if (!Array.isArray(payments)) {
      payments = [];
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ok: true,
        payments
      })
    };
  } catch (err) {
    console.error("[list-tenant-payments]", err);
    return json(500, { ok: false, error: err.message || "Server error" });
  }
};
