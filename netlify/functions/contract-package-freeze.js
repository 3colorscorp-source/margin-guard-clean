/**
 * CH-011A — Freeze immutable Contract Package (Owner/Admin).
 * POST /.netlify/functions/contract-package-freeze
 *
 * No envelopes, email, PDF, Stripe, invoices, ledger, or Payment Intents.
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
  freezeContractPackage,
  trimField,
} = require("./_lib/contract-package");

const OWNER_ADMIN_ROLES = new Set(["owner", "admin"]);
const ALLOWED_BODY_KEYS = new Set([
  "project_id",
  "quote_id",
  "expected_setup_updated_at",
  "expected_schedule_updated_at",
]);

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function parseBody(raw) {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
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
  return { tenant, membership, session };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") {
      return json(204, {});
    }
    if (event.httpMethod !== "POST") {
      return json(405, {
        ok: false,
        error: "Method not allowed",
        code: "method_not_allowed",
      });
    }

    const body = parseBody(event.body);
    if (!body) {
      return json(400, {
        ok: false,
        error: "Invalid JSON body",
        code: "invalid_json",
      });
    }

    const unknown = unknownKeys(body, ALLOWED_BODY_KEYS);
    if (unknown.length) {
      return json(400, {
        ok: false,
        error: `Unknown fields: ${unknown.join(", ")}`,
        code: "unknown_fields",
      });
    }

    if (Object.prototype.hasOwnProperty.call(body, "tenant_id")) {
      return json(400, {
        ok: false,
        error: "tenant_id is not accepted from client",
        code: "tenant_id_forbidden",
      });
    }

    const projectId = trimField(body.project_id).toLowerCase();
    const quoteId = trimField(body.quote_id).toLowerCase();
    if (!validUuid(projectId) || !validUuid(quoteId)) {
      return json(400, {
        ok: false,
        error: "project_id and quote_id are required UUIDs",
        code: "invalid_ids",
      });
    }

    const { tenant, membership } = await requireOwnerOrAdmin(event);
    const result = await freezeContractPackage({
      tenantId: tenant.id,
      projectId,
      quoteId,
      createdBy: membership.id || null,
      expectedSetupUpdatedAt: body.expected_setup_updated_at
        ? trimField(body.expected_setup_updated_at)
        : null,
      expectedScheduleUpdatedAt: body.expected_schedule_updated_at
        ? trimField(body.expected_schedule_updated_at)
        : null,
    });

    if (!result.ok) {
      return json(result.status || 400, {
        ok: false,
        error: result.error,
        code: result.code,
        missing: result.missing || undefined,
        version: API_VERSION,
      });
    }

    return json(200, {
      ok: true,
      version: API_VERSION,
      idempotent: Boolean(result.idempotent),
      package: result.package,
    });
  } catch (err) {
    if (err?.isGuardError) {
      return json(err.statusCode || 403, {
        ok: false,
        error: err.message,
        code: err.code,
      });
    }
    console.error("contract-package-freeze", err);
    return json(500, {
      ok: false,
      error: "Server error",
      code: "server_error",
    });
  }
};

exports._test = {
  ALLOWED_BODY_KEYS,
  API_VERSION,
};
