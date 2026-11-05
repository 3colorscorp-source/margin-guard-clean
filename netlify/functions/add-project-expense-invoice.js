/**
 * Owner action: add selected project expenses to one draft expense invoice.
 * Does not email, charge, record a payment, or mark the invoice sent.
 * Does not set quote_id. The contract invoice keeps the one allowed quote link.
 */
const { readSessionFromEvent } = require("./_lib/session");
const { supabaseRequest } = require("./_lib/supabase-admin");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");
const { hasOwnerSessionIdentity } = require("./_lib/owner-access");
const {
  resolveProfileRoleForSession,
  roleMayAccessFinancialSnapshot,
} = require("./_lib/resolve-profile-role");
const { makePublicToken } = require("./_lib/public-token");
const {
  planProjectExpenseInvoice,
  nextExpenseInsertPayload,
  missingInvoiceColumn,
} = require("./_lib/project-expense-invoice");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  };
}

function text(value, max) {
  return String(value == null ? "" : value)
    .trim()
    .slice(0, max || 500);
}

function dueInThirtyDays(now) {
  const d = new Date(now.getTime());
  d.setUTCDate(d.getUTCDate() + 30);
  return d.toISOString().slice(0, 10);
}

async function loadProject(tenantId, projectId) {
  const tid = encodeURIComponent(tenantId);
  const pid = encodeURIComponent(projectId);
  const rows = await supabaseRequest(
    `tenant_projects?id=eq.${pid}&tenant_id=eq.${tid}&select=id,project_name,client_name,client_email,quote_id&limit=1`
  );
  return Array.isArray(rows) ? rows[0] : null;
}

async function loadExpenses(tenantId, projectId) {
  const tid = encodeURIComponent(tenantId);
  const pid = encodeURIComponent(projectId);
  const rows = await supabaseRequest(
    `tenant_project_expenses?tenant_id=eq.${tid}&project_id=eq.${pid}&select=id,expense_date,amount,note,day_number&order=expense_date.asc,created_at.asc`
  );
  return Array.isArray(rows) ? rows : [];
}

const INVOICE_LOOKUP_COLUMNS = [
  "id",
  "status",
  "notes",
  "amount",
  "paid_amount",
  "balance_due",
  "project_id",
  "quote_id",
  "invoice_label",
  "customer_name",
  "customer_email",
  "project_name",
  "business_name",
  "currency",
  "created_at",
];

async function loadProjectInvoices(tenantId, projectId) {
  const tid = encodeURIComponent(tenantId);
  const pid = encodeURIComponent(projectId);
  const columns = INVOICE_LOOKUP_COLUMNS.slice();
  let lastError = null;
  for (let attempt = 0; attempt < columns.length; attempt += 1) {
    try {
      const rows = await supabaseRequest(
        `invoices?tenant_id=eq.${tid}&project_id=eq.${pid}&select=${columns.join(",")}&order=created_at.desc&limit=100`
      );
      return Array.isArray(rows) ? rows : [];
    } catch (err) {
      lastError = err;
      const missing = missingInvoiceColumn(err && err.message ? err.message : err);
      const index = columns.indexOf(missing);
      if (!missing || missing === "project_id" || index < 0) break;
      columns.splice(index, 1);
    }
  }
  throw lastError;
}

function contactFrom(project, invoices) {
  const list = Array.isArray(invoices) ? invoices : [];
  const withEmail = list.find((row) => text(row && row.customer_email, 200).includes("@"));
  const named = list.find((row) => text(row && row.customer_name, 200));
  return {
    customerName: text(project && project.client_name, 300) || text(named && named.customer_name, 300),
    customerEmail: text(project && project.client_email, 200) || text(withEmail && withEmail.customer_email, 200),
    projectName: text(project && project.project_name, 300) || text(named && named.project_name, 300),
    businessName: text(withEmail && withEmail.business_name, 300) || text(named && named.business_name, 300),
    currency: text(withEmail && withEmail.currency, 12) || "USD",
  };
}

