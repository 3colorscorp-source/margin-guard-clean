#!/usr/bin/env node
/**
 * Start Payment PDF / public invoice must show the project contract total,
 * not the billed start-payment amount. Children omit quote_id.
 * Isolated: mocked Supabase only. No live Netlify, email, SQL, or production writes.
 * Run: node scripts/test-invoice-hub-pdf-contract-total.js
 */
"use strict";

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "mg-invoice-hub-pdf-contract-test-key";

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

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PARENT_ID = "11111111-1111-4111-8111-aaaaaaaaaaaa";
const CHILD_ID = "22222222-2222-4222-8222-aaaaaaaaaaaa";
const QUOTE_ID = "33333333-3333-4333-8333-aaaaaaaaaaaa";
const PROJECT_ID = "44444444-4444-4444-8444-aaaaaaaaaaaa";
const TOKEN = "inv_startpay_contract_token";
const CONTRACT = 20000;
const START_PAY = 8755;

function parseQuery(restPath) {
  const q = String(restPath || "").split("?")[1] || "";
  const out = {};
  q.split("&").forEach((part) => {
    if (!part) return;
    const eqAt = part.indexOf("=");
    if (eqAt < 0) return;
    const key = decodeURIComponent(part.slice(0, eqAt));
    out[key] = decodeURIComponent(part.slice(eqAt + 1));
  });
  return out;
}

function childInvoice(overrides) {
  return Object.assign(
    {
      id: CHILD_ID,
      tenant_id: TENANT,
      public_token: TOKEN,
      quote_id: null,
      project_id: PROJECT_ID,
      amount: START_PAY,
      paid_amount: 0,
      balance_due: START_PAY,
      invoice_label: "Start Payment",
      notes:
        "Hi Strong Hold, here is a start payment invoice for 554 commercial tile project.\n[source_invoice:" +
        PARENT_ID +
        "]",
      customer_name: "Strong Hold",
      customer_email: "colm@strongholdconstructionsf.com",
      project_name: "554 commercial tile project",
      invoice_no: "INV-1794077321027",
      status: "sent",
      currency: "USD",
      business_name: "Three Colors Corp",
      type: "PROGRESS",
      issue_date: "2026-11-17",
      due_date: "2026-11-17",
      accent_color: "",
      logo_url: "",
      payment_link: ""
    },
    overrides || {}
  );
}

function parentInvoice() {
  return {
    id: PARENT_ID,
    tenant_id: TENANT,
    quote_id: QUOTE_ID,
    project_id: PROJECT_ID,
    amount: CONTRACT,
    invoice_label: "",
    notes: ""
  };
}

function loadHandler(db) {
  const mods = [
    "../netlify/functions/_lib/supabase-admin",
    "../netlify/functions/_lib/tenant-display",
    "../netlify/functions/_lib/material-balance",
    "../netlify/functions/_lib/invoice-contract-total",
    "../netlify/functions/get-public-invoice"
  ];
  mods.forEach((rel) => {
    try {
      delete require.cache[require.resolve(rel)];
    } catch (_e) {}
  });
  const adminPath = require.resolve("../netlify/functions/_lib/supabase-admin");
  require.cache[adminPath] = {
    id: adminPath,
    filename: adminPath,
    loaded: true,
    exports: {
      supabaseRequest: async (restPath, opts) => db(String(restPath || ""), opts || {})
    }
  };
  return require("../netlify/functions/get-public-invoice");
}

async function runPublic(db, token) {
  const handler = loadHandler(db);
  const res = await handler.handler({
    httpMethod: "GET",
    queryStringParameters: { token: token || TOKEN }
  });
  let body = {};
  try {
    body = JSON.parse(res.body || "{}");
  } catch (_err) {
    body = {};
  }
  return { status: res.statusCode, body };
}

