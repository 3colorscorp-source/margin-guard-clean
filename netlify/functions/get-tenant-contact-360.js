/**
 * Step 3E-C17-J3 — read-only Contact 360 aggregator (owner/admin).
 */

const { supabaseRequest } = require("./_lib/supabase-admin");
const { readSessionFromEvent } = require("./_lib/session");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");
const {
  membershipRole,
  membershipIsActive,
  resolveMembershipByEmail,
} = require("./_lib/membership-resolve");
const { throwGuard } = require("./_lib/tenant-device-guard");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const OWNER_ADMIN_ROLES = new Set(["owner", "admin"]);
const APPROVED_QUOTE_STATUSES = new Set(["accepted", "approved"]);
const OPEN_QUOTE_STATUSES = new Set([
  "ready_to_send",
  "sent",
  "draft",
  "pending",
  "viewed",
]);
const CLOSED_INVOICE_STATUSES = new Set(["paid", "void", "archived", "cancelled"]);
const CHUNK_SIZE = 40;

const CONTACT_SELECT = [
  "id",
  "display_name",
  "first_name",
  "last_name",
  "company_name",
  "contact_type",
  "email",
  "phone",
  "city",
  "state",
  "status",
  "last_activity_at",
].join(",");

const QUOTE_SELECT = [
  "id",
  "quote_number_display",
  "project_name",
  "title",
  "status",
  "total",
  "deposit_required",
  "currency",
  "created_at",
  "updated_at",
  "accepted_at",
  "public_token",
].join(",");

const PROJECT_SELECT = [
  "id",
  "quote_id",
  "contact_id",
  "project_name",
  "client_name",
  "status",
  "sale_price",
  "signed_at",
  "created_at",
  "updated_at",
].join(",");

const INVOICE_SELECT = [
  "id",
  "quote_id",
  "project_id",
  "invoice_no",
  "customer_name",
  "project_name",
  "status",
  "amount",
  "paid_amount",
  "balance_due",
  "due_date",
  "created_at",
  "currency",
].join(",");

const PAYMENT_SELECT = [
  "id",
  "invoice_id",
  "quote_id",
  "project_id",
  "amount",
  "payment_method",
  "payment_type",
  "paid_at",
  "created_at",
].join(",");

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function pickFirst(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  return "";
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function roundMoney(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 100) / 100;
}

function normStatus(s) {
  return String(s || "")
    .trim()
    .toLowerCase();
}

function uniqueIds(ids) {
  return Array.from(
    new Set((ids || []).map((id) => String(id || "").trim()).filter((id) => UUID_RE.test(id)))
  );
}

async function requireOwnerOrAdmin(event) {
  const session = readSessionFromEvent(event);
  if (!session?.e || !session?.c) {
    throwGuard(401, "Unauthorized", "no_session");
  }

  const tenant = await resolveTenantFromSession(session);
  if (!tenant?.id) {
    throwGuard(422, "Tenant not found for this session.", "tenant_not_found");
  }

  const membership = await resolveMembershipByEmail(supabaseRequest, tenant.id, session.e);
  if (!membership?.id) {
    throwGuard(403, "Membership not found", "membership_not_found");
  }
  if (!membershipIsActive(membership)) {
    throwGuard(403, "Membership is not active", "membership_inactive");
  }
  const role = membershipRole(membership);
  if (!OWNER_ADMIN_ROLES.has(role)) {
    throwGuard(403, "Owner or admin membership required", "owner_required");
  }

  return { tenant, membership };
}

function buildPublicQuoteUrl(publicToken) {
  const token = String(publicToken || "").trim();
  if (!token) return null;
  const siteUrl = String(
    process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.SITE_URL || ""
  ).replace(/\/+$/, "");
  if (siteUrl) {
    return `${siteUrl}/estimate-public.html?token=${encodeURIComponent(token)}`;
  }
  return `/estimate-public.html?token=${encodeURIComponent(token)}`;
}

function serializeContact(row) {
  if (!row?.id) return null;
  return {
    id: row.id,
    display_name: row.display_name || "",
    first_name: row.first_name ?? null,
    last_name: row.last_name ?? null,
    company_name: row.company_name ?? null,
    contact_type: row.contact_type ?? null,
    email: row.email ?? null,
    phone: row.phone ?? null,
    city: row.city ?? null,
    state: row.state ?? null,
    status: row.status ?? null,
    last_activity_at: row.last_activity_at ?? null,
  };
}

