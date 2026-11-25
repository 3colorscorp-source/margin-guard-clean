#!/usr/bin/env node
/**
 * Invoice Hub: paid contract must not leave remaining-balance / leftover drafts collectible.
 * Usage: node scripts/test-invoice-hub-settled-project-payments.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const api = require("../public/js/mg-hub-settled-project-payments.js");

let failed = 0;
let passed = 0;

function assert(name, cond) {
  if (cond) {
    passed += 1;
    console.log("PASS  " + name);
  } else {
    failed += 1;
    console.log("FAIL  " + name);
  }
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function erinRows() {
  return [
    {
      id: "contract-uuid",
      status: "paid",
      rawStatus: "paid",
      balance: 0,
      amount: 15753.52,
      title: "Erin's Master bathroom",
      customer: "Erin Thomson.",
      customerEmail: "erin@example.com",
      invoiceLabel: "CONTRACT",
      projectId: "proj-erin",
      quoteId: "quote-erin",
      sourceInvoiceId: ""
    },
    {
      id: "remaining-uuid",
      status: "overdue",
      rawStatus: "sent",
      balance: 8671.61,
      amount: 8671.61,
      title: "Erin's Master bathroom",
      customer: "Erin Thomson.",
      customerEmail: "erin@example.com",
      invoiceLabel: "Remaining Balance",
      projectId: "proj-erin",
      quoteId: "",
      sourceInvoiceId: "contract-uuid"
    },
    {
      id: "expenses-uuid",
      status: "draft",
      rawStatus: "draft",
      balance: 557,
      amount: 557,
      title: "Erin's Master bathroom",
      customer: "Erin Thomson.",
      customerEmail: "erin@example.com",
      invoiceLabel: "PROJECT EXPENSES",
      projectId: "proj-erin",
      quoteId: "",
      sourceInvoiceId: ""
    }
  ];
}

function main() {
  const appSrc = read("public/js/app.js");
  const htmlSrc = read("public/estimates-invoices.html");

  const settle = api.idsToSettle(erinRows());
  assert("1. remaining-balance leftover is settled", settle.has("remaining-uuid"));
  assert("2. project-expenses draft leftover is settled", settle.has("expenses-uuid"));
  assert("3. paid contract is not re-settled", !settle.has("contract-uuid"));

  const material = api.idsToSettle([
    ...erinRows(),
    {
      id: "material-uuid",
      status: "sent",
      rawStatus: "sent",
      balance: 200,
      amount: 200,
      title: "Erin's Master bathroom",
      customer: "Erin Thomson.",
      customerEmail: "erin@example.com",
      invoiceLabel: "Material Cost",
      projectId: "proj-erin",
      quoteId: "",
      sourceInvoiceId: "contract-uuid"
    }
  ]);
  assert("4. material cost extra stays collectible", !material.has("material-uuid"));

  const otherJob = api.idsToSettle([
    ...erinRows(),
    {
      id: "adan-uuid",
      status: "sent",
      rawStatus: "sent",
      balance: 4559.6,
      amount: 4559.6,
      title: "Nourse Room Floor Repair",
      customer: "Adan Zepeda / Fremont Hospital",
      customerEmail: "adan@example.com",
      invoiceLabel: "",
      projectId: "proj-adan",
      quoteId: "",
      sourceInvoiceId: ""
    }
  ]);
  assert("5. other unpaid jobs are not settled", !otherJob.has("adan-uuid"));

  const unpaidContract = api.idsToSettle(
    erinRows().map((row) =>
      row.id === "contract-uuid" ? Object.assign({}, row, { status: "sent", balance: 15753.52 }) : row
    )
  );
  assert("6. leftovers stay collectible while contract is unpaid", unpaidContract.size === 0);

  const byNameOnly = api.idsToSettle(
    erinRows().map((row) => Object.assign({}, row, { projectId: "", quoteId: "" }))
  );
  assert(
    "7. same client + title still clusters without project_id",
    byNameOnly.has("remaining-uuid") && byNameOnly.has("expenses-uuid")
  );

  const mixedIds = api.idsToSettle([
    Object.assign({}, erinRows()[0]),
    Object.assign({}, erinRows()[1], { projectId: "" }),
    Object.assign({}, erinRows()[2], { projectId: "", quoteId: "", sourceInvoiceId: "" })
  ]);
  assert(
    "7b. mixed project_id still clusters by client + title",
    mixedIds.has("remaining-uuid") && mixedIds.has("expenses-uuid")
  );

  assert("8. app.js reconciles after merge", /reconcileHubSettledProjectPayments\(out\)/.test(appSrc));
  assert("9. next-action honors hubProjectSettled", /if \(row\?\.hubProjectSettled\) return "Completed"/.test(appSrc));
  const readyFn = (appSrc.match(/function hubRowMatchesReadyToBillView\(row\) \{[\s\S]*?\n  \}/) || [""])[0];
  assert(
    "10. ready-to-bill requires a real send action",
    /na === "Send Invoice" \|\| na === "Send material cost invoice"/.test(readyFn) &&
      /hubProjectSettled/.test(readyFn)
  );
  assert("11. Start with skips completed rows", /function hubFirstCollectActionRow/.test(appSrc));
  assert(
    "12. estimates-invoices loads settled-payments helper",
    /mg-hub-settled-project-payments\.js/.test(htmlSrc)
  );

  console.log("");
  console.log(passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
}

main();
