/**
 * Platform-admin read-only Square SaaS invoice verification.
 * Never writes tenants, saas_onboarding, or plan_status.
 */
"use strict";

const { assertPlatformAdminSession } = require("./_lib/mg-support/require-platform-admin");
const { readSessionFromEvent } = require("./_lib/session");
const { getSquareInvoice } = require("./_lib/square-saas-api");
const db = require("./_lib/saas-square-db");
const {
  evaluateFullyPaidAnnualInvoice,
  isAutoActivationEnabled,
  planStatusNorm,
  summarizeSquareInvoice,
} = require("./_lib/square-saas-policy");
const { logSquareSaas } = require("./_lib/square-saas-log");

const DRY_RUN_ONBOARDING_STATUSES = new Set([
  "registered",
  "paid_verified",
  "failed",
  "admin_review",
]);

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

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || "").trim()
  );
}

function safeOnboardingView(row) {
  return {
    id: row.id,
    status: row.status,
    external_invoice_id: row.external_invoice_id,
    expected_amount_cents: row.expected_amount_cents,
    currency: String(row.currency || "").trim().toUpperCase() || null,
    paid_at: row.paid_at || null,
    activated_at: row.activated_at || null,
  };
}

function safeInvoiceView(summary) {
  if (!summary) return null;
  return {
    id: summary.id,
    status: summary.status,
    invoice_number: summary.invoice_number,
    title: summary.title,
    amount_cents: summary.amount_cents,
    completed_amount_cents: summary.completed_amount_cents,
    currency: summary.currency,
  };
}

function decide(opts) {
  if (!opts.invoiceFound) return "invoice_not_found";
  if (!opts.currencyMatches) return "currency_mismatch_admin_review";
  if (!opts.amountMatches) return "amount_mismatch_admin_review";
  if (!opts.tenantPending) return "tenant_not_pending";
  if (opts.wouldMarkPaidVerified) {
    return opts.autoActivationEnabled
      ? "would_activate_if_enabled"
      : "paid_but_activation_disabled";
  }
  return "registered_unpaid_no_action";
}

