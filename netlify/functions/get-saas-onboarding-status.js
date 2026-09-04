/**
 * Platform-admin read-only SaaS onboarding status.
 */
"use strict";

const { assertPlatformAdminSession } = require("./_lib/mg-support/require-platform-admin");
const { readSessionFromEvent } = require("./_lib/session");
const db = require("./_lib/saas-square-db");

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

      const qs = event.queryStringParameters || {};
      const tenantId = String(qs.tenant_id || "").trim();
      const invoiceId = String(qs.square_invoice_id || "").trim();
      if (!tenantId && !invoiceId) {
        return json(400, { ok: false, error: "invalid_request" });
      }

      let row = null;
      if (invoiceId) {
        row = await db.getOnboardingByInvoice(invoiceId, deps.supabaseRequest);
      } else {
        row = await db.getLatestOnboardingForTenant(tenantId, deps.supabaseRequest);
      }

      if (tenantId && row && String(row.tenant_id) !== tenantId) {
        return json(404, { ok: false, error: "not_found" });
      }
      if (!row) return json(200, { ok: true, registered: false });

      return json(200, {
        ok: true,
        registered: true,
        tenant_id: row.tenant_id,
        provider: row.provider,
        invoice_registered: Boolean(row.external_invoice_id),
        status: row.status,
        paid: Boolean(row.paid_at),
        activated: row.status === "activated",
        term_start_at: row.term_start_at || null,
        term_expires_at: row.term_expires_at || null,
        last_error_code: row.last_error_code || null,
      });
    } catch (_err) {
      return json(500, { ok: false, error: "status_failed" });
    }
  };
}

exports.handler = createHandler();
exports.createHandler = createHandler;
