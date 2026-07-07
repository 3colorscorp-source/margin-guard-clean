/**
 * POST — create a linked DRAFT invoice for unexpected material costs (owner session).
 * Does not send email, record payments, or modify the source invoice.
 */
const { readSessionFromEvent } = require("./_lib/session");
const { supabaseRequest } = require("./_lib/supabase-admin");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");
const { makePublicToken } = require("./_lib/public-token");
const { pickFirst } = require("./_lib/tenant-display");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MATERIAL_COST_LABEL = "Material Cost";
const INVOICE_TYPE_MARKER = "[invoice_type:unexpected_material_cost]";
const ACTIVE_DUPLICATE_STATUSES = new Set([
  "draft",
  "open",
  "sent",
  "partial",
  "overdue",
  "issued",
  "pending",
  "unpaid"
]);
const TERMINAL_STATUSES = new Set(["paid", "void", "archived", "cancelled", "canceled"]);

const DUPLICATE_MATERIAL_COST_MESSAGE =
  "An active material cost draft already exists for this project/invoice. Review or cancel the existing draft before creating another.";

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

function moneyText(value) {
  return `$${finiteMoney(value, 0).toFixed(2)}`;
}

function sourceInvoiceMarker(sourceId) {
  return `[source_invoice:${String(sourceId).trim()}]`;
}

function notesContainSourceMarker(notes, sourceId) {
  const marker = sourceInvoiceMarker(sourceId);
  return String(notes || "").includes(marker);
}

function notesContainTypeMarker(notes) {
  return String(notes || "").includes(INVOICE_TYPE_MARKER);
}

function appendMarkers(notes, sourceId) {
  let base = String(notes || "").trim();
  const sourceMarker = sourceInvoiceMarker(sourceId);
  if (!base.includes(sourceMarker)) {
    base = base ? `${base}\n\n${sourceMarker}` : sourceMarker;
  }
  if (!base.includes(INVOICE_TYPE_MARKER)) {
    base = `${base}\n${INVOICE_TYPE_MARKER}`;
  }
  return base.slice(0, 7900);
}

function normalizeDueDate(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function defaultDueDate() {
  const d = new Date();
  d.setDate(d.getDate() + 30);
  return d.toISOString().slice(0, 10);
}

function cleanMultilineText(raw, maxLen = 2000) {
  return String(raw == null ? "" : raw)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim()
    .slice(0, maxLen);
}

function buildMaterialCostNotes({ clientMessage, materialDescription, materialCost, sourceId }) {
  const sections = [];
  const msg = cleanMultilineText(clientMessage, 4000);
  if (msg) {
    sections.push(msg);
  }
  const desc = cleanMultilineText(materialDescription, 2000) || "Materials";
  sections.push(`Materials:\n${desc}\nMaterials subtotal: ${moneyText(materialCost)}`);
  sections.push(`Invoice total:\n${moneyText(materialCost)}`);
  return appendMarkers(sections.join("\n\n"), sourceId);
}

async function findDuplicateMaterialCostDraft({ tenantId, sourceId }) {
  const tidEnc = encodeURIComponent(String(tenantId));
  const path =
    `invoices?tenant_id=eq.${tidEnc}` +
    `&invoice_label=eq.${encodeURIComponent(MATERIAL_COST_LABEL)}` +
    `&select=id,status,amount,notes,invoice_no` +
    `&limit=50` +
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
    if (!notesContainTypeMarker(inv?.notes)) continue;
    return inv;
  }
  return null;
}

function buildMaterialCostInsert({ source, tenantId, materialCost, notesFinal, dueDate }) {
  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  const payload = {
    tenant_id: tenantId,
    public_token: makePublicToken("inv"),
    invoice_no: `INV-${Date.now()}`,
    customer_name: pickStr(source.customer_name),
    customer_email: pickStr(source.customer_email),
    project_name: pickStr(source.project_name),
    invoice_label: MATERIAL_COST_LABEL,
    notes: notesFinal,
    amount: materialCost,
    paid_amount: 0,
    balance_due: materialCost,
    issue_date: today,
    due_date: dueDate,
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
  return payload;
}

function ownerSafeInsertError(rawMessage) {
  const msg = String(rawMessage || "").trim();
  if (/invoices_tenant_quote_unique|tenant_id.*quote_id|duplicate key.*quote/i.test(msg)) {
    return {
      status: 409,
      reason: "quote_id_unique_violation",
      error: "Could not create the material cost draft invoice. Please refresh and try again."
    };
  }
  if (/duplicate key|violates unique constraint|23505/i.test(msg)) {
    return {
      status: 409,
      reason: "insert_unique_violation",
      error: "Could not create the material cost draft invoice. Please refresh and try again."
    };
  }
  return {
    status: 500,
    reason: "insert_failed",
    error: "Could not create the material cost draft invoice. Please refresh and try again."
  };
}

/**
 * POST body:
 * {
 *   source_invoice_id,
 *   material_description?,
 *   material_cost,
 *   due_date?,
 *   notes?  // message to client
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

    const materialCost = finiteMoney(body.material_cost ?? body.materialCost, NaN);
    if (!Number.isFinite(materialCost) || materialCost <= 0) {
      return json(400, {
        ok: false,
        reason: "material_cost_invalid",
        error: "Enter a material cost greater than zero."
      });
    }

    const materialDescription = cleanMultilineText(
      body.material_description != null ? body.material_description : body.materials_description,
      2000
    );
    const clientMessage = body.notes != null ? cleanMultilineText(body.notes, 4000) : "";
    const dueDate =
      normalizeDueDate(body.due_date ?? body.dueDate) ||
      normalizeDueDate(body.due) ||
      defaultDueDate();

    const iidEnc = encodeURIComponent(sourceInvoiceId);
    const tidEnc = encodeURIComponent(tenantId);
    const rows = await supabaseRequest(
      `invoices?id=eq.${iidEnc}&tenant_id=eq.${tidEnc}&select=*&limit=1`,
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

    const duplicate = await findDuplicateMaterialCostDraft({
      tenantId,
      sourceId: sourceInvoiceId
    });
    if (duplicate?.id) {
      return json(409, {
        ok: false,
        reason: "duplicate_material_cost_draft",
        error: DUPLICATE_MATERIAL_COST_MESSAGE
      });
    }

    const notesFinal = buildMaterialCostNotes({
      clientMessage,
      materialDescription,
      materialCost,
      sourceId: sourceInvoiceId
    });

    const insertPayload = buildMaterialCostInsert({
      source,
      tenantId,
      materialCost,
      notesFinal,
      dueDate
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
      amount: finiteMoney(invoice.amount, materialCost),
      source_invoice_id: sourceInvoiceId,
      invoice,
      message: "Material cost draft invoice created. Review and send it when ready."
    });
  } catch (err) {
    console.error("[create-material-cost-invoice]", err);
    const safe = ownerSafeInsertError(err?.message || err);
    return json(safe.status, { ok: false, reason: safe.reason, error: safe.error });
  }
};
