/**
 * Platform-admin: list SaaS onboarding customers.
 */
"use strict";

const { assertPlatformAdminSession } = require("./_lib/mg-support/require-platform-admin");
const { readSessionFromEvent } = require("./_lib/session");
const { listSaasCustomers } = require("./_lib/saas-admin-customers");

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify(body),
  };
}

function createHandler(deps = {}) {
  const assertAdmin = deps.assertPlatformAdminSession || assertPlatformAdminSession;
  const readSession = deps.readSessionFromEvent || readSessionFromEvent;

  return async function handler(event) {
    try {
      if (String(event?.httpMethod || "GET").toUpperCase() !== "GET") {
        return json(405, { ok: false, error: "method_not_allowed" });
      }
      const session = readSession(event);
      if (!session) return json(401, { ok: false, error: "not_authorized" });
      const gate = await assertAdmin(event, deps);
      if (!gate?.ok) return json(403, { ok: false, error: "not_authorized" });

      const customers = await listSaasCustomers(deps);
      return json(200, { ok: true, customers });
    } catch (_err) {
      return json(500, { ok: false, error: "list_failed" });
    }
  };
}

exports.handler = createHandler();
exports.createHandler = createHandler;
