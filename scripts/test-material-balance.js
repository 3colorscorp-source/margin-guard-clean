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

console.log("PASS materials can join the balance without changing the contract");
