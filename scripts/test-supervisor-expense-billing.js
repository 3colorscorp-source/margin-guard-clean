#!/usr/bin/env node
/**
 * Selected field expenses become one project draft. They do not join the contract quote invoice.
 * Run: node scripts/test-supervisor-expense-billing.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");
const {
  planProjectExpenseInvoice,
  TYPE_MARKER,
  storedInvoiceType,
  missingInvoiceColumn,
  nextExpenseInsertPayload,
} = require("../netlify/functions/_lib/project-expense-invoice");

const ROOT = path.resolve(__dirname, "..");
const PROJECT = "11111111-1111-4111-8111-111111111111";
const QUOTE = "22222222-2222-4222-8222-222222222222";

let passed = 0;
function ok(label, cond) {
  assert.ok(cond, label);
  passed += 1;
  console.log("PASS " + label);
}

const expenses = [
  { id: "e1", expense_date: "2026-11-04", amount: 22, note: "Caulking one tube" },
  { id: "e2", expense_date: "2026-11-04", amount: 20, note: "511 Sealer" },
  { id: "e3", expense_date: "2026-10-14", amount: 224, note: "Materials to cover all the work area" },
];

const contractOnly = [
  {
    id: "inv-contract",
    project_id: PROJECT,
    quote_id: QUOTE,
    invoice_label: "Contract",
    status: "draft",
    amount: 9114.61,
    notes: "Contract invoice linked to the accepted quote.",
    created_at: "2026-10-01T00:00:00.000Z",
  },
];

const none = planProjectExpenseInvoice({
  projectId: PROJECT,
  selectedIds: [],
  expenses,
  invoices: contractOnly,
});
ok("zero selection does not create an invoice", none.ok === true && none.action === "none" && none.created === false);

const first = planProjectExpenseInvoice({
  projectId: PROJECT,
  selectedIds: ["e1", "e2"],
  expenses,
  invoices: contractOnly,
});
ok("selected expenses create a draft", first.ok === true && first.action === "create" && first.created === true);
ok("the draft is linked to the project", first.insert.project_id === PROJECT);
ok("the draft does not take the quote link", first.quoteIdSet === false && !Object.prototype.hasOwnProperty.call(first.insert, "quote_id"));
ok("the contract invoice is not the target", first.action !== "append");
ok("each expense is one line at the stored amount", first.lines.length === 2 && first.insert.amount === 42);
ok("the line keeps the date and concept", first.lines[0] === "2026-11-04 — Caulking one tube — $22.00");
ok("the draft is marked as project expenses", first.insert.notes.indexOf(TYPE_MARKER) >= 0 && first.insert.status === "draft");
ok("type service is not a stored draft type", storedInvoiceType("service") === "");
ok("the draft now uses PROGRESS", storedInvoiceType(first.insert.type) === "PROGRESS" && first.insert.type === "PROGRESS");

const productionMissingColumn =
  "Supabase HTTP 400: Could not find the 'invoice_label' column of 'invoices' in the schema cache";
const oldProjectColumnRegex = /column .*project_id.* does not exist/i;
ok(
  "the old save catch does not recognize a PostgREST missing column",
  oldProjectColumnRegex.test(productionMissingColumn) === false && missingInvoiceColumn(productionMissingColumn) === "invoice_label"
);
const retried = nextExpenseInsertPayload(
  {
    project_id: PROJECT,
    type: first.insert.type,
    invoice_label: "Project expenses",
    notes: first.insert.notes,
    status: "draft",
    amount: first.insert.amount,
  },
  productionMissingColumn
);
ok(
  "a missing optional column retries without dropping the project link",
  retried.action === "retry" &&
    retried.payload.project_id === PROJECT &&
    retried.payload.type === "PROGRESS" &&
    !Object.prototype.hasOwnProperty.call(retried.payload, "invoice_label") &&
    !Object.prototype.hasOwnProperty.call(retried.payload, "quote_id")
);
const projectColumnMissing =
  "Supabase HTTP 400: Could not find the 'project_id' column of 'invoices' in the schema cache";
const blocked = nextExpenseInsertPayload(
  { project_id: PROJECT, type: "PROGRESS", notes: first.insert.notes },
  projectColumnMissing
);
ok("a missing project column still does not build an unlinked invoice", blocked.action === "project_link_required" && !blocked.payload);

const expenseDraft = {
  id: "inv-exp",
  project_id: PROJECT,
  status: "draft",
  amount: 42,
  paid_amount: 0,
  created_at: "2026-11-04T00:00:00.000Z",
  notes: first.insert.notes,
  invoice_label: "Project expenses",
};
const second = planProjectExpenseInvoice({
  projectId: PROJECT,
  selectedIds: ["e1", "e2"],
  expenses,
  invoices: contractOnly.concat([expenseDraft]),
});
ok("a second add does not duplicate lines", second.ok === true && second.action === "none" && second.created === false);

const added = planProjectExpenseInvoice({
  projectId: PROJECT,
  selectedIds: ["e3"],
  expenses,
  invoices: contractOnly.concat([expenseDraft]),
});
ok("a later expense joins the open draft", added.ok === true && added.action === "append" && added.invoiceId === "inv-exp" && added.created === false);
ok("the open draft total includes the new line once", added.patch.amount === 266 && added.lines.length === 3);
ok("the append still does not set a quote link", added.quoteIdSet === false && !Object.prototype.hasOwnProperty.call(added.patch, "quote_id"));

const html = fs.readFileSync(path.join(ROOT, "public/project-control.html"), "utf8");
const handler = fs.readFileSync(path.join(ROOT, "netlify/functions/add-project-expense-invoice.js"), "utf8");
ok(
  "the summary keeps print and adds one billing action",
  html.includes('id="pccExpensePrint"') &&
    html.includes("Print expense report") &&
    html.includes('id="pccExpenseAddInvoice"') &&
    html.includes("Add selected expenses to a project expense invoice")
);
const picker = html.slice(html.indexOf("type=\"checkbox\" data-pcc-expense-id"), html.indexOf("aria-label=\"Select expense\""));
ok("rows are not selected until the owner checks them", picker.indexOf("checkbox") >= 0 && picker.indexOf("checked") < 0);
ok("a billed expense can show On invoice", html.includes("On invoice"));
const selectAllMarkup = html.slice(html.indexOf('id="pccExpenseSelectAll"') - 40, html.indexOf('id="pccExpenseSelectAll"') + 80);
ok(
  "the summary includes Select all",
  html.includes('id="pccExpenseSelectAll"') && html.includes("Select all") && selectAllMarkup.indexOf("checked") < 0
);
const selectAllFn = html.slice(html.indexOf("function selectablePccExpenseInputs"), html.indexOf("function renderPccExpenseRows"));
ok(
  "Select all marks only expense checkboxes and shows a mixed state",
  selectAllFn.includes("#pccExpenseBody input[data-pcc-expense-id]") &&
    selectAllFn.includes("indeterminate") &&
    selectAllFn.indexOf("On invoice") < 0
);

function fakeBox(id) {
  return {
    checked: false,
    getAttribute(name) {
      return name === "data-pcc-expense-id" ? id : null;
    },
  };
}
const openA = fakeBox("open-a");
const openB = fakeBox("open-b");
const boxes = [openA, openB];
const selectAllBox = { checked: false, indeterminate: false, disabled: false };
const fakeDocument = {
  getElementById(id) {
    if (id === "pccExpenseSelectAll") return selectAllBox;
    if (id === "pccExpenseAddInvoice") return { disabled: true, dataset: {} };
    return null;
  },
  querySelectorAll(selector) {
    if (selector === "#pccExpenseBody input[data-pcc-expense-id]") return boxes;
    if (selector === "#pccExpenseBody input[data-pcc-expense-id]:checked") {
      return boxes.filter((box) => box.checked);
    }
    return [];
  },
};
const behaviorSrc = html.slice(html.indexOf("function selectedPccExpenseIds"), html.indexOf("function renderPccExpenseRows"));
const behavior = new Function(
  "document",
  behaviorSrc +
    "\nreturn { selectablePccExpenseInputs: selectablePccExpenseInputs, syncPccExpenseSelectAll: syncPccExpenseSelectAll, selectedPccExpenseIds: selectedPccExpenseIds };"
)(fakeDocument);
behavior.syncPccExpenseSelectAll();
ok("Select all starts clear when nothing is marked", selectAllBox.checked === false && selectAllBox.indeterminate === false);
selectAllBox.checked = true;
boxes.forEach((box) => {
  box.checked = true;
});
behavior.syncPccExpenseSelectAll();
ok(
  "Select all marks the open rows and leaves an invoiced row out",
  openA.checked && openB.checked && behavior.selectedPccExpenseIds().join(",") === "open-a,open-b" && boxes.length === 2
);
openB.checked = false;
behavior.syncPccExpenseSelectAll();
ok(
  "unchecking one row leaves Select all mixed",
  selectAllBox.checked === false && selectAllBox.indeterminate === true && behavior.selectedPccExpenseIds().join(",") === "open-a"
);
boxes.forEach((box) => {
  box.checked = false;
});
behavior.syncPccExpenseSelectAll();
ok("clearing Select all leaves nothing to bill", behavior.selectedPccExpenseIds().length === 0 && selectAllBox.checked === false);
const insertBlock = handler.slice(handler.indexOf("const insertPayload"), handler.indexOf("let created"));
ok("the save payload links the project and omits quote_id", insertBlock.includes("project_id: projectId") && !insertBlock.includes("quote_id"));
ok("a missing project column does not create an unlinked invoice", handler.includes("project_link_required") && !handler.includes("delete fallbackPayload.project_id"));

console.log("\n" + passed + " passed");
