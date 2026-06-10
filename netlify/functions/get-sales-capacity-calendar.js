/**
 * GET sales capacity calendar for the session tenant.
 * Query: estimated_days, desired_start_date (optional), project_id (optional)
 */

const { supabaseRequest } = require("./_lib/supabase-admin");
const { resolveOwnerOrSellerContext } = require("./_lib/tenant-device-guard");
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

    const ctx = await resolveOwnerOrSellerContext(event);
    const tenant = ctx.tenant;
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
    if (err.isGuardError) {
      return json(err.statusCode, { error: err.message, code: err.code });
    }
    return json(500, { ok: false, error: err.message || "Unexpected error" });
  }
};
