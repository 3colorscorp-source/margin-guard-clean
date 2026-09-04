/**
 * Platform-admin: bind a Square invoice id to a pending tenant.
 * Does not accept plan_status / amount / paid_at from the caller.
 */
"use strict";

const { assertPlatformAdminSession } = require("./_lib/mg-support/require-platform-admin");
const { readSessionFromEvent } = require("./_lib/session");
const { getSquareInvoice, safeInvoiceId } = require("./_lib/square-saas-api");
const { activateTenantFromVerifiedSquareInvoice } = require("./_lib/saas-square-activate");
const db = require("./_lib/saas-square-db");
const {
  ANNUAL_AMOUNT_CENTS,
  ANNUAL_CURRENCY,
  evaluateFullyPaidAnnualInvoice,
  invoiceStatus,
  isAcceptablePrepaymentInvoice,
  isAutoActivationEnabled,
  planStatusNorm,
} = require("./_lib/square-saas-policy");
const { logSquareSaas } = require("./_lib/square-saas-log");

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
  const getInvoice = deps.getSquareInvoice || getSquareInvoice;
  const activate = deps.activateTenantFromVerifiedSquareInvoice || activateTenantFromVerifiedSquareInvoice;

  return async function handler(event) {
    try {
      if (String(event?.httpMethod || "").toUpperCase() !== "POST") {
        return json(405, { ok: false, error: "method_not_allowed" });
      }

      const session = readSession(event);
      if (!session) {
        return json(401, { ok: false, error: "not_authorized" });
      }
      const gate = await assertAdmin(event, deps);
      if (!gate?.ok) {
        return json(403, { ok: false, error: "not_authorized" });
      }

      const body = parseBody(event);
      if (!body) return json(400, { ok: false, error: "invalid_json" });

      const tenantId = String(body.tenant_id || "").trim();
      const invoiceId = safeInvoiceId(body.square_invoice_id);
      if (!tenantId || !invoiceId) {
        return json(400, { ok: false, error: "invalid_request" });
      }
      if (body.terms_confirmed !== true) {
        return json(400, { ok: false, error: "terms_required" });
      }

      const tenant = await db.getTenantById(tenantId, deps.supabaseRequest);
      if (!tenant?.id) return json(404, { ok: false, error: "tenant_not_found" });
      if (planStatusNorm(tenant) !== "pending") {
        return json(409, { ok: false, error: "tenant_not_pending" });
      }

      const fetched = await getInvoice(invoiceId, deps);
      if (!fetched.ok) {
        return json(502, { ok: false, error: fetched.code || "invoice_get_failed" });
      }
      const invoice = fetched.invoice;
      if (String(invoice.id || "").trim() !== invoiceId) {
        return json(409, { ok: false, error: "invoice_id_mismatch" });
      }

      const status = invoiceStatus(invoice);
      const prepay = isAcceptablePrepaymentInvoice(invoice, deps.env || process.env);
      const paid = evaluateFullyPaidAnnualInvoice(invoice, deps.env || process.env);
      if (status === "PAID") {
        if (!paid.ok) return json(409, { ok: false, error: paid.code });
      } else if (!prepay.ok) {
        return json(409, { ok: false, error: prepay.code });
      }

      const existingInvoice = await db.getOnboardingByInvoice(invoiceId, deps.supabaseRequest);
      if (existingInvoice && String(existingInvoice.tenant_id) !== tenantId) {
        return json(409, { ok: false, error: "invoice_used_by_other_tenant" });
      }
      if (existingInvoice && String(existingInvoice.tenant_id) === tenantId) {
        if (status === "PAID") {
          const activated = await activate(
            { onboardingId: existingInvoice.id },
            { ...deps, getSquareInvoice: getInvoice }
          );
          logSquareSaas({
            processing_status: activated.ok ? "activated" : "ignored",
            onboarding_id: existingInvoice.id,
            error_code: activated.code,
          });
          return json(200, {
            ok: true,
            registered: true,
            activated: activated.activated === true,
            reason: activated.code,
            onboarding_id: existingInvoice.id,
            kill_switch: isAutoActivationEnabled(deps.env || process.env),
          });
        }
        return json(200, {
          ok: true,
          registered: true,
          activated: false,
          reason: "already_registered",
          onboarding_id: existingInvoice.id,
        });
      }

      const open = await db.listOpenOnboardingForTenant(tenantId, deps.supabaseRequest);
      const conflict = open.find((row) => String(row.external_invoice_id) !== invoiceId);
      if (conflict) {
        return json(409, { ok: false, error: "tenant_has_open_onboarding" });
      }

      const now = new Date().toISOString();
      const inserted = await db.insertOnboarding(
        {
          tenant_id: tenantId,
          provider: "square",
          external_invoice_id: invoiceId,
          expected_amount_cents: ANNUAL_AMOUNT_CENTS,
          currency: ANNUAL_CURRENCY,
          status: "registered",
          terms_accepted_at: now,
          registered_at: now,
          updated_at: now,
        },
        deps.supabaseRequest
      );
      if (!inserted.ok) {
        return json(409, { ok: false, error: inserted.code || "duplicate_onboarding" });
      }

      let activated = { ok: true, activated: false, code: "registered" };
      if (status === "PAID") {
        activated = await activate(
          { onboardingId: inserted.row.id },
          { ...deps, getSquareInvoice: getInvoice }
        );
      }

      logSquareSaas({
        processing_status: activated.activated ? "activated" : "registered",
        onboarding_id: inserted.row.id,
        error_code: activated.code,
      });

      return json(200, {
        ok: true,
        registered: true,
        activated: activated.activated === true,
        reason: activated.code,
        onboarding_id: inserted.row.id,
        kill_switch: isAutoActivationEnabled(deps.env || process.env),
      });
    } catch (_err) {
      logSquareSaas({ processing_status: "failed", error_code: "register_failed" });
      return json(500, { ok: false, error: "register_failed" });
    }
  };
}

exports.handler = createHandler();
exports.createHandler = createHandler;
