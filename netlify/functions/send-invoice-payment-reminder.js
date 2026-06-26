/**
 * POST — tenant-scoped manual invoice payment reminder (owner-initiated).
 * Env: ZAPIER_INVOICE_REMINDER_WEBHOOK
 */
const fetch = globalThis.fetch;
if (!fetch) {
  throw new Error("Global fetch is not available. Set Netlify Node to 18+.");
}
const crypto = require("crypto");

const { readSessionFromEvent } = require("./_lib/session");
const { supabaseRequest } = require("./_lib/supabase-admin");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");
const { pickFirst } = require("./_lib/tenant-display");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const REMINDER_STAGE = "MANUAL";

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}

function jsonError(statusCode, reason, message, extra = {}) {
  const msg = String(message || "").trim() || String(reason || "").replace(/_/g, " ");
  return json(statusCode, {
    ok: false,
    reason: String(reason || "error"),
    message: msg,
    error: msg,
    ...extra
  });
}

function pickFirstStr(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  return "";
}

function isValidEmail(value) {
  const s = String(value || "").trim();
  return s.includes("@") && s.includes(".") && s.length >= 5 && s.length < 320;
}

function statusLower(inv) {
  return String(inv?.status || "")
    .trim()
    .toLowerCase();
}

function remainingBalance(inv) {
  const amt = Number(inv.amount || 0);
  const paid = Number(inv.paid_amount || 0);
  let bal = Number(inv.balance_due);
  if (!Number.isFinite(bal)) bal = amt - paid;
  if (!Number.isFinite(bal)) return 0;
  return Math.round(bal * 100) / 100;
}

function isArchived(inv) {
  return statusLower(inv) === "archived";
}

function isPaid(inv) {
  if (statusLower(inv) === "paid") return true;
  const bal = remainingBalance(inv);
  if (!(bal > 0)) return true;
  const amt = Number(inv.amount || 0);
  const paid = Number(inv.paid_amount || 0);
  if (amt > 0 && paid >= amt) return true;
  return false;
}

function originFromEvent(event) {
  const host = String(event?.headers?.host || event?.headers?.["x-forwarded-host"] || "")
    .split(",")[0]
    .trim();
  if (!host) {
    return String(process.env.URL || process.env.DEPLOY_PRIME_URL || "")
      .trim()
      .replace(/\/+$/, "");
  }
  const proto = String(event?.headers?.["x-forwarded-proto"] || "https")
    .split(",")[0]
    .trim()
    .replace(/:$/, "");
  return `${proto || "https"}://${host}`.replace(/\/+$/, "");
}

function buildZapierSignatureMeta(payload) {
  const secret = String(process.env.ZAPIER_WEBHOOK_SECRET || "").trim();
  if (!secret) {
    console.log("[zapier-signature] secret missing; sending unsigned");
    return null;
  }
  const timestamp = new Date().toISOString();
  const nonce = crypto.randomBytes(16).toString("hex");
  const canonical = `${timestamp}.${nonce}.${JSON.stringify(payload)}`;
  const signature = crypto.createHmac("sha256", secret).update(canonical).digest("hex");
  return { signature, timestamp, nonce, version: "v1" };
}

function buildPublicInvoiceUrl(publicToken, event) {
  const token = pickFirstStr(publicToken);
  if (!token) return "";
  const origin = originFromEvent(event);
  if (origin) {
    return `${origin}/invoice-public.html?token=${encodeURIComponent(token)}`;
  }
  const siteUrl = String(process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.SITE_URL || "")
    .trim()
    .replace(/\/+$/, "");
  return siteUrl
    ? `${siteUrl}/invoice-public.html?token=${encodeURIComponent(token)}`
    : `/invoice-public.html?token=${encodeURIComponent(token)}`;
}

