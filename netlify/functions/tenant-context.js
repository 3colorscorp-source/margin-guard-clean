const { readSessionFromEvent } = require("./_lib/session");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");
const { supabaseRequest } = require("./_lib/supabase-admin");
const { resolveMembershipByEmail, membershipIsActive, membershipRole } = require("./_lib/membership-resolve");

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  };
}

function createHandler(deps = {}) {
  const readSession = deps.readSessionFromEvent || readSessionFromEvent;
  const resolveTenant = deps.resolveTenantFromSession || resolveTenantFromSession;
  const requestFn = deps.supabaseRequest || supabaseRequest;

  return async function handler(event) {
    try {
      if (event.httpMethod !== "GET") {
        return json(405, { error: "Method not allowed" });
      }

      const session = readSession(event);
      if (!session?.e) {
        return json(401, { error: "Unauthorized" });
      }

      const tenant = await resolveTenant(session, deps);
      if (!tenant) {
        return json(404, { error: "Tenant not found" });
      }

      const membership = await resolveMembershipByEmail(requestFn, tenant.id, session.e);
      if (
        !membership ||
        !membershipIsActive(membership) ||
        membershipRole(membership) !== "owner"
      ) {
        return json(403, { error: "Unauthorized" });
      }

      return json(200, {
        ok: true,
        tenant_id: tenant.id,
        tenant,
        profile: membership,
      });
    } catch (err) {
      return json(500, { error: "Unable to load tenant context" });
    }
  };
}

exports.handler = createHandler();
exports.createHandler = createHandler;
