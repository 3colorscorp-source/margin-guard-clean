/**
 * Scheduled (Netlify cron): past-due invoice reminders via Zapier (due_date ladder D1–D14).
 * Env: ZAPIER_INVOICE_REMINDER_WEBHOOK
 */
const fetch = globalThis.fetch;
if (!fetch) {
  throw new Error("Global fetch is not available. Set Netlify Node to 18+.");
}

const { supabaseRequest } = require("./_lib/supabase-admin");

const MAX_SCAN = 250;
const MAX_SENDS_PER_RUN = 40;

const STAGES = [
  { key: "D1", days: 1, column: "reminder_d1_sent_at" },
  { key: "D3", days: 3, column: "reminder_d3_sent_at" },
  { key: "D7", days: 7, column: "reminder_d7_sent_at" },
  { key: "D14", days: 14, column: "reminder_d14_sent_at" }
];

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

function parseDateOnlyUtc(value) {
  const s = String(value || "").trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null;
  return new Date(Date.UTC(y, mo, d));
}

/** Whole UTC calendar days after due_date (1 = first day past due). */
function calendarDaysPastDue(dueDateStr) {
  const due = parseDateOnlyUtc(dueDateStr);
  if (!due) return -1;
  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const dueUtc = Date.UTC(due.getUTCFullYear(), due.getUTCMonth(), due.getUTCDate());
  return Math.floor((todayUtc - dueUtc) / 86400000);
}

function remainingBalance(inv) {
  const amt = Number(inv.amount || 0);
  const paid = Number(inv.paid_amount || 0);
  let bal = Number(inv.balance_due);
  if (!Number.isFinite(bal)) bal = amt - paid;
  if (!Number.isFinite(bal)) return 0;
  return Math.round(bal * 100) / 100;
}

function statusLower(inv) {
  return String(inv.status || "").trim().toLowerCase();
}

function isArchived(inv) {
  return statusLower(inv) === "archived";
}

/** True if invoice should be treated as paid (do not remind). */
function isPaid(inv) {
  if (statusLower(inv) === "paid") return true;
  const bal = remainingBalance(inv);
  if (!(bal > 0)) return true;
  const amt = Number(inv.amount || 0);
  const paid = Number(inv.paid_amount || 0);
  if (amt > 0 && paid >= amt) return true;
  return false;
}

function hasClientEmail(inv) {
  const e = pickFirstStr(inv.customer_email);
  return e.includes("@") && e.length >= 5;
}

/** First stage in order that is due by calendar day and not yet sent. */
function nextReminderStage(inv, daysPastDue) {
  if (daysPastDue < 1) return null;
  for (const { key, days, column } of STAGES) {
    if (daysPastDue < days) return null;
    if (inv[column]) continue;
    return { key, column };
  }
  return null;
}