function buildReminderPayload(inv, tenantName, event, manualTriggeredAt, idempotencyNonce) {
  const tenant_id = String(inv.tenant_id || "").trim();
  const invoice_id = String(inv.id || "").trim();
  const quote_id = String(inv.quote_id || "").trim();
  const project_id = String(inv.project_id || "").trim();
  const public_invoice_url = buildPublicInvoiceUrl(inv.public_token, event);
  const balanceDue = remainingBalance(inv);
  const idempotency_key = `${tenant_id}:${invoice_id}:${REMINDER_STAGE}:${manualTriggeredAt}:${idempotencyNonce}`;

  return {
    client_email: pickFirstStr(inv.customer_email),
    "Client Email": pickFirstStr(inv.customer_email),
    client_name: pickFirstStr(inv.customer_name, inv.project_name),
    customer_name: pickFirstStr(inv.customer_name, inv.project_name),
    customer_email: pickFirstStr(inv.customer_email),
    business_name: pickFirstStr(inv.business_name, tenantName),
    project_name: pickFirstStr(inv.project_name),
    invoice_label: pickFirstStr(inv.invoice_label),
    invoice_number: pickFirstStr(inv.invoice_no),
    invoice_no: pickFirstStr(inv.invoice_no),
    public_invoice_url,
    "Public Invoice Url": public_invoice_url,
    tenant_id,
    invoice_id,
    quote_id,
    project_id,
    event_type: "invoice_reminder",
    schema_version: "invoice_webhook_v1",
    idempotency_key,
    amount: Number(inv.amount || 0),
    paid_amount: Number(inv.paid_amount || 0),
    balance_due: balanceDue,
    remaining_balance: balanceDue,
    due_date: inv.due_date != null ? String(inv.due_date) : "",
    status: pickFirstStr(inv.status),
    is_paid: false,
    is_archived: false,
    reminder_stage: REMINDER_STAGE,
    manual_triggered_at: manualTriggeredAt
  };
}

async function loadInvoiceForTenant(tenantId, invoiceId) {
  const tidEnc = encodeURIComponent(tenantId);
  const iidEnc = encodeURIComponent(invoiceId);
  const rows = await supabaseRequest(
    `invoices?id=eq.${iidEnc}&tenant_id=eq.${tidEnc}&select=*&limit=1`,
    { method: "GET" }
  );
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return null;
  const invoice = list[0];
  if (String(invoice.tenant_id || "") !== tenantId) return null;
  return invoice;
}

