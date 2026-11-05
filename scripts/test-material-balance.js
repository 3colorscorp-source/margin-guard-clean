#!/usr/bin/env node
/**
 * Reported materials can be marked onto the contract balance.
 * The contract invoice itself cannot.
 * Run: node scripts/test-material-balance.js
 */
"use strict";

const assert = require("assert");
const {
  MARKER,
  notesIncludeBalanceMarker,
  invoiceCanJoinContractBalance,
  notesWithBalanceMarker,
  materialsReadyForInvoice,
  notesWithMaterials,
  notesWithBilledOn,
  notesAlreadyBilledOnBalanceInvoice,
} = require("../netlify/functions/_lib/material-balance");

const expenses = {
  invoice_label: "Project expenses",
  notes: "Project expenses:\n2026-11-04 — Sealer — $20.00\n[invoice_type:project_expenses]",
};
assert.strictEqual(invoiceCanJoinContractBalance(expenses), true);
assert.strictEqual(notesIncludeBalanceMarker(expenses.notes), false);
const marked = notesWithBalanceMarker(expenses.notes);
assert.strictEqual(notesIncludeBalanceMarker(marked), true);
assert.strictEqual(notesWithBalanceMarker(marked), marked);
assert.ok(marked.indexOf(MARKER) > 0);

const material = { invoice_label: "Material Cost", notes: "[invoice_type:unexpected_material_cost]" };
assert.strictEqual(invoiceCanJoinContractBalance(material), true);

const contract = { invoice_label: "Contract", notes: "", quote_id: "00130740-3e22-47d8-9388-2dc65bf3cf00" };
assert.strictEqual(invoiceCanJoinContractBalance(contract), false);

const progress = { invoice_label: "Progress Payment", notes: "", amount: 5800 };
assert.strictEqual(invoiceCanJoinContractBalance(progress), false);

const ready = materialsReadyForInvoice([
  {
    id: "exp-1",
    invoice_label: "Project expenses",
    amount: 557,
    paid_amount: 0,
    status: "draft",
    notes: "Project expenses:\n2026-11-04 — Sealer — $20.00\n\nInvoice total:\n$557.00\n[invoice_type:project_expenses]\n[included_in_contract_balance]",
  },
  { id: "progress", invoice_label: "Progress Payment", amount: 5800, paid_amount: 0, status: "overdue", notes: "" },
  { id: "contract", invoice_label: "Contract", amount: 9114.61, paid_amount: 1000, status: "sent", notes: "" },
]);
assert.strictEqual(ready.amount, 557);
assert.deepStrictEqual(ready.ids, ["exp-1"]);
assert.deepStrictEqual(ready.lines, ["2026-11-04 — Sealer — $20.00"]);

const notes = notesWithMaterials("Hi Erin, here is the balance.", ready);
assert.ok(notes.indexOf("Materials reported:") > 0);
assert.ok(notes.indexOf("2026-11-04 — Sealer — $20.00") > 0);
assert.ok(notes.indexOf("Materials on this invoice: $557.00") > 0);

const billed = notesWithBilledOn(
  expenses.notes + "\n[included_in_contract_balance]",
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
);
assert.strictEqual(notesAlreadyBilledOnBalanceInvoice(billed), true);
const again = materialsReadyForInvoice([
  {
    id: "exp-1",
    invoice_label: "Project expenses",
    amount: 557,
    paid_amount: 0,
    status: "draft",
    notes: billed,
  },
]);
assert.strictEqual(again.amount, 0);

console.log("PASS materials can join the balance without changing the contract");
