/**
 * GET sales capacity calendar for the session tenant.
 * Query: estimated_days, desired_start_date (optional), project_id (optional)
 */

const { readSessionFromEvent } = require("./_lib/session");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");
const { supabaseRequest } = require("./_lib/supabase-admin");
const { computeSalesCapacityCalendar } = require("./_lib/sales-capacity-calendar");

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  };
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "GET") {
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

    const qs = event.queryStringParameters || {};
    const estimatedDays = num(qs.estimated_days, 0);
    const desiredStartDate = String(qs.desired_start_date || "").trim() || null;
    let excludeProjectId = String(qs.project_id || "").trim();

    if (excludeProjectId) {
      const tid = encodeURIComponent(tenant.id);
      const pid = encodeURIComponent(excludeProjectId);
      const rows = await supabaseRequest(
        `tenant_projects?id=eq.${pid}&tenant_id=eq.${tid}&select=id&limit=1`
      );
      if (!Array.isArray(rows) || !rows[0]?.id) {
        excludeProjectId = "";
      }
    }

    const result = await computeSalesCapacityCalendar({
      tenantId: tenant.id,
      estimatedDays,
      desiredStartDate,
      excludeProjectId,
    });

    return json(200, result);
  } catch (err) {
    return json(500, { ok: false, error: err.message || "Unexpected error" });
  }
};
