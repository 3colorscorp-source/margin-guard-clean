/**
 * Scheduled (Netlify cron): send invoice payment reminders via Zapier when
 * sent_at is set and the invoice is still open (not paid/void, balance open).
 *
 * Waves (from sent_at): +10 minutes, +24 hours, +72 hours — same webhook URL
 * as send-invoice (ZAPIER_INVOICE_SEND_WEBHOOK_URL). Payload matches invoice
 * send plus email_subject for the reminder line.
 *
 * Requires columns followup_1_sent_at, followup_2_sent_at, followup_3_sent_at
 * (see SUPABASE_INVOICES_FOLLOWUP_TRACKING.sql).
 */
const fetch = globalThis.fetch;
if (!fetch) {
  throw new Error("Global fetch is not available. Set Netlify Node to 18+.");
}

const { supabaseRequest } = require("./_lib/supabase-admin");

const TEN_MIN_MS = 10 * 60 * 1000;
const H24_MS = 24 * 60 * 60 * 1000;
const H72_MS = 72 * 60 * 60 * 1000;
const MAX_SCAN = 150;
const MAX_SENDS_PER_RUN = 40;

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}

function pickFirstStr(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  return "";
}

function originBase() {
  return String(process.env.URL || process.env.DEPLOY_PRIME_URL || "")
    .trim()
    .replace(/\/+$/, "");
}

function publicInvoiceUrl(origin, token) {
  const t = encodeURIComponent(String(token || "").trim());
  if (!t) return "";
  const o = String(origin || "").replace(/\/+$/, "");
  return o ? `${o}/invoice-public.html?token=${t}` : `/invoice-public.html?token=${t}`;
}

function buildReminderPayload(invoice, businessName, origin) {
  const token = String(invoice.public_token || "").trim();
  const client_name = pickFirstStr(invoice.customer_name, invoice.project_name);
  const client_email = pickFirstStr(invoice.customer_email);
  const business_name = businessName || "";
  const public_invoice_url = publicInvoiceUrl(origin, token);
  const displayBiz = business_name || "your contractor";
  return {
    client_name,
    "Client Email": client_email,
    "Public Invoice Url": public_invoice_url,
    business_name,
    email_subject: `Invoice balance reminder — ${displayBiz}`
  };
}

function msSinceSent(sentAtIso) {
  const t = Date.parse(String(sentAtIso || ""));
  if (!Number.isFinite(t)) return -1;
  return Date.now() - t;
}

function isInvoiceOpenForFollowup(inv) {
  const st = String(inv.status || "").toLowerCase();
  if (st === "paid" || st === "void") return false;
  const amt = Number(inv.amount || 0);
  const paid = Number(inv.paid_amount || 0);
  let bal = Number(inv.balance_due);
  if (!Number.isFinite(bal)) bal = amt - paid;
  if (amt > 0 && paid >= amt) return false;
  if (Number.isFinite(bal) && bal <= 0) return false;
  return true;
}

/** Which wave (1|2|3) is due, or 0 if none. Strictly sequential: 2 only after 1, 3 after 2. */
function dueFollowupWave(inv) {
  const elapsed = msSinceSent(inv.sent_at);
  if (elapsed < 0) return 0;
  if (!inv.followup_1_sent_at) {
    if (elapsed >= TEN_MIN_MS) return 1;
    return 0;
  }
  if (!inv.followup_2_sent_at) {
    if (elapsed >= H24_MS) return 2;
    return 0;
  }
  if (!inv.followup_3_sent_at) {
    if (elapsed >= H72_MS) return 3;
    return 0;
  }
  return 0;
}

exports.handler = async (event) => {
  if (
    event?.httpMethod &&
    event.httpMethod !== "GET" &&
    event.httpMethod !== "POST" &&
    event.httpMethod !== "HEAD"
  ) {
    return json(405, { ok: false, error: "Method Not Allowed" });
  }

  const webhookUrl = String(process.env.ZAPIER_INVOICE_SEND_WEBHOOK_URL || "").trim();
  if (!webhookUrl || /TU_WEBHOOK_URL_AQUI/i.test(webhookUrl)) {
    console.info("[invoice-followups-due] ZAPIER_INVOICE_SEND_WEBHOOK_URL missing; noop");
    return json(200, { ok: true, skipped: true, reason: "webhook_not_configured" });
  }

  const origin = originBase();
  let list = [];
  try {
    const rows = await supabaseRequest(
      `invoices?sent_at=not.is.null&order=sent_at.desc&limit=${MAX_SCAN}`,
      { method: "GET" }
    );
    list = Array.isArray(rows) ? rows : [];
  } catch (e) {
    console.warn("[invoice-followups-due] list failed", e?.message || e);
    return json(500, { ok: false, error: e.message || "list failed" });
  }

  const stats = { scanned: list.length, sent: 0, skipped: 0, errors: 0 };
  const tenantNameCache = new Map();

  for (const inv of list) {
    if (stats.sent >= MAX_SENDS_PER_RUN) break;
    if (!inv?.id || !inv.tenant_id) {
      stats.skipped += 1;
      continue;
    }
    if (!isInvoiceOpenForFollowup(inv)) {
      stats.skipped += 1;
      continue;
    }
    const wave = dueFollowupWave(inv);
    if (!wave) {
      stats.skipped += 1;
      continue;
    }

    const client_email = pickFirstStr(inv.customer_email);
    if (!client_email) {
      stats.skipped += 1;
      continue;
    }

    let tenantName = tenantNameCache.get(String(inv.tenant_id));
    if (tenantName === undefined) {
      tenantName = "";
      try {
        const trows = await supabaseRequest(
          `tenants?id=eq.${encodeURIComponent(String(inv.tenant_id))}&select=name&limit=1`,
          { method: "GET" }
        );
        const tr = Array.isArray(trows) && trows[0];
        tenantName = tr ? String(tr.name || "").trim() : "";
      } catch (_e) {
        tenantName = "";
      }
      tenantNameCache.set(String(inv.tenant_id), tenantName);
    }

    const businessName = pickFirstStr(inv.business_name, tenantName);
    const payload = buildReminderPayload(inv, businessName, origin);
    if (!payload["Client Email"] || !payload["Public Invoice Url"]) {
      stats.skipped += 1;
      continue;
    }

    try {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        console.warn("[invoice-followups-due] Zapier non-OK", {
          invoiceId: inv.id,
          wave,
          status: res.status
        });
        stats.errors += 1;
        continue;
      }

      const nowIso = new Date().toISOString();
      const patchBody =
        wave === 1
          ? { followup_1_sent_at: nowIso, updated_at: nowIso }
          : wave === 2
            ? { followup_2_sent_at: nowIso, updated_at: nowIso }
            : { followup_3_sent_at: nowIso, updated_at: nowIso };

      await supabaseRequest(
        `invoices?id=eq.${encodeURIComponent(String(inv.id))}&tenant_id=eq.${encodeURIComponent(String(inv.tenant_id))}`,
        { method: "PATCH", headers: { Prefer: "return=minimal" }, body: patchBody }
      );
      stats.sent += 1;
      console.log("[invoice-followups-due] sent wave", wave, "invoice", inv.id);
    } catch (e) {
      console.warn("[invoice-followups-due] send/patch failed", inv.id, e?.message || e);
      stats.errors += 1;
    }
  }

  return json(200, { ok: true, ...stats });
};