function buildPayload(inv, tenantName, stageKey, remainingBal) {
  const tenant_id = String(inv.tenant_id || "").trim();
  const invoice_id = String(inv.id || "").trim();
  const quote_id = String(inv.quote_id || "").trim();
  const project_id = String(inv.project_id || "").trim();
  const public_token = pickFirstStr(inv.public_token);
  const siteUrl = String(process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.SITE_URL || "")
    .trim()
    .replace(/\/+$/, "");
  const public_invoice_url = public_token
    ? (siteUrl
      ? `${siteUrl}/invoice-public.html?token=${encodeURIComponent(public_token)}`
      : `/invoice-public.html?token=${encodeURIComponent(public_token)}`)
    : "";
  const event_type = "invoice_reminder";
  const schema_version = "invoice_webhook_v1";
  const idempotency_key = `${tenant_id}:${invoice_id}:${stageKey}`;
  return {
    client_email: pickFirstStr(inv.customer_email),
    "Client Email": pickFirstStr(inv.customer_email),
    client_name: pickFirstStr(inv.customer_name, inv.project_name),
    business_name: pickFirstStr(inv.business_name, tenantName),
    project_name: pickFirstStr(inv.project_name),
    invoice_label: pickFirstStr(inv.invoice_label),
    invoice_number: pickFirstStr(inv.invoice_no),
    public_invoice_url,
    "Public Invoice Url": public_invoice_url,
    tenant_id,
    invoice_id,
    quote_id,
    project_id,
    event_type,
    schema_version,
    idempotency_key,
    remaining_balance: remainingBal,
    is_paid: false,
    is_archived: false,
    reminder_stage: stageKey
  };
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

  const webhookUrl = String(process.env.ZAPIER_INVOICE_REMINDER_WEBHOOK || "").trim();
  if (!webhookUrl) {
    console.info("[invoice-followups-due] ZAPIER_INVOICE_REMINDER_WEBHOOK missing; noop");
    return json(200, { ok: true, skipped: true, reason: "reminder_webhook_not_configured" });
  }

  let list = [];
  try {
    const rows = await supabaseRequest(
      `invoices?due_date=not.is.null&tenant_id=not.is.null&order=due_date.asc&limit=${MAX_SCAN}`,
      { method: "GET" }
    );
    list = Array.isArray(rows) ? rows : [];
  } catch (e) {
    console.warn("[invoice-followups-due] list failed", e?.message || e);
    return json(500, { ok: false, error: e.message || "list failed" });
  }

  const stats = {
    scanned: list.length,
    sent: 0,
    skipped: 0,
    errors: 0,
    byStage: { D1: 0, D3: 0, D7: 0, D14: 0 }
  };
  const tenantNameCache = new Map();

  for (const inv of list) {
    if (stats.sent >= MAX_SENDS_PER_RUN) break;
    if (!inv?.id || !inv.tenant_id) {
      stats.skipped += 1;
      continue;
    }
    if (isArchived(inv) || isPaid(inv)) {
      stats.skipped += 1;
      continue;
    }
    if (!hasClientEmail(inv)) {
      stats.skipped += 1;
      continue;
    }

    const bal = remainingBalance(inv);
    if (!(bal > 0)) {
      stats.skipped += 1;
      continue;
    }

    const daysPast = calendarDaysPastDue(inv.due_date);
    if (daysPast < 1) {
      stats.skipped += 1;
      continue;
    }

    const stage = nextReminderStage(inv, daysPast);
    if (!stage) {
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

    const payload = buildPayload(inv, tenantName, stage.key, bal);
    const claimAt = new Date().toISOString();
    const invoiceIdEnc = encodeURIComponent(String(inv.id));
    const tenantIdEnc = encodeURIComponent(String(inv.tenant_id));

    try {
      const claimRows = await supabaseRequest(
        `invoices?id=eq.${invoiceIdEnc}&tenant_id=eq.${tenantIdEnc}&${stage.column}=is.null`,
        {
          method: "PATCH",
          headers: { Prefer: "return=representation" },
          body: { [stage.column]: claimAt, updated_at: claimAt }
        }
      );
      const claimed = Array.isArray(claimRows) ? claimRows : claimRows ? [claimRows] : [];
      if (!claimed.length) {
        stats.skipped += 1;
        continue;
      }

      console.log("[zapier-reminder]", {
        tenant_id: String(inv.tenant_id),
        invoice_id: String(inv.id),
        reminder_stage: stage.key,
        idempotency_key: payload.idempotency_key
      });

      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        console.warn("[invoice-followups-due] Zapier non-OK", {
          invoiceId: inv.id,
          stage: stage.key,
          status: res.status
        });
        await supabaseRequest(
          `invoices?id=eq.${invoiceIdEnc}&tenant_id=eq.${tenantIdEnc}&${stage.column}=eq.${encodeURIComponent(claimAt)}`,
          {
            method: "PATCH",
            headers: { Prefer: "return=minimal" },
            body: { [stage.column]: null, updated_at: new Date().toISOString() }
          }
        ).catch(() => {});
        stats.errors += 1;
        continue;
      }

      const nowIso = new Date().toISOString();
      const patchBody = {
        last_reminder_at: nowIso,
        updated_at: nowIso
      };

      await supabaseRequest(
        `invoices?id=eq.${invoiceIdEnc}&tenant_id=eq.${tenantIdEnc}`,
        { method: "PATCH", headers: { Prefer: "return=minimal" }, body: patchBody }
      );
      stats.sent += 1;
      if (stats.byStage[stage.key] != null) stats.byStage[stage.key] += 1;
      console.log("[invoice-followups-due] sent", stage.key, "invoice", inv.id);
    } catch (e) {
      console.warn("[invoice-followups-due] send/patch failed", inv.id, e?.message || e);
      stats.errors += 1;
    }
  }

  return json(200, { ok: true, ...stats });
};
