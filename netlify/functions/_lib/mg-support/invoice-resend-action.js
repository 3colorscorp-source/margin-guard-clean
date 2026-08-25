/**
 * MG-SUPPORT-003D.C1 — Support invoice resend execution.
 * Ledger claim before any Zapier POST. No OpenAI. No Hub send-invoice-zapier call.
 */
"use strict";

const crypto = require("crypto");
const { supabaseRequest } = require("../supabase-admin");
const { mintEscalationToken, ENTITY_REF_MAX } = require("./case-intake");
const {
  ACTION_TYPE,
  isUuid,
  mintInvoiceResendToken,
  verifyInvoiceResendToken,
  stateFingerprintMatches,
} = require("./action-token");
const {
  reloadInvoiceForResend,
  denialMessage,
} = require("./invoice-resend-eligibility");
const {
  buildSupportCanonicalInvoiceEmail,
  validateCanonicalInvoiceEmail,
  applyCanonicalToZapierPayload,
  pickFirstStr,
} = require("./invoice-resend-canonical");

const ACTIONS_TABLE = "tenant_support_actions";
const ZAPIER_TIMEOUT_MS = 20000;
const SUCCESS_MESSAGE = "Invoice resend was submitted to the email delivery bridge.";
const UNKNOWN_MESSAGE =
  "Margin Guard could not confirm whether the resend submission was accepted. It was not automatically retried to avoid sending a duplicate.";
const CASE_UNKNOWN_EXCERPT = "Invoice resend submission status could not be confirmed.";
const CASE_CONFIG_EXCERPT = "Invoice resend is missing required delivery configuration.";

function clipEntityRef(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  return text.length <= ENTITY_REF_MAX ? text : text.slice(0, ENTITY_REF_MAX);
}

function isUniqueViolation(err) {
  const status = Number(err?.status);
  const msg = String(err?.message || "");
  const raw = String(err?.supabaseRaw || "");
  return status === 409 || /duplicate key|unique constraint|23505/i.test(msg + "\n" + raw);
}

function isLikelyStatusCheck(err) {
  const status = Number(err?.status);
  const msg = String(err?.message || err || "");
  return status === 400 || /check constraint|invoices_status_check|violates check/i.test(msg);
}

function isConfirmedHttp2xx(res) {
  const status = Number(res?.status);
  return Number.isInteger(status) && status >= 200 && status < 300;
}

function isAbortError(err) {
  return Boolean(err && (err.name === "AbortError" || /aborted|timeout/i.test(String(err.message || err))));
}

function getZapierConfig(deps = {}) {
  const url =
    typeof deps.getZapierInvoiceWebhookUrl === "function"
      ? String(deps.getZapierInvoiceWebhookUrl() || "").trim()
      : String(process.env.ZAPIER_INVOICE_SEND_WEBHOOK_URL || "").trim();
  const secret =
    typeof deps.getZapierWebhookSecret === "function"
      ? String(deps.getZapierWebhookSecret() || "").trim()
      : String(process.env.ZAPIER_WEBHOOK_SECRET || "").trim();
  return { url, secret };
}

function buildZapierSignatureMeta(payload, secret) {
  const timestamp = new Date().toISOString();
  const nonce = crypto.randomBytes(16).toString("hex");
  const canonical = `${timestamp}.${nonce}.${JSON.stringify(payload)}`;
  const signature = crypto.createHmac("sha256", secret).update(canonical).digest("hex");
  return { signature, timestamp, nonce, version: "v1" };
}

async function defaultRequest(path, opts) {
  return supabaseRequest(path, opts);
}

function requestFn(deps) {
  return typeof deps.supabaseRequest === "function" ? deps.supabaseRequest : defaultRequest;
}

async function loadTenantName(tenantId, deps) {
  try {
    const rows = await requestFn(deps)(
      `tenants?id=eq.${encodeURIComponent(tenantId)}&select=id,name&limit=1`,
      { method: "GET" }
    );
    const row = Array.isArray(rows) ? rows[0] : null;
    return pickFirstStr(row?.name);
  } catch (_err) {
    return "";
  }
}

