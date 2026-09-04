#!/usr/bin/env node
/**
 * MG-SALES-READY-004C — freeze remaining browser business_branding access
 * Usage: node scripts/test-mg-sales-ready-004c.js
 *
 * Does not connect to production. Does not apply the migration.
 */
"use strict";

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "mg-sales-ready-004c-test-session-secret";
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "mg-sales-ready-004c-test-service-role";

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = path.resolve(__dirname, "..");
const { createHandler } = require("../netlify/functions/get-tenant-branding");
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

function parse(res) {
  try {
    return JSON.parse(res.body || "{}");
  } catch (_err) {
    return {};
  }
}

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

const APPLY = "SUPABASE_MG_SALES_READY_004C_BUSINESS_BRANDING_GRANT_REVOKE.sql";
const ROLLBACK = "SUPABASE_MG_SALES_READY_004C_BUSINESS_BRANDING_GRANT_REVOKE_ROLLBACK.sql";
const APPLY_004A = "SUPABASE_MG_SALES_READY_004A_PUBLIC_SURFACE_HARDENING.sql";
const APPLY_004B = "SUPABASE_MG_SALES_READY_004B_QUOTES_INVOICES_RLS_HARDENING.sql";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SENSITIVE = [
  "quotes",
  "quote_items",
  "invoices",
  "invoice_payments",
  "payments",
  "tenant_projects",
  "tenant_bank_accounts",
  "tenant_bank_connections",
  "tenant_financial_summary",
  "business_branding",
];

