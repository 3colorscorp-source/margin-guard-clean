/**
 * MG-SUPPORT-003B — confirmed support-case intake.
 * POST /.netlify/functions/mg-support-create-case
 *
 * Auth: signed owner session (e + c). Tenant from session only.
 * Writes only via case-intake closed helper. No OpenAI. No CORS changes.
 */
"use strict";

const { readSessionFromEvent } = require("./_lib/session");
const { assertOwnerSupportSession, hasOwnerEmailAndCustomer } = require("./_lib/mg-support/require-owner-session");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");
const { verifyEscalationToken, intakeSupportCase } = require("./_lib/mg-support/case-intake");

const MAX_BODY_CHARS = 4096;
const ALLOWED_KEYS = new Set(["confirmation_token", "confirmed"]);

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(body),
  };
}

function hasOverrideQuery(event) {
  const q = event?.queryStringParameters || {};
  const keys = Object.keys(q || {});
  return keys.some((k) => /tenant|company/i.test(String(k || "")));
}

function hasOverrideHeader(event) {
  const headers = event?.headers || {};
  return Object.keys(headers).some((k) => /^(x-)?(tenant|company)(-id)?$/i.test(String(k || "")));
}

function createHandler(deps = {}) {
  const readSession = deps.readSessionFromEvent || readSessionFromEvent;
  const assertSession = deps.assertOwnerSupportSession || assertOwnerSupportSession;
  const resolveTenant = deps.resolveTenantFromSession || resolveTenantFromSession;

  return async function handler(event) {
    try {
      const method = String(event?.httpMethod || "GET").toUpperCase();
      if (method !== "POST") {
        return json(405, { ok: false, result: "invalid_request", error: "Method not allowed." });
      }

      const rawBody = event?.body == null ? "" : String(event.body);
      if (rawBody.length > MAX_BODY_CHARS) {
        return json(400, { ok: false, result: "invalid_request", error: "Request is too large." });
      }

      let body = {};
      try {
        body = rawBody ? JSON.parse(rawBody) : {};
      } catch (_err) {
        return json(400, { ok: false, result: "invalid_request", error: "Send a JSON body." });
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return json(400, { ok: false, result: "invalid_request", error: "Send a JSON body." });
      }

      const keys = Object.keys(body);
      if (keys.some((k) => !ALLOWED_KEYS.has(k))) {
        return json(400, { ok: false, result: "invalid_request", error: "Unsupported request fields." });
      }
      if (hasOverrideQuery(event) || hasOverrideHeader(event)) {
        return json(400, { ok: false, result: "invalid_request", error: "Unsupported request fields." });
      }
      if (body.confirmed !== true) {
        return json(400, { ok: false, result: "invalid_request", error: "Confirmation is required." });
      }
      if (typeof body.confirmation_token !== "string" || !body.confirmation_token.trim()) {
        return json(400, { ok: false, result: "invalid_request", error: "Confirmation is required." });
      }

      const session = readSession(event);
      const sessionGate = await assertSession(session, deps);
      if (!sessionGate?.ok) {
        return json(401, { ok: false, result: "not_authorized", error: "Please sign in to use Ask Margin Guard." });
      }
      if (!hasOwnerEmailAndCustomer(session)) {
        return json(401, { ok: false, result: "not_authorized", error: "Account diagnostics require an active tenant context." });
      }

      let tenant = null;
      try {
        tenant = await resolveTenant(session);
      } catch (_err) {
        console.error("[mg-support-create-case] tenant resolve failed");
        return json(502, { ok: false, result: "write_failed", error: "I couldn't create that support case right now." });
      }
      if (!tenant?.id) {
        return json(403, { ok: false, result: "no_tenant_context", error: "Account diagnostics require an active tenant context." });
      }

      const verified = verifyEscalationToken(body.confirmation_token, String(tenant.id), deps);
      if (!verified.ok) {
        return json(400, {
          ok: false,
          result: "invalid_confirmation",
          error: "That support-case confirmation is not valid. Ask again, then create the case.",
        });
      }

      const creatorId = session?.u ? String(session.u).trim() : null;
      const intake = await intakeSupportCase({
        payload: verified.payload,
        creatorId,
        deps,
      });
      return json(intake.http, intake.body);
    } catch (_err) {
      console.error("[mg-support-create-case] unhandled");
      return json(500, { ok: false, result: "write_failed", error: "I couldn't create that support case right now." });
    }
  };
}

exports.handler = createHandler();
exports.createHandler = createHandler;
