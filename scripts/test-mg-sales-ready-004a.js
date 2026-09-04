#!/usr/bin/env node
/**
 * MG-SALES-READY-004A — Supabase public surface hardening (SQL + caller inventory)
 * Usage: node scripts/test-mg-sales-ready-004a.js
 *
 * Does not connect to production. Does not apply the migration.
 */
"use strict";

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "mg-sales-ready-004a-test-session-secret";

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = path.resolve(__dirname, "..");
const { createHandler: createFcSessionHandler } = require("../netlify/functions/create-financial-connections-session");
const { createHandler: createSyncHandler } = require("../netlify/functions/sync-tenant-financial-summary");
const { buildSessionPayload, createSessionCookie } = require("../netlify/functions/_lib/session");

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

const TABLES = [
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

const SENSITIVE_TABLES = [
  "tenant_projects",
  "tenant_bank_accounts",
  "tenant_bank_connections",
  "tenant_financial_summary",
];

const DANGEROUS_FUNCS = [
  "get_invoice_by_id",
  "get_invoice_email_payload",
  "mark_invoice_ready_to_send",
  "send_quote",
  "create_invoice_from_quote",
  "create_deposit_and_balance",
  "allocate_next_quote_number",
  "recalc_financial_snapshot",
];

const ALL_FUNCS = [
  "allocate_next_quote_number",
  "approve_public_quote",
  "create_deposit_and_balance",
  "create_invoice_from_quote",
  "get_invoice_by_id",
  "get_invoice_email_payload",
  "get_public_quote",
  "get_seller_quote_context",
  "get_supervisor_project_context",
  "get_supervisor_quote_context",
  "mark_deposit_paid",
  "mark_invoice_ready_to_send",
  "mark_quote_completed",
  "mark_quote_sent",
  "mark_quote_viewed",
  "recalc_financial_snapshot",
  "send_quote",
  "update_labor_usage",
  "upsert_quote_service_line",
];

const APPLY = "SUPABASE_MG_SALES_READY_004A_PUBLIC_SURFACE_HARDENING.sql";
const ROLLBACK = "SUPABASE_MG_SALES_READY_004A_PUBLIC_SURFACE_HARDENING_ROLLBACK.sql";

function walkJsHtml(dir, out) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === "node_modules" || ent.name === ".qa-ch013a48") continue;
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

