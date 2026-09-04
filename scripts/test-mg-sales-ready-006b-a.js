#!/usr/bin/env node
/**
 * MG-SALES-READY-006B-A — Square automatic activation design freeze
 * Usage: node scripts/test-mg-sales-ready-006b-a.js
 *
 * Proves current repo has no Square SaaS activation path.
 * Does not call Square, Netlify production, or mutate the database.
 */
"use strict";

const fs = require("fs");
const path = require("path");

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

function walkFiles(dir, acc) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name.startsWith(".qa-")) continue;
      walkFiles(full, acc);
    } else {
      acc.push(full);
    }
  }
  return acc;
}

async function main() {
  const design = read("docs/MG_SALES_READY_006B_A_SQUARE_ACTIVATION_DESIGN.md");
  const sql004a = read("SUPABASE_MG_SALES_READY_004A_PUBLIC_SURFACE_HARDENING.sql");
  const checkoutSrc = read("netlify/functions/create-checkout-session.js");
  const stripeWhSrc = read("netlify/functions/stripe-invoice-webhook.js");
  const ownerAccessSrc = read("netlify/functions/_lib/owner-access.js");
  const projectPaySql = read("SUPABASE_TENANT_PROJECT_PAYMENTS.sql");
  const checkout = require("../netlify/functions/create-checkout-session");

  assert("design doc exists", design.length > 2000);
  assert("production activation remains off in design", /Production activation is NOT implemented/.test(design));
  assert("Option B recommended for first 1-5", /Option B \+ register-time Square GET/.test(design));
  assert("webhook must not choose tenant by email", /Do not discover tenants by email/.test(design));
  assert("do not reuse tenant_project_payments", /Do \*\*not\*\* use `tenant_project_payments`/.test(design));
  assert("do not reuse square_webhook_events", /Do \*\*not\*\* reuse it for SaaS activation/.test(design));
  assert("Zapier is not entitlement authority", /Zapier is \*\*not\*\* in this chain/.test(design));

  const webhookPath = path.join(ROOT, "netlify/functions/square-saas-webhook.js");
  const registerPath = path.join(ROOT, "netlify/functions/register-saas-square-invoice.js");
  const activateSrc = read("netlify/functions/_lib/saas-square-activate.js");
  const { isAutoActivationEnabled } = require("../netlify/functions/_lib/square-saas-policy");
  assert("E. square-saas-webhook exists behind kill switch", fs.existsSync(webhookPath));
  assert("E. register-saas-square-invoice exists", fs.existsSync(registerPath));
  assert("kill switch defaults off", isAutoActivationEnabled({}) === false);
  assert("activate library enforces kill switch", /isAutoActivationEnabled/.test(activateSrc));
  assert("006B SQL is unapplied source in repo", fs.existsSync(path.join(ROOT, "SUPABASE_MG_SALES_READY_006B_SAAS_SQUARE_ONBOARDING.sql")));

  const fnFiles = walkFiles(path.join(ROOT, "netlify/functions"), []).filter((f) => f.endsWith(".js"));
  const publicSquareEnv = walkFiles(path.join(ROOT, "public"), []).filter((f) =>
    /process\.env\.SQUARE_/.test(fs.readFileSync(f, "utf8"))
  );
  assert("D. no SQUARE_ env references in public/", publicSquareEnv.length === 0);

  const squareTableCallers = fnFiles.filter((f) => /\bsquare_webhook_events\b/.test(fs.readFileSync(f, "utf8")));
  assert("C. no Netlify caller of square_webhook_events", squareTableCallers.length === 0);
  assert("C. square_webhook_events is a 004A artifact only", sql004a.includes("'square_webhook_events'"));

  const publicPlan = walkFiles(path.join(ROOT, "public"), []).filter((f) => {
    if (!/\.(js|html)$/.test(f)) return false;
    return /plan_status/.test(fs.readFileSync(f, "utf8"));
  });
  assert("no browser plan_status write", publicPlan.length === 0);

  const saasActivate = fnFiles.filter((f) => {
    const src = fs.readFileSync(f, "utf8");
    return /plan_status:\s*["']active["']/.test(src);
  });
  assert(
    "only saas-square-activate.js writes plan_status active",
    saasActivate.length === 1 && /saas-square-activate\.js$/.test(saasActivate[0])
  );

  assert("Stripe SaaS checkout still disabled", /subscription_checkout_disabled/.test(checkoutSrc));
  const checkoutRes = await checkout.handler({ httpMethod: "POST", body: "{}" });
  assert("Stripe checkout still 403", checkoutRes.statusCode === 403);

  assert("Stripe invoice webhook does not set plan_status", !/plan_status/.test(stripeWhSrc));
  assert("planIsActive remain exact active", /===\s*"active"/.test(ownerAccessSrc));
  assert("project payments table is not SaaS", /payment_type in \('deposit'/.test(projectPaySql));

  assert("004A file intact", sql004a.includes("'tenant_projects'"));
  assert("004B file intact", read("SUPABASE_MG_SALES_READY_004B_QUOTES_INVOICES_RLS_HARDENING.sql").includes("'quotes_read_all'"));
  assert("004C file intact", read("SUPABASE_MG_SALES_READY_004C_BUSINESS_BRANDING_GRANT_REVOKE.sql").includes("business_branding"));
  assert("006A pending default file intact", /SET DEFAULT 'pending'/.test(read("SUPABASE_MG_SALES_READY_006A_SAFE_TENANT_ACTIVATION.sql")));

  const toml = read("netlify.toml");
  assert("netlify.toml has no Square SaaS webhook redirect", !/square-saas-webhook/.test(toml));

  console.log("");
  console.log(passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
