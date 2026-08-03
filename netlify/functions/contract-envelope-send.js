/**
 * CH-011E — Send Contract Envelope (Owner/Admin).
 * POST /.netlify/functions/contract-envelope-send
 * Provider-agnostic: prepares tokens + transitions draft → sent.
 * Does not send email. delivery_status = prepared.
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
  sendContractEnvelope,
  trimField,
} = require("./_lib/contract-envelope-send");

const OWNER_ADMIN_ROLES = new Set(["owner", "admin"]);
const ALLOWED_BODY_KEYS = new Set([
  "envelope_id",
  "expected_updated_at",
  "expires_at",
  "delivery_mode",
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
  return { tenant, membership };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") return json(204, {});
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

    const envelopeId = trimField(body.envelope_id).toLowerCase();
    if (!validUuid(envelopeId)) {
      return json(400, {
        ok: false,
        error: "envelope_id is required",
        code: "invalid_envelope_id",
      });
    }

    const expectedUpdatedAt = trimField(body.expected_updated_at);
    if (!expectedUpdatedAt) {
      return json(400, {
        ok: false,
        error: "expected_updated_at is required",
        code: "invalid_expected_updated_at",
      });
    }

    const { tenant, membership } = await requireOwnerOrAdmin(event);
    const result = await sendContractEnvelope({
      tenantId: tenant.id,
      envelopeId,
      expectedUpdatedAt,
      expiresAt:
        body.expires_at === undefined || body.expires_at === null
          ? null
          : body.expires_at,
      deliveryMode:
        body.delivery_mode === undefined || body.delivery_mode === null
          ? "prepared"
          : body.delivery_mode,
      sentBy: membership.id || null,
    });

    if (!result.ok) {
      return json(result.status || 400, {
        ok: false,
        error: result.error,
        code: result.code,
        blockers: result.blockers || undefined,
        current_updated_at: result.current_updated_at || undefined,
        signer_id: result.signer_id || undefined,
        version: API_VERSION,
      });
    }

    return json(200, {
      ok: true,
      version: API_VERSION,
      idempotent: !!result.idempotent,
      envelope: result.envelope,
      delivery: result.delivery,
    });
  } catch (err) {
    if (err?.isGuardError) {
      return json(err.statusCode || 403, {
        ok: false,
        error: err.message,
        code: err.code,
      });
    }
    console.error("contract-envelope-send", err);
    return json(500, {
      ok: false,
      error: "Server error",
      code: "server_error",
    });
  }
};

exports._test = { ALLOWED_BODY_KEYS, API_VERSION };
