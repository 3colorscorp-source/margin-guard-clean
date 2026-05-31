/**
 * GET production projects for Project Control Center only.
 * Stricter than Supervisor list: accepted quote + complete name + not hidden from PCC.
 */

const { readSessionFromEvent } = require("./_lib/session");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");
const {
  PRODUCTION_PROJECT_STATUSES,
  loadProductionProjectsForTenant,
} = require("./_lib/tenant-production-projects");

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  };
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

    const useDebug = event.queryStringParameters && event.queryStringParameters.debug === "1";
    const { projects, counts } = await loadProductionProjectsForTenant(tenant.id, {
      forProjectControl: true,
    });

    const payload = {
      ok: true,
      projects,
      allowed_project_statuses: PRODUCTION_PROJECT_STATUSES,
      filter: {
        quote_statuses: ["accepted", "approved"],
        requires_project_name: true,
        excludes_hidden_from_project_control: true,
      },
    };

    if (useDebug) {
      payload.counts = counts;
    }

    return json(200, payload);
  } catch (err) {
    return json(500, { error: err.message || "Unexpected error" });
  }
};