function mintCaseEscalation({ tenantId, invoiceNo, excerpt, deps }) {
  const minted = mintEscalationToken(
    {
      tenant_id: tenantId,
      category: "diagnostic_unavailable",
      support_module: "invoice_hub",
      related_entity_type: "invoice",
      related_entity_ref: clipEntityRef(invoiceNo) || "invoice",
      question_excerpt: excerpt,
    },
    deps
  );
  if (!minted?.token) return null;
  return {
    eligible: true,
    label: "Create support case",
    confirmation_token: minted.token,
    expires_at: minted.expires_at,
  };
}

function result(http, actionStatus, message, extra = {}) {
  const body = {
    ok: actionStatus === "bridge_accepted",
    action_status: actionStatus,
    message,
  };
  if (extra.result_code) body.result_code = extra.result_code;
  if (extra.escalation) body.escalation = extra.escalation;
  return { http, body, ...extra.meta };
}

async function markLedgerUnknown(actionRow, tenantId, resultCode, deps) {
  if (!actionRow?.id) return false;
  try {
    await requestFn(deps)(
      `${ACTIONS_TABLE}?id=eq.${encodeURIComponent(actionRow.id)}&tenant_id=eq.${encodeURIComponent(tenantId)}&status=eq.claimed`,
      {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: {
          status: "submission_unknown",
          completed_at: new Date().toISOString(),
          result_code: resultCode || "submission_unknown",
        },
      }
    );
    return true;
  } catch (_err) {
    return false;
  }
}

async function persistInvoiceSent(invoice, tenantId, sentAt, deps) {
  const filter = `id=eq.${encodeURIComponent(String(invoice.id))}&tenant_id=eq.${encodeURIComponent(tenantId)}`;
  const patchPath = `invoices?${filter}`;
  const req = requestFn(deps);
  try {
    const updated = await req(patchPath, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: { sent_at: sentAt, updated_at: sentAt, status: "issued" },
    });
    const rows = Array.isArray(updated) ? updated : updated ? [updated] : [];
    if (rows[0]?.id) return { ok: true, fallback: false };
  } catch (patchErr) {
    if (!isLikelyStatusCheck(patchErr)) {
      return { ok: false, fallback: false };
    }
    try {
      const updated = await req(patchPath, {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: { sent_at: sentAt, updated_at: sentAt },
      });
      const rows = Array.isArray(updated) ? updated : updated ? [updated] : [];
      if (rows[0]?.id) return { ok: true, fallback: true };
      return { ok: false, fallback: true };
    } catch (_err) {
      return { ok: false, fallback: true };
    }
  }
  try {
    const updated = await req(patchPath, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: { sent_at: sentAt, updated_at: sentAt },
    });
    const rows = Array.isArray(updated) ? updated : updated ? [updated] : [];
    if (rows[0]?.id) return { ok: true, fallback: true };
  } catch (_err) {
    return { ok: false, fallback: true };
  }
  return { ok: false, fallback: false };
}

async function postSignedZapier({ url, secret, payload, deps, timeoutMs }) {
  const fetchImpl = typeof deps.fetchImpl === "function" ? deps.fetchImpl : globalThis.fetch;
  const signatureMeta = buildZapierSignatureMeta(payload, secret);
  payload.zapier_signature = signatureMeta.signature;
  payload.zapier_timestamp = signatureMeta.timestamp;
  payload.zapier_nonce = signatureMeta.nonce;
  payload.zapier_signature_version = signatureMeta.version;
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-MG-Signature": signatureMeta.signature,
    "X-MG-Timestamp": signatureMeta.timestamp,
    "X-MG-Nonce": signatureMeta.nonce,
    "X-MG-Signature-Version": signatureMeta.version,
  };
  const controller = new AbortController();
  const ms = Number(timeoutMs) > 0 ? Number(timeoutMs) : ZAPIER_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return { res, aborted: false };
  } catch (err) {
    return { res: null, aborted: isAbortError(err), err };
  } finally {
    clearTimeout(timer);
  }
}

