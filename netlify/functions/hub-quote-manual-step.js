const { readSessionFromEvent } = require("./_lib/session");
const { supabaseRequest } = require("./_lib/supabase-admin");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");
const { bridgeAcceptedQuoteToProject, UUID_RE } = require("./_lib/quote-accept-bridge");

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

async function fetchQuoteForTenant(tenantId, quoteId) {
  const tid = encodeURIComponent(tenantId);
  const qid = encodeURIComponent(quoteId);
  const rows = await supabaseRequest(`quotes?id=eq.${qid}&tenant_id=eq.${tid}&select=*`, { method: "GET" });
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

/** Inactive / non-actionable invoice statuses for Hub deposit actions. */
const INACTIVE_INVOICE_STATUSES = new Set(["archived", "void", "cancelled", "canceled"]);

function normInvoiceStatus(value) {
  return String(value || "").trim().toLowerCase();
}

/**
 * Active invoice usable for check_pending / deposit_received.
 * Excludes archived/void/cancelled and rows with voided_at set.
 */
function isActiveInvoiceForDepositAction(row) {
  if (!row || !row.id) return false;
  const st = normInvoiceStatus(row.status);
  if (INACTIVE_INVOICE_STATUSES.has(st)) return false;
  if (row.voided_at != null && String(row.voided_at).trim() !== "") return false;
  return true;
}

/**
 * Deterministic active-invoice pick for Hub deposit actions.
 * Prefer most recently updated, then created, then id desc.
 * @returns {{ invoice: object|null, activeCount: number }}
 */
function selectActiveInvoiceForQuote(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter(isActiveInvoiceForDepositAction);
  if (!list.length) return { invoice: null, activeCount: 0 };
  list.sort((a, b) => {
    const ub = String(b.updated_at || b.created_at || "");
    const ua = String(a.updated_at || a.created_at || "");
    if (ub !== ua) return ub.localeCompare(ua);
    const cb = String(b.created_at || "");
    const ca = String(a.created_at || "");
    if (cb !== ca) return cb.localeCompare(ca);
    return String(b.id || "").localeCompare(String(a.id || ""));
  });
  return { invoice: list[0], activeCount: list.length };
}

async function fetchInvoicesForQuote(tenantId, quoteId) {
  const tid = encodeURIComponent(tenantId);
  const qid = encodeURIComponent(quoteId);
  const rows = await supabaseRequest(
    `invoices?tenant_id=eq.${tid}&quote_id=eq.${qid}` +
      `&select=id,status,voided_at,created_at,updated_at` +
      `&order=updated_at.desc.nullslast,created_at.desc&limit=20`,
    { method: "GET" }
  );
  return Array.isArray(rows) ? rows : [];
}

async function fetchTenantProjectForQuote(tenantId, quoteId) {
  const tid = encodeURIComponent(tenantId);
  const qid = encodeURIComponent(quoteId);
  const rows = await supabaseRequest(
    `tenant_projects?tenant_id=eq.${tid}&quote_id=eq.${qid}&select=id&limit=2`,
    { method: "GET" }
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

function quoteIsAccepted(quote) {
  if (!quote) return false;
  if (String(quote.status || "").trim().toLowerCase() === "accepted") return true;
  const at = String(quote.accepted_at || "").trim();
  return Boolean(at);
}

const NO_INVOICE_HUB_MSG =
  "No invoice for this quote. Create an invoice in Invoice Hub first.";

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
    const body = parseBody(event.body);
    const quoteId = String(body.quote_id || "").trim();
    const action = String(body.action || "").trim().toLowerCase();

    if (!UUID_RE.test(quoteId)) {
      return json(400, { error: "Invalid quote_id" });
    }
    if (!["accept", "check_pending", "deposit_received"].includes(action)) {
      return json(400, { error: "Invalid action" });
    }

    const quote = await fetchQuoteForTenant(tenantId, quoteId);
    if (!quote) {
      return json(404, { error: "Quote not found" });
    }

    const tidEnc = encodeURIComponent(tenantId);
    const qidEnc = encodeURIComponent(quoteId);
    const nowIso = new Date().toISOString();

    if (action === "accept") {
      if (!quoteIsAccepted(quote)) {
        await supabaseRequest(`quotes?id=eq.${qidEnc}&tenant_id=eq.${tidEnc}`, {
          method: "PATCH",
          body: {
            status: "accepted",
            accepted_at: nowIso,
            updated_at: nowIso
          }
        });
      }
      const refreshed = (await fetchQuoteForTenant(tenantId, quoteId)) || quote;
      await bridgeAcceptedQuoteToProject(refreshed);
      return json(200, { ok: true, action: "accept" });
    }

    if (action === "check_pending") {
      if (!quoteIsAccepted(quote)) {
        return json(422, { error: "Accept the quote before marking check deposit pending." });
      }
      // CH-009-P2C — invoice first; zero project writes if missing.
      const invoices = await fetchInvoicesForQuote(tenantId, quoteId);
      const { invoice: inv } = selectActiveInvoiceForQuote(invoices);
      if (!inv?.id) {
        return json(422, { error: NO_INVOICE_HUB_MSG, code: "invoice_required" });
      }
      await bridgeAcceptedQuoteToProject(quote);
      const iidEnc = encodeURIComponent(String(inv.id));
      await supabaseRequest(`invoices?id=eq.${iidEnc}&tenant_id=eq.${tidEnc}`, {
        method: "PATCH",
        body: { payment_status: "check_pending" }
      });
      return json(200, { ok: true, action: "check_pending" });
    }

    if (action === "deposit_received") {
      if (!quoteIsAccepted(quote)) {
        return json(422, { error: "Accept the quote before marking deposit received." });
      }

      // CH-009-P2C — invoice first; zero project/quote/invoice writes if missing.
      const invoices = await fetchInvoicesForQuote(tenantId, quoteId);
      const { invoice: inv } = selectActiveInvoiceForQuote(invoices);
      if (!inv?.id) {
        return json(422, { error: NO_INVOICE_HUB_MSG, code: "invoice_required" });
      }

      await bridgeAcceptedQuoteToProject(quote);

      await supabaseRequest(`quotes?id=eq.${qidEnc}&tenant_id=eq.${tidEnc}`, {
        method: "PATCH",
        body: {
          deposit_paid_at: nowIso,
          updated_at: nowIso
        }
      });

      const iidEnc = encodeURIComponent(String(inv.id));
      await supabaseRequest(`invoices?id=eq.${iidEnc}&tenant_id=eq.${tidEnc}`, {
        method: "PATCH",
        body: { payment_status: "deposit_paid" }
      });

      let tp = await fetchTenantProjectForQuote(tenantId, quoteId);
      if (!tp?.id) {
        const q2 = (await fetchQuoteForTenant(tenantId, quoteId)) || quote;
        await bridgeAcceptedQuoteToProject(q2);
        tp = await fetchTenantProjectForQuote(tenantId, quoteId);
      }
      if (tp?.id && UUID_RE.test(String(tp.id))) {
        const pidEnc = encodeURIComponent(String(tp.id));
        await supabaseRequest(`tenant_projects?id=eq.${pidEnc}&tenant_id=eq.${tidEnc}`, {
          method: "PATCH",
          body: {
            deposit_paid: true,
            status: "deposit_paid",
            updated_at: nowIso
          }
        });
      }

      return json(200, { ok: true, action: "deposit_received" });
    }

    return json(400, { error: "Unsupported action" });
  } catch (err) {
    console.error("[hub-quote-manual-step]", err);
    return json(500, { ok: false, error: err.message || "Server error" });
  }
};

exports.isActiveInvoiceForDepositAction = isActiveInvoiceForDepositAction;
exports.selectActiveInvoiceForQuote = selectActiveInvoiceForQuote;
exports.INACTIVE_INVOICE_STATUSES = INACTIVE_INVOICE_STATUSES;
