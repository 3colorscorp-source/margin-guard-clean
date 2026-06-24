const { readSessionFromEvent } = require("./_lib/session");
const { supabaseRequest } = require("./_lib/supabase-admin");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");
const { pickFirst } = require("./_lib/tenant-display");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ALLOWED_PATCH_KEYS = new Set(["customer_name", "customer_email", "notes"]);

const RESPONSE_SELECT = [
  "id",
  "invoice_no",
  "customer_name",
  "customer_email",
  "notes",
  "amount",
  "paid_amount",
  "balance_due",
  "public_token",
  "status",
  "sent_at",
  "quote_id"
].join(",");

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}

function isValidEmail(value) {
  const s = String(value || "").trim();
  return s.includes("@") && s.includes(".") && s.length < 320;
}

function buildContactPatch(body) {
  const disallowed = [];
  for (const key of Object.keys(body || {})) {
    if (key === "invoice_id" || key === "invoiceId" || key === "id") continue;
    if (!ALLOWED_PATCH_KEYS.has(key)) {
      disallowed.push(key);
    }
  }
  if (disallowed.length) {
    return { error: "unknown_fields", fields: disallowed };
  }

  const patch = {};
  if (Object.prototype.hasOwnProperty.call(body, "customer_name")) {
    const name = String(body.customer_name ?? "")
      .trim()
      .slice(0, 255);
    if (!name) {
      return { error: "invalid_name", message: "customer_name cannot be empty." };
    }
    patch.customer_name = name;
  }
  if (Object.prototype.hasOwnProperty.call(body, "customer_email")) {
    const email = String(body.customer_email ?? "")
      .trim()
      .slice(0, 255);
    if (!isValidEmail(email)) {
      return { error: "invalid_email", message: "Invalid customer_email." };
    }
    patch.customer_email = email;
  }
  if (Object.prototype.hasOwnProperty.call(body, "notes")) {
    const notes = String(body.notes ?? "").trim();
    patch.notes = notes ? notes.slice(0, 5000) : null;
  }

  if (Object.keys(patch).length === 0) {
    return { error: "no_edit_fields", message: "No editable contact fields were provided." };
  }

  return { patch };
}

/**
 * POST — update invoice delivery contact fields only (tenant-scoped).
 * Body: { invoice_id, customer_name?, customer_email?, notes? }
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
        error: "Cannot update invoice contact: tenant not found for this session. Run bootstrap-tenant first."
      });
    }

    const tenantId = String(tenant.id);

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch (_err) {
      return json(400, { ok: false, error: "validation:invalid_json_body" });
    }

    const clientTenantId = pickFirst(body.tenant_id, body.tenantId);
    if (
      clientTenantId != null &&
      clientTenantId !== "" &&
      String(clientTenantId) !== tenantId
    ) {
      return json(403, { error: "tenant_id does not match the signed-in account." });
    }

    const rawId = pickFirst(body.invoice_id, body.invoiceId, body.id);
    const invoiceId = rawId ? String(rawId).trim() : "";
    if (!invoiceId) {
      return json(400, {
        ok: false,
        code: "invoice_id_required",
        error: "invoice_id is required."
      });
    }
    if (!UUID_RE.test(invoiceId)) {
      return json(400, {
        ok: false,
        code: "invalid_invoice_id",
        error: "Invalid invoice_id (expected UUID)."
      });
    }

    const built = buildContactPatch(body);
    if (built.error === "unknown_fields") {
      return json(400, {
        ok: false,
        code: "unknown_fields",
        error: "Disallowed fields in request.",
        fields: built.fields
      });
    }
    if (built.error) {
      return json(400, {
        ok: false,
        code: built.error,
        error: built.message || "Invalid contact fields."
      });
    }

    const patch = built.patch;
    const filter = `id=eq.${encodeURIComponent(invoiceId)}&tenant_id=eq.${encodeURIComponent(tenantId)}`;

    let updated;
    try {
      updated = await supabaseRequest(`invoices?${filter}&select=${RESPONSE_SELECT}`, {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: patch
      });
    } catch (error) {
      console.error("[patch-tenant-invoice-contact] update failed:", error);
      const status =
        Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
          ? error.status
          : 500;
      return json(status, {
        ok: false,
        error: error?.message || "Failed to update invoice contact",
        supabaseRaw: error?.supabaseRaw || ""
      });
    }

    const rows = Array.isArray(updated) ? updated : updated ? [updated] : [];
    if (rows.length === 0) {
      return json(404, { ok: false, error: "Invoice not found or not in your tenant." });
    }

    const invoice = rows[0];

    return json(200, { ok: true, invoice });
  } catch (err) {
    console.error("[patch-tenant-invoice-contact] unhandled failure", err);
    return json(500, { ok: false, error: err.message || "Server error" });
  }
};