async function main() {
  const applySrc = read(APPLY);
  const rollbackSrc = read(ROLLBACK);
  const applyLive = stripSqlComments(applySrc);
  const rollbackLive = stripSqlComments(rollbackSrc);
  const salesSrc = read("public/sales.html");
  const tenantJs = read("public/js/tenant.js");
  const brandingSrc = read("netlify/functions/get-tenant-branding.js");
  const billingSrc = read("public/js/billing.js");
  const inviteSrc = read("public/js/supervisor-invite.js");
  const pubInv = read("netlify/functions/get-public-invoice.js");
  const pubEst = read("netlify/functions/get-public-estimate.js");
  const invoiceHtml = read("public/invoice.html");
  const estimateJs = read("public/js/estimate-builder.js");

  assert("0a. apply migration exists", applySrc.length > 200);
  assert("0b. rollback exists separately", rollbackSrc.length > 100);
  assert("0c. no DELETE/DROP TABLE", !/\bDROP TABLE\b/i.test(applyLive) && !/\bDELETE FROM\b/i.test(applyLive));
  assert("0d. no GRANT to anon", !/\bGRANT\b[\s\S]{0,80}\bTO\s+anon\b/i.test(applyLive));
  assert("0e. no GRANT to authenticated", !/\bGRANT\b[\s\S]{0,80}\bTO\s+authenticated\b/i.test(applyLive));
  assert("0f. revokes anon and authenticated on business_branding", /REVOKE ALL ON TABLE public\.%I FROM anon/.test(applySrc) && /REVOKE ALL ON TABLE public\.%I FROM authenticated/.test(applySrc));
  assert("0g. grants service_role only", /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\.%I TO service_role/.test(applySrc));
  assert("0h. does not rewrite 004A/004B tables", !applySrc.includes("'quotes'") && !applySrc.includes("'tenant_projects'"));
  assert("0i. 004A file still present", read(APPLY_004A).includes("'tenant_projects'"));
  assert("0j. 004B file still present", read(APPLY_004B).includes("'quotes_read_all'"));
  assert("0k. rollback does not GRANT to anon", !/\bGRANT\b[\s\S]{0,80}\bTO\s+anon\b/i.test(rollbackLive));

  const publicFiles = [];
  walkJsHtml(path.join(ROOT, "public"), publicFiles);
  const publicSrc = publicFiles.map((p) => fs.readFileSync(p, "utf8")).join("\n");

  SENSITIVE.forEach((table) => {
    const direct = new RegExp("\\.from\\(\\s*['\"]" + table + "['\"]\\s*\\)");
    assert("2. browser does not .from(" + table + ")", !direct.test(publicSrc));
  });
  assert("2b. no supabase.rpc tenant tables", !/\.rpc\s*\(/.test(publicSrc));
  assert("1. sales branding uses get-tenant-branding", /getTenantBranding/.test(salesSrc) && /MarginGuardTenant/.test(salesSrc));
  assert("1b. sales.html no business_branding table access", !/from\(\s*['"]business_branding['"]/.test(salesSrc));
  assert("1c. sales.html no getCurrentTenantId branding lookup", !/function getCurrentTenantId/.test(salesSrc));
  assert("1d. seller route is not skipped for branding API", !/__mgIsRealSellerDeviceRoute\(\)[\s\S]{0,80}return null/.test(salesSrc));
  assert("6. tenant.js does not send tenant_id", !/tenant_id/.test(tenantJs) && /get-tenant-branding/.test(tenantJs));
  assert("6b. get-tenant-branding ignores query tenant_id", !/queryStringParameters/.test(brandingSrc));
  assert("6c. get-tenant-branding uses server session/device tenant", /resolveTenantFromSession/.test(brandingSrc) && /requireSellerDevice/.test(brandingSrc));
  assert("7. owner login still uses signInWithPassword", /signInWithPassword/.test(billingSrc) && /restore-owner-session/.test(billingSrc));
  assert("7b. recovery/invite auth remains", /updateUser/.test(billingSrc) && /updateUser/.test(inviteSrc));
  assert("11. public invoice still Netlify token", /public_token=eq/.test(pubInv) && /get-public-invoice\?token=/.test(invoiceHtml));
  assert("11b. public estimate still Netlify token", /get-public-estimate\?token=/.test(estimateJs) && /public_token=eq/.test(pubEst));

  const cookieA = createSessionCookie(
    buildSessionPayload({
      tenantId: TENANT_A,
      email: "owner-a@example.com",
      userId: "user-a",
      customerId: "",
      subscriptionId: "",
    })
  ).split(";")[0];
  const cookieB = createSessionCookie(
    buildSessionPayload({
      tenantId: TENANT_B,
      email: "owner-b@example.com",
      userId: "user-b",
      customerId: "",
      subscriptionId: "",
    })
  ).split(";")[0];

  function ownerHandler() {
    return createHandler({
      resolveTenantFromSession: async (session) => {
        const email = String(session?.e || "").toLowerCase();
        if (email === "owner-a@example.com") return { id: TENANT_A, name: "Acme" };
        if (email === "owner-b@example.com") return { id: TENANT_B, name: "Beta" };
        return null;
      },
      requireSellerDevice: async () => {
        const err = new Error("Device session required");
        err.statusCode = 401;
        err.isGuardError = true;
        throw err;
      },
      supabaseRequest: async (p) => {
        const pathStr = String(p);
        if (pathStr.includes("tenant_branding") && pathStr.includes(TENANT_A)) {
          return [{ business_name: "Acme Roofing", logo_url: "", business_email: "a@example.com", business_phone: "", business_address: "" }];
        }
        if (pathStr.includes("tenant_branding") && pathStr.includes(TENANT_B)) {
          return [{ business_name: "Beta Builders", logo_url: "", business_email: "b@example.com", business_phone: "", business_address: "" }];
        }
        return [];
      },
    });
  }

  const unauth = await ownerHandler()({ httpMethod: "GET", headers: {}, queryStringParameters: { tenant_id: TENANT_A } });
  assert("6d. unauthenticated branding is 401 even with query tenant_id", unauth.statusCode === 401);

  const ownerA = await ownerHandler()({ httpMethod: "GET", headers: { cookie: cookieA } });
  const bodyA = parse(ownerA);
  assert("3. owner A branding is correct", ownerA.statusCode === 200 && bodyA.ok === true && bodyA.branding?.business_name === "Acme Roofing");

  const ownerB = await ownerHandler()({ httpMethod: "GET", headers: { cookie: cookieB } });
  const bodyB = parse(ownerB);
  assert("5. tenant A cannot receive tenant B branding", ownerB.statusCode === 200 && bodyB.branding?.business_name === "Beta Builders" && bodyB.branding?.business_name !== "Acme Roofing");

  const ownerAWithBQuery = await ownerHandler()({
    httpMethod: "GET",
    headers: { cookie: cookieA },
    queryStringParameters: { tenant_id: TENANT_B, business_id: TENANT_B },
  });
  const bodyA2 = parse(ownerAWithBQuery);
  assert("6e. browser tenant_id cannot select tenant B branding", ownerAWithBQuery.statusCode === 200 && bodyA2.branding?.business_name === "Acme Roofing");

  const sellerHandler = createHandler({
    resolveTenantFromSession: async () => null,
    requireSellerDevice: async () => ({ tenant: { id: TENANT_A, name: "Acme" } }),
    supabaseRequest: async (p) => {
      if (String(p).includes(TENANT_A)) {
        return [{ business_name: "Acme Roofing", logo_url: "", business_email: "", business_phone: "", business_address: "" }];
      }
      return [{ business_name: "SHOULD_NOT_RETURN", logo_url: "", business_email: "", business_phone: "", business_address: "" }];
    },
  });
  const seller = await sellerHandler({ httpMethod: "GET", headers: { cookie: "mg_device_session=seller-device" } });
  const sellerBody = parse(seller);
  assert("4. seller branding is tenant-scoped Netlify", seller.statusCode === 200 && sellerBody.branding?.business_name === "Acme Roofing");

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
    assert("zip-it includes get-tenant-branding", names.includes("get-tenant-branding"));
    assert("zip-it includes restore-owner-session", names.includes("restore-owner-session"));
  } else {
    assert("get-tenant-branding remains", fs.existsSync(path.join(fnDir, "get-tenant-branding.js")));
    assert("restore-owner-session remains", fs.existsSync(path.join(fnDir, "restore-owner-session.js")));
  }

  console.log("");
  console.log(passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