/**
 * POST — send manual payment reminder for one tenant invoice.
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
      return jsonError(400, "invalid_json", "Invalid JSON body.");
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

    let invoice;
    try {
      invoice = await loadInvoiceForTenant(tenantId, invoiceId);
    } catch (loadErr) {
      console.error("[send-invoice-payment-reminder] load failed", loadErr?.message || loadErr);
      return jsonError(500, "load_failed", "Failed to load invoice.");
    }

    if (!invoice) {
      return jsonError(404, "invoice_not_found", "Invoice not found.");
    }

    if (isArchived(invoice)) {
      return jsonError(422, "invoice_archived", "Cannot send reminder for an archived invoice.");
    }

    if (isPaid(invoice)) {
      return jsonError(422, "invoice_paid", "Cannot send reminder for a paid invoice.");
    }

    const balanceDue = remainingBalance(invoice);
    if (!(balanceDue > 0)) {
      return jsonError(422, "no_balance_due", "Cannot send reminder when balance_due is zero or less.");
    }

    const customerEmail = pickFirstStr(invoice.customer_email);
    if (!isValidEmail(customerEmail)) {
      return jsonError(422, "missing_customer_email", "Invoice is missing a valid customer_email.");
    }

    const publicToken = pickFirstStr(invoice.public_token);
    if (!publicToken) {
      return jsonError(422, "missing_public_token", "Invoice is missing public_token.");
    }

    const webhookUrl = String(process.env.ZAPIER_INVOICE_REMINDER_WEBHOOK || "").trim();
    if (!webhookUrl) {
      return jsonError(
        503,
        "reminder_webhook_not_configured",
        "ZAPIER_INVOICE_REMINDER_WEBHOOK is not configured."
      );
    }

    let tenantName = "";
    try {
      const trows = await supabaseRequest(
        `tenants?id=eq.${encodeURIComponent(tenantId)}&select=name&limit=1`,
        { method: "GET" }
      );
      const tr = Array.isArray(trows) && trows[0];
      tenantName = tr ? String(tr.name || "").trim() : "";
    } catch (_e) {
      tenantName = "";
    }

    const manualTriggeredAt = new Date().toISOString();
    const idempotencyNonce = crypto.randomBytes(8).toString("hex");
    const payload = buildReminderPayload(
      invoice,
      tenantName,
      event,
      manualTriggeredAt,
      idempotencyNonce
    );
    const signatureMeta = buildZapierSignatureMeta(payload);
    if (signatureMeta) {
      payload.zapier_signature = signatureMeta.signature;
      payload.zapier_timestamp = signatureMeta.timestamp;
      payload.zapier_nonce = signatureMeta.nonce;
      payload.zapier_signature_version = signatureMeta.version;
    }

    console.log("[send-invoice-payment-reminder]", {
      tenant_id: tenantId,
      invoice_id: invoiceId,
      reminder_stage: REMINDER_STAGE,
      idempotency_key: payload.idempotency_key
    });

    const headers = { "Content-Type": "application/json", Accept: "application/json" };
    if (signatureMeta) {
      headers["X-MG-Signature"] = signatureMeta.signature;
      headers["X-MG-Timestamp"] = signatureMeta.timestamp;
      headers["X-MG-Nonce"] = signatureMeta.nonce;
      headers["X-MG-Signature-Version"] = signatureMeta.version;
    }

    let zapRes;
    try {
      zapRes = await fetch(webhookUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(payload)
      });
    } catch (zapErr) {
      console.warn("[send-invoice-payment-reminder] Zapier request failed", zapErr?.message || zapErr);
      return jsonError(502, "webhook_unreachable", "Unable to reach invoice reminder webhook.");
    }

    if (!zapRes.ok) {
      const zapierText = await zapRes.text().catch(() => "");
      console.warn("[send-invoice-payment-reminder] Zapier non-OK", zapRes.status, zapierText.slice(0, 500));
      return jsonError(502, "zapier_error", "Zapier reminder webhook returned an error.", {
        status: zapRes.status,
        details: zapierText.slice(0, 500)
      });
    }

    const lastReminderAt = new Date().toISOString();
    const iidEnc = encodeURIComponent(invoiceId);
    const tidEnc = encodeURIComponent(tenantId);
    let patched;
    try {
      patched = await supabaseRequest(
        `invoices?id=eq.${iidEnc}&tenant_id=eq.${tidEnc}&select=id,last_reminder_at`,
        {
          method: "PATCH",
          headers: { Prefer: "return=representation" },
          body: { last_reminder_at: lastReminderAt, updated_at: lastReminderAt }
        }
      );
    } catch (patchErr) {
      console.error("[send-invoice-payment-reminder] patch failed", patchErr?.message || patchErr);
      return jsonError(
        500,
        "patch_failed",
        "Reminder was sent but failed to update last_reminder_at."
      );
    }

    const rows = Array.isArray(patched) ? patched : patched ? [patched] : [];
    const row = rows[0];
    const storedLastReminderAt = row?.last_reminder_at || lastReminderAt;

    return json(200, {
      ok: true,
      invoice_id: invoiceId,
      last_reminder_at: storedLastReminderAt,
      reminder_stage: REMINDER_STAGE
    });
  } catch (err) {
    console.error("[send-invoice-payment-reminder] unhandled failure", err);
    return json(500, { ok: false, error: err.message || "Server error" });
  }
};
