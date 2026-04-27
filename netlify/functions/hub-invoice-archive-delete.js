const { readSessionFromEvent } = require("./_lib/session");
const { supabaseRequest } = require("./_lib/supabase-admin");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}

function parseBody(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

function normInvStatus(s) {
  return String(s || "")
    .trim()
    .toLowerCase();
}

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
      return json(422, { error: "Tenant not found for this session." });
    }

    const tenantId = String(tenant.id);
    const tidEnc = encodeURIComponent(tenantId);
    const body = parseBody(event.body);
    const invoiceId = String(body.invoice_id || body.invoiceId || "").trim();
    const action = String(body.action || "").trim().toLowerCase();

    if (!UUID_RE.test(invoiceId)) {
      return json(400, { error: "Invalid invoice_id" });
    }
    if (!["archive", "delete"].includes(action)) {
      return json(400, { error: "Invalid action" });
    }

    const iidEnc = encodeURIComponent(invoiceId);
    const invRows = await supabaseRequest(
      `invoices?id=eq.${iidEnc}&tenant_id=eq.${tidEnc}&select=id,status,quote_id`,
      { method: "GET" }
    );
    const inv = Array.isArray(invRows) && invRows[0] ? invRows[0] : null;
    if (!inv?.id) {
      return json(404, { error: "Invoice not found" });
    }

    const invStatus = normInvStatus(inv.status);
    const quoteId = inv.quote_id != null ? String(inv.quote_id).trim() : "";

    if (action === "archive") {
      if (invStatus === "archived") {
        return json(200, { ok: true, action: "archive", already: true });
      }
      const nowIso = new Date().toISOString();
      await supabaseRequest(`invoices?id=eq.${iidEnc}&tenant_id=eq.${tidEnc}`, {
        method: "PATCH",
        body: { status: "archived", updated_at: nowIso }
      });
      if (quoteId && UUID_RE.test(quoteId)) {
        const qidEnc = encodeURIComponent(quoteId);
        try {
          await supabaseRequest(`quotes?id=eq.${qidEnc}&tenant_id=eq.${tidEnc}`, {
            method: "PATCH",
            body: { status: "archived", updated_at: nowIso }
          });
        } catch (qErr) {
          console.warn("[hub-invoice-archive-delete] quote archive skipped", qErr?.message || qErr);
        }
      }
      return json(200, { ok: true, action: "archive" });
    }

    if (action === "delete") {
      if (!["draft", "sent"].includes(invStatus)) {
        return json(422, { error: "Delete is only allowed for draft or sent invoices." });
      }

      let quoteAccepted = false;
      if (quoteId && UUID_RE.test(quoteId)) {
        const qidEnc = encodeURIComponent(quoteId);
        const qRows = await supabaseRequest(
          `quotes?id=eq.${qidEnc}&tenant_id=eq.${tidEnc}&select=id,accepted_at,status`,
          { method: "GET" }
        );
        const q = Array.isArray(qRows) && qRows[0] ? qRows[0] : null;
        if (q) {
          const qs = normInvStatus(q.status);
          const at = String(q.accepted_at || "").trim();
          quoteAccepted = qs === "accepted" || Boolean(at);
        }
      }

      if (quoteAccepted) {
        return json(422, { error: "Cannot delete: quote is accepted." });
      }

      await supabaseRequest(`invoices?id=eq.${iidEnc}&tenant_id=eq.${tidEnc}`, { method: "DELETE" });
      return json(200, { ok: true, action: "delete" });
    }

    return json(400, { error: "Unsupported action" });
  } catch (err) {
    console.error("[hub-invoice-archive-delete]", err);
    return json(500, { ok: false, error: err.message || "Server error" });
  }
};
