#!/usr/bin/env node
/**
 * MG-SALES-READY-004B — quotes / invoices RLS hardening
 * Usage: node scripts/test-mg-sales-ready-004b.js
 *
 * Does not connect to production. Does not apply the migration.
 */
"use strict";

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "mg-sales-ready-004b-test-session-secret";
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "mg-sales-ready-004b-test-service-role";

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = path.resolve(__dirname, "..");

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

function stripSqlComments(src) {
  return String(src || "")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[ \t]*--[^\n]*$/gm, " ");
}

const TABLES = ["quotes", "quote_items", "invoices", "invoice_payments", "payments"];
const APPLY = "SUPABASE_MG_SALES_READY_004B_QUOTES_INVOICES_RLS_HARDENING.sql";
const ROLLBACK = "SUPABASE_MG_SALES_READY_004B_QUOTES_INVOICES_RLS_HARDENING_ROLLBACK.sql";
const APPLY_004A = "SUPABASE_MG_SALES_READY_004A_PUBLIC_SURFACE_HARDENING.sql";
const TABLES_004A = [
  "project_daily_costs",
  "quote_change_requests",
  "square_webhook_events",
  "tenant_bank_accounts",
  "tenant_bank_connections",
  "tenant_financial_account_mapping",
  "tenant_financial_account_mapping_backup",
  "tenant_financial_summary",
  "tenant_financial_summary_backup",
  "tenant_financial_summary_migration_backup",
  "tenant_project_reports",
  "tenant_projects",
];

const NAMED_DROPS = [
  "quotes_read_all",
  "quotes_insert_all",
  "quotes_update_owner",
  "allow read quote items",
  "allow insert quote items",
  "invoices_all_auth",
  "public can read invoices by token",
  "public read invoice by token",
  "payments_all_auth",
];

function walkJsHtml(dir, out) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === "node_modules" || ent.name.startsWith(".qa-")) continue;
      walkJsHtml(p, out);
      continue;
    }
    if (/\.(js|html)$/.test(ent.name)) out.push(p);
  }
}

function parse(res) {
  try {
    return JSON.parse(res.body || "{}");
  } catch (_err) {
    return {};
  }
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

function loadPublicHandlers() {
  [
    "../netlify/functions/_lib/supabase-admin",
    "../netlify/functions/_lib/tenant-display",
    "../netlify/functions/get-public-invoice",
    "../netlify/functions/get-public-estimate",
  ].forEach((rel) => {
    delete require.cache[require.resolve(rel)];
  });
  return {
    getPublicInvoice: require("../netlify/functions/get-public-invoice"),
    getPublicEstimate: require("../netlify/functions/get-public-estimate"),
  };
}

async function withMockedFetch(impl, fn) {
  const prev = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn(loadPublicHandlers());
  } finally {
    globalThis.fetch = prev;
  }
}

