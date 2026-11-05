#!/usr/bin/env node
/**
 * Contract & collection uses the real contract.
 * A progress invoice and a material invoice are not added on top of it.
 * Run: node scripts/test-project-collection-contract.js
 */
"use strict";

const assert = require("assert");
const { buildCollectionSection } = require("../netlify/functions/_lib/project-financial-detail");

const project = {
  sale_price: 9114.61,
  projected_revenue_total: 9114.61,
};

const erinInvoices = [
  {
    id: "contract",
    amount: 9114.61,
    paid_amount: 1000,
    status: "sent",
    payment_status: "deposit_paid",
    invoice_label: "Contract",
    quote_id: "00130740-3e22-47d8-9388-2dc65bf3cf00",
    created_at: "2026-10-29T12:00:00Z",
  },
  {
    id: "progress",
    amount: 5800,
    paid_amount: 0,
    status: "overdue",
    invoice_label: "Progress Payment",
    quote_id: null,
    created_at: "2026-10-29T13:00:00Z",
  },
  {
    id: "expenses",
    amount: 557,
    paid_amount: 0,
    status: "draft",
    invoice_label: "Project expenses",
    notes: "[invoice_type:project_expenses]",
    created_at: "2026-11-05T12:00:00Z",
  },
];

const section = buildCollectionSection({
  project,
  invoices: erinInvoices,
  payments: [
    { id: "pay-contract", invoice_id: "contract", amount: 1000, paid_at: "2026-10-29" },
    { id: "pay-extra", invoice_id: "expenses", amount: 557, paid_at: "2026-11-06" },
  ],
  changeOrders: [],
  ledgerPaidByInvoiceId: new Map(),
});

assert.strictEqual(section.original_contract, 9114.61);
assert.strictEqual(section.approved_change_orders, 0);
assert.strictEqual(section.current_contract_total, 9114.61);
assert.strictEqual(section.total_invoiced, 9114.61);
assert.notStrictEqual(section.total_invoiced, 15471.61);
assert.strictEqual(section.outside_contract, 557);
assert.strictEqual(section.materials_on_balance, 0);
assert.strictEqual(section.paid_to_date, 1000);
assert.strictEqual(section.balance_due, 8114.61);
assert.strictEqual(section.invoice_status, "Deposit paid");
assert.strictEqual(section.last_payment_date, "2026-10-29");

const progressOnly = buildCollectionSection({
  project,
  invoices: [erinInvoices[1]],
  payments: [],
  changeOrders: [],
  ledgerPaidByInvoiceId: new Map(),
});
assert.strictEqual(progressOnly.total_invoiced, 5800);
assert.strictEqual(progressOnly.current_contract_total, 9114.61);
assert.strictEqual(progressOnly.balance_due, 9114.61);
assert.strictEqual(progressOnly.invoice_status, "Overdue");
assert.strictEqual(progressOnly.outside_contract, 0);

const single = buildCollectionSection({
  project: { sale_price: 2000 },
  invoices: [{ id: "one", amount: 2000, paid_amount: 500, status: "partial", created_at: "2026-01-01" }],
  payments: [{ invoice_id: "one", amount: 500, paid_at: "2026-01-02" }],
  changeOrders: [],
  ledgerPaidByInvoiceId: new Map(),
});
assert.strictEqual(single.total_invoiced, 2000);
assert.strictEqual(single.paid_to_date, 500);
assert.strictEqual(single.balance_due, 1500);
assert.strictEqual(single.invoice_status, "Partially paid");

const material = buildCollectionSection({
  project,
  invoices: [
    erinInvoices[0],
    {
      id: "material",
      amount: 80,
      paid_amount: 0,
      status: "draft",
      invoice_label: "Material Cost",
      notes: "[invoice_type:unexpected_material_cost]",
      created_at: "2026-11-02T00:00:00Z",
    },
  ],
  payments: [],
  changeOrders: [],
  ledgerPaidByInvoiceId: new Map([["contract", 1000]]),
});
assert.strictEqual(material.total_invoiced, 9114.61);
assert.strictEqual(material.outside_contract, 80);
assert.strictEqual(material.paid_to_date, 1000);
assert.strictEqual(material.balance_due, 8114.61);

const added = buildCollectionSection({
  project,
  invoices: [
    erinInvoices[0],
    erinInvoices[1],
    Object.assign({}, erinInvoices[2], {
      notes: erinInvoices[2].notes + "\n[included_in_contract_balance]",
    }),
  ],
  payments: [{ id: "pay-contract", invoice_id: "contract", amount: 1000, paid_at: "2026-10-29" }],
  changeOrders: [],
  ledgerPaidByInvoiceId: new Map(),
});
assert.strictEqual(added.total_invoiced, 9114.61);
assert.strictEqual(added.outside_contract, 0);
assert.strictEqual(added.materials_on_balance, 557);
assert.strictEqual(added.paid_to_date, 1000);
assert.strictEqual(added.balance_due, 8671.61);

console.log("PASS contract collection stays on the real contract");
