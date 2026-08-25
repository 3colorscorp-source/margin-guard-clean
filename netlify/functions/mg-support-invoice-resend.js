/**
 * MG-SUPPORT-003D.C1 — confirmed Support invoice resend.
 * POST /.netlify/functions/mg-support-invoice-resend
 *
 * Auth: signed owner session (e + c). Tenant from session only.
 * Closed body: { confirmation_token, confirmed: true }.
 * No OpenAI. No CORS. Does not call send-invoice-zapier.
 */
"use strict";

const { readSessionFromEvent } = require("./_lib/session");
const { assertOwnerSupportSession, hasOwnerEmailAndCustomer } = require("./_lib/mg-support/require-owner-session");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");
const { executeInvoiceResend } = require("./_lib/mg-support/invoice-resend-action");

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

function originFromEvent(event) {
  const host = String(event?.headers?.host || event?.headers?.["x-forwarded-host"] || "")
    .split(",")[0]
    .trim();
  if (!host) {
    const u = String(process.env.URL || process.env.DEPLOY_PRIME_URL || "").trim().replace(/\/+$/, "");
    return u;
  }
  const proto = String(event?.headers?.["x-forwarded-proto"] || "https")
    .split(",")[0]
    .trim()
    .replace(/:$/, "");
  return `${proto || "https"}://${host}`.replace(/\/+$/, "");
}

function createHandler(deps = {}) {
  const readSession = deps.readSessionFromEvent || readSessionFromEvent;
  const assertSession = deps.assertOwnerSupportSession || assertOwnerSupportSession;
  const resolveTenant = deps.resolveTenantFromSession || resolveTenantFromSession;
  const execute = deps.executeInvoiceResend || executeInvoiceResend;

  return async function handler(event) {
    try {
      const method = String(event?.httpMethod || "GET").toUpperCase();
      if (method !== "POST") {
        return json(405, {
          ok: false,
          action_status: "local_denied",
          message: "Method not allowed.",
          result_code: "method_not_allowed",
        });
      }

      const rawBody = event?.body == null ? "" : String(event.body);
      if (rawBody.length > MAX_BODY_CHARS) {
        return json(400, {
          ok: false,
          action_status: "local_denied",
          message: "Request is too large.",
          result_code: "invalid_request",
        });
      }

      let body = {};
      try {
        body = rawBody ? JSON.parse(rawBody) : {};
      } catch (_err) {
        return json(400, {
          ok: false,
          action_status: "local_denied",
          message: "Send a JSON body.",
          result_code: "invalid_request",
        });
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return json(400, {
          ok: false,
          action_status: "local_denied",
          message: "Send a JSON body.",
          result_code: "invalid_request",
        });
      }

      const keys = Object.keys(body);
      if (keys.some((k) => !ALLOWED_KEYS.has(k))) {
        return json(400, {
          ok: false,
          action_status: "local_denied",
          message: "Unsupported request fields.",
          result_code: "invalid_request",
        });
      }
      if (hasOverrideQuery(event) || hasOverrideHeader(event)) {
        return json(400, {
          ok: false,
          action_status: "local_denied",
          message: "Unsupported request fields.",
          result_code: "invalid_request",
        });
      }
      if (body.confirmed !== true) {
        return json(400, {
          ok: false,
          action_status: "local_denied",
          message: "Confirmation is required.",
          result_code: "invalid_request",
        });
      }
      if (typeof body.confirmation_token !== "string" || !body.confirmation_token.trim()) {
        return json(400, {
          ok: false,
          action_status: "local_denied",
          message: "Confirmation is required.",
          result_code: "invalid_request",
        });
      }

      const session = readSession(event);
      const sessionGate = await assertSession(session, deps);
      if (!sessionGate?.ok) {
        return json(401, {
          ok: false,
          action_status: "local_denied",
          message: "Please sign in to use Ask Margin Guard.",
          result_code: "unauthenticated",
        });
      }
      if (!hasOwnerEmailAndCustomer(session)) {
        return json(401, {
          ok: false,
          action_status: "local_denied",
          message: "Account diagnostics require an active tenant context.",
          result_code: "no_tenant",
        });
      }

      let tenant = null;
      try {
        tenant = await resolveTenant(session);
      } catch (_err) {
        return json(502, {
          ok: false,
          action_status: "local_denied",
          message: "Account diagnostics require an active tenant context.",
          result_code: "no_tenant",
        });
      }
      if (!tenant?.id) {
        return json(403, {
          ok: false,
          action_status: "local_denied",
          message: "Account diagnostics require an active tenant context.",
          result_code: "no_tenant",
        });
      }

      const out = await execute({
        session,
        tenantId: String(tenant.id),
        token: body.confirmation_token.trim(),
        origin: originFromEvent(event),
        deps,
      });
      return json(out.http, out.body);
    } catch (_err) {
      console.error("[mg-support-invoice-resend] unhandled");
      return json(500, {
        ok: false,
        action_status: "local_denied",
        message: "Invoice resend could not be completed.",
        result_code: "server_error",
      });
    }
  };
}

exports.handler = createHandler();
exports.createHandler = createHandler;
