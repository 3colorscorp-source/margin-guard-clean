/**
 * Scheduled (Netlify cron): past-due invoice balance reminders via Zapier.
 *
 * Ladder (calendar days after due_date, UTC date math): D1, D3, D7, D14.
 * One webhook per qualifying stage; PATCH marks the stage sent only after Zapier POST succeeds.
 *
 * Env: ZAPIER_INVOICE_REMINDER_WEBHOOK (Catch Hook URL).
 * DB: reminder_d1_sent_at … reminder_d14_sent_at (see SUPABASE_INVOICES_DUE_DATE_REMINDER_LADDER.sql).
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

/** Parse YYYY-MM-DD (issue_date / due_date) to UTC midnight for that calendar day. */
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

/** Whole calendar days from due date to today (UTC). 0 = due today, 1 = first day after due, etc. */
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

function isPaidLike(inv) {
  const st = String(inv.status || "").trim().toLowerCase();
  if (st === "paid" || st === "void") return true;
  const bal = remainingBalance(inv);
  if (bal <= 0) return true;
  const amt = Number(inv.amount || 0);
  const paid = Number(inv.paid_amount || 0);
  if (amt > 0 && paid >= amt) return true;
  return false;
}

function isArchived(inv) {
  return String(inv.status || "").trim().toLowerCase() === "archived";
}

function hasClientEmail(inv) {
  const e = pickFirstStr(inv.customer_email);
  return e.includes("@") && e.length >= 5;
}

/**
 * Earliest ladder stage that qualifies and has not been sent yet (sequential catch-up).
 */
function nextReminderStage(inv, daysPastDue) {
  if (daysPastDue < 1) return null;
  for (const { key, days, column } of STAGES) {
    if (daysPastDue < days) return null;
    if (inv[column]) continue;
    return { key, days, column };
  }
  return null;
}

function buildReminderPayload(inv, tenantName, stageKey, remainingBal) {
  const business_name = pickFirstStr(inv.business_name, tenantName);
  const client_name = pickFirstStr(inv.customer_name, inv.project_name);
  const client_email = pickFirstStr(inv.customer_email);
  const project_name = pickFirstStr(inv.project_name);
  const invoice_label = pickFirstStr(inv.invoice_label);
  const invoice_number = pickFirstStr(inv.invoice_no);
  const st = String(inv.status || "").trim().toLowerCase();
  return {
    client_email,
    client_name,
    business_name,
    project_name,
    invoice_label,
    invoice_number,
    remaining_balance: remainingBal,
    is_paid: isPaidLike(inv),
    is_archived: st === "archived",
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
  if (!webhookUrl || /TU_WEBHOOK_URL_AQUI/i.test(webhookUrl)) {
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
    if (isArchived(inv) || isPaidLike(inv)) {
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

    const payload = buildReminderPayload(inv, tenantName, stage.key, bal);

    try {
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
        stats.errors += 1;
        continue;
      }

      const nowIso = new Date().toISOString();
      const patchBody = {
        [stage.column]: nowIso,
        last_reminder_at: nowIso,
        updated_at: nowIso
      };

      await supabaseRequest(
        `invoices?id=eq.${encodeURIComponent(String(inv.id))}&tenant_id=eq.${encodeURIComponent(String(inv.tenant_id))}`,
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
