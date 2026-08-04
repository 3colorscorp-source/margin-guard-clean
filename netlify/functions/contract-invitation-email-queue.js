/**
 * CH-013A.2.1 — Queue contract invitation email (Owner/Admin).
 * POST /.netlify/functions/contract-invitation-email-queue
 * GET  /.netlify/functions/contract-invitation-email-queue?envelope_id=&signer_id=
 *   → email_delivery capability (no secrets)
 * GET  /.netlify/functions/contract-invitation-email-queue?attempt_id= | envelope_id=&signer_id=
 *   → delivery attempt status (queued|sending|sent|failed) — never "Email sent" from queue alone
 * POST body { envelope_id, signer_id } → queue
 * POST body { recover: true, attempt_id } → manual re-dispatch (same attempt; no Gen bump)
 *
 * Never returns raw token or signing URL.
 * Provider send does not run in this request — background dispatch only.
 * Background body is IDs only (Design B encrypted handoff).
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
  emailCapability,
  queueInvitationEmail,
  invokeBackgroundDispatch,
  getEmailDeliveryStatus,
  recoverEmailDispatch,
  normalizeEmail,
} = require("./_lib/contract-invitation-email");
const { trimField, validUuid } = require("./_lib/platform-events");

const OWNER_ADMIN_ROLES = new Set(["owner", "admin"]);
const ALLOWED_BODY_KEYS = new Set(["envelope_id", "signer_id", "attempt_id", "recover"]);

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
  return { tenant, membership, session };
}

async function loadSignerEmail(tenantId, signerId) {
  const rows = await supabaseRequest(
    `tenant_contract_signers?tenant_id=eq.${encodeURIComponent(tenantId)}&id=eq.${encodeURIComponent(signerId)}&select=id,email&limit=1`,
    { method: "GET" }
  );
  const row = Array.isArray(rows) ? rows[0] : rows;
  return row?.email || "";
}

function publicOriginFromEvent(event) {
  const headers = event.headers || {};
  const proto =
    trimField(headers["x-forwarded-proto"] || headers["X-Forwarded-Proto"]) || "https";
  const host = trimField(headers.host || headers.Host);
  if (host) return `${proto}://${host}`;
  return (
    trimField(process.env.PUBLIC_SITE_URL) ||
    trimField(process.env.URL) ||
    trimField(process.env.SITE_URL) ||
    ""
  );
}

exports.handler = async (event) => {
  try {
    const method = String(event.httpMethod || "GET").toUpperCase();
    const { tenant, membership } = await requireOwnerOrAdmin(event);

    if (method === "GET") {
      const qs = event.queryStringParameters || {};
      const envelopeId = trimField(singleQueryValue(qs.envelope_id)).toLowerCase();
      const signerId = trimField(singleQueryValue(qs.signer_id)).toLowerCase();
      const attemptId = trimField(singleQueryValue(qs.attempt_id)).toLowerCase();
      const wantStatus =
        trimField(singleQueryValue(qs.status)).toLowerCase() === "1" ||
        trimField(singleQueryValue(qs.status)).toLowerCase() === "true" ||
        Boolean(validUuid(attemptId));

      if (wantStatus) {
        const status = await getEmailDeliveryStatus({
          tenantId: tenant.id,
          attemptId: validUuid(attemptId) ? attemptId : "",
          envelopeId: validUuid(envelopeId) ? envelopeId : "",
          signerId: validUuid(signerId) ? signerId : "",
        });
        return json(200, {
          ok: true,
          version: API_VERSION,
          ...status,
        });
      }

      let recipient = "";
      if (validUuid(signerId)) {
        recipient = await loadSignerEmail(tenant.id, signerId);
      }
      const cap = emailCapability(recipient);
      return json(200, {
        ok: true,
        version: API_VERSION,
        email_delivery: cap,
        envelope_id: validUuid(envelopeId) ? envelopeId : null,
        signer_id: validUuid(signerId) ? signerId : null,
        recipient_masked: recipient
          ? require("./_lib/contract-invitation").maskEmail(normalizeEmail(recipient))
          : null,
      });
    }

    if (method !== "POST") {
      return json(405, { ok: false, error: "Method Not Allowed" });
    }

    const body = parseBody(event.body);
    if (!body) {
      return json(400, { ok: false, error: "Invalid JSON body", code: "invalid_json" });
    }
    if (Object.prototype.hasOwnProperty.call(body, "tenant_id")) {
      return json(400, {
        ok: false,
        error: "tenant_id is not accepted from the client",
        code: "tenant_id_forbidden",
      });
    }
    const unknown = Object.keys(body).filter((k) => !ALLOWED_BODY_KEYS.has(k));
    if (unknown.length) {
      return json(400, {
        ok: false,
        error: `Unknown fields: ${unknown.join(", ")}`,
        code: "unknown_fields",
      });
    }

    for (const k of Object.keys(body)) {
      if (/token|signing_url|secret|recipient/i.test(k) && k !== "attempt_id") {
        return json(400, {
          ok: false,
          error: "Raw tokens, signing URLs, and recipient overrides are not accepted",
          code: "forbidden_field",
        });
      }
    }

    const origin = publicOriginFromEvent(event);

    if (body.recover === true || body.recover === "true" || body.recover === 1) {
      const attemptId = trimField(body.attempt_id).toLowerCase();
      if (!validUuid(attemptId)) {
        return json(400, {
          ok: false,
          error: "attempt_id is required for recover",
          code: "invalid_id",
        });
      }
      const recovered = await recoverEmailDispatch({
        tenantId: tenant.id,
        attemptId,
        publicOrigin: origin,
      });
      if (!recovered.ok) {
        return json(recovered.status || 422, {
          ok: false,
          error: recovered.error,
          code: recovered.code,
          ui_status: recovered.ui_status || undefined,
          version: API_VERSION,
        });
      }
      if (recovered._dispatch) {
        try {
          await invokeBackgroundDispatch(recovered._dispatch, { site_origin: origin });
        } catch (_e) {
          /* attempt remains recoverable */
        }
      }
      return json(200, {
        ok: true,
        version: API_VERSION,
        recovered: Boolean(recovered.recovered),
        idempotent: Boolean(recovered.idempotent),
        queued: recovered.ui_status === "queued",
        ui_status: recovered.ui_status,
        attempt_id: recovered.attempt_id,
        invitation_id: recovered.invitation_id || null,
        provider_message_id: recovered.provider_message_id || null,
      });
    }

    const envelopeId = trimField(body.envelope_id).toLowerCase();
    const signerId = trimField(body.signer_id).toLowerCase();
    if (!validUuid(envelopeId) || !validUuid(signerId)) {
      return json(400, {
        ok: false,
        error: "envelope_id and signer_id are required UUIDs",
        code: "invalid_id",
      });
    }

    const queued = await queueInvitationEmail({
      tenantId: tenant.id,
      envelopeId,
      signerId,
      publicOrigin: origin,
      membershipId: membership.id,
    });

    if (!queued.ok) {
      return json(queued.status || 422, {
        ok: false,
        error: queued.error,
        code: queued.code,
        email_delivery: queued.email_delivery || undefined,
        version: API_VERSION,
      });
    }

    // Invoke background with IDs only — never return secrets to client.
    if (queued._dispatch && !queued.idempotent) {
      try {
        await invokeBackgroundDispatch(queued._dispatch, { site_origin: origin });
      } catch (_e) {
        // Attempt remains queued / recoverable; Owner can recover or re-queue (idempotent).
      }
    } else if (queued._dispatch && queued.idempotent && queued.ui_status !== "sent") {
      // Re-kick dispatch for stuck queued/sending without Gen bump.
      try {
        await invokeBackgroundDispatch(queued._dispatch, { site_origin: origin });
      } catch (_e) {
        /* ignore */
      }
    }

    return json(200, {
      ok: true,
      version: API_VERSION,
      queued: true,
      ui_status: queued.ui_status || "queued",
      idempotent: Boolean(queued.idempotent),
      attempt_id: queued.attempt_id,
      invitation_id: queued.invitation_id,
      generation_number: queued.generation_number,
      generation_rotated: Boolean(queued.generation_rotated),
      recipient_masked: queued.recipient_masked,
      email_delivery: queued.email_delivery,
    });
  } catch (err) {
    if (err && err.statusCode) {
      return json(err.statusCode, {
        ok: false,
        error: err.message || "Forbidden",
        code: err.code || "forbidden",
      });
    }
    console.error("contract-invitation-email-queue", err?.message || err);
    return json(500, { ok: false, error: "Server error", code: "server_error" });
  }
};
