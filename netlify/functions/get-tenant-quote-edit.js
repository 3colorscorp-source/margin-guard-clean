/**
 * Step 3E-C18-B — read-only quote edit fetch (owner/admin).
 * Returns safe quote fields + edit lock evaluation. No writes.
 */

const { supabaseRequest } = require("./_lib/supabase-admin");
const { readSessionFromEvent } = require("./_lib/session");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");
const {
  membershipRole,
  membershipIsActive,
  resolveMembershipByEmail,
} = require("./_lib/membership-resolve");
const { throwGuard } = require("./_lib/tenant-device-guard");
const { UUID_RE, evaluateQuoteEditGuard } = require("./_lib/quote-edit-guard");

const OWNER_ADMIN_ROLES = new Set(["owner", "admin"]);

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function pickFirst(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  return "";
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

  const membership = await resolveMembershipByEmail(supabaseRequest, tenant.id, session.e);
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

  return { tenant, membership };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "GET") {
      return json(405, { ok: false, error: "Method Not Allowed" });
    }

    const { tenant } = await requireOwnerOrAdmin(event);
    const tenantId = String(tenant.id);
    const qs = event.queryStringParameters || {};

    const quoteId = pickFirst(qs.quote_id, qs.quoteId);
    if (!quoteId) {
      return json(400, {
        ok: false,
        error: "quote_id is required",
        code: "quote_id_required",
      });
    }
    if (!UUID_RE.test(quoteId)) {
      return json(400, {
        ok: false,
        error: "Invalid quote_id",
        code: "invalid_quote_id",
      });
    }

    const result = await evaluateQuoteEditGuard(tenantId, quoteId);

    if (result.notFound) {
      return json(404, {
        ok: false,
        error: "Quote not found",
        code: "quote_not_found",
      });
    }

    if (result.invalidQuoteId) {
      return json(400, {
        ok: false,
        error: "Invalid quote_id",
        code: "invalid_quote_id",
      });
    }

    return json(200, {
      ok: true,
      quote: result.quote,
      edit: result.edit,
      locks: result.locks,
    });
  } catch (err) {
    if (err?.isGuardError) {
      return json(err.statusCode || 403, {
        ok: false,
        error: err.message,
        code: err.code,
      });
    }
    console.error("[get-tenant-quote-edit]", err);
    return json(500, { ok: false, error: err.message || "Server error" });
  }
};
