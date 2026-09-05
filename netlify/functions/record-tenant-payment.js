/**
 * POST — record a tenant_project_payments ledger row for the signed-in tenant.
 *
 * Invoice-linked payments go through rpc/record_tenant_invoice_payment so the
 * ledger insert and invoice rollup commit together. Amounts are dollars.
 */
"use strict";

const { readSessionFromEvent } = require("./_lib/session");
const { supabaseRequest } = require("./_lib/supabase-admin");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");
const { parseInvoiceHubPaymentAmount } = require("./_lib/invoice-hub-payment-amount");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PAYMENT_TYPES = new Set(["deposit", "progress", "final", "adjustment"]);
const PAYMENT_METHODS = new Set(["check", "cash", "zelle", "stripe", "bank_transfer", "other"]);

const PAY_ERROR_STATUS = {
  invoice_not_found: 404,
  project_not_found: 404,
  quote_not_found: 404,
  quote_mismatch: 422,
  project_mismatch: 422,
  invoice_quote_tenant_mismatch: 422,
  invoice_project_tenant_mismatch: 422,
  payment_exceeds_remaining_balance: 422,
  invoice_archived: 422,
  invoice_cancelled: 422,
  invoice_void: 422,
  invoice_already_paid: 422,
  idempotency_key_conflict: 409,
  invalid_amount: 400,
  zero_amount: 400,
  negative_normal_payment: 400,
  invalid_payment_type: 400,
  invalid_payment_method: 400,
  missing_idempotency_key: 400,
  invalid_idempotency_key: 400,
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function payError(code, fallbackStatus, fallbackMessage) {
  const status = PAY_ERROR_STATUS[code] || fallbackStatus || 400;
  const message = fallbackMessage || String(code || "error").replace(/_/g, " ");
  return json(status, {
    ok: false,
    error: code || message,
    reason: code || "error",
    message,
  });
}

function parseBody(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

function str(v, max = 8000) {
  return String(v == null ? "" : v)
    .trim()
    .slice(0, max);
}

function optionalUuid(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  return UUID_RE.test(s) ? s : "";
}

function parseIdempotencyKey(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return { ok: false, error: "missing_idempotency_key" };
  if (s.length > 36 || !IDEMPOTENCY_UUID_RE.test(s)) {
    return { ok: false, error: "invalid_idempotency_key" };
  }
  return { ok: true, key: s.toLowerCase() };
}

function extractPayCode(err) {
  const msg = String(err && err.message ? err.message : err || "");
  const m = /MG_PAY:([a-z0-9_]+)/i.exec(msg);
  return m ? String(m[1]).toLowerCase() : "";
}

function createHandler(deps = {}) {
  const readSession = deps.readSessionFromEvent || readSessionFromEvent;
  const resolveTenant = deps.resolveTenantFromSession || resolveTenantFromSession;
  const requestFn = deps.supabaseRequest || supabaseRequest;

  return async function handler(event) {
    try {
      if (event.httpMethod !== "POST") {
        return json(405, { error: "Method Not Allowed" });
      }

      const session = readSession(event);
      if (!session?.e || !session?.c) {
        return json(401, { error: "Unauthorized" });
      }

      const tenant = await resolveTenant(session, deps);
      if (!tenant?.id) {
        return json(422, { error: "Tenant not found for this session." });
      }

      // Browser tenant_id is never authority. Session tenant wins.
      const tenantId = String(tenant.id);
      const tidEnc = encodeURIComponent(tenantId);
      const body = parseBody(event.body);

      const invoiceId = optionalUuid(body.invoice_id || body.invoiceId);
      const projectId = optionalUuid(body.project_id || body.projectId);
      const quoteId = optionalUuid(body.quote_id || body.quoteId);

      if (!invoiceId && !projectId && !quoteId) {
        return json(400, { error: "Provide at least one of invoice_id, project_id, or quote_id." });
      }

      const paymentType = str(body.payment_type || body.paymentType, 32).toLowerCase();
      const paymentMethod = str(body.payment_method || body.paymentMethod, 32).toLowerCase();
      if (!PAYMENT_TYPES.has(paymentType)) {
        return payError("invalid_payment_type", 400, "Invalid payment_type.");
      }
      if (!PAYMENT_METHODS.has(paymentMethod)) {
        return payError("invalid_payment_method", 400, "Invalid payment_method.");
      }

      const parsedAmount = parseInvoiceHubPaymentAmount(body.amount, paymentType);
      if (!parsedAmount.ok) {
        return payError(parsedAmount.error);
      }
      const amount = parsedAmount.amount;

      const idem = parseIdempotencyKey(body.idempotency_key || body.idempotencyKey);
      if (!idem.ok) {
        return payError(idem.error);
      }

      let paidAt = new Date().toISOString();
      const paidAtRaw = str(body.paid_at || body.paidAt, 64);
      if (paidAtRaw) {
        const t = Date.parse(paidAtRaw);
        if (!Number.isFinite(t)) {
          return json(400, { error: "Invalid paid_at (use ISO 8601)." });
        }
        paidAt = new Date(t).toISOString();
      }

      const notes = str(body.notes, 8000);
      const createdBy = str(session.e || session.u || "", 320) || null;

      if (invoiceId) {
        let rpcResult;
        try {
          rpcResult = await requestFn("rpc/record_tenant_invoice_payment", {
            method: "POST",
            body: {
              p_tenant_id: tenantId,
              p_invoice_id: invoiceId,
              p_payment_type: paymentType,
              p_payment_method: paymentMethod,
              p_amount: amount,
              p_paid_at: paidAt,
              p_notes: notes,
              p_created_by: createdBy,
              p_idempotency_key: idem.key,
              p_quote_id: quoteId || null,
              p_project_id: projectId || null,
            },
          });
        } catch (rpcErr) {
          const code = extractPayCode(rpcErr);
          if (code) return payError(code);
          throw rpcErr;
        }

        const result = Array.isArray(rpcResult) ? rpcResult[0] : rpcResult;
        if (!result || result.ok !== true) {
          const code = String(result?.error || result?.reason || "record_failed");
          return payError(code, 500, "Unable to record payment.");
        }

        return json(200, {
          ok: true,
          payment: result.payment || null,
          invoice: result.invoice || null,
          idempotent: Boolean(result.idempotent),
        });
      }

      if (projectId) {
        const tpRows = await requestFn(
          `tenant_projects?id=eq.${encodeURIComponent(projectId)}&tenant_id=eq.${tidEnc}&select=id`,
          { method: "GET" }
        );
        const tp = Array.isArray(tpRows) && tpRows[0] ? tpRows[0] : null;
        if (!tp?.id) {
          return payError("project_not_found", 404, "Project not found for this tenant.");
        }
      }

      if (quoteId) {
        const qRows = await requestFn(
          `quotes?id=eq.${encodeURIComponent(quoteId)}&tenant_id=eq.${tidEnc}&select=id`,
          { method: "GET" }
        );
        const q = Array.isArray(qRows) && qRows[0] ? qRows[0] : null;
        if (!q?.id) {
          return payError("quote_not_found", 404, "Quote not found for this tenant.");
        }
      }

      const insertPayload = {
        tenant_id: tenantId,
        quote_id: quoteId || null,
        invoice_id: null,
        project_id: projectId || null,
        payment_type: paymentType,
        payment_method: paymentMethod,
        amount,
        paid_at: paidAt,
        notes,
        created_by: createdBy,
        idempotency_key: idem.key,
      };

      let row;
      try {
        const created = await requestFn("tenant_project_payments", {
          method: "POST",
          headers: { Prefer: "return=representation" },
          body: insertPayload,
        });
        row = Array.isArray(created) ? created[0] : created;
      } catch (insertErr) {
        if (Number(insertErr?.status) === 409 || /23505|duplicate key/i.test(String(insertErr?.message || ""))) {
          const existing = await requestFn(
            `tenant_project_payments?tenant_id=eq.${tidEnc}&idempotency_key=eq.${encodeURIComponent(
              idem.key
            )}&select=*&limit=1`,
            { method: "GET" }
          );
          row = Array.isArray(existing) ? existing[0] : existing;
          if (!row?.id) throw insertErr;
          const sameSemantic =
            String(row.invoice_id || "") === "" &&
            String(row.quote_id || "") === String(quoteId || "") &&
            String(row.project_id || "") === String(projectId || "") &&
            String(row.payment_type || "") === paymentType &&
            String(row.payment_method || "") === paymentMethod &&
            Number(row.amount) === amount;
          if (!sameSemantic) return payError("idempotency_key_conflict");
          return json(200, { ok: true, payment: row, idempotent: true });
        }
        throw insertErr;
      }

      return json(200, {
        ok: true,
        payment: row || null,
        idempotent: false,
      });
    } catch (err) {
      console.error("[record-tenant-payment]", err);
      return json(500, { ok: false, error: err.message || "Server error" });
    }
  };
}

exports.handler = createHandler();
exports.createHandler = createHandler;