function createHandler(deps = {}) {
  const assertAdmin = deps.assertPlatformAdminSession || assertPlatformAdminSession;
  const readSession = deps.readSessionFromEvent || readSessionFromEvent;
  const getInvoice = deps.getSquareInvoice || getSquareInvoice;

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
      const onboardingId = String(body.onboarding_id || "").trim();
      if (!tenantId && !onboardingId) {
        return json(400, { ok: false, error: "invalid_request" });
      }
      if (tenantId && !isUuid(tenantId)) {
        return json(400, { ok: false, error: "invalid_request" });
      }
      if (onboardingId && !isUuid(onboardingId)) {
        return json(400, { ok: false, error: "invalid_request" });
      }

      const requestFn = deps.supabaseRequest;
      let row = null;
      if (onboardingId) {
        row = await db.getOnboardingById(onboardingId, requestFn);
      } else {
        row = await db.getLatestOnboardingForTenant(tenantId, requestFn);
      }

      if (!row) {
        return json(404, {
          ok: false,
          mode: "dry_run",
          decision: "onboarding_not_found",
          error: "onboarding_not_found",
        });
      }
      if (tenantId && String(row.tenant_id) !== tenantId) {
        return json(404, {
          ok: false,
          mode: "dry_run",
          decision: "onboarding_not_found",
          error: "onboarding_not_found",
        });
      }
      if (String(row.provider || "") !== "square") {
        return json(409, { ok: false, mode: "dry_run", error: "provider_not_square" });
      }
      if (!DRY_RUN_ONBOARDING_STATUSES.has(String(row.status || ""))) {
        return json(409, { ok: false, mode: "dry_run", error: "onboarding_status_not_dry_runnable" });
      }

      const tenant = await db.getTenantById(row.tenant_id, requestFn);
      if (!tenant?.id) {
        return json(404, {
          ok: false,
          mode: "dry_run",
          decision: "tenant_not_found",
          error: "tenant_not_found",
        });
      }

      const env = deps.env || process.env;
      const fetched = await getInvoice(row.external_invoice_id, { ...deps, env });
      if (!fetched.ok) {
        if (fetched.code === "square_not_found") {
          const autoActivationEnabled = isAutoActivationEnabled(env);
          const payload = {
            ok: true,
            mode: "dry_run",
            tenant: {
              id: tenant.id,
              slug: tenant.slug || null,
              plan_status: tenant.plan_status,
            },
            onboarding: safeOnboardingView(row),
            square_invoice: null,
            checks: {
              invoice_found: false,
              amount_matches: false,
              currency_matches: false,
              is_paid: false,
              would_mark_paid_verified: false,
              auto_activation_enabled: autoActivationEnabled,
              would_activate: false,
            },
            decision: "invoice_not_found",
          };
          logSquareSaas({
            event_type: "admin_dry_run",
            processing_status: "ignored",
            onboarding_id: row.id,
            error_code: "invoice_not_found",
          });
          return json(200, payload);
        }
        logSquareSaas({
          event_type: "admin_dry_run",
          processing_status: "failed",
          onboarding_id: row.id,
          error_code: fetched.code || "square_request_failed",
        });
        return json(502, {
          ok: false,
          mode: "dry_run",
          error: fetched.code || "square_request_failed",
        });
      }

      const invoice = fetched.invoice;
      const summary = summarizeSquareInvoice(invoice);
      const expectedCents = Number(row.expected_amount_cents);
      const expectedCurrency = String(row.currency || "")
        .trim()
        .toUpperCase();
      const invoiceIdMatches =
        String(invoice.id || "").trim() === String(row.external_invoice_id || "").trim();
      const structureOk =
        Boolean(summary) &&
        summary.payment_request_count === 1 &&
        summary.tipping_enabled !== true &&
        summary.amount_cents != null &&
        summary.currency != null;
      const amountMatches =
        invoiceIdMatches &&
        structureOk &&
        Number.isInteger(expectedCents) &&
        summary.amount_cents === expectedCents;
      const currencyMatches =
        invoiceIdMatches &&
        structureOk &&
        expectedCurrency &&
        summary.currency === expectedCurrency;
      const paidCheck = evaluateFullyPaidAnnualInvoice(invoice, env);
      const wouldMarkPaidVerified = paidCheck.ok === true && invoiceIdMatches;
      const tenantPending = planStatusNorm(tenant) === "pending";
      const autoActivationEnabled = isAutoActivationEnabled(env);
      const wouldActivate =
        wouldMarkPaidVerified && tenantPending && autoActivationEnabled;
      const decision = decide({
        invoiceFound: Boolean(invoiceIdMatches && summary),
        currencyMatches,
        amountMatches,
        tenantPending,
        wouldMarkPaidVerified,
        autoActivationEnabled,
      });

      logSquareSaas({
        event_type: "admin_dry_run",
        processing_status: "ignored",
        onboarding_id: row.id,
        error_code: decision,
      });

      return json(200, {
        ok: true,
        mode: "dry_run",
        tenant: {
          id: tenant.id,
          slug: tenant.slug || null,
          plan_status: tenant.plan_status,
        },
        onboarding: safeOnboardingView(row),
        square_invoice: safeInvoiceView(summary),
        checks: {
          invoice_found: invoiceIdMatches,
          amount_matches: amountMatches,
          currency_matches: currencyMatches,
          is_paid: String(summary && summary.status) === "PAID",
          would_mark_paid_verified: wouldMarkPaidVerified,
          auto_activation_enabled: autoActivationEnabled,
          would_activate: wouldActivate,
        },
        decision,
      });
    } catch (_err) {
      logSquareSaas({
        event_type: "admin_dry_run",
        processing_status: "failed",
        error_code: "dry_run_failed",
      });
      return json(500, { ok: false, mode: "dry_run", error: "dry_run_failed" });
    }
  };
}

exports.handler = createHandler();
exports.createHandler = createHandler;
exports.DRY_RUN_ONBOARDING_STATUSES = DRY_RUN_ONBOARDING_STATUSES;
