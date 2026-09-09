#!/usr/bin/env node
/**
 * Invoice Hub Sent tab — outstanding sent-like rows (read-model only).
 * Isolated: extracts hubRowMatchesSentView from app.js. No live Netlify, email, SQL, or PATCH.
 * Run: node scripts/test-hub-sent-view-outstanding.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

let passed = 0;
function ok(label, cond) {
  assert.ok(cond, label);
  passed += 1;
  console.log("PASS " + label);
}

function eq(label, a, b) {
  assert.strictEqual(a, b, label + " expected " + JSON.stringify(b) + " got " + JSON.stringify(a));
  passed += 1;
  console.log("PASS " + label);
}

function extractFunction(source, name) {
  const start = source.indexOf("function " + name + "(");
  assert.ok(start >= 0, "function not found: " + name);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error("unbalanced braces for " + name);
}

const appSrc = read("public/js/app.js");

function nonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function finiteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

const hubRowMatchesSentView = new Function(
  "finiteNumber",
  "nonEmptyString",
  extractFunction(appSrc, "hubRowMatchesSentView") + "\nreturn hubRowMatchesSentView;"
)(finiteNumber, nonEmptyString);

function row(extra) {
  return Object.assign(
    {
      balance: 16536,
      status: "sent",
      hubInvoiceRawStatus: "issued",
      invoiceStatus: "sent",
      hubInvoiceSentAt: "2026-09-09T01:00:00.000Z"
    },
    extra || {}
  );
}

ok("helper exists", typeof hubRowMatchesSentView === "function");
ok("Sent tab uses helper", /case\s+"sent":\s*if\s*\(\s*!hubRowMatchesSentView\(row\)\s*\)/.test(appSrc));
ok("status dropdown sent uses helper", /statusFilter === "sent"[\s\S]{0,80}hubRowMatchesSentView\(row\)/.test(appSrc));
ok("Paid tab stays exact paid", /case\s+"paid":\s*if\s*\(String\(row\.status \|\| ""\)\.toLowerCase\(\) !== "paid"\)/.test(appSrc));
ok(
  "Status chip still prints row.status",
  /<span class="hub-status \$\{escapeHtml\(row\.status\)\}">\$\{escapeHtml\(row\.status\)\}<\/span>/.test(appSrc)
);
ok("helper does not use hubRowServerInvoiceSentLike", !/hubRowServerInvoiceSentLike/.test(extractFunction(appSrc, "hubRowMatchesSentView")));
ok("helper does not auto-include accepted", !/accepted/.test(extractFunction(appSrc, "hubRowMatchesSentView")));
ok("helper does not auto-include deposit_paid", !/deposit_paid/.test(extractFunction(appSrc, "hubRowMatchesSentView")));

eq("issued + sent_at + balance > 0", hubRowMatchesSentView(row()), true);
eq(
  "sent_at + display accepted + balance > 0",
  hubRowMatchesSentView(row({ status: "accepted", hubInvoiceRawStatus: "issued" })),
  true
);
eq(
  "sent_at + display deposit_paid + balance > 0",
  hubRowMatchesSentView(row({ status: "deposit_paid", hubInvoiceRawStatus: "issued" })),
  true
);
eq(
  "partial + balance > 0",
  hubRowMatchesSentView(
    row({ status: "partial", hubInvoiceRawStatus: "partial", hubInvoiceSentAt: "" })
  ),
  true
);
eq(
  "overdue + balance > 0",
  hubRowMatchesSentView(
    row({ status: "overdue", hubInvoiceRawStatus: "overdue", hubInvoiceSentAt: "" })
  ),
  true
);
eq(
  "draft + no sent_at not Sent",
  hubRowMatchesSentView(
    row({ status: "draft", hubInvoiceRawStatus: "draft", invoiceStatus: "draft", hubInvoiceSentAt: "" })
  ),
  false
);
eq(
  "open + no sent_at not Sent",
  hubRowMatchesSentView(
    row({ status: "draft", hubInvoiceRawStatus: "open", invoiceStatus: "draft", hubInvoiceSentAt: "" })
  ),
  false
);
eq(
  "accepted without sent_at or sent-like raw not Sent",
  hubRowMatchesSentView(
    row({
      status: "accepted",
      hubInvoiceRawStatus: "draft",
      invoiceStatus: "draft",
      hubInvoiceSentAt: ""
    })
  ),
  false
);
eq(
  "deposit_paid without sent_at or sent-like raw not Sent",
  hubRowMatchesSentView(
    row({
      status: "deposit_paid",
      hubInvoiceRawStatus: "draft",
      invoiceStatus: "draft",
      hubInvoiceSentAt: ""
    })
  ),
  false
);
eq(
  "paid not Sent",
  hubRowMatchesSentView(row({ status: "paid", hubInvoiceRawStatus: "paid", balance: 16536 })),
  false
);
eq("balance 0 not Sent", hubRowMatchesSentView(row({ balance: 0 })), false);
eq(
  "archived not Sent",
  hubRowMatchesSentView(row({ status: "archived", hubInvoiceRawStatus: "archived" })),
  false
);
eq(
  "void not Sent",
  hubRowMatchesSentView(row({ status: "void", hubInvoiceRawStatus: "void" })),
  false
);
eq(
  "cancelled not Sent",
  hubRowMatchesSentView(row({ status: "cancelled", hubInvoiceRawStatus: "cancelled" })),
  false
);

console.log("\n" + passed + " passed");
