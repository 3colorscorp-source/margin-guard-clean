/**
 * POST — create a linked DRAFT project payment invoice (owner session).
 * Does not send email, record payments, or modify the source invoice.
 * Accepts owner-selected invoice_label (payment stage).
 */
const { readSessionFromEvent } = require("./_lib/session");
const { supabaseRequest } = require("./_lib/supabase-admin");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");
const { makePublicToken } = require("./_lib/public-token");
const { pickFirst } = require("./_lib/tenant-display");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ALLOWED_PAYMENT_STAGE_LABELS = [
  "Start Payment",
  "Progress Payment",
  "Final Payment",
  "Remaining Balance",
  "Change Order"
];
const ALLOWED_LABEL_SET = new Set(ALLOWED_PAYMENT_STAGE_LABELS.map((s) => s.toLowerCase()));
const FULL_REMAINING_LABELS = new Set(["remaining balance", "final payment"]);

const ACTIVE_DUPLICATE_STATUSES = new Set([
  "draft",
  "open",
  "sent",
  "partial",
  "overdue",
  "issued",
  "pending"
]);
const TERMINAL_STATUSES = new Set(["paid", "void", "archived", "cancelled", "canceled"]);

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}

function finiteMoney(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.round(n * 100) / 100;
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

function sourceInvoiceMarker(sourceId) {
  return `[source_invoice:${String(sourceId).trim()}]`;
}

function notesContainSourceMarker(notes, sourceId) {
  const marker = sourceInvoiceMarker(sourceId);
  return String(notes || "").includes(marker);
}

function appendSourceMarker(notes, sourceId) {
  const base = String(notes || "").trim();
  const marker = sourceInvoiceMarker(sourceId);
  if (base.includes(marker)) return base;
  return base ? `${base}\n\n${marker}` : marker;
}

function normalizeDueDate(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function resolveContractTotal(source, quoteEmbed) {
  const quoteTotal = finiteMoney(quoteEmbed?.total, 0);
  if (quoteTotal > 0) return quoteTotal;
  return Math.max(finiteMoney(source?.amount, 0), 0);
}

/** Prefer project ledger, then quote, then invoice — never invent paid from invoice amount. */
async function sumLedgerPayments(tenantId, { projectId, quoteId, invoiceId }) {
  const tidEnc = encodeURIComponent(String(tenantId));
  const params = new URLSearchParams();
  params.set("tenant_id", `eq.${tidEnc}`);
  params.set("select", "amount");
  params.set("limit", "500");

  if (projectId && UUID_RE.test(projectId)) {
    params.set("project_id", `eq.${encodeURIComponent(projectId)}`);
  } else if (quoteId && UUID_RE.test(quoteId)) {
    params.set("quote_id", `eq.${encodeURIComponent(quoteId)}`);
  } else if (invoiceId && UUID_RE.test(invoiceId)) {
    params.set("invoice_id", `eq.${encodeURIComponent(invoiceId)}`);
  } else {
    return 0;
  }

  const rows = await supabaseRequest(`tenant_project_payments?${params.toString()}`, { method: "GET" });
  const list = Array.isArray(rows) ? rows : [];
  let sum = 0;
  for (const p of list) {
    sum += finiteMoney(p?.amount, 0);
  }
  return finiteMoney(sum, 0);
}

function normalizeAmountMode(raw) {
  const s = String(raw || "")
    .trim()
    .toLowerCase();
  if (s === "manual" || s === "enter_manual_amount") return "manual";
  return "remaining_balance";
}

function normalizeInvoiceLabel(raw, { selectedAmount, remainingBalance }) {
  const s = String(raw || "").trim();
  if (s && ALLOWED_LABEL_SET.has(s.toLowerCase())) {
    const exact = ALLOWED_PAYMENT_STAGE_LABELS.find((l) => l.toLowerCase() === s.toLowerCase());
    return exact || s;
  }
  // Default from amount vs ledger remaining.
  if (
    Number.isFinite(selectedAmount) &&
    Number.isFinite(remainingBalance) &&
    Math.abs(selectedAmount - remainingBalance) <= 0.01
  ) {
    return "Remaining Balance";
  }
  return "Progress Payment";
}

const DUPLICATE_PROJECT_PAYMENT_MESSAGE =
  "A project payment invoice already exists for this project. Open or resend the existing invoice, or cancel it before creating another.";

async function findDuplicateProjectPaymentDraft({ tenantId, sourceId }) {
  const tidEnc = encodeURIComponent(String(tenantId));
  const path =
    `invoices?tenant_id=eq.${tidEnc}` +
    `&select=id,status,amount,notes,invoice_no,invoice_label,sent_at` +
    `&limit=80` +
    `&order=created_at.desc`;

  let rows;
  try {
    rows = await supabaseRequest(path, { method: "GET" });
  } catch (_err) {
    return null;
  }
  const list = Array.isArray(rows) ? rows : [];

  for (const inv of list) {
    const st = normStatus(inv?.status);
    if (TERMINAL_STATUSES.has(st)) continue;
    if (!ACTIVE_DUPLICATE_STATUSES.has(st) && st !== "") continue;
    if (!notesContainSourceMarker(inv?.notes, sourceId)) continue;
    const label = String(inv?.invoice_label || "").trim().toLowerCase();
    // Material Cost stays out of this flow; skip those drafts.
    if (label === "material cost") continue;
    if (label && !ALLOWED_LABEL_SET.has(label) && label !== "remaining balance") continue;
    return inv;
  }
  return null;
}

function displayStatusForDuplicate(inv) {
  const status = normStatus(inv?.status) || "draft";
  const sentAt = pickStr(inv?.sent_at);
  if (sentAt && (status === "draft" || status === "open" || status === "")) {
    return "sent/draft";
  }
  return status;
}

function formatExistingInvoiceDetail(inv) {
  if (!inv || typeof inv !== "object") return "";
  const no = pickStr(inv.invoice_no) || "invoice";
  const status = displayStatusForDuplicate(inv);
  const label = pickStr(inv.invoice_label);
  const amt = finiteMoney(inv.amount, NaN);
  const amtPart = Number.isFinite(amt)
    ? ` · $${amt.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : "";
  const labelPart = label ? ` · ${label}` : "";
  return ` Existing: ${no} · ${status}${labelPart}${amtPart}.`;
}

function buildProjectPaymentInsert({ source, tenantId, selectedAmount, notesFinal, invoiceLabel }) {
  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  const payload = {
    tenant_id: tenantId,
    public_token: makePublicToken("inv"),
    invoice_no: `INV-${Date.now()}`,
    customer_name: pickStr(source.customer_name),
    customer_email: pickStr(source.customer_email),
    project_name: pickStr(source.project_name),
    invoice_label: invoiceLabel,
    notes: notesFinal,
    amount: selectedAmount,
    paid_amount: 0,
    balance_due: selectedAmount,
    issue_date: today,
    due_date: normalizeDueDate(source.due_date),
    type: "PROGRESS",
    business_name: pickStr(source.business_name),
    currency: pickStr(source.currency) || "USD",
    status: "draft",
    created_at: now,
    updated_at: now
  };
  const projectId = pickStr(source.project_id);
  if (projectId && UUID_RE.test(projectId)) {
    payload.project_id = projectId;
  }
  // Do not set quote_id — invoices_tenant_quote_unique allows one invoice per quote per tenant.
  // Source linkage is preserved via notes marker [source_invoice:<uuid>].
  return payload;
}

function ownerSafeInsertError(rawMessage) {
  const msg = String(rawMessage || "").trim();
  if (/invoices_tenant_quote_unique|tenant_id.*quote_id|duplicate key.*quote/i.test(msg)) {
    return {
      status: 409,
      reason: "quote_id_unique_violation",
      error: "Could not create the project payment draft invoice. Please refresh and try again."
    };
  }
  if (/duplicate key|violates unique constraint|23505/i.test(msg)) {
    return {
      status: 409,
      reason: "insert_unique_violation",
      error: "Could not create the project payment draft invoice. Please refresh and try again."
    };
  }
  return {
    status: 500,
    reason: "insert_failed",
    error: "Could not create the project payment draft invoice. Please refresh and try again."
  };
}

/**
 * POST body:
 * {
 *   source_invoice_id,
 *   amount_mode: "remaining_balance" | "manual",
 *   manual_amount?,
 *   invoice_label?,
 *   notes?
 * }
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

    const rawSourceId = pickFirst(
      body.source_invoice_id,
      body.sourceInvoiceId,
      body.invoice_id,
      body.invoiceId
    );
    const sourceInvoiceId = rawSourceId ? String(rawSourceId).trim() : "";
    if (!sourceInvoiceId) {
      return json(400, { ok: false, error: "source_invoice_id is required." });
    }
    if (!UUID_RE.test(sourceInvoiceId)) {
      return json(400, { ok: false, error: "Invalid source_invoice_id (expected UUID)." });
    }

    const amountMode = normalizeAmountMode(body.amount_mode || body.amountMode);
    const manualAmountRaw = body.manual_amount ?? body.manualAmount;

    const iidEnc = encodeURIComponent(sourceInvoiceId);
    const tidEnc = encodeURIComponent(tenantId);
    const rows = await supabaseRequest(
      `invoices?id=eq.${iidEnc}&tenant_id=eq.${tidEnc}&select=*,quotes(id,total)&limit=1`,
      { method: "GET" }
    );
    const source = Array.isArray(rows) && rows[0] ? rows[0] : null;
    if (!source?.id) {
      return json(404, { ok: false, error: "Source invoice not found." });
    }

    const sourceStatus = normStatus(source.status);
    if (sourceStatus === "archived") {
      return json(422, { ok: false, reason: "invoice_archived", error: "Cannot create from an archived invoice." });
    }
    if (sourceStatus === "void") {
      return json(422, { ok: false, reason: "invoice_void", error: "Cannot create from a void invoice." });
    }

    let quoteWrap = source.quotes;
    if (Array.isArray(quoteWrap)) quoteWrap = quoteWrap[0];
    const quoteEmbed = quoteWrap && typeof quoteWrap === "object" ? quoteWrap : null;
    const quoteId =
      quoteEmbed?.id != null
        ? String(quoteEmbed.id).trim()
        : source.quote_id != null
          ? String(source.quote_id).trim()
          : "";

    const contractTotal = resolveContractTotal(source, quoteEmbed);
    if (!(contractTotal > 0)) {
      return json(422, { ok: false, reason: "no_contract_total", error: "Could not resolve a contract total." });
    }

    const invoiceId = String(source.id).trim();
    const projectId = pickStr(source.project_id);
    const paidToDate = await sumLedgerPayments(tenantId, {
      projectId: UUID_RE.test(projectId) ? projectId : "",
      quoteId: UUID_RE.test(quoteId) ? quoteId : "",
      invoiceId
    });

    const remainingBalance = Math.max(0, finiteMoney(contractTotal - paidToDate, 0));
    if (!(remainingBalance > 0)) {
      return json(422, {
        ok: false,
        reason: "no_remaining_balance",
        error: "No remaining balance on this project."
      });
    }

    let selectedAmount = remainingBalance;
    if (amountMode === "manual") {
      selectedAmount = finiteMoney(manualAmountRaw, NaN);
      if (!Number.isFinite(selectedAmount) || selectedAmount <= 0) {
        return json(400, { ok: false, error: "manual_amount must be greater than 0." });
      }
      if (selectedAmount > remainingBalance + 0.001) {
        return json(422, {
          ok: false,
          reason: "manual_amount_exceeds_remaining",
          error: `Manual amount cannot exceed remaining balance (${remainingBalance.toFixed(2)}).`
        });
      }
      selectedAmount = finiteMoney(selectedAmount, 0);
    }

    const invoiceLabel = normalizeInvoiceLabel(body.invoice_label || body.invoiceLabel, {
      selectedAmount,
      remainingBalance
    });
    if (!ALLOWED_LABEL_SET.has(invoiceLabel.toLowerCase())) {
      return json(400, {
        ok: false,
        reason: "invalid_invoice_label",
        error: `invoice_label must be one of: ${ALLOWED_PAYMENT_STAGE_LABELS.join(", ")}.`
      });
    }

    const isFullRemainingLabel = FULL_REMAINING_LABELS.has(invoiceLabel.toLowerCase());
    const amountMatchesRemaining = Math.abs(selectedAmount - remainingBalance) <= 0.01;
    let labelWarning = "";
    if (isFullRemainingLabel && !amountMatchesRemaining) {
      labelWarning =
        "This amount is less than the actual remaining project balance. Consider using Progress Payment instead.";
    }

    const duplicate = await findDuplicateProjectPaymentDraft({
      tenantId,
      sourceId: sourceInvoiceId
    });
    if (duplicate?.id) {
      const detail = formatExistingInvoiceDetail(duplicate);
      return json(409, {
        ok: false,
        reason: "duplicate_remaining_balance_draft",
        error: DUPLICATE_PROJECT_PAYMENT_MESSAGE + detail,
        message: DUPLICATE_PROJECT_PAYMENT_MESSAGE + detail,
        existing_invoice: {
          id: String(duplicate.id),
          invoice_no: pickStr(duplicate.invoice_no),
          status: normStatus(duplicate.status) || "draft",
          sent_at: pickStr(duplicate.sent_at) || "",
          amount: finiteMoney(duplicate.amount, 0),
          invoice_label: pickStr(duplicate.invoice_label)
        }
      });
    }

    const clientNotes = body.notes != null ? String(body.notes).trim().slice(0, 7900) : "";
    const notesFinal = appendSourceMarker(clientNotes, sourceInvoiceId);

    const insertPayload = buildProjectPaymentInsert({
      source,
      tenantId,
      selectedAmount,
      notesFinal,
      invoiceLabel
    });

    let created;
    try {
      created = await supabaseRequest("invoices", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: insertPayload
      });
    } catch (insertErr) {
      const msg = String(insertErr?.message || insertErr || "");
      const projectColumnMissing = /column .*project_id.* does not exist/i.test(msg);
      if (projectColumnMissing && insertPayload.project_id) {
        const fallbackPayload = { ...insertPayload };
        delete fallbackPayload.project_id;
        try {
          created = await supabaseRequest("invoices", {
            method: "POST",
            headers: { Prefer: "return=representation" },
            body: fallbackPayload
          });
        } catch (retryErr) {
          const safe = ownerSafeInsertError(retryErr?.message || retryErr);
          return json(safe.status, { ok: false, reason: safe.reason, error: safe.error });
        }
      } else {
        const safe = ownerSafeInsertError(msg);
        return json(safe.status, { ok: false, reason: safe.reason, error: safe.error });
      }
    }

    const invoice = Array.isArray(created) ? created[0] : created;
    if (!invoice?.id) {
      return json(500, { ok: false, error: "Insert did not return an invoice row." });
    }
    if (String(invoice.tenant_id || "") !== tenantId) {
      return json(500, { ok: false, error: "Invoice was stored without valid tenant scope." });
    }

    return json(200, {
      ok: true,
      invoice_id: String(invoice.id),
      status: normStatus(invoice.status) || "draft",
      amount: finiteMoney(invoice.amount, selectedAmount),
      invoice_label: pickStr(invoice.invoice_label, invoiceLabel),
      source_invoice_id: sourceInvoiceId,
      remaining_balance: remainingBalance,
      contract_total: contractTotal,
      paid_to_date: paidToDate,
      warning: labelWarning || undefined,
      invoice,
      message:
        "Project payment draft invoice created. No email was sent and no payment was recorded."
    });
  } catch (err) {
    console.error("[create-remaining-balance-invoice]", err);
    const safe = ownerSafeInsertError(err?.message || err);
    return json(safe.status, { ok: false, reason: safe.reason, error: safe.error });
  }
};