function makeDb({ frozen, quoteTotal, salePrice, includeParent, child }) {
  const quoteVal = quoteTotal == null ? CONTRACT : quoteTotal;
  const saleVal = salePrice == null ? 0 : salePrice;
  const frozenVal = frozen == null ? 0 : frozen;
  return async function db(restPath) {
    const table = String(restPath).split("?")[0];
    const q = parseQuery(restPath);
    if (table === "invoices") {
      if (q.public_token === "eq." + TOKEN || q.public_token === TOKEN) {
        return [child || childInvoice()];
      }
      if (q.id === "eq." + PARENT_ID || q.id === PARENT_ID) {
        return includeParent === false ? [] : [parentInvoice()];
      }
      return [];
    }
    if (table === "quotes") {
      if (q.id === "eq." + QUOTE_ID || q.id === QUOTE_ID) {
        return [{ id: QUOTE_ID, tenant_id: TENANT, total: quoteVal }];
      }
      return [];
    }
    if (table === "tenant_projects") {
      if (q.id === "eq." + PROJECT_ID || q.id === PROJECT_ID) {
        return [{ id: PROJECT_ID, tenant_id: TENANT, sale_price: saleVal }];
      }
      return [];
    }
    if (table === "tenant_contract_packages") {
      if (frozenVal > 0) {
        return [
          {
            snapshot_json: { price: { contract_total: frozenVal }, quote: { total: frozenVal } }
          }
        ];
      }
      return [];
    }
    if (table === "tenant_project_payments") return [];
    if (table === "tenants") return [{ id: TENANT, name: "Three Colors Corp" }];
    if (table === "tenant_branding") return [];
    if (table === "owner_settings") return [];
    if (table === "tenant_legal_profiles") return [];
    if (table === "tenant_snapshots") return [];
    return [];
  };
}

async function main() {
  const app = read("public/js/app.js");
  const publicFn = read("netlify/functions/get-public-invoice.js");
  const remaining = read("netlify/functions/create-remaining-balance-invoice.js");
  const lib = read("netlify/functions/_lib/invoice-contract-total.js");

  ok(
    "start payment drafts still omit quote_id",
    /Do not set quote_id/.test(remaining)
  );
  ok(
    "hub pdf uses resolved project contract total",
    /pdfContractTotal = hubRowResolvedProjectContractTotal\(row\)/.test(app)
  );
  ok(
    "hub pdf does not copy row amount as contract total",
    !/contractTotal:\s*finiteNumber\(row\?\.projectContractTotal,\s*finiteNumber\(row\?\.salePrice,\s*0\)\)/.test(app)
  );
  ok(
    "public invoice uses shared contract resolver",
    /resolveInvoiceContractTotal/.test(publicFn)
  );
  ok(
    "public invoice no longer falls back to this invoice amount for contract",
    !/quoteTotal > 0 \? quoteTotal : projectTotal > 0 \? projectTotal : Math\.max\(invoiceAmount/.test(publicFn)
  );
  ok(
    "resolver never substitutes billed amount for project payments",
    /isProjectPayment\) return resolved/.test(lib)
  );

  const fromParent = await runPublic(makeDb({ frozen: 0, includeParent: true }));
  eq("start payment public invoice is 200", fromParent.status, 200);
  eq(
    "start payment contract total comes from parent quote, not 8755",
    fromParent.body.invoice && fromParent.body.invoice.contract_total,
    CONTRACT
  );
  eq(
    "start payment billed amount stays 8755",
    fromParent.body.invoice && fromParent.body.invoice.invoice_amount,
    START_PAY
  );

  const fromFrozen = await runPublic(makeDb({ frozen: 25000, quoteTotal: CONTRACT, includeParent: true }));
  eq(
    "frozen signed contract total wins over quote",
    fromFrozen.body.invoice && fromFrozen.body.invoice.contract_total,
    25000
  );

  const noParent = await runPublic(
    makeDb({
      frozen: 0,
      quoteTotal: 0,
      salePrice: 0,
      includeParent: false,
      child: childInvoice({ project_id: null, notes: "Hi Strong Hold, start payment." })
    })
  );
  eq(
    "start payment without parent/quote does not invent contract from billed amount",
    noParent.body.invoice && noParent.body.invoice.contract_total,
    0
  );

  const standard = await runPublic(
    makeDb({
      frozen: 0,
      includeParent: false,
      child: childInvoice({
        invoice_label: "Manual Invoice",
        notes: "Service details",
        quote_id: null,
        project_id: null,
        amount: 500,
        balance_due: 500
      })
    })
  );
  eq(
    "standard invoice can still use billed amount as contract when no quote exists",
    standard.body.invoice && standard.body.invoice.contract_total,
    500
  );

  console.log("\n" + passed + " passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