function unknownWithCase(tenantId, invoiceNo, deps, resultCode, meta) {
  const escalation = mintCaseEscalation({
    tenantId,
    invoiceNo,
    excerpt: resultCode === "local_config_error" ? CASE_CONFIG_EXCERPT : CASE_UNKNOWN_EXCERPT,
    deps,
  });
  const status = resultCode === "local_config_error" ? "local_denied" : "submission_unknown";
  const message =
    resultCode === "local_config_error"
      ? "Invoice resend is not configured. Create a support case if you need help."
      : UNKNOWN_MESSAGE;
  return result(resultCode === "local_config_error" ? 503 : 200, status, message, {
    result_code: resultCode,
    escalation,
    meta,
  });
}

/**
 * Execute a confirmed invoice resend. Network is attempted at most once.
 */
async function executeInvoiceResend({ session, tenantId, token, origin, deps = {} }) {
  const meta = { fetchCount: 0, claimed: false, networkAttempted: false };
  const verified = verifyInvoiceResendToken(token, tenantId, session, deps);
  if (!verified.ok) {
    const actionStatus = verified.reason === "expired" ? "expired" : "local_denied";
    return result(400, actionStatus, denialMessage(verified.reason), {
      result_code: verified.reason === "expired" ? "expired" : "invalid_token",
      meta,
    });
  }

  const loaded = await reloadInvoiceForResend(tenantId, verified.payload.invoice_id, deps);
  if (loaded.outcome === "status_unverified") {
    return result(422, "local_denied", denialMessage("ineligible_status"), {
      result_code: "status_unverified",
      meta,
    });
  }
  if (!loaded.invoice) {
    return result(422, "local_denied", denialMessage(loaded.outcome || "not_found"), {
      result_code: loaded.outcome || "not_found",
      meta,
    });
  }
  if (!stateFingerprintMatches(verified.payload, loaded.invoice, tenantId, deps)) {
    return result(409, "local_denied", denialMessage("invoice_state_changed"), {
      result_code: "invoice_state_changed",
      meta,
    });
  }
  if (!loaded.eligibility?.ok) {
    return result(422, "local_denied", denialMessage(loaded.eligibility.reason), {
      result_code: loaded.eligibility.reason,
      meta,
    });
  }

  const publicToken = String(loaded.invoice.public_token || "").trim();
  const publicUrl = origin
    ? `${String(origin).replace(/\/+$/, "")}/invoice-public.html?token=${encodeURIComponent(publicToken)}`
    : `/invoice-public.html?token=${encodeURIComponent(publicToken)}`;
  const tenantName = await loadTenantName(tenantId, deps);
  const built = await buildSupportCanonicalInvoiceEmail({
    invoice: loaded.invoice,
    publicUrl,
    businessName: tenantName,
    deps,
  });
  const validation = validateCanonicalInvoiceEmail(built.canonical);
  if (!validation.ok) {
    return result(422, "local_denied", denialMessage("ineligible_status"), {
      result_code: "invalid_canonical_email",
      meta,
    });
  }

  const zapier = getZapierConfig(deps);
  if (!zapier.url || /TU_WEBHOOK_URL_AQUI/i.test(zapier.url) || !zapier.secret) {
    return unknownWithCase(tenantId, loaded.invoice.invoice_no, deps, "local_config_error", meta);
  }

  const nonce = String(verified.payload.nonce).trim();
  const creatorId = isUuid(session?.u) ? String(session.u).trim() : null;
  const claimedAt = new Date().toISOString();
  let actionRow;
  try {
    const inserted = await requestFn(deps)(ACTIONS_TABLE, {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: {
        tenant_id: tenantId,
        created_by_user_id: creatorId,
        action_type: ACTION_TYPE,
        related_entity_type: "invoice",
        related_entity_id: String(loaded.invoice.id).trim(),
        idempotency_key: nonce,
        status: "claimed",
        claimed_at: claimedAt,
        result_code: null,
      },
    });
    actionRow = Array.isArray(inserted) ? inserted[0] : inserted;
    if (!actionRow?.id) {
      return result(502, "local_denied", "Invoice resend could not be started.", {
        result_code: "local_claim_failed",
        meta,
      });
    }
    meta.claimed = true;
  } catch (err) {
    if (isUniqueViolation(err)) {
      return result(409, "already_claimed", denialMessage("already_claimed"), {
        result_code: "already_claimed",
        meta,
      });
    }
    return result(502, "local_denied", "Invoice resend could not be started.", {
      result_code: "local_claim_failed",
      meta,
    });
  }

  const basePayload = {
    client_name: pickFirstStr(loaded.invoice.customer_name, loaded.invoice.project_name),
    client_email: pickFirstStr(loaded.invoice.customer_email),
    "Client Email": pickFirstStr(loaded.invoice.customer_email),
    public_invoice_url: publicUrl,
    "Public Invoice Url": publicUrl,
    business_name: pickFirstStr(tenantName, loaded.invoice.business_name) || "Three Colors Corp",
    project_name: pickFirstStr(loaded.invoice.project_name),
    invoice_label: pickFirstStr(loaded.invoice.invoice_label),
    tenant_id: tenantId,
    invoice_id: String(loaded.invoice.id).trim(),
    quote_id: String(loaded.invoice.quote_id || "").trim(),
    project_id: String(loaded.invoice.project_id || "").trim(),
    event_type: "invoice_sent",
    schema_version: "invoice_webhook_v1",
    idempotency_key: nonce,
  };
  const payload = applyCanonicalToZapierPayload(basePayload, built.canonical);

  try {
    meta.networkAttempted = true;
    meta.fetchCount = 1;
    const timeoutMs = Number(deps.zapierTimeoutMs) > 0 ? Number(deps.zapierTimeoutMs) : ZAPIER_TIMEOUT_MS;
    const posted = await postSignedZapier({
      url: zapier.url,
      secret: zapier.secret,
      payload,
      deps,
      timeoutMs,
    });

    if (!isConfirmedHttp2xx(posted.res)) {
      const code = posted.aborted ? "submission_unknown_timeout" : "submission_unknown";
      await markLedgerUnknown(actionRow, tenantId, code, deps);
      return unknownWithCase(tenantId, loaded.invoice.invoice_no, deps, code, meta);
    }

    const sentAt = new Date().toISOString();
    const persisted = await persistInvoiceSent(loaded.invoice, tenantId, sentAt, deps);
    if (!persisted.ok) {
      await markLedgerUnknown(actionRow, tenantId, "submission_unknown_db", deps);
      return unknownWithCase(tenantId, loaded.invoice.invoice_no, deps, "submission_unknown_db", meta);
    }

    try {
      await requestFn(deps)(
        `${ACTIONS_TABLE}?id=eq.${encodeURIComponent(actionRow.id)}&tenant_id=eq.${encodeURIComponent(tenantId)}&status=eq.claimed`,
        {
          method: "PATCH",
          headers: { Prefer: "return=representation" },
          body: {
            status: "bridge_accepted",
            completed_at: new Date().toISOString(),
            result_code: "bridge_accepted",
          },
        }
      );
    } catch (_err) {
      return unknownWithCase(tenantId, loaded.invoice.invoice_no, deps, "ledger_finalize_failed", meta);
    }

    return result(200, "bridge_accepted", SUCCESS_MESSAGE, {
      result_code: persisted.fallback ? "bridge_accepted_sent_at_only" : "bridge_accepted",
      meta,
    });
  } catch (_err) {
    await markLedgerUnknown(actionRow, tenantId, "submission_unknown", deps);
    return unknownWithCase(tenantId, loaded.invoice.invoice_no, deps, "submission_unknown", meta);
  }
}

module.exports = {
  ACTIONS_TABLE,
  ZAPIER_TIMEOUT_MS,
  SUCCESS_MESSAGE,
  UNKNOWN_MESSAGE,
  mintInvoiceResendToken,
  executeInvoiceResend,
  getZapierConfig,
  isConfirmedHttp2xx,
  isUniqueViolation,
};
