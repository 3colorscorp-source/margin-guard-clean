const fetch = globalThis.fetch;
if (!fetch) {
  throw new Error("Global fetch is not available. Set Netlify Node to 18+.");
}

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

/** Structured error for Invoice Hub; `error` mirrors `message` for older clients. */
function jsonError(statusCode, reason, message, extra = {}) {
  const msg = String(message || "").trim() || String(reason || "").replace(/_/g, " ");
  return json(statusCode, {
    ok: false,
    reason: String(reason || "error"),
    message: msg,
    error: msg,
    ...extra
  });
}

function originFromEvent(event) {
  const host = String(event?.headers?.host || event?.headers?.["x-forwarded-host"] || "").split(",")[0].trim();
  if (!host) {
    const u = String(process.env.URL || process.env.DEPLOY_PRIME_URL || "").trim().replace(/\/+$/, "");
    return u;
  }
  const proto = String(event?.headers?.["x-forwarded-proto"] || "https")
    .split(",")[0]
    .trim()
    .replace(/:$/, "");
  return `${proto || "https"}://${host}`.replace(/\/+$/, "");
}

function pickFirstStr(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  return "";
}

async function loadInvoiceForTenant(tenantId, id, publicToken) {
  const params = new URLSearchParams();
  params.set("tenant_id", `eq.${tenantId}`);
  params.set("select", "*");
  params.set("limit", "2");

  if (id) {
    if (!UUID_RE.test(id)) {
      throw new Error("Invalid id (expected UUID).");
    }
    params.set("id", `eq.${id}`);
  } else {
    if (publicToken.length < 8 || publicToken.length > 256 || !/^[a-zA-Z0-9_]+$/.test(publicToken)) {
      throw new Error("Invalid public_token.");
    }
    params.set("public_token", `eq.${publicToken}`);
  }

  const path = `invoices?${params.toString()}`;
  const rows = await supabaseRequest(path, { method: "GET" });
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) return null;
  if (list.length > 1) throw new Error("Ambiguous invoice reference.");
  const invoice = list[0];
  if (String(invoice.tenant_id || "") !== tenantId) return null;
  return invoice;
}

/** Minimal probe when tenant-scoped lookup returns empty (wrong tenant vs missing). */
async function probeInvoiceTenantRow(id, publicToken) {
  try {
    if (id && UUID_RE.test(id)) {
      const rows = await supabaseRequest(
        `invoices?id=eq.${encodeURIComponent(id)}&select=id,tenant_id&limit=1`,
        { method: "GET" }
      );
      const list = Array.isArray(rows) ? rows : [];
      return list[0] || null;
    }
    if (
      publicToken &&
      publicToken.length >= 8 &&
      publicToken.length <= 256 &&
      /^[a-zA-Z0-9_]+$/.test(publicToken)
    ) {
      const rows = await supabaseRequest(
        `invoices?public_token=eq.${encodeURIComponent(publicToken)}&select=id,tenant_id&limit=1`,
        { method: "GET" }
      );
      const list = Array.isArray(rows) ? rows : [];
      return list[0] || null;
    }
  } catch (_e) {
    return null;
  }
  return null;
}

/**
 * POST — tenant-scoped invoice send: forward to Zapier, then mark sent in Supabase.
 * Body: { id } OR { public_token } (exactly one). Never trust client tenant_id.
 */
exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "Method Not Allowed" });
    }

    console.log("[Invoice Send] starting");

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
      return json(400, { ok: false, error: "Invalid JSON body" });
    }

    const id = String(pickFirstStr(body.id, body.invoice_id, body.invoiceId) || "").trim();
    const publicToken = String(pickFirstStr(body.public_token, body.publicToken) || "").trim();

    if (id && publicToken) {
      return json(400, { ok: false, error: "Provide only one of id or public_token." });
    }
    if (!id && !publicToken) {
      return json(400, { ok: false, error: "Missing id or public_token." });
    }

    let invoice;
    try {
      invoice = await loadInvoiceForTenant(tenantId, id, publicToken);
    } catch (e) {
      return json(400, { ok: false, error: e.message || "Invalid request" });
    }

    if (!invoice) {
      return json(404, { ok: false, error: "Invoice not found." });
    }

    const tenantRows = await supabaseRequest(
      `tenants?id=eq.${encodeURIComponent(tenantId)}&select=id,name,owner_email`
    );
    const tenantRow = Array.isArray(tenantRows) ? tenantRows[0] : null;

    // Webhook URL must come only from Netlify env (never hardcoded in repo).
    const webhookUrl = String(process.env.ZAPIER_INVOICE_SEND_WEBHOOK_URL || "").trim();
    if (!webhookUrl || /TU_WEBHOOK_URL_AQUI/i.test(webhookUrl)) {
      return jsonError(
        503,
        "webhook_not_configured",
        "Zapier invoice webhook is not configured. Set Netlify environment variable ZAPIER_INVOICE_SEND_WEBHOOK_URL to your real Zapier Catch Hook URL (https://hooks.zapier.com/...). Do not use an empty value or the placeholder text."
      );
    }

    const token = String(invoice.public_token || "").trim();
    if (!token) {
      return jsonError(422, "missing_public_token", "Missing public token; publish or sync draft first.");
    }

    const origin = originFromEvent(event);
    const publicInvoiceUrl = origin
      ? `${origin}/invoice-public.html?token=${encodeURIComponent(token)}`
      : `/invoice-public.html?token=${encodeURIComponent(token)}`;

    const businessName = pickFirstStr(invoice.business_name, tenantRow?.name);
    const client_name = pickFirstStr(invoice.customer_name, invoice.project_name);
    const client_email = pickFirstStr(invoice.customer_email);
    const public_invoice_url = publicInvoiceUrl;
    const business_name = businessName;

    /** Zapier Catch Hook field names (exact keys with spaces). */
    const payload = {
      client_name,
      "Client Email": client_email,
      "Public Invoice Url": public_invoice_url,
      business_name
    };

    let zapRes;
    try {
      zapRes = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload)
      });
    } catch (error) {
      console.warn("[Invoice Send] Zapier request failed", error?.message || error);
      return jsonError(502, "webhook_unreachable", "Unable to reach invoice send webhook.");
    }

    if (!zapRes.ok) {
      const zapierText = await zapRes.text().catch(() => "");
      console.warn("[Invoice Send] Zapier non-OK", zapRes.status, zapierText.slice(0, 500));
      return jsonError(502, "zapier_error", "Zapier webhook returned an error", {
        status: zapRes.status,
        details: zapierText.slice(0, 500)
      });
    }

    console.log("[Invoice Send] Zapier completed");

    const sentAt = new Date().toISOString();
    const filter = `id=eq.${encodeURIComponent(String(invoice.id))}&tenant_id=eq.${encodeURIComponent(tenantId)}`;
    const patchPath = `invoices?${filter}`;
    let updated;
    try {
      updated = await supabaseRequest(patchPath, {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: { sent_at: sentAt, updated_at: sentAt, status: "issued" }
      });
    } catch (patchErr) {
      const msg = String(patchErr?.message || patchErr || "");
      const status = patchErr?.status;
      const isLikelyStatusCheck =
        status === 400 || /check constraint|invoices_status_check|violates check/i.test(msg);
      if (!isLikelyStatusCheck) throw patchErr;
      console.warn("[Invoice Send] status issued not accepted, patching sent_at only", msg.slice(0, 400));
      updated = await supabaseRequest(patchPath, {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: { sent_at: sentAt, updated_at: sentAt }
      });
    }
    const rows = Array.isArray(updated) ? updated : updated ? [updated] : [];
    const row = rows[0];
    if (!row?.id) {
      return jsonError(
        500,
        "database_update_failed",
        "Invoice was forwarded but could not be updated in the database."
      );
    }

    console.log("[Invoice Send] invoice marked sent");

    return json(200, { ok: true, forwarded: true, invoice: row });
  } catch (error) {
    console.warn("[Invoice Send] error", error?.message || error);
    return jsonError(500, "server_error", error.message || "Server error");
  }
};
