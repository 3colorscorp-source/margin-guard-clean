#!/usr/bin/env node
/**
 * A full remaining-balance invoice replaces an unpaid progress invoice.
 * Run: node scripts/test-project-payment-replace.js
 */
"use strict";

const assert = require("assert");
const { planFullBalanceAgainstExisting } = require("../netlify/functions/create-remaining-balance-invoice");

const progress = {
  id: "1793291661911",
  invoice_label: "Progress Payment",
  amount: 5800,
  paid_amount: 0,
  status: "draft",
  invoice_no: "INV-1793291661911",
};

const plan = planFullBalanceAgainstExisting([progress], true);
assert.strictEqual(plan.action, "create");
assert.strictEqual(plan.replace.length, 1);
assert.strictEqual(plan.replace[0].invoice_no, "INV-1793291661911");

const partialAgain = planFullBalanceAgainstExisting([progress], false);
assert.strictEqual(partialAgain.action, "block");
assert.strictEqual(partialAgain.replace.length, 0);

const paid = planFullBalanceAgainstExisting([{ ...progress, paid_amount: 1000 }], true);
assert.strictEqual(paid.action, "block");

const alreadyFull = planFullBalanceAgainstExisting(
  [{ ...progress, invoice_label: "Remaining Balance", amount: 8671.61 }],
  true
);
assert.strictEqual(alreadyFull.action, "block");

console.log("PASS full balance replaces the unpaid progress invoice");
