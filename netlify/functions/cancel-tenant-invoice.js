/**
 * POST — tenant-scoped soft cancel for a server invoice (archived + voided_at, no delete).
 */
const { readSessionFromEvent } = require("./_lib/session");
const { supabaseRequest } = require("./_lib/supabase-admin");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");
const { pickFirst } = require("./_lib/tenant-display");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}

function jsonError(statusCode, reason, message) {
  const msg = String(message || "").trim() || String(reason || "").replace(/_/g, " ");
  return json(statusCode, {
    ok: false,
    reason: String(reason || "error"),
    message: msg,
    error: msg
  });
}

function pickStr(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  return "";
}

function normStatus(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase();
}

function finiteMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function remainingBalance(inv) {
  const amt = finiteMoney(inv?.amount);
  const paid = finiteMoney(inv?.paid_amount);
  let bal = Number(inv?.balance_due);
  if (!Number.isFinite(bal)) bal = amt - paid;
  if (!Number.isFinite(bal)) return 0;
  return Math.round(bal * 100) / 100;
}

function hasStripePaymentTrace(inv) {
  return Boolean(
    pickStr(inv?.stripe_checkout_session_id) ||
      pickStr(inv?.stripe_payment_intent_id) ||
      pickStr(inv?.stripe_session_id)
  );
}

/**
 * POST — cancel one tenant invoice: status archived + voided_at (no delete, no ledger changes).
 * Body: { invoice_id }
 */
exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "Method Not Allowed" });
    }

    const session = readSessionFromEvent(event);
    if (!session?.e || !session?.c) {
      return json(401, { ok: false, error: "Unauthorized" });
    }

    const tenant = await resolveTenantFromSession(session);
    if (!tenant?.id) {
      return json(422, {
        ok: false,
        error: "Tenant not found for this session. Run bootstrap-tenant first."
      });
    }

    const tenantId = String(tenant.id);

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch (_err) {
      return json(400, { ok: false, error: "Invalid JSON body." });
    }

    const clientTenantId = pickFirst(body.tenant_id, body.tenantId);
    if (
      clientTenantId != null &&
      clientTenantId !== "" &&
      String(clientTenantId) !== tenantId
    ) {
      return json(403, { ok: false, error: "tenant_id does not match the signed-in account." });
    }

    const rawId = pickFirst(body.invoice_id, body.invoiceId, body.id);
    const invoiceId = rawId ? String(rawId).trim() : "";
    if (!invoiceId) {
      return jsonError(400, "invoice_id_required", "invoice_id is required.");
    }
    if (!UUID_RE.test(invoiceId)) {
      return jsonError(400, "invalid_invoice_id", "Invalid invoice_id (expected UUID).");
    }

    const iidEnc = encodeURIComponent(invoiceId);
    const tidEnc = encodeURIComponent(tenantId);
    const rows = await supabaseRequest(
      `invoices?id=eq.${iidEnc}&tenant_id=eq.${tidEnc}&select=*&limit=1`,
      { method: "GET" }
    );
    const invoice = Array.isArray(rows) && rows[0] ? rows[0] : null;
    if (!invoice?.id) {
      return jsonError(404, "invoice_not_found", "Invoice not found.");
    }

    const status = normStatus(invoice.status);
    if (status === "archived") {
      return jsonError(422, "invoice_archived", "Cannot cancel an archived invoice.");
    }
    if (status === "void") {
      return jsonError(422, "invoice_void", "Invoice is already void.");
    }
    if (status === "paid") {
      return jsonError(422, "invoice_paid", "Cannot cancel a paid invoice.");
    }

    const paidAmount = finiteMoney(invoice.paid_amount);
    if (paidAmount > 0) {
      return jsonError(422, "invoice_has_payments", "Cannot cancel an invoice with recorded payments.");
    }

    const balanceDue = remainingBalance(invoice);
    if (!(balanceDue > 0)) {
      return jsonError(422, "no_balance_due", "Cannot cancel when balance_due is zero or less.");
    }

    if (hasStripePaymentTrace(invoice)) {
      return jsonError(
        422,
        "invoice_stripe_payment",
        "Cannot cancel an invoice with Stripe payment activity."
      );
    }

    const ledgerRows = await supabaseRequest(
      `tenant_project_payments?tenant_id=eq.${tidEnc}&invoice_id=eq.${iidEnc}&select=id&limit=1`,
      { method: "GET" }
    );
    if (Array.isArray(ledgerRows) && ledgerRows.length > 0) {
      return jsonError(
        422,
        "invoice_has_ledger_payments",
        "Cannot cancel an invoice with ledger payments."
      );
    }

    const voidedAt = new Date().toISOString();
    const patchBody = {
      status: "archived",
      voided_at: voidedAt,
      updated_at: voidedAt
    };
    let patched;
    try {
      patched = await supabaseRequest(`invoices?id=eq.${iidEnc}&tenant_id=eq.${tidEnc}`, {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: patchBody
      });
    } catch (patchErr) {
      const msg = String(patchErr?.message || patchErr || "");
      if (/invoice_status_check|check constraint/i.test(msg)) {
        return jsonError(
          422,
          "invoice_status_constraint",
          "Could not cancel this invoice. Please refresh and try again."
        );
      }
      throw patchErr;
    }

    const out = Array.isArray(patched) ? patched[0] : patched;
    const storedVoidedAt = out?.voided_at || voidedAt;

    return json(200, {
      ok: true,
      invoice_id: invoiceId,
      status: "archived",
      voided_at: storedVoidedAt,
      message: "Invoice cancelled and archived."
    });
  } catch (err) {
    console.error("[cancel-tenant-invoice]", err);
    return json(500, { ok: false, error: err.message || "Server error" });
  }
};