async function main() {
  const applySrc = read(APPLY);
  const rollbackSrc = read(ROLLBACK);
  const applyLive = stripSqlComments(applySrc);
  const rollbackLive = stripSqlComments(rollbackSrc);

  assert("0a. apply migration exists", applySrc.length > 200);
  assert("0b. rollback exists separately", rollbackSrc.length > 100);
  assert("0c. apply does not DELETE/DROP production rows or backup tables", !/\bDROP TABLE\b/i.test(applyLive) && !/\bDELETE FROM\b/i.test(applyLive));
  assert("0d. apply does not GRANT to anon", !/\bGRANT\b[\s\S]{0,80}\bTO\s+anon\b/i.test(applyLive));
  assert("0e. apply does not GRANT to authenticated", !/\bGRANT\b[\s\S]{0,80}\bTO\s+authenticated\b/i.test(applyLive));
  assert("0f2. no CREATE POLICY for anon/authenticated", !/CREATE POLICY[\s\S]{0,200}\bTO\s+(anon|authenticated)\b/i.test(applyLive));
  assert("0g. apply grants service_role table DML", /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\.%I TO service_role/.test(applySrc));
  assert("0h. apply sets safe search_path", /SET search_path = public, pg_temp/.test(applySrc));
  assert("0i. rollback live SQL does not GRANT to anon", !/\bGRANT\b[\s\S]{0,80}\bTO\s+anon\b/i.test(rollbackLive));
  assert("0j. apply is transactional", /^\s*BEGIN;/m.test(applySrc) && /^\s*COMMIT;/m.test(applySrc));

  TABLES.forEach((table) => {
    assert("G. table listed for RLS: " + table, applySrc.includes("'" + table + "'"));
    assert("H. revoke anon template covers " + table, /REVOKE ALL ON TABLE public\.%I FROM anon/.test(applySrc));
  });
  SENSITIVE_TABLES.forEach((table) => {
    assert("1-4. sensitive table in harden list: " + table, applySrc.includes("'" + table + "'"));
  });
  assert("5. INSERT/UPDATE/DELETE revoked with ALL ON TABLE from anon/authenticated", /REVOKE ALL ON TABLE public\.%I FROM anon/.test(applySrc) && /REVOKE ALL ON TABLE public\.%I FROM authenticated/.test(applySrc));
  assert("ENABLE ROW LEVEL SECURITY is issued", /ENABLE ROW LEVEL SECURITY/.test(applySrc));

  ALL_FUNCS.forEach((fn) => {
    assert("D. function in EXECUTE harden list: " + fn, applySrc.includes("'" + fn + "'"));
  });
  DANGEROUS_FUNCS.forEach((fn) => {
    assert("9-16. dangerous fn loses anon EXECUTE: " + fn, applySrc.includes("'" + fn + "'") && /REVOKE ALL ON FUNCTION/.test(applySrc) && /FROM anon/.test(applySrc));
  });
  assert("E. EXECUTE granted only to service_role", /GRANT EXECUTE ON FUNCTION/.test(applySrc) && /TO service_role/.test(applySrc));
  assert("F. no listed fn kept GRANT EXECUTE to PUBLIC/anon", !/GRANT EXECUTE[\s\S]{0,120}\bTO\s+(PUBLIC|anon|authenticated)\b/i.test(applyLive));

  const publicFiles = [];
  walkJsHtml(path.join(ROOT, "public"), publicFiles);
  const publicSrc = publicFiles.map((p) => fs.readFileSync(p, "utf8")).join("\n");
  SENSITIVE_TABLES.forEach((table) => {
    const direct = new RegExp("\\.from\\(\\s*['\"]" + table + "['\"]\\s*\\)");
    const rest = new RegExp("rest\\/v1\\/" + table);
    assert("B. browser does not .from(" + table + ")", !direct.test(publicSrc) && !rest.test(publicSrc));
  });
  ALL_FUNCS.forEach((fn) => {
    assert("B. browser does not rpc " + fn, !new RegExp("\\.rpc\\(\\s*['\"]" + fn + "['\"]").test(publicSrc) && !publicSrc.includes("rpc/" + fn));
  });

  const adminSrc = read("netlify/functions/_lib/supabase-admin.js");
  assert("8a. Netlify uses service role key", /SUPABASE_SERVICE_ROLE_KEY/.test(adminSrc) && /Authorization: `Bearer \$\{key\}`/.test(adminSrc));

  const fcSrc = read("netlify/functions/create-financial-connections-session.js");
  const syncSrc = read("netlify/functions/sync-tenant-financial-summary.js");
  const listBankSrc = read("netlify/functions/list-tenant-bank-accounts.js");
  const upsertProjSrc = read("netlify/functions/upsert-tenant-project.js");
  const pubEstSrc = read("netlify/functions/get-public-estimate.js");
  const pubInvSrc = read("netlify/functions/get-public-invoice.js");
  const changeSrc = read("netlify/functions/submit-public-quote-change-request.js");
  const trackSrc = read("netlify/functions/track-estimate-view.js");
  const supportReq = read("netlify/functions/_lib/mg-support/require-owner-session.js");
  const publishSrc = read("netlify/functions/publish-public-quote.js");

  assert("8b. FC session uses supabase-admin", /supabase-admin/.test(fcSrc) || /supabaseRequest/.test(fcSrc));
  assert("8c. bank sync uses supabaseRequest", /supabaseRequest/.test(syncSrc));
  assert("8d. list-tenant-bank-accounts is server-side", /supabaseRequest/.test(listBankSrc));
  assert("8e. tenant_projects upsert is server-side", /supabaseRequest/.test(upsertProjSrc) && /never trusts client tenant_id/.test(upsertProjSrc));
  assert("7. browser-supplied tenant_id is not table authority", /never trusts client tenant_id/.test(upsertProjSrc));
  assert("17. public estimate requires token", /Missing token/.test(pubEstSrc) && /Invalid token/.test(pubEstSrc) && /public_token=eq/.test(pubEstSrc));
  assert("17b. public estimate uses service-role REST not get_public_quote RPC", /supabaseRequest/.test(pubEstSrc) && !/rpc\/get_public_quote/.test(pubEstSrc));
  assert("17c. public invoice uses public_token + service role", /public_token=eq/.test(pubInvSrc) && /supabaseRequest/.test(pubInvSrc));
  assert("17d. quote change request is Netlify-token path", /public_token/.test(changeSrc) && /quote_change_requests/.test(changeSrc) && /serviceRoleKey/.test(changeSrc));
  assert("18. invalid public token is rejected in estimate handler", /trimmed\.length < 10/.test(pubEstSrc));
  assert("18b. track-estimate-view requires public_token", /no_public_token|missing public_token/.test(trackSrc));
  assert("19. owner quote publish allocates via service-role RPC", /rpc\/allocate_next_quote_number/.test(publishSrc) && /supabaseRequest/.test(publishSrc));
  assert("22. support uses service-role helper", /supabase-admin/.test(supportReq));
  assert("21. FC remains balances-only", /permissions\[\]", "balances"/.test(fcSrc) && !/permissions\[\]", "transactions"/.test(fcSrc));

  const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const cookieA = createSessionCookie(
    buildSessionPayload({
      tenantId: TENANT_A,
      email: "owner-a@example.com",
      userId: "user-a",
      customerId: "",
      subscriptionId: "",
    })
  ).split(";")[0];

  const syncOk = await createSyncHandler({
    resolveTenantFromSession: async () => ({
      id: TENANT_A,
      owner_email: "owner-a@example.com",
      stripe_customer_id: "cus_A",
    }),
    readUsdBalanceForAccount: async () => 10,
    supabaseRequest: async (p, options = {}) => {
      const method = String(options.method || "GET").toUpperCase();
      if (String(p).includes("tenant_financial_account_mapping")) {
        return [{ bucket: "operating", tenant_bank_account_id: "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }];
      }
      if (String(p).includes("tenant_bank_accounts")) {
        return [{ id: "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa", stripe_fc_account_id: "fca_op", status: "active" }];
      }
      if (String(p).includes("tenant_financial_summary") && method === "GET") {
        return [{ tenant_id: TENANT_A }];
      }
      if (String(p).includes("tenant_financial_summary") && method === "PATCH") {
        return [{ tenant_id: TENANT_A, operating_balance: 10 }];
      }
      return [];
    },
  })({ httpMethod: "POST", headers: { cookie: cookieA }, body: "{}" });
  assert("8f. service-role bank sync handler still 200", syncOk.statusCode === 200 && parse(syncOk).persisted === true);

  const unauthFc = await createFcSessionHandler({
    resolveTenantFromSession: async () => {
      throw new Error("must not resolve");
    },
    supabaseRequest: async () => {
      throw new Error("must not write");
    },
  })({ httpMethod: "POST", headers: {}, body: "{}" });
  assert("20. unauthenticated cannot use owner FC", unauthFc.statusCode === 401);

  const cookieB = createSessionCookie(
    buildSessionPayload({
      tenantId: TENANT_B,
      email: "owner-b@example.com",
      userId: "user-b",
      customerId: "",
      subscriptionId: "",
    })
  ).split(";")[0];
  let wroteA = false;
  const bOnA = await createSyncHandler({
    resolveTenantFromSession: async () => ({
      id: TENANT_B,
      owner_email: "owner-b@example.com",
      stripe_customer_id: "cus_B",
    }),
    readUsdBalanceForAccount: async () => 1,
    supabaseRequest: async (p, options = {}) => {
      const method = String(options.method || "GET").toUpperCase();
      if (String(p).includes(TENANT_A)) wroteA = true;
      if (String(p).includes("tenant_financial_account_mapping")) return [];
      if (String(p).includes("tenant_financial_summary") && method === "GET") return [];
      if (p === "tenant_financial_summary" && method === "POST") {
        return [{ tenant_id: TENANT_B }];
      }
      return [];
    },
  })({ httpMethod: "POST", headers: { cookie: cookieB }, body: "{}" });
  assert("6. tenant B session does not query tenant A financial rows", bOnA.statusCode === 200 && wroteA === false);

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
    assert("M. zip-it still includes sync-tenant-financial-summary", names.includes("sync-tenant-financial-summary"));
    assert("M2. zip-it still includes get-public-estimate", names.includes("get-public-estimate"));
    assert("M3. zip-it still includes mg-support-chat", names.includes("mg-support-chat"));
  } else {
    assert("M. sync function remains", fs.existsSync(path.join(fnDir, "sync-tenant-financial-summary.js")));
    assert("M2. get-public-estimate remains", fs.existsSync(path.join(fnDir, "get-public-estimate.js")));
    assert("M3. mg-support-chat remains", fs.existsSync(path.join(fnDir, "mg-support-chat.js")));
  }

  console.log("");
  console.log(passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
