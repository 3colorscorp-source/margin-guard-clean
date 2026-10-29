#!/usr/bin/env node
/**
 * Accepted quote with zero invoices can create the first linked contract draft.
 * Isolated source + pure helpers. No network, SQL, email, or production writes.
 * Run: node scripts/test-invoice-hub-accepted-quote-link.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const QUOTE_ID = "00130740-3e22-47d8-9388-2dc65bf3cf00";

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function extractFunction(src, name) {
  const re = new RegExp("function\\s+" + name + "\\s*\\(");
  const m = re.exec(src);
  if (!m) throw new Error("missing function " + name);
  const brace = src.indexOf("{", m.index);
  let depth = 0;
  for (let j = brace; j < src.length; j += 1) {
    const ch = src[j];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(m.index, j + 1);
    }
  }
  throw new Error("unclosed function " + name);
}

let passed = 0;
function ok(label, cond) {
  assert.ok(cond, label);
  passed += 1;
  console.log("PASS " + label);
}
function eq(label, a, b) {
  assert.strictEqual(a, b, label);
  passed += 1;
  console.log("PASS " + label);
}

const app = read("public/js/app.js");
const html = read("public/estimates-invoices.html");
const upsert = read("netlify/functions/upsert-tenant-invoice-draft.js");
const progress = read("netlify/functions/create-remaining-balance-invoice.js");

const names = [
  "hubIsoDateOk",
  "hubMoneyLabelFromQuoteTotal",
  "hubBuildLinkedQuoteInvoiceDraft",
  "hubLinkedQuoteInvoiceOffer"
];
const src = names.map((name) => extractFunction(app, name)).join("\n");
const createSrc = extractFunction(app, "createHubLinkedQuoteInvoice");
const sandbox = {
  MG_SERVER_INVOICE_UUID_RE:
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  Date: Date
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

const quote = {
  id: QUOTE_ID,
  quote_number_display: "2026-0172",
  project_name: "Erin's Master bathroom",
  client_name: "Erin Thomson",
  client_email: "client@example.com",
  status: "Accepted",
  total: 9114.61,
  due_date: "2026-11-01",
  accepted_at: "2026-10-01T00:00:00.000Z"
};

const draft = sandbox.hubBuildLinkedQuoteInvoiceDraft(quote, "2026-10-29");
eq("draft uses the quote id", draft.quote_id, QUOTE_ID);
eq("draft amount is the quote total", draft.amount, 9114.61);
eq("draft does not prepay the deposit", draft.paid_amount, 0);
eq("draft balance starts at the quote total", draft.balance_due, 9114.61);
eq("draft label is the contract invoice", draft.invoice_label, "Contract");
eq("draft status is draft", draft.status, "draft");
eq("issue date is the supplied day", draft.issue_date, "2026-10-29");
eq("due date is copied when valid", draft.due_date, "2026-11-01");
ok("draft does not send a client project id", !Object.prototype.hasOwnProperty.call(draft, "project_id"));
ok("draft notes do not mark a child invoice", !String(draft.notes).includes("source_invoice"));
ok("draft does not invent a progress dollar amount", !/8114\.61|\b1000\b/.test(JSON.stringify(draft)));

const offer = sandbox.hubLinkedQuoteInvoiceOffer(quote, { has_project: true, has_invoice: false });
eq("accepted quote with a project and no invoice can create", offer.mode, "create");
ok("offer shows the quote total", offer.message.includes("$9114.61"));
ok("offer does not invent the progress amount", !offer.message.includes("8114.61") && !offer.message.includes("1000"));
ok("offer says the progress amount is not chosen here", offer.message.includes("does not choose a progress amount"));

eq(
  "existing invoice does not create another",
  sandbox.hubLinkedQuoteInvoiceOffer(quote, { has_project: true, has_invoice: true }).mode,
  "exists"
);
eq(
  "accepted quote without a project is blocked",
  sandbox.hubLinkedQuoteInvoiceOffer(quote, { has_project: false, has_invoice: false }).mode,
  "blocked"
);
eq(
  "quote that is not accepted stays hidden",
  sandbox.hubLinkedQuoteInvoiceOffer({ ...quote, status: "sent", accepted_at: "" }, { has_project: true }).mode,
  "hidden"
);
eq(
  "missing email is blocked",
  sandbox.hubLinkedQuoteInvoiceOffer({ ...quote, client_email: "" }, { has_project: true, has_invoice: false }).mode,
  "blocked"
);
eq("invalid quote id builds nothing", sandbox.hubBuildLinkedQuoteInvoiceDraft({ ...quote, id: "nope" }), null);

ok("hub page has the linked-invoice banner", html.includes('id="hubAcceptedQuoteInvoiceBanner"'));
ok("hub page has the linked-invoice button", html.includes('id="btnHubCreateLinkedQuoteInvoice"'));
ok("linked create posts the existing draft endpoint", createSrc.includes('"/ .netlify/functions/upsert-tenant-invoice-draft"'.replace(" ", "")) || createSrc.includes("/.netlify/functions/upsert-tenant-invoice-draft"));
ok("linked create does not use the standalone manual invoice", !createSrc.includes("create-manual-invoice"));
ok("linked create does not hardcode the deposit or remaining balance", !/8114\.61|\b1000\b/.test(createSrc));
ok("standalone Create Invoice button is still separate", app.includes("openCreateManualInvoiceForm()"));
ok("draft upsert still stamps project_id from the quote", upsert.includes("insert.project_id = resolvedProjectId"));
ok("progress draft still copies project_id", progress.includes("payload.project_id = projectId"));
ok("progress draft still omits a second quote_id", progress.includes("Do not set quote_id"));

console.log("\n" + passed + " passed");
