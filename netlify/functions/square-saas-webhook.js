/**
 * Square SaaS webhook. Signature first. Never activates from payload fields alone.
 */
"use strict";

const { activateTenantFromVerifiedSquareInvoice } = require("./_lib/saas-square-activate");
const db = require("./_lib/saas-square-db");
const { getSquareInvoice, getSquarePayment, safeInvoiceId } = require("./_lib/square-saas-api");
const { logSquareSaas } = require("./_lib/square-saas-log");
const {
  configuredSquareEnvironment,
  envVal,
  isSandboxAllowed,
} = require("./_lib/square-saas-policy");
const {
  getSquareRawBody,
  readSquareEnvironmentHeader,
  readSquareSignatureHeader,
  verifySquareWebhookSignature,
} = require("./_lib/square-webhook-signature");

const ACTIVATE_TYPE = "invoice.payment_made";
const REFUND_TYPES = new Set(["invoice.refunded", "refund.created", "refund.updated"]);

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function sandboxEvent(squareEnvHeader, env) {
  const hdr = String(squareEnvHeader || "").trim().toLowerCase();
  if (hdr === "sandbox") return true;
  return configuredSquareEnvironment(env) === "sandbox";
}

function invoiceIdFromPayload(payload) {
  const data = payload && payload.data ? payload.data : {};
  const fromData = safeInvoiceId(data.id);
  if (fromData && String(data.type || "").toLowerCase() === "invoice") return fromData;
  if (fromData && String(payload.type || "") === ACTIVATE_TYPE) return fromData;
  const obj = data.object && typeof data.object === "object" ? data.object : {};
  const invoice = obj.invoice || obj;
  return safeInvoiceId(invoice && invoice.id);
}

function paymentIdHint(payload) {
  const data = payload && payload.data ? payload.data : {};
  const obj = data.object && typeof data.object === "object" ? data.object : {};
  const refund = obj.refund || obj;
  return (
    safeInvoiceId(refund.payment_id) ||
    safeInvoiceId(obj.payment && obj.payment.id) ||
    ""
  );
}