function serializeQuote(row) {
  if (!row?.id) return null;
  return {
    id: row.id,
    quote_number_display: row.quote_number_display ?? null,
    estimate_number: row.quote_number_display ?? null,
    project_name: pickFirst(row.project_name, row.title) || null,
    status: row.status ?? null,
    total: row.total ?? null,
    deposit_required: row.deposit_required ?? null,
    currency: row.currency ?? "USD",
    created_at: row.created_at ?? null,
    accepted_at: row.accepted_at ?? null,
    public_url: buildPublicQuoteUrl(row.public_token),
  };
}

function serializeProject(row) {
  if (!row?.id) return null;
  const pid = String(row.id);
  return {
    id: row.id,
    quote_id: row.quote_id ?? null,
    contact_id: row.contact_id ?? null,
    project_name: row.project_name ?? null,
    client_name: row.client_name ?? null,
    status: row.status ?? null,
    sale_price: row.sale_price ?? null,
    signed_at: row.signed_at ?? null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
    project_control_url: `/project-control.html`,
    invoices_url: `/estimates-invoices.html?project_id=${encodeURIComponent(pid)}`,
  };
}

function serializeInvoice(row) {
  if (!row?.id) return null;
  const pid = row.project_id != null ? String(row.project_id).trim() : "";
  return {
    id: row.id,
    quote_id: row.quote_id ?? null,
    project_id: row.project_id ?? null,
    invoice_number: row.invoice_no ?? null,
    customer_name: row.customer_name ?? null,
    project_name: row.project_name ?? null,
    status: row.status ?? null,
    amount: row.amount ?? null,
    paid_amount: row.paid_amount ?? null,
    balance_due: row.balance_due ?? null,
    due_date: row.due_date ?? null,
    created_at: row.created_at ?? null,
    currency: row.currency ?? "USD",
    invoices_url: pid
      ? `/estimates-invoices.html?project_id=${encodeURIComponent(pid)}`
      : "/estimates-invoices.html",
  };
}

function serializePayment(row) {
  if (!row?.id) return null;
  return {
    id: row.id,
    invoice_id: row.invoice_id ?? null,
    quote_id: row.quote_id ?? null,
    project_id: row.project_id ?? null,
    amount: row.amount ?? null,
    method: row.payment_method ?? null,
    payment_type: row.payment_type ?? null,
    status: null,
    paid_at: row.paid_at ?? null,
    created_at: row.created_at ?? null,
  };
}

