/**
 * Owner action: mark a reported material or project-expense invoice as part
 * of the contract balance. Does not change the contract total, email, or charge.
 */
const { readSessionFromEvent } = require("./_lib/session");
const { supabaseRequest } = require("./_lib/supabase-admin");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");
const { hasOwnerSessionIdentity } = require("./_lib/owner-access");
const {
  resolveProfileRoleForSession,
  roleMayAccessFinancialSnapshot,
} = require("./_lib/resolve-profile-role");
const {
  notesIncludeBalanceMarker,
  invoiceCanJoinContractBalance,
  notesWithBalanceMarker,
} = require("./_lib/material-balance");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLOSED = new Set(["void", "voided", "cancelled", "canceled", "archived"]);

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  };
}

function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "Method not allowed" });
    }

    const session = readSessionFromEvent(event);
    if (!hasOwnerSessionIdentity(session)) {
      return json(401, { ok: false, error: "Unauthorized" });
    }

    const tenant = await resolveTenantFromSession(session);
    if (!tenant?.id) {
      return json(404, { ok: false, error: "Tenant not found" });
    }

    const role = await resolveProfileRoleForSession(session, tenant.id);
    if (!roleMayAccessFinancialSnapshot(role)) {
      return json(403, { ok: false, error: "Adding materials to the balance is restricted to the owner." });
    }

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch (_err) {
      return json(400, { ok: false, error: "Invalid JSON body." });
    }

    const invoiceId = String(body.invoice_id || body.invoiceId || "").trim();
    if (!UUID_RE.test(invoiceId)) {
      return json(400, { ok: false, error: "invoice_id is required" });
    }

    const tenantId = String(tenant.id);
    const rows = await supabaseRequest(
      `invoices?id=eq.${encodeURIComponent(invoiceId)}&tenant_id=eq.${encodeURIComponent(tenantId)}` +
        `&select=id,invoice_label,notes,amount,paid_amount,status,project_id&limit=1`
    );
    const invoice = Array.isArray(rows) ? rows[0] : null;
    if (!invoice?.id) {
      return json(404, { ok: false, error: "Invoice not found" });
    }

    const status = String(invoice.status || "").trim().toLowerCase();
    if (CLOSED.has(status)) {
      return json(400, { ok: false, error: "This invoice is closed." });
    }
    if (!invoiceCanJoinContractBalance(invoice)) {
      return json(400, { ok: false, error: "Only reported materials can be added to the balance." });
    }

    const due = money(Math.max(0, money(invoice.amount) - money(invoice.paid_amount)));
    if (notesIncludeBalanceMarker(invoice.notes)) {
      return json(200, { ok: true, already: true, invoice_id: invoiceId, amount: due });
    }

    const notes = notesWithBalanceMarker(invoice.notes);
    await supabaseRequest(
      `invoices?id=eq.${encodeURIComponent(invoiceId)}&tenant_id=eq.${encodeURIComponent(tenantId)}`,
      {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: { notes, updated_at: new Date().toISOString() },
      }
    );

    return json(200, { ok: true, already: false, invoice_id: invoiceId, amount: due });
  } catch (_err) {
    return json(500, {
      ok: false,
      error: "Could not add the materials to the balance.",
    });
  }
};
