/**
 * CH-011A — List Contract Packages for a project (Owner/Admin, read-only).
 * GET /.netlify/functions/contract-packages?project_id=...
 *
 * Newest version first. No writes.
 */

"use strict";

const { supabaseRequest } = require("./_lib/supabase-admin");
const { readSessionFromEvent } = require("./_lib/session");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");
const {
  resolveMembershipByEmail,
  membershipRole,
  membershipIsActive,
} = require("./_lib/membership-resolve");
const { throwGuard } = require("./_lib/tenant-device-guard");
const {
  API_VERSION,
  validUuid,
  unknownKeys,
  listPackagesForProject,
  trimField,
} = require("./_lib/contract-package");

const OWNER_ADMIN_ROLES = new Set(["owner", "admin"]);
const ALLOWED_QUERY_KEYS = new Set(["project_id"]);

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function singleQueryValue(value) {
  if (Array.isArray(value)) return value[0];
  return value;
}

async function requireOwnerOrAdmin(event) {
  const session = readSessionFromEvent(event);
  if (!session?.e || !session?.c) {
    throwGuard(401, "Unauthorized", "no_session");
  }
  const tenant = await resolveTenantFromSession(session);
  if (!tenant?.id) {
    throwGuard(422, "Tenant not found for this session.", "tenant_not_found");
  }
  const membership = await resolveMembershipByEmail(
    supabaseRequest,
    tenant.id,
    session.e
  );
  if (!membership?.id) {
    throwGuard(403, "Membership not found", "membership_not_found");
  }
  if (!membershipIsActive(membership)) {
    throwGuard(403, "Membership is not active", "membership_inactive");
  }
  const role = membershipRole(membership);
  if (!OWNER_ADMIN_ROLES.has(role)) {
    throwGuard(403, "Owner or admin membership required", "owner_required");
  }
  return { tenant };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") {
      return json(204, {});
    }
    if (event.httpMethod !== "GET") {
      return json(405, {
        ok: false,
        error: "Method not allowed",
        code: "method_not_allowed",
      });
    }

    const query = event.queryStringParameters || {};
    const unknown = unknownKeys(query, ALLOWED_QUERY_KEYS);
    if (unknown.length) {
      return json(400, {
        ok: false,
        error: `Unknown query fields: ${unknown.join(", ")}`,
        code: "unknown_fields",
      });
    }

    const projectId = trimField(singleQueryValue(query.project_id)).toLowerCase();
    if (!validUuid(projectId)) {
      return json(400, {
        ok: false,
        error: "project_id is required",
        code: "invalid_project_id",
      });
    }

    const { tenant } = await requireOwnerOrAdmin(event);

    const projects = await supabaseRequest(
      `tenant_projects?id=eq.${encodeURIComponent(projectId)}` +
        `&tenant_id=eq.${encodeURIComponent(tenant.id)}&select=id&limit=1`,
      { method: "GET" }
    );
    if (!Array.isArray(projects) || !projects[0]?.id) {
      return json(404, {
        ok: false,
        error: "Project not found",
        code: "not_found",
      });
    }

    const packages = await listPackagesForProject(tenant.id, projectId);
    return json(200, {
      ok: true,
      version: API_VERSION,
      project_id: projectId,
      packages,
    });
  } catch (err) {
    if (err?.isGuardError) {
      return json(err.statusCode || 403, {
        ok: false,
        error: err.message,
        code: err.code,
      });
    }
    console.error("contract-packages", err);
    return json(500, {
      ok: false,
      error: "Server error",
      code: "server_error",
    });
  }
};

exports._test = {
  ALLOWED_QUERY_KEYS,
  API_VERSION,
};