async function loadContactForTenant(tenantId, contactId) {
  const tid = encodeURIComponent(tenantId);
  const cid = encodeURIComponent(contactId);
  const rows = await supabaseRequest(
    `tenant_contacts?id=eq.${cid}&tenant_id=eq.${tid}&select=${CONTACT_SELECT}&limit=1`,
    { method: "GET" }
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function fetchRowsInChunks(table, tenantId, column, ids, select, order) {
  const tid = encodeURIComponent(tenantId);
  const out = [];
  const seen = new Set();
  const idList = uniqueIds(ids);
  if (!idList.length) return out;

  for (let i = 0; i < idList.length; i += CHUNK_SIZE) {
    const chunk = idList.slice(i, i + CHUNK_SIZE);
    const inList = chunk.map((id) => encodeURIComponent(id)).join(",");
    const path =
      `${table}?tenant_id=eq.${tid}&${column}=in.(${inList})` +
      `&select=${select}` +
      (order ? `&order=${order}` : "");
    const rows = await supabaseRequest(path, { method: "GET" });
    for (const row of Array.isArray(rows) ? rows : []) {
      const key = row?.id != null ? String(row.id) : "";
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(row);
    }
  }
  return out;
}

async function loadQuotesForContact(tenantId, contactId, limit) {
  const tid = encodeURIComponent(tenantId);
  const cid = encodeURIComponent(contactId);
  const rows = await supabaseRequest(
    `quotes?tenant_id=eq.${tid}&contact_id=eq.${cid}&select=${QUOTE_SELECT}&order=created_at.desc&limit=${limit}`,
    { method: "GET" }
  );
  return Array.isArray(rows) ? rows : [];
}

async function loadProjectsForContact(tenantId, contactId, quoteIds, limit) {
  const tid = encodeURIComponent(tenantId);
  const cid = encodeURIComponent(contactId);
  const byId = new Map();

  const direct = await supabaseRequest(
    `tenant_projects?tenant_id=eq.${tid}&contact_id=eq.${cid}&select=${PROJECT_SELECT}&order=created_at.desc&limit=${limit}`,
    { method: "GET" }
  );
  for (const row of Array.isArray(direct) ? direct : []) {
    if (row?.id) byId.set(String(row.id), row);
  }

  const quoteIdList = uniqueIds(quoteIds);
  if (quoteIdList.length) {
    const viaQuote = await fetchRowsInChunks(
      "tenant_projects",
      tenantId,
      "quote_id",
      quoteIdList,
      PROJECT_SELECT,
      "created_at.desc"
    );
    for (const row of viaQuote) {
      if (row?.id) byId.set(String(row.id), row);
    }
  }

  return Array.from(byId.values())
    .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")))
    .slice(0, limit);
}

async function loadInvoicesForLinks(tenantId, quoteIds, projectIds, limit) {
  const byId = new Map();

  const viaProject = await fetchRowsInChunks(
    "invoices",
    tenantId,
    "project_id",
    projectIds,
    INVOICE_SELECT,
    "created_at.desc"
  );
  for (const row of viaProject) {
    if (row?.id) byId.set(String(row.id), row);
  }

  const viaQuote = await fetchRowsInChunks(
    "invoices",
    tenantId,
    "quote_id",
    quoteIds,
    INVOICE_SELECT,
    "created_at.desc"
  );
  for (const row of viaQuote) {
    if (row?.id) byId.set(String(row.id), row);
  }

  return Array.from(byId.values())
    .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")))
    .slice(0, limit);
}

async function loadPaymentsForLinks(tenantId, invoiceIds, quoteIds, projectIds, limit) {
  const byId = new Map();

  const viaInvoice = await fetchRowsInChunks(
    "tenant_project_payments",
    tenantId,
    "invoice_id",
    invoiceIds,
    PAYMENT_SELECT,
    "paid_at.desc"
  );
  for (const row of viaInvoice) {
    if (row?.id) byId.set(String(row.id), row);
  }

  const viaQuote = await fetchRowsInChunks(
    "tenant_project_payments",
    tenantId,
    "quote_id",
    quoteIds,
    PAYMENT_SELECT,
    "paid_at.desc"
  );
  for (const row of viaQuote) {
    if (row?.id) byId.set(String(row.id), row);
  }

  const viaProject = await fetchRowsInChunks(
    "tenant_project_payments",
    tenantId,
    "project_id",
    projectIds,
    PAYMENT_SELECT,
    "paid_at.desc"
  );
  for (const row of viaProject) {
    if (row?.id) byId.set(String(row.id), row);
  }

  return Array.from(byId.values())
    .sort((a, b) => String(b.paid_at || b.created_at || "").localeCompare(String(a.paid_at || a.created_at || "")))
    .slice(0, limit);
}

function invoiceOpenBalance(inv) {
  const st = normStatus(inv?.status);
  if (CLOSED_INVOICE_STATUSES.has(st)) return 0;
  const balance = roundMoney(inv?.balance_due);
  if (balance > 0) return balance;
  const amount = roundMoney(inv?.amount);
  const paid = roundMoney(inv?.paid_amount);
  return Math.max(0, roundMoney(amount - paid));
}

function isOpenInvoice(inv) {
  return invoiceOpenBalance(inv) > 0;
}

function computeTotals(quotes, projects, invoices, payments) {
  const quotedTotal = quotes.reduce((sum, q) => sum + roundMoney(q.total), 0);

  const projectQuoteIds = new Set(
    projects.map((p) => (p.quote_id != null ? String(p.quote_id) : "")).filter(Boolean)
  );

  const approvedTotal = quotes.reduce((sum, q) => {
    const st = normStatus(q.status);
    const approved =
      APPROVED_QUOTE_STATUSES.has(st) || projectQuoteIds.has(String(q.id || ""));
    return approved ? sum + roundMoney(q.total) : sum;
  }, 0);

  const invoicedTotal = invoices.reduce((sum, inv) => sum + roundMoney(inv.amount), 0);

  const paidTotal = payments.reduce((sum, p) => sum + roundMoney(p.amount), 0);

  const balanceDue = invoices.reduce((sum, inv) => sum + invoiceOpenBalance(inv), 0);

  const openInvoiceCount = invoices.filter((inv) => isOpenInvoice(inv)).length;

  return {
    quote_count: quotes.length,
    project_count: projects.length,
    invoice_count: invoices.length,
    payment_count: payments.length,
    quoted_total: roundMoney(quotedTotal),
    approved_total: roundMoney(approvedTotal),
    invoiced_total: roundMoney(invoicedTotal),
    paid_total: roundMoney(paidTotal),
    balance_due: roundMoney(balanceDue),
    open_invoice_count: openInvoiceCount,
  };
}

function parseIsoMs(value) {
  const s = String(value || "").trim();
  if (!s) return 0;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : 0;
}

function computeLastActivityAt(contact, quotes, projects, invoices, payments) {
  const candidates = [contact?.last_activity_at];
  for (const q of quotes) candidates.push(q.updated_at, q.created_at, q.accepted_at);
  for (const p of projects) candidates.push(p.updated_at, p.created_at, p.signed_at);
  for (const inv of invoices) candidates.push(inv.created_at, inv.due_date);
  for (const pay of payments) candidates.push(pay.paid_at, pay.created_at);

  let bestMs = 0;
  let bestIso = contact?.last_activity_at ?? null;
  for (const raw of candidates) {
    const ms = parseIsoMs(raw);
    if (ms > bestMs) {
      bestMs = ms;
      bestIso = raw;
    }
  }
  return bestIso;
}

function deriveNextAction(quotes, projects, invoices) {
  const openInvoices = invoices.filter((inv) => isOpenInvoice(inv));
  if (openInvoices.length) {
    const sorted = [...openInvoices].sort((a, b) => invoiceOpenBalance(b) - invoiceOpenBalance(a));
    const top = sorted[0];
    const num = top?.invoice_no ? String(top.invoice_no) : "";
    const bal = roundMoney(invoiceOpenBalance(top));
    return {
      label: "Collect open invoice balance",
      detail: num ? `Invoice ${num} · $${bal.toFixed(2)} due` : `$${bal.toFixed(2)} due`,
      invoice_id: top?.id ?? null,
    };
  }

  const openQuotes = quotes.filter((q) => OPEN_QUOTE_STATUSES.has(normStatus(q.status)));
  if (openQuotes.length) {
    const top = openQuotes[0];
    const num = top?.quote_number_display ? String(top.quote_number_display) : "";
    return {
      label: "Follow up on open quote",
      detail: num || pickFirst(top?.project_name) || "Quote pending",
      quote_id: top?.id ?? null,
    };
  }

  const activeProjects = projects.filter((p) => {
    const st = normStatus(p.status);
    return st && st !== "completed" && st !== "cancelled" && st !== "archived";
  });
  if (activeProjects.length) {
    const top = activeProjects[0];
    return {
      label: "Review project status",
      detail: pickFirst(top?.project_name) || "Active project",
      project_id: top?.id ?? null,
    };
  }

  return null;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "GET") {
      return json(405, { ok: false, error: "Method Not Allowed" });
    }

    const { tenant } = await requireOwnerOrAdmin(event);
    const tenantId = String(tenant.id);
    const qs = event.queryStringParameters || {};

    const contactId = pickFirst(qs.contact_id, qs.contactId);
    if (!contactId) {
      return json(400, { ok: false, error: "contact_id is required", code: "contact_id_required" });
    }
    if (!UUID_RE.test(contactId)) {
      return json(400, { ok: false, error: "Invalid contact_id", code: "invalid_contact_id" });
    }

    const limit = clampInt(qs.limit, 1, 100, 50);

    const contactRow = await loadContactForTenant(tenantId, contactId);
    if (!contactRow) {
      return json(404, { ok: false, error: "Contact not found", code: "contact_not_found" });
    }

    const quoteRows = await loadQuotesForContact(tenantId, contactId, limit);
    const quoteIds = quoteRows.map((q) => q.id).filter(Boolean);

    const projectRows = await loadProjectsForContact(tenantId, contactId, quoteIds, limit);
    const projectIds = projectRows.map((p) => p.id).filter(Boolean);

    const invoiceRows = await loadInvoicesForLinks(tenantId, quoteIds, projectIds, limit);
    const invoiceIds = invoiceRows.map((inv) => inv.id).filter(Boolean);

    const paymentRows = await loadPaymentsForLinks(
      tenantId,
      invoiceIds,
      quoteIds,
      projectIds,
      limit
    );

    const quotes = quoteRows.map(serializeQuote).filter(Boolean);
    const projects = projectRows.map(serializeProject).filter(Boolean);
    const invoices = invoiceRows.map(serializeInvoice).filter(Boolean);
    const payments = paymentRows.map(serializePayment).filter(Boolean);

    const totals = computeTotals(quoteRows, projectRows, invoiceRows, paymentRows);
    const lastActivityAt = computeLastActivityAt(
      contactRow,
      quoteRows,
      projectRows,
      invoiceRows,
      paymentRows
    );
    const nextAction = deriveNextAction(quoteRows, projectRows, invoiceRows);

    return json(200, {
      ok: true,
      contact: serializeContact(contactRow),
      totals,
      activity: {
        last_activity_at: lastActivityAt,
        next_action: nextAction,
      },
      quotes,
      projects,
      invoices,
      payments,
    });
  } catch (err) {
    if (err?.isGuardError) {
      return json(err.statusCode || 403, { ok: false, error: err.message, code: err.code });
    }
    console.error("[get-tenant-contact-360]", err);
    return json(500, { ok: false, error: err.message || "Server error" });
  }
};