async function main() {
  const applySrc = read(APPLY);
  const rollbackSrc = read(ROLLBACK);
  const applyLive = stripSqlComments(applySrc);
  const rollbackLive = stripSqlComments(rollbackSrc);
  const apply004a = read(APPLY_004A);

  assert("0a. apply migration exists", applySrc.length > 200);
  assert("0b. rollback exists separately", rollbackSrc.length > 100);
  assert(
    "0c. apply does not DELETE/DROP production rows or tables",
    !/\bDROP TABLE\b/i.test(applyLive) && !/\bDELETE FROM\b/i.test(applyLive)
  );
  assert("0d. apply does not GRANT to anon", !/\bGRANT\b[\s\S]{0,80}\bTO\s+anon\b/i.test(applyLive));
  assert(
    "0e. apply does not GRANT to authenticated",
    !/\bGRANT\b[\s\S]{0,80}\bTO\s+authenticated\b/i.test(applyLive)
  );
  assert(
    "0f. no CREATE POLICY for anon/authenticated",
    !/CREATE POLICY[\s\S]{0,220}\bTO\s+(anon|authenticated)\b/i.test(applyLive)
  );
  assert(
    "0g. apply grants service_role table DML",
    /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\.%I TO service_role/.test(applySrc)
  );
  assert("0h. apply is transactional", /^\s*BEGIN;/m.test(applySrc) && /^\s*COMMIT;/m.test(applySrc));
  assert("0i. rollback live SQL does not GRANT to anon", !/\bGRANT\b[\s\S]{0,80}\bTO\s+anon\b/i.test(rollbackLive));
  assert("0j. 004A file is unchanged and still present", apply004a.includes("'tenant_projects'"));
  assert(
    "0k. 004B does not reapply 004A table list",
    !applySrc.includes("'tenant_projects'") && !applySrc.includes("'tenant_bank_accounts'")
  );

  TABLES.forEach((table) => {
    assert("table listed for RLS: " + table, applySrc.includes("'" + table + "'"));
  });
  TABLES_004A.forEach((table) => {
    assert("18. 004A still lists " + table, apply004a.includes("'" + table + "'"));
  });
  NAMED_DROPS.forEach((name) => {
    assert("drop named policy: " + name, applySrc.includes("'" + name + "'"));
  });
  assert("ENABLE ROW LEVEL SECURITY is issued", /ENABLE ROW LEVEL SECURITY/.test(applySrc));
  assert(
    "revoke anon/authenticated/PUBLIC",
    /REVOKE ALL ON TABLE public\.%I FROM PUBLIC/.test(applySrc) &&
      /REVOKE ALL ON TABLE public\.%I FROM anon/.test(applySrc) &&
      /REVOKE ALL ON TABLE public\.%I FROM authenticated/.test(applySrc)
  );
  assert(
    "1-5. anon cannot list/insert quotes, invoices, quote_items (revoke + drop USING true)",
    applySrc.includes("'quotes_read_all'") &&
      applySrc.includes("'quotes_insert_all'") &&
      applySrc.includes("'allow read quote items'") &&
      applySrc.includes("'allow insert quote items'") &&
      applySrc.includes("'public can read invoices by token'") &&
      applySrc.includes("'public read invoice by token'") &&
      /REVOKE ALL ON TABLE public\.%I FROM anon/.test(applySrc)
  );
  assert(
    "6-9. authenticated cannot all-true read/mutate other tenant quotes/invoices",
    applySrc.includes("'quotes_update_owner'") &&
      applySrc.includes("'invoices_all_auth'") &&
      /REVOKE ALL ON TABLE public\.%I FROM authenticated/.test(applySrc)
  );
  assert(
    "10-11. authenticated cannot CRUD all invoice_payments/payments",
    applySrc.includes("'payments_all_auth'") &&
      applySrc.includes("'invoice_payments'") &&
      /client_facing AND broad/.test(applySrc)
  );
  assert("keeps tenant-aware client policies", /retain tenant-aware client policy/.test(applySrc));
  assert("keeps service_role policies", /keep service_role policy/.test(applySrc));

  const publicFiles = [];
  walkJsHtml(path.join(ROOT, "public"), publicFiles);
  const publicSrc = publicFiles.map((p) => fs.readFileSync(p, "utf8")).join("\n");
  TABLES.forEach((table) => {
    const direct = new RegExp("\\.from\\(\\s*['\"]" + table + "['\"]\\s*\\)");
    const rest = new RegExp("rest\\/v1\\/" + table + "(?:\\?|\"|'|$)");
    assert("C. browser does not .from(" + table + ")", !direct.test(publicSrc));
    assert("C2. browser does not rest/v1/" + table, !rest.test(publicSrc));
  });

  const invoiceHtml = read("public/invoice.html");
  assert("D. invoice.html no supabase-js CDN", !/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js/.test(invoiceHtml));
  assert("D2. invoice.html no createClient", !/createClient/.test(invoiceHtml));
  assert("D3. invoice.html no .from(invoices)", !/\.from\(\s*['"]invoices['"]\s*\)/.test(invoiceHtml));
  assert("E. invoice.html uses get-public-invoice", /get-public-invoice\?token=/.test(invoiceHtml));
  assert("E2. invoice.html requires token", /Missing invoice token/.test(invoiceHtml));
  assert("E3. invoice.html does not query by id", !/params\.get\(["']id["']\)/.test(invoiceHtml));
  assert("E4. invoice.html does not render internal ids", !/Invoice ID/.test(invoiceHtml) && !/Quote ID/.test(invoiceHtml));

  const invoicePublic = read("public/invoice-public.html");
  const estimatePublic = read("public/js/estimate-builder.js");
  assert("K. invoice-public.html still uses get-public-invoice", /get-public-invoice\?token=/.test(invoicePublic));
  assert("K2. estimate-builder uses get-public-estimate", /get-public-estimate\?token=/.test(estimatePublic));

  const pubInvSrc = read("netlify/functions/get-public-invoice.js");
  const pubEstSrc = read("netlify/functions/get-public-estimate.js");
  const listInvSrc = read("netlify/functions/list-tenant-invoices.js");
  const recordPaySrc = read("netlify/functions/record-tenant-payment.js");
  const listQuotesSrc = read("netlify/functions/list-tenant-quotes.js");
  const publishSrc = read("netlify/functions/publish-public-quote.js");
  const sendQuoteSrc = read("netlify/functions/send-quote-zapier.js");
  const adminSrc = read("netlify/functions/_lib/supabase-admin.js");
  const appSrc = read("public/js/app.js");
  const sellerSendSrc = read("public/js/estimate-public-send.js");
  const supportReq = read("netlify/functions/_lib/mg-support/require-owner-session.js");
  const fcSrc = read("netlify/functions/create-financial-connections-session.js");

  assert("17. get-public-invoice uses service-role REST", /supabaseRequest/.test(pubInvSrc) && /public_token=eq/.test(pubInvSrc));
  assert("17b. get-public-invoice validates token length/charset", /trimmed\.length < 10/.test(pubInvSrc) && /a-zA-Z0-9_/.test(pubInvSrc));
  assert("14. get-public-estimate uses public_token + service role", /public_token=eq/.test(pubEstSrc) && /supabaseRequest/.test(pubEstSrc));
  assert("14b. get-public-estimate rejects invalid token", /Invalid token/.test(pubEstSrc) && /trimmed\.length < 10/.test(pubEstSrc));
  assert("16. Invoice Hub lists via Netlify tenant_id", /list-tenant-invoices/.test(appSrc) && /tenant_id/.test(listInvSrc) && /resolveTenantFromSession/.test(listInvSrc));
  assert("16b. record-tenant-payment is tenant-scoped", /tenant_id=eq/.test(recordPaySrc) && /tenant_project_payments/.test(recordPaySrc));
  assert("15. seller publish is owner/seller Netlify context", /resolveOwnerOrSellerContext/.test(publishSrc) && /tenant_id: tenant\.id/.test(publishSrc));
  assert("15b. seller send uses Netlify not browser table", /publish-public-quote/.test(sellerSendSrc) && /send-quote-zapier/.test(sendQuoteSrc));
  assert("15c. owner quote list is tenant-scoped Netlify", /quotes\?tenant_id=eq/.test(listQuotesSrc) && /requireOwnerMembership/.test(listQuotesSrc));
  assert("8a. Netlify uses service role key", /SUPABASE_SERVICE_ROLE_KEY/.test(adminSrc));
  assert("20. support uses service-role helper", /supabase-admin/.test(supportReq));
  assert("19. FC remains balances-only", /permissions\[\]", "balances"/.test(fcSrc) && !/permissions\[\]", "transactions"/.test(fcSrc));

  const VALID_TOKEN = "mgpubinv_" + "x".repeat(16);
  const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const cold = loadPublicHandlers();

  const missing = await cold.getPublicInvoice.handler({ httpMethod: "GET", queryStringParameters: {} });
  assert("13a. missing invoice token fails", missing.statusCode === 400 && /Missing token/.test(parse(missing).error || ""));

  const badCharset = await cold.getPublicInvoice.handler({
    httpMethod: "GET",
    queryStringParameters: { token: "not-a-valid-token!!" },
  });
  assert("13b. invalid invoice token charset fails", badCharset.statusCode === 400);

  const shortTok = await cold.getPublicInvoice.handler({
    httpMethod: "GET",
    queryStringParameters: { token: "short" },
  });
  assert("13c. short invoice token fails", shortTok.statusCode === 400);

  const missingEst = await cold.getPublicEstimate.handler({ httpMethod: "GET", queryStringParameters: {} });
  assert("14c. missing estimate token fails", missingEst.statusCode === 400);

  await withMockedFetch(async (url) => {
    const u = String(url);
    if (u.includes("/rest/v1/invoices?") && u.includes("public_token=eq." + encodeURIComponent(VALID_TOKEN))) {
      return jsonResponse(200, [
        {
          business_name: "Acme",
          status: "sent",
          currency: "USD",
          amount: 100,
          paid_amount: 0,
          balance_due: 100,
          accent_color: "",
          logo_url: "",
          payment_link: "",
          invoice_no: "INV-TEST",
          due_date: "2026-01-15",
          customer_name: "Client",
          customer_email: "client@example.com",
          project_name: "Job",
          invoice_label: "",
          issue_date: "2026-01-01",
          type: "invoice",
          notes: "",
          id: "11111111-1111-4111-8111-111111111111",
          tenant_id: TENANT_A,
          quote_id: "",
          project_id: "",
        },
      ]);
    }
    return jsonResponse(200, []);
  }, async ({ getPublicInvoice }) => {
    const ok = await getPublicInvoice.handler({
      httpMethod: "GET",
      queryStringParameters: { token: VALID_TOKEN },
    });
    const body = parse(ok);
    assert("12. valid public invoice token loads through Netlify", ok.statusCode === 200 && body.ok === true && body.invoice);
    assert("12b. public invoice omits ids/tenant", body.invoice && body.invoice.id == null && body.invoice.tenant_id == null);
    assert("12c. public invoice returns customer-safe fields", body.invoice && body.invoice.invoice_no === "INV-TEST");
  });

  await withMockedFetch(async () => jsonResponse(200, []), async ({ getPublicInvoice }) => {
    const missingInv = await getPublicInvoice.handler({
      httpMethod: "GET",
      queryStringParameters: { token: "mgpubinv_" + "z".repeat(16) },
    });
    assert("13d. unknown invoice token is 404", missingInv.statusCode === 404);
  });

  await withMockedFetch(async (url) => {
    const u = String(url);
    if (u.includes("/rest/v1/quotes?") && u.includes("public_token=eq." + encodeURIComponent(VALID_TOKEN))) {
      return jsonResponse(200, [
        {
          business_name: "Acme",
          company_name: "",
          title: "Estimate",
          project_name: "Job",
          client_name: "Client",
          total: 100,
          currency: "USD",
          status: "sent",
          tenant_id: TENANT_A,
          id: "22222222-2222-4222-8222-222222222222",
          created_at: "2026-01-01T00:00:00Z",
        },
      ]);
    }
    return jsonResponse(200, []);
  }, async ({ getPublicEstimate }) => {
    const ok = await getPublicEstimate.handler({
      httpMethod: "GET",
      queryStringParameters: { token: VALID_TOKEN },
    });
    const body = parse(ok);
    assert("14d. valid public estimate token loads through Netlify", ok.statusCode === 200 && body.ok === true && body.estimate);
  });

  const zisiCandidates = [
    path.join(
      ROOT,
      ".qa-ch013a48/netlify-cli-pkg/node_modules/netlify-cli/node_modules/@netlify/zip-it-and-ship-it/dist/main.js"
    ),
    path.join(
      "C:\\Margin Guard System\\margin-guard-clean",
      ".qa-ch013a48/netlify-cli-pkg/node_modules/netlify-cli/node_modules/@netlify/zip-it-and-ship-it/dist/main.js"
    ),
  ];
  const zisiPath = zisiCandidates.find((p) => fs.existsSync(p));
  const fnDir = path.join(ROOT, "netlify/functions");
  if (zisiPath) {
    const { listFunctions } = await import(pathToFileURL(zisiPath).href);
    const listed = await listFunctions(fnDir);
    const names = (listed || []).map((fn) => fn.name);
    assert("17c. zip-it includes get-public-invoice", names.includes("get-public-invoice"));
    assert("17d. zip-it includes get-public-estimate", names.includes("get-public-estimate"));
    assert("16c. zip-it includes list-tenant-invoices", names.includes("list-tenant-invoices"));
  } else {
    assert("17c. get-public-invoice remains", fs.existsSync(path.join(fnDir, "get-public-invoice.js")));
    assert("17d. get-public-estimate remains", fs.existsSync(path.join(fnDir, "get-public-estimate.js")));
    assert("16c. list-tenant-invoices remains", fs.existsSync(path.join(fnDir, "list-tenant-invoices.js")));
  }

  console.log("");
  console.log(passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
