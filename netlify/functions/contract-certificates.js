/**
 * CH-011H — List audit certificates for an envelope (Owner/Admin).
 * GET /.netlify/functions/contract-certificates?envelope_id=
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
  listCertificatesForEnvelope,
  trimField,
} = require("./_lib/contract-certificate");

const OWNER_ADMIN_ROLES = new Set(["owner", "admin"]);

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
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
    if (event.httpMethod === "OPTIONS") return json(204, {});
    if (event.httpMethod !== "GET") {
      return json(405, {
        ok: false,
        error: "Method not allowed",
        code: "method_not_allowed",
      });
    }

    const envelopeId = trimField(
      event?.queryStringParameters?.envelope_id
    ).toLowerCase();
    if (!validUuid(envelopeId)) {
      return json(400, {
        ok: false,
        error: "envelope_id is required",
        code: "invalid_envelope_id",
      });
    }

    const { tenant } = await requireOwnerOrAdmin(event);
    const certificates = await listCertificatesForEnvelope(
      tenant.id,
      envelopeId
    );

    return json(200, {
      ok: true,
      version: API_VERSION,
      certificates,
    });
  } catch (err) {
    if (err?.isGuardError) {
      return json(err.statusCode || 403, {
        ok: false,
        error: err.message,
        code: err.code,
      });
    }
    console.error("contract-certificates", err?.message || err);
    return json(500, {
      ok: false,
      error: "Server error",
      code: "server_error",
    });
  }
};

exports._test = { API_VERSION };