function publicResult(plan, invoiceId) {
  return {
    ok: true,
    action: plan.action,
    created: plan.created === true,
    invoice_id: invoiceId || null,
    billed_expense_ids: plan.billedExpenseIds || [],
    skipped_expense_ids: plan.skippedExpenseIds || [],
    quote_id_set: false,
  };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "GET" && event.httpMethod !== "POST") {
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
      return json(403, { ok: false, error: "Project expense billing is restricted to the owner." });
    }

    const tenantId = String(tenant.id);
    let projectId = "";
    let selectedIds = [];
    if (event.httpMethod === "GET") {
      projectId = text((event.queryStringParameters || {}).project_id, 80);
    } else {
      let body = {};
      try {
        body = JSON.parse(event.body || "{}");
      } catch (_err) {
        return json(400, { ok: false, error: "Invalid JSON body." });
      }
      projectId = text(body.project_id || body.projectId, 80);
      selectedIds = Array.isArray(body.expense_ids) ? body.expense_ids : [];
    }

    if (!projectId || !UUID_RE.test(projectId)) {
      return json(400, { ok: false, error: "project_id is required" });
    }

    const project = await loadProject(tenantId, projectId);
    if (!project?.id) {
      return json(403, { ok: false, error: "Project not found for this tenant" });
    }

    const [expenses, invoices] = await Promise.all([
      loadExpenses(tenantId, projectId),
      loadProjectInvoices(tenantId, projectId),
    ]);

    if (event.httpMethod === "GET") {
      const look = planProjectExpenseInvoice({
        projectId,
        selectedIds: [],
        expenses,
        invoices,
      });
      const draft = invoices.find(
        (row) =>
          String(row.project_id || "") === projectId &&
          String(row.status || "").trim().toLowerCase() === "draft" &&
          String(row.notes || "").indexOf("[invoice_type:project_expenses]") >= 0
      );
      return json(200, {
        ok: true,
        action: "none",
        created: false,
        invoice_id: draft && draft.id ? String(draft.id) : null,
        billed_expense_ids: look.billedExpenseIds || [],
        quote_id_set: false,
      });
    }

    const plan = planProjectExpenseInvoice({
      projectId,
      selectedIds,
      expenses,
      invoices,
    });
    if (!plan.ok) {
      return json(400, { ok: false, code: plan.code, error: plan.error });
    }
    if (plan.action === "none") {
      return json(200, publicResult(plan, null));
    }

    const now = new Date();
    const nowIso = now.toISOString();

    if (plan.action === "append") {
      let patchBody = {
        notes: plan.patch.notes,
        amount: plan.patch.amount,
        balance_due: plan.patch.balance_due,
        invoice_label: plan.patch.invoice_label,
        updated_at: nowIso,
      };
      let updated = null;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
          updated = await supabaseRequest(
            `invoices?id=eq.${encodeURIComponent(plan.invoiceId)}&tenant_id=eq.${encodeURIComponent(tenantId)}`,
            {
              method: "PATCH",
              headers: { Prefer: "return=representation" },
              body: patchBody,
            }
          );
          break;
        } catch (patchErr) {
          const msg = String(patchErr && patchErr.message ? patchErr.message : patchErr || "");
          const next = nextExpenseInsertPayload(Object.assign({ project_id: projectId }, patchBody), msg);
          if (next.action !== "retry" || !next.payload) throw patchErr;
          patchBody = next.payload;
          delete patchBody.project_id;
          delete patchBody.quote_id;
        }
      }
      const row = Array.isArray(updated) ? updated[0] : updated;
      return json(200, publicResult(plan, row && row.id ? String(row.id) : plan.invoiceId));
    }

    const contact = contactFrom(project, invoices);
    const insertPayload = {
      tenant_id: tenantId,
      public_token: makePublicToken("inv"),
      invoice_no: "INV-" + String(now.getTime()),
      customer_name: contact.customerName,
      customer_email: contact.customerEmail,
      project_name: contact.projectName,
      invoice_label: plan.insert.invoice_label,
      notes: plan.insert.notes,
      amount: plan.insert.amount,
      paid_amount: 0,
      balance_due: plan.insert.balance_due,
      issue_date: nowIso.slice(0, 10),
      due_date: dueInThirtyDays(now),
      type: plan.insert.type,
      business_name: contact.businessName,
      currency: contact.currency,
      status: "draft",
      project_id: projectId,
      created_at: nowIso,
      updated_at: nowIso,
    };

    let payload = insertPayload;
    let created;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        created = await supabaseRequest("invoices", {
          method: "POST",
          headers: { Prefer: "return=representation" },
          body: payload,
        });
        break;
      } catch (insertErr) {
        const msg = String(insertErr && insertErr.message ? insertErr.message : insertErr || "");
        const next = nextExpenseInsertPayload(payload, msg);
        if (next.action === "project_link_required") {
          return json(422, {
            ok: false,
            code: "project_link_required",
            error: "This expense invoice cannot be saved until it can be linked to the project.",
          });
        }
        if (next.action === "retry" && next.payload) {
          payload = next.payload;
          continue;
        }
        return json(500, { ok: false, code: "save_failed", error: "Could not save the expense invoice draft." });
      }
    }

    const row = Array.isArray(created) ? created[0] : created;
    if (!row || !row.id) {
      return json(500, { ok: false, code: "save_failed", error: "Could not save the expense invoice draft." });
    }
    return json(200, publicResult(plan, String(row.id)));
  } catch (_err) {
    return json(500, { ok: false, code: "save_failed", error: "Could not save the expense invoice draft." });
  }
};
