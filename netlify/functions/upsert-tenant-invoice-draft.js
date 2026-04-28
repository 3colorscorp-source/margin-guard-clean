const { readSessionFromEvent } = require("./_lib/session");
const { supabaseRequest } = require("./_lib/supabase-admin");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");
const { makePublicToken } = require("./_lib/public-token");
const { pickFirst } = require("./_lib/tenant-display");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ALLOWED_STATUS = new Set(["draft", "sent", "partial", "paid", "overdue", "void"]);
const ALLOWED_INVOICE_TYPES = new Set(["progress_payment", "final", "deposit"]);

/** Fields the client may set on create or update (never tenant_id / id via body for update filter). */
const UPSERT_KEYS = new Set([
  "customer_name",
  "customer_email",
  "project_name",
  "amount",
  "paid_amount",
  "balance_due",
  "issue_date",
  "due_date",
  "type",
  "notes",
  "payment_link",
  "business_name",
  "logo_url",
  "accent_color",
  "currency",
  "status",
  "payment_status",
  "quote_id",
  "invoice_no",
  "invoice_label",
  "sent_at",
  "paid_at",
  "voided_at",
  "pdf_storage_path",
  "stripe_checkout_session_id",
  "stripe_payment_intent_id",
  "last_reminder_at"
]);

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

function normalizeStatus(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return "draft";
  if (!ALLOWED_STATUS.has(s)) {
    throw new Error(`Invalid status. Allowed: ${[...ALLOWED_STATUS].join(", ")}`);
  }
  return s;
}

function buildPatchPayload(body) {
  const out = {};
  for (const key of UPSERT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    const v = body[key];
    if (key === "amount" || key === "paid_amount" || key === "balance_due") {
      out[key] = finiteMoney(v, 0);
      continue;
    }
    if (key === "status") {
      out[key] = normalizeStatus(v);
      continue;
    }
    if (key === "type") {
      out[key] = v;
      continue;
    }
    if (key === "invoice_label") {
      const s = String(v ?? "")
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 200);
      out[key] = s;
      continue;
    }
    if (key === "quote_id") {
      if (v === null || v === undefined || String(v).trim() === "") {
        out[key] = null;
        continue;
      }
      const q = String(v).trim();
      if (!UUID_RE.test(q)) {
        throw new Error("Invalid quote_id (expected UUID).");
      }
      out[key] = q;
      continue;
    }
    if (v === null || v === undefined) {
      out[key] = null;
      continue;
    }
    out[key] = typeof v === "string" ? v : v;
  }
  return out;
}

function sanitizePayloadKeys(body) {
  if (!body || typeof body !== "object") return [];
  return Object.keys(body).filter((k) => typeof k === "string").slice(0, 200);
}

/**
 * POST — create draft (no id / no id in body) or update draft (body.id UUID).
 * tenant_id always from session on create; updates require id + tenant_id match.
 */
exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { error: "Method Not Allowed" });
    }

    const session = readSessionFromEvent(event);
    if (!session?.e || !session?.c) {
      return json(401, { error: "Unauthorized" });
    }

    const tenant = await resolveTenantFromSession(session);
    if (!tenant?.id) {
      return json(422, {
        error: "Cannot upsert invoice: tenant not found for this session. Run bootstrap-tenant first."
      });
    }

    const tenantId = String(tenant.id);

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch (_err) {
      return json(400, {
        ok: false,
        error: "validation:invalid_json_body",
        missing: [],
        received: []
      });
    }
    if (
      body &&
      typeof body === "object" &&
      Object.prototype.hasOwnProperty.call(body, "invoice_date") &&
      !Object.prototype.hasOwnProperty.call(body, "issue_date")
    ) {
      body.issue_date = body.invoice_date;
    }
    const rawType = String(pickFirst(body.type, body.invoice_type) || "").trim();
    const invoiceType = ALLOWED_INVOICE_TYPES.has(rawType)
      ? rawType
      : "progress_payment";
    body.type = invoiceType;

    const clientTenantId = pickFirst(body.tenant_id, body.tenantId);
    if (
      clientTenantId != null &&
      clientTenantId !== "" &&
      String(clientTenantId) !== tenantId
    ) {
      return json(403, { error: "tenant_id does not match the signed-in account." });
    }

    const rawId = pickFirst(body.id, body.invoice_id, body.invoiceId);
    const id = rawId ? String(rawId).trim() : "";

    if (id && !UUID_RE.test(id)) {
      return json(400, {
        ok: false,
        error: "validation:invalid_id_uuid",
        missing: [],
        received: sanitizePayloadKeys(body)
      });
    }

    if (id) {
      const patch = buildPatchPayload(body);
      if (Object.keys(patch).length === 0) {
        return json(400, {
          ok: false,
          error: "validation:no_updatable_fields",
          missing: ["any_of: " + [...UPSERT_KEYS].join(", ")],
          received: sanitizePayloadKeys(body)
        });
      }

      const filter = `id=eq.${encodeURIComponent(id)}&tenant_id=eq.${encodeURIComponent(tenantId)}`;
      let updated;
      try {
        updated = await supabaseRequest(`invoices?${filter}`, {
          method: "PATCH",
          headers: { Prefer: "return=representation" },
          body: patch
        });
      } catch (error) {
        console.error("Invoice draft error:", error);
        const status =
          Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
            ? error.status
            : 500;
        return json(status, {
          ok: false,
          error: error?.message || "Failed to update invoice draft",
          supabaseRaw: error?.supabaseRaw || ""
        });
      }
      const rows = Array.isArray(updated) ? updated : updated ? [updated] : [];
      if (rows.length === 0) {
        return json(404, { error: "Invoice not found or not in your tenant." });
      }
      return json(200, { ok: true, invoice: rows[0] });
    }

    const insert = buildPatchPayload(body);
    insert.tenant_id = tenantId;
    insert.public_token = makePublicToken("inv");
    insert.invoice_no = String(
      pickFirst(body.invoice_no, body.invoiceNo) || `INV-${Date.now()}`
    ).trim();
    if (!insert.invoice_no) {
      return json(400, {
        ok: false,
        error: "validation:invoice_no_required",
        missing: ["invoice_no"],
        received: sanitizePayloadKeys(body)
      });
    }
    insert.status = insert.status != null ? normalizeStatus(insert.status) : "draft";
    insert.amount = finiteMoney(insert.amount ?? 0, 0);
    insert.paid_amount = finiteMoney(insert.paid_amount ?? 0, 0);
    insert.balance_due =
      insert.balance_due !== undefined && insert.balance_due !== null
        ? finiteMoney(insert.balance_due, 0)
        : finiteMoney(insert.amount - insert.paid_amount, 0);

    let created;
    try {
      created = await supabaseRequest("invoices", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: insert
      });
    } catch (error) {
      console.error("Invoice draft error:", error);
      const status =
        Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
          ? error.status
          : 500;
      return json(status, {
        ok: false,
        error: error?.message || "Failed to create invoice draft",
        supabaseRaw: error?.supabaseRaw || ""
      });
    }
    const row = Array.isArray(created) ? created[0] : created;
    if (!row?.id) {
      return json(500, { error: "Insert did not return an invoice row." });
    }
    if (String(row.tenant_id || "") !== tenantId) {
      return json(500, { error: "Invoice was stored without valid tenant scope." });
    }

    return json(200, { ok: true, invoice: row });
  } catch (err) {
    console.error("[upsert-tenant-invoice-draft] unhandled failure", {
      message: err?.message || "Server error",
      status: err?.status || null,
      supabaseRaw: err?.supabaseRaw || "",
      stack: err?.stack || ""
    });
    const msg = err.message || "Server error";
    if (msg.startsWith("Invalid status")) {
      return json(400, {
        ok: false,
        error: "validation:invalid_status",
        missing: [],
        received: sanitizePayloadKeys(body)
      });
    }
    if (msg.includes("Invalid quote_id")) {
      return json(400, {
        ok: false,
        error: "validation:invalid_quote_id_uuid",
        missing: [],
        received: sanitizePayloadKeys(body)
      });
    }
    return json(500, { error: msg });
  }
};
