/**
 * Platform-admin: create a pending SaaS tenant + owner profile, then register Square invoice.
 * Browser cannot set plan_status, amount, currency, provider, or is_admin.
 */
"use strict";

const { assertPlatformAdminSession } = require("./_lib/mg-support/require-platform-admin");
const { readSessionFromEvent } = require("./_lib/session");
const { createPendingSaasCustomer } = require("./_lib/saas-admin-create");

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify(body),
  };
}

function parseBody(event) {
  if (!event || event.body == null || event.body === "") return {};
  const raw = typeof event.body === "string" ? event.body : JSON.stringify(event.body);
  try {
    return JSON.parse(raw);
  } catch (_err) {
    return null;
  }
}

function createHandler(deps = {}) {
  const assertAdmin = deps.assertPlatformAdminSession || assertPlatformAdminSession;
  const readSession = deps.readSessionFromEvent || readSessionFromEvent;
  const createCustomer = deps.createPendingSaasCustomer || createPendingSaasCustomer;

  return async function handler(event) {
    try {
      if (String(event?.httpMethod || "").toUpperCase() !== "POST") {
        return json(405, { ok: false, error: "method_not_allowed" });
      }
      const session = readSession(event);
      if (!session) return json(401, { ok: false, error: "not_authorized" });
      const gate = await assertAdmin(event, deps);
      if (!gate?.ok) return json(403, { ok: false, error: "not_authorized" });

      const body = parseBody(event);
      if (!body) return json(400, { ok: false, error: "invalid_json" });

      const result = await createCustomer(body, deps);
      return json(result.statusCode, result.body);
    } catch (_err) {
      return json(500, { ok: false, error: "create_failed" });
    }
  };
}

exports.handler = createHandler();
exports.createHandler = createHandler;
