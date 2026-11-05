/**
 * Plan a project expense draft invoice.
 * Lines are reimbursable field expenses. They never join the contract quote invoice.
 * quote_id stays unset: invoices_tenant_quote_unique allows one invoice per quote.
 */

const TYPE_MARKER = "[invoice_type:project_expenses]";
const ID_MARKER_RE = /\[mg_expense_ids:([^\]]*)\]/i;
const RELEASED_STATUSES = new Set(["void", "archived", "cancelled", "canceled"]);
const LABEL = "Project expenses";
// Draft writers persist only these. upsert-tenant-invoice-draft rewrites anything else to PROGRESS.
const STORED_INVOICE_TYPES = new Set(["DEPOSIT", "PROGRESS", "FINAL"]);
const INVOICE_TYPE = "PROGRESS";
const OPTIONAL_INSERT_COLUMNS = new Set([
  "invoice_label",
  "business_name",
  "currency",
  "customer_email",
  "customer_name",
  "project_name",
  "due_date",
]);

function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function text(value, max) {
  return String(value == null ? "" : value)
    .trim()
    .slice(0, max || 500);
}

function uniqueIds(raw) {
  const out = [];
  const seen = new Set();
  const list = Array.isArray(raw) ? raw : [];
  for (let i = 0; i < list.length; i += 1) {
    const id = text(list[i], 80);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function expenseIdsFromNotes(notes) {
  const match = String(notes || "").match(ID_MARKER_RE);
  if (!match) return [];
  return uniqueIds(String(match[1] || "").split(","));
}

function isProjectExpenseInvoice(row) {
  return String(row && row.notes ? row.notes : "").indexOf(TYPE_MARKER) >= 0;
}

function statusOf(row) {
  return text(row && row.status, 40).toLowerCase();
}

function releasedInvoice(row) {
  return RELEASED_STATUSES.has(statusOf(row));
}

function sameProject(row, projectId) {
  const pid = text(projectId, 80);
  const rowPid = text(row && row.project_id, 80);
  if (!pid) return false;
  if (!rowPid) return false;
  return rowPid === pid;
}

function conceptFromExpense(row) {
  const raw = text(row && (row.concept || row.note), 2000);
  const crewAt = raw.lastIndexOf("[[mg-crew:v1]]");
  const note = crewAt >= 0 ? raw.slice(0, crewAt).trim() : raw;
  const nl = note.indexOf("\n");
  const concept = (nl >= 0 ? note.slice(0, nl) : note).trim();
  return concept || "Expense";
}

function expenseDate(row) {
  const raw = text(row && row.expense_date, 32);
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : "";
}

function lineForExpense(row) {
  const date = expenseDate(row) || "Date not set";
  const concept = conceptFromExpense(row);
  const amount = money(row && row.amount);
  return date + " — " + concept + " — $" + amount.toFixed(2);
}

function buildNotes(expensesInOrder) {
  const lines = expensesInOrder.map(lineForExpense);
  const total = money(expensesInOrder.reduce((sum, row) => sum + money(row && row.amount), 0));
  const ids = expensesInOrder.map((row) => text(row && row.id, 80)).filter(Boolean);
  const body = [
    "Project expenses:",
    lines.join("\n"),
    "",
    "Invoice total:",
    "$" + total.toFixed(2),
    TYPE_MARKER,
    "[mg_expense_ids:" + ids.join(",") + "]",
  ].join("\n");
  return { notes: body, amount: total, expenseIds: ids };
}

function billedExpenseIds(invoices, projectId) {
  const ids = [];
  const seen = new Set();
  const list = Array.isArray(invoices) ? invoices : [];
  for (let i = 0; i < list.length; i += 1) {
    const row = list[i];
    if (!isProjectExpenseInvoice(row) || releasedInvoice(row)) continue;
    if (!sameProject(row, projectId)) continue;
    const found = expenseIdsFromNotes(row.notes);
    for (let j = 0; j < found.length; j += 1) {
      if (seen.has(found[j])) continue;
      seen.add(found[j]);
      ids.push(found[j]);
    }
  }
  return ids;
}

function openExpenseDraft(invoices, projectId) {
  const list = Array.isArray(invoices) ? invoices : [];
  const drafts = list.filter(
    (row) => isProjectExpenseInvoice(row) && !releasedInvoice(row) && statusOf(row) === "draft" && sameProject(row, projectId)
  );
  if (!drafts.length) return null;
  drafts.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
  return drafts[0];
}

function expensesForIds(catalog, ids) {
  const byId = new Map();
  const list = Array.isArray(catalog) ? catalog : [];
  for (let i = 0; i < list.length; i += 1) {
    const id = text(list[i] && list[i].id, 80);
    if (id) byId.set(id, list[i]);
  }
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

/**
 * Decide whether to leave invoices alone, append to the open expense draft, or create one.
 * Never targets an invoice that only exists because it holds the accepted quote.
 */
function planProjectExpenseInvoice({ projectId, selectedIds, expenses, invoices }) {
  const pid = text(projectId, 80);
  const billed = billedExpenseIds(invoices, pid);
  const billedSet = new Set(billed);
  const selected = uniqueIds(selectedIds);
  if (!pid) {
    return { ok: false, code: "project_required", error: "project_id is required" };
  }
  if (!selected.length) {
    return {
      ok: true,
      action: "none",
      created: false,
      billedExpenseIds: billed,
      skippedExpenseIds: [],
      quoteIdSet: false,
    };
  }

  const catalog = Array.isArray(expenses) ? expenses : [];
  const known = new Set(catalog.map((row) => text(row && row.id, 80)).filter(Boolean));
  const unknown = selected.filter((id) => !known.has(id));
  if (unknown.length) {
    return {
      ok: false,
      code: "unknown_expense",
      error: "One or more expenses are not on this project.",
      unknownExpenseIds: unknown,
    };
  }

  const fresh = selected.filter((id) => !billedSet.has(id));
  const skipped = selected.filter((id) => billedSet.has(id));
  if (!fresh.length) {
    return {
      ok: true,
      action: "none",
      created: false,
      billedExpenseIds: billed,
      skippedExpenseIds: skipped,
      quoteIdSet: false,
    };
  }

  const invalid = expensesForIds(catalog, fresh).filter((row) => !(money(row.amount) > 0));
  if (invalid.length) {
    return {
      ok: false,
      code: "invalid_amount",
      error: "Each selected expense needs an amount greater than zero.",
    };
  }

  const draft = openExpenseDraft(invoices, pid);
  const draftIds = draft ? expenseIdsFromNotes(draft.notes) : [];
  const combinedIds = uniqueIds(draftIds.concat(fresh));
  const combined = expensesForIds(catalog, combinedIds);
  if (combined.length !== combinedIds.length) {
    return {
      ok: false,
      code: "unknown_expense",
      error: "One or more expenses are not on this project.",
    };
  }
  const built = buildNotes(combined);
  const paid = draft ? money(draft.paid_amount) : 0;
  const patch = {
    notes: built.notes,
    amount: built.amount,
    balance_due: money(built.amount - paid),
    invoice_label: LABEL,
    project_id: pid,
  };
  if (draft && draft.id) {
    return {
      ok: true,
      action: "append",
      created: false,
      invoiceId: String(draft.id),
      patch,
      expenseIds: built.expenseIds,
      billedExpenseIds: uniqueIds(billed.concat(fresh)),
      skippedExpenseIds: skipped,
      quoteIdSet: false,
      lines: combined.map(lineForExpense),
    };
  }
  return {
    ok: true,
    action: "create",
    created: true,
    insert: {
      invoice_label: LABEL,
      notes: built.notes,
      amount: built.amount,
      paid_amount: 0,
      balance_due: built.amount,
      type: INVOICE_TYPE,
      status: "draft",
      project_id: pid,
    },
    expenseIds: built.expenseIds,
    billedExpenseIds: uniqueIds(billed.concat(fresh)),
    skippedExpenseIds: skipped,
    quoteIdSet: false,
    lines: combined.map(lineForExpense),
  };
}

function storedInvoiceType(raw) {
  const type = String(raw || "").trim().toUpperCase();
  return STORED_INVOICE_TYPES.has(type) ? type : "";
}

/**
 * PostgREST reports a missing column as:
 * Could not find the 'project_id' column of 'invoices' in the schema cache
 * The previous handler only matched SQL text "column project_id does not exist",
 * so every other rejection became "Could not save the expense invoice draft."
 */
function missingInvoiceColumn(message) {
  const text = String(message || "");
  let match = text.match(/Could not find the '([A-Za-z0-9_]+)' column/i);
  if (match) return match[1];
  match = text.match(/column (?:[\w."]+\.)?"?([A-Za-z0-9_]+)"? does not exist/i);
  return match ? match[1] : "";
}

function nextExpenseInsertPayload(payload, message) {
  const source = payload && typeof payload === "object" ? payload : {};
  const column = missingInvoiceColumn(message);
  if (!column) return { action: "fail" };
  if (column === "project_id") return { action: "project_link_required" };
  if (!OPTIONAL_INSERT_COLUMNS.has(column)) return { action: "fail" };
  if (!Object.prototype.hasOwnProperty.call(source, column)) return { action: "fail" };
  const next = Object.assign({}, source);
  delete next[column];
  delete next.quote_id;
  if (!next.project_id) return { action: "project_link_required" };
  return { action: "retry", payload: next };
}

module.exports = {
  TYPE_MARKER,
  LABEL,
  INVOICE_TYPE,
  STORED_INVOICE_TYPES,
  planProjectExpenseInvoice,
  billedExpenseIds,
  expenseIdsFromNotes,
  isProjectExpenseInvoice,
  buildNotes,
  storedInvoiceType,
  missingInvoiceColumn,
  nextExpenseInsertPayload,
};