function createHandler(deps = {}) {
  const activate = deps.activateTenantFromVerifiedSquareInvoice || activateTenantFromVerifiedSquareInvoice;
  const getInvoice = deps.getSquareInvoice || getSquareInvoice;
  const getPayment = deps.getSquarePayment || getSquarePayment;
  const verify = deps.verifySquareWebhookSignature || verifySquareWebhookSignature;

  return async function handler(event) {
    const env = deps.env || process.env;
    try {
      if (String(event?.httpMethod || "").toUpperCase() !== "POST") {
        return json(405, { ok: false, error: "method_not_allowed" });
      }

      const rawBody = getSquareRawBody(event);
      if (rawBody == null) {
        return json(400, { ok: false, error: "invalid_body" });
      }
      const signatureHeader = readSquareSignatureHeader(event.headers || {});
      if (!signatureHeader) {
        return json(403, { ok: false, error: "invalid_signature" });
      }
      const okSig = verify({
        rawBody,
        signatureHeader,
        signatureKey: envVal("SQUARE_WEBHOOK_SIGNATURE_KEY", env),
        notificationUrl: envVal("SQUARE_WEBHOOK_NOTIFICATION_URL", env),
      });
      if (!okSig) {
        return json(403, { ok: false, error: "invalid_signature" });
      }

      const squareEnvHeader = readSquareEnvironmentHeader(event.headers || {});
      if (sandboxEvent(squareEnvHeader, env) && !isSandboxAllowed(env)) {
        return json(200, { ok: true, ignored: true, reason: "sandbox_ignored" });
      }
      if (
        configuredSquareEnvironment(env) === "production" &&
        String(squareEnvHeader).toLowerCase() === "sandbox"
      ) {
        return json(200, { ok: true, ignored: true, reason: "sandbox_ignored" });
      }

      let payload;
      try {
        payload = rawBody ? JSON.parse(rawBody) : {};
      } catch (_err) {
        return json(400, { ok: false, error: "invalid_json" });
      }

      const eventId = String(payload.event_id || "").trim();
      const eventType = String(payload.type || "").trim();
      if (!eventId || !eventType) {
        return json(400, { ok: false, error: "invalid_event" });
      }

      const claimed = await db.insertWebhookEvent(
        {
          event_id: eventId,
          event_type: eventType,
          square_environment: squareEnvHeader || configuredSquareEnvironment(env),
          processing_status: "received",
        },
        deps.supabaseRequest
      );
      const eventRow = claimed.row;
      if (
        claimed.duplicate &&
        eventRow &&
        ["activated", "ignored"].includes(String(eventRow.processing_status || ""))
      ) {
        return json(200, { ok: true, duplicate: true, reason: eventRow.processing_status });
      }

      const now = new Date().toISOString();
      await db.patchWebhookEvent(
        eventId,
        { processing_status: "verified", verified_at: now, updated_at: now },
        deps.supabaseRequest
      );

      if (REFUND_TYPES.has(eventType)) {
        const invoiceId = invoiceIdFromPayload(payload);
        const payId = paymentIdHint(payload);
        let onboarding = invoiceId
          ? await db.getOnboardingByInvoice(invoiceId, deps.supabaseRequest)
          : null;
        if (!onboarding && payId) {
          onboarding = await db.getOnboardingByPayment(payId, deps.supabaseRequest);
        }
        if (onboarding) {
          await db.patchOnboarding(
            onboarding.id,
            {
              status: "admin_review",
              last_error_code: "refund_or_dispute",
              updated_at: now,
            },
            deps.supabaseRequest
          );
        }
        await db.patchWebhookEvent(
          eventId,
          {
            processing_status: "ignored",
            processed_at: now,
            last_error_code: "refund_or_dispute",
            external_invoice_id: invoiceId || null,
            external_payment_id: payId || null,
            updated_at: now,
          },
          deps.supabaseRequest
        );
        logSquareSaas({
          event_type: eventType,
          event_id: eventId,
          processing_status: "ignored",
          onboarding_id: onboarding && onboarding.id,
          error_code: "refund_or_dispute",
        });
        return json(200, { ok: true, ignored: true, reason: "refund_or_dispute" });
      }

      if (eventType !== ACTIVATE_TYPE) {
        await db.patchWebhookEvent(
          eventId,
          {
            processing_status: "ignored",
            processed_at: now,
            last_error_code: "unknown_event_type",
            updated_at: now,
          },
          deps.supabaseRequest
        );
        return json(200, { ok: true, ignored: true, reason: "unknown_event_type" });
      }

      const invoiceId = invoiceIdFromPayload(payload);
      if (!invoiceId) {
        await db.patchWebhookEvent(
          eventId,
          {
            processing_status: "ignored",
            processed_at: now,
            last_error_code: "unregistered_invoice",
            updated_at: now,
          },
          deps.supabaseRequest
        );
        return json(200, { ok: true, ignored: true, reason: "unregistered_invoice" });
      }

      const onboarding = await db.getOnboardingByInvoice(invoiceId, deps.supabaseRequest);
      if (!onboarding) {
        await db.patchWebhookEvent(
          eventId,
          {
            processing_status: "ignored",
            processed_at: now,
            last_error_code: "unregistered_invoice",
            external_invoice_id: invoiceId,
            updated_at: now,
          },
          deps.supabaseRequest
        );
        logSquareSaas({
          event_type: eventType,
          event_id: eventId,
          processing_status: "ignored",
          error_code: "unregistered_invoice",
        });
        return json(200, { ok: true, ignored: true, reason: "unregistered_invoice" });
      }

      await db.patchWebhookEvent(
        eventId,
        {
          processing_status: "processing",
          external_invoice_id: invoiceId,
          updated_at: now,
        },
        deps.supabaseRequest
      );

      const result = await activate(
        { onboardingId: onboarding.id, paymentId: paymentIdHint(payload) },
        { ...deps, env, getSquareInvoice: getInvoice, getSquarePayment: getPayment }
      );

      const terminal = result.ok
        ? result.activated || result.idempotent
          ? "activated"
          : "ignored"
        : result.code === "activation_disabled" ||
            result.code === "invoice_unpaid" ||
            String(result.code || "").startsWith("invoice_")
          ? "ignored"
          : result.code === "square_unavailable"
            ? "failed"
            : "ignored";

      const retryable = result.code === "square_unavailable" || result.code === "cas_failed";
      if (retryable) {
        await db.patchWebhookEvent(
          eventId,
          {
            processing_status: "failed",
            last_error_code: result.code,
            updated_at: new Date().toISOString(),
          },
          deps.supabaseRequest
        );
        logSquareSaas({
          event_type: eventType,
          event_id: eventId,
          processing_status: "failed",
          onboarding_id: onboarding.id,
          error_code: result.code,
        });
        return json(500, { ok: false, error: "retryable_failure" });
      }

      await db.patchWebhookEvent(
        eventId,
        {
          processing_status: terminal,
          processed_at: new Date().toISOString(),
          last_error_code: result.ok ? null : result.code,
          updated_at: new Date().toISOString(),
        },
        deps.supabaseRequest
      );
      logSquareSaas({
        event_type: eventType,
        event_id: eventId,
        processing_status: terminal,
        onboarding_id: onboarding.id,
        error_code: result.code,
      });
      return json(200, {
        ok: true,
        activated: result.activated === true,
        reason: result.code,
        duplicate: claimed.duplicate === true,
      });
    } catch (_err) {
      logSquareSaas({ processing_status: "failed", error_code: "webhook_failed" });
      return json(500, { ok: false, error: "webhook_failed" });
    }
  };
}

exports.handler = createHandler();
exports.createHandler = createHandler;
exports.ACTIVATE_TYPE = ACTIVATE_TYPE;
