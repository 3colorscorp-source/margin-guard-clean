const fetch = globalThis.fetch;
if (!fetch) {
  throw new Error("Global fetch is not available in this runtime.");
}

const { getSupabaseConfig, supabaseRequest } = require("./_lib/supabase-admin");
const { makePublicToken } = require("./_lib/public-token");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}

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

/**
 * After a quote is accepted: idempotent tenant_projects + invoices draft rows.
 * tenant_id and quote_id come ONLY from the patched quote row (never from the client body).
 */
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

  // --- tenant_projects: idempotent on (tenant_id, quote_id) ---
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

  // --- invoices draft: idempotent on (tenant_id, quote_id) via lookup + insert or PATCH ---
  const invRows = await supabaseRequest(
    `invoices?tenant_id=eq.${tidEnc}&quote_id=eq.${qidEnc}&select=id,public_token`,
    { method: "GET" }
  );
  const invHit = Array.isArray(invRows) ? invRows[0] : null;

  if (invHit?.id && UUID_RE.test(String(invHit.id))) {
    const iidEnc = encodeURIComponent(String(invHit.id));
    await supabaseRequest(`invoices?id=eq.${iidEnc}&tenant_id=eq.${tidEnc}`, {
      method: "PATCH",
      body: {
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
    await supabaseRequest("invoices", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: {
        tenant_id: tenantId,
        quote_id: quoteId,
        public_token: makePublicToken("inv"),
        invoice_no: `INV-${Date.now()}`,
        customer_name: clientName,
        customer_email: clientEmail,
        project_name: projectName,
        amount: salePrice,
        paid_amount: 0,
        balance_due: salePrice,
        status: "draft",
        currency
      }
    });
  }
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { error: "Method Not Allowed" });
    }

    let supabaseUrl;
    let serviceRoleKey;
    try {
      ({ url: supabaseUrl, key: serviceRoleKey } = getSupabaseConfig());
    } catch (_e) {
      return json(500, { error: "Missing server configuration" });
    }

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch (_err) {
      return json(400, { error: "Invalid JSON" });
    }

    const rawToken = body.token;
    if (rawToken === undefined || rawToken === null) {
      return json(400, { error: "Missing token" });
    }
    const trimmed = String(rawToken).trim();
    if (trimmed === "") {
      return json(400, { error: "Missing token" });
    }
    if (trimmed.length < 10 || trimmed.length > 256) {
      return json(400, { error: "Invalid token" });
    }
    if (!/^[a-zA-Z0-9_]+$/.test(trimmed)) {
      return json(400, { error: "Invalid token" });
    }

    const status = String(body.status || "").trim().toLowerCase();

    if (!["accepted", "declined"].includes(status)) {
      return json(400, { error: "Invalid status" });
    }

    const nowIso = new Date().toISOString();

    const patch = {
      status,
      updated_at: nowIso
    };

    if (status === "accepted") {
      patch.accepted_at = nowIso;
    }

    const response = await fetch(
      `${supabaseUrl}/rest/v1/quotes?public_token=eq.${encodeURIComponent(trimmed)}&tenant_id=not.is.null`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          Prefer: "return=representation"
        },
        body: JSON.stringify(patch)
      }
    );

    const text = await response.text();

    if (!response.ok) {
      return json(502, {
        error: text || "Failed to update estimate status"
      });
    }

    let rows = [];
    try {
      rows = JSON.parse(text);
    } catch {
      rows = [];
    }

    const row = Array.isArray(rows) ? rows[0] : null;

    const rowAccepted =
      row &&
      typeof row === "object" &&
      String(row.status || "")
        .trim()
        .toLowerCase() === "accepted";

    if (status === "accepted" && rowAccepted) {
      try {
        await bridgeAcceptedQuoteToProjectAndInvoice(row);
      } catch (bridgeErr) {
        console.error("[accept-bridge] tenant_projects / invoices bridge failed", bridgeErr?.message || bridgeErr);
      }

      const acceptedWebhookUrl = String(process.env.ZAPIER_ESTIMATE_ACCEPTED_WEBHOOK_URL || "").trim();
      if (!acceptedWebhookUrl) {
        console.warn("[ZAPIER ACCEPTED WEBHOOK SKIPPED] missing webhook url");
      } else {
        try {
          const siteUrl = String(process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.SITE_URL || "")
            .trim()
            .replace(/\/+$/, "");
          const public_quote_url = siteUrl
            ? `${siteUrl}/estimate-public.html?token=${encodeURIComponent(trimmed)}`
            : "";

          const outbound = {
            event_type: "estimate_accepted",
            client_email: pickStr(row.client_email, 320),
            tenant_email: pickStr(row.business_email, 320),
            public_quote_url: pickStr(public_quote_url, 2000),
            business_name: pickStr(row.business_name, 300),
            to_name: pickStr(row.client_name, 200),
            quote_status: pickStr(row.status, 80),
            accepted_at: pickStr(row.accepted_at, 64),
            public_token: trimmed
          };

          console.log("[ZAPIER ACCEPTED WEBHOOK SEND] starting", { public_token: trimmed });
          const res = await fetch(acceptedWebhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(outbound)
          });
          console.log("[ZAPIER ACCEPTED WEBHOOK SEND] completed", { status: res.status });
          if (!res.ok) {
            console.warn("[ZAPIER ACCEPTED WEBHOOK] upstream non-OK", { status: res.status });
          }
        } catch (zErr) {
          console.error("[ZAPIER ACCEPTED WEBHOOK ERROR]", zErr);
        }
      }
    }

    return json(200, {
      ok: true,
      status,
      row
    });
  } catch (err) {
    return json(500, { error: err.message || "Server error" });
  }
};
