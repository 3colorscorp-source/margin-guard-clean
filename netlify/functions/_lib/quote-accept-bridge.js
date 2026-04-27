/**
 * Idempotent bridge: accepted quote → tenant_projects row + invoices draft.
 * Used by public estimate accept and Invoice Hub manual accept.
 * tenant_id / quote_id must come only from the quote row passed in (never from untrusted client-only paths without prior quote fetch).
 */

const { supabaseRequest } = require("./supabase-admin");
const { makePublicToken } = require("./public-token");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function pickStr(v, maxLen) {
  const s = v == null || v === undefined ? "" : String(v).trim();
  if (!maxLen || maxLen < 1) return s;
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

function finiteMoney(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.round(n * 100) / 100;
}

async function bridgeAcceptedQuoteToProjectAndInvoice(quoteRow) {
  if (!quoteRow || typeof quoteRow !== "object") return;

  const tenantId = String(quoteRow.tenant_id || "").trim();
  const quoteId = String(quoteRow.id || "").trim();
  if (!UUID_RE.test(tenantId) || !UUID_RE.test(quoteId)) {
    console.warn("[accept-bridge] skip: invalid tenant_id or quote id on row");
    return;
  }

  const tidEnc = encodeURIComponent(tenantId);
  const qidEnc = encodeURIComponent(quoteId);
  const nowIso = new Date().toISOString();

  const projectName = pickStr(quoteRow.project_name || quoteRow.title, 2000).trim() || "Project";
  const clientName = pickStr(quoteRow.client_name, 500);
  const clientEmail = pickStr(quoteRow.client_email, 320);
  const salePrice = Math.max(finiteMoney(quoteRow.total, 0), 0);
  const signedAt = pickStr(quoteRow.accepted_at, 64) || nowIso;
  const currency = pickStr(quoteRow.currency, 8) || "USD";

  try {
    const tpRows = await supabaseRequest(
      `tenant_projects?tenant_id=eq.${tidEnc}&quote_id=eq.${qidEnc}&select=id`,
      { method: "GET" }
    );
    const tpHit = Array.isArray(tpRows) ? tpRows[0] : null;

    if (tpHit?.id && UUID_RE.test(String(tpHit.id))) {
      const pidEnc = encodeURIComponent(String(tpHit.id));
      await supabaseRequest(`tenant_projects?id=eq.${pidEnc}&tenant_id=eq.${tidEnc}`, {
        method: "PATCH",
        body: {
          project_name: projectName,
          client_name: clientName,
          client_email: clientEmail,
          sale_price: salePrice,
          recommended_price: salePrice,
          minimum_price: salePrice,
          status: "signed",
          updated_at: nowIso
        }
      });
    } else {
      try {
        await supabaseRequest("tenant_projects", {
          method: "POST",
          headers: { Prefer: "return=minimal" },
          body: {
            tenant_id: tenantId,
            quote_id: quoteId,
            project_name: projectName,
            client_name: clientName,
            client_email: clientEmail,
            status: "signed",
            signed_at: signedAt,
            deposit_paid: false,
            estimated_days: 0,
            labor_budget: 0,
            sale_price: salePrice,
            recommended_price: salePrice,
            minimum_price: salePrice,
            notes: "",
            quoted_labor_plan: [],
            created_at: nowIso,
            updated_at: nowIso
          }
        });
      } catch (e) {
        const raw = String(e?.supabaseRaw || e?.message || "");
        if (!/23505|duplicate key/i.test(raw)) throw e;
        const again = await supabaseRequest(
          `tenant_projects?tenant_id=eq.${tidEnc}&quote_id=eq.${qidEnc}&select=id`,
          { method: "GET" }
        );
        const againHit = Array.isArray(again) ? again[0] : null;
        if (!againHit?.id || !UUID_RE.test(String(againHit.id))) throw e;
        const pidEnc2 = encodeURIComponent(String(againHit.id));
        await supabaseRequest(`tenant_projects?id=eq.${pidEnc2}&tenant_id=eq.${tidEnc}`, {
          method: "PATCH",
          body: {
            project_name: projectName,
            client_name: clientName,
            client_email: clientEmail,
            sale_price: salePrice,
            recommended_price: salePrice,
            minimum_price: salePrice,
            status: "signed",
            updated_at: nowIso
          }
        });
      }
    }
  } catch (tpErr) {
    console.error("[accept-bridge] tenant_projects step failed (invoice step will still run)", tpErr);
  }

  console.log("[accept-bridge] project bridge done, starting invoice");

  const existingInvoices = await supabaseRequest(
    `invoices?tenant_id=eq.${tidEnc}&quote_id=eq.${qidEnc}&select=id,public_token,quote_id`,
    { method: "GET" }
  );
  console.log("[accept-bridge] existing invoices", existingInvoices);

  const invList = Array.isArray(existingInvoices)
    ? existingInvoices
    : existingInvoices && typeof existingInvoices === "object"
      ? [existingInvoices]
      : [];
  const invHit =
    invList.find(
      (r) =>
        r &&
        r.id &&
        UUID_RE.test(String(r.id)) &&
        String(r.quote_id || "").replace(/-/g, "").toLowerCase() ===
          String(quoteId).replace(/-/g, "").toLowerCase()
    ) || null;

  if (invHit?.id && UUID_RE.test(String(invHit.id))) {
    console.log("[accept-bridge] invoice path: PATCH existing", { id: invHit.id, quote_id: quoteId });
    const iidEnc = encodeURIComponent(String(invHit.id));
    await supabaseRequest(`invoices?id=eq.${iidEnc}&tenant_id=eq.${tidEnc}`, {
      method: "PATCH",
      body: {
        quote_id: quoteId,
        customer_name: clientName,
        customer_email: clientEmail,
        project_name: projectName,
        amount: salePrice,
        paid_amount: 0,
        balance_due: salePrice,
        currency
      }
    });
  } else {
    const rawTotal = Number(quoteRow.total || 0);
    const insertAmount = Number.isFinite(rawTotal) ? rawTotal : 0;
    const invoiceInsertPayload = {
      tenant_id: tenantId,
      quote_id: quoteId,
      public_token: makePublicToken("inv"),
      invoice_no: `INV-${Date.now()}`,
      customer_name: quoteRow.client_name || "",
      customer_email: quoteRow.client_email || "",
      project_name: quoteRow.project_name || "",
      amount: insertAmount,
      paid_amount: 0,
      balance_due: insertAmount,
      currency: pickStr(quoteRow.currency, 8) || "USD",
      status: "DRAFT",
      type: "FINAL"
    };

    console.log("[accept-bridge] inserting invoice", invoiceInsertPayload);

    try {
      const created = await supabaseRequest("invoices", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: invoiceInsertPayload
      });
      const invoiceRow = Array.isArray(created) ? created[0] : created;
      console.log("[accept-bridge] invoice created", invoiceRow);
    } catch (err) {
      console.error("[accept-bridge] invoice insert failed", err);
      if (err?.supabaseRaw) {
        console.error("[accept-bridge] invoice insert supabaseRaw", err.supabaseRaw);
      }
      throw err;
    }
  }
}

module.exports = {
  bridgeAcceptedQuoteToProjectAndInvoice,
  UUID_RE
};
