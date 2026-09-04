#!/usr/bin/env node
/**
 * MG-SALES-READY-005A — SaaS Terms + Privacy public pages
 * Usage: node scripts/test-mg-sales-ready-005a.js
 *
 * Does not connect to production. Does not apply database changes.
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

const CERT_CLAIM =
  /SOC\s*2 certified|HIPAA compliant|PCI certified|PCI-DSS certified|banking license|we are a fiduciary|guaranteed secure|100%\s*secure/i;

async function main() {
  const termsPath = path.join(ROOT, "public/terms.html");
  const privacyPath = path.join(ROOT, "public/privacy.html");
  const terms = read("public/terms.html");
  const privacy = read("public/privacy.html");
  const indexSrc = read("public/index.html");
  const navSrc = read("public/js/mg-app-nav.js");
  const toml = read("netlify.toml");
  const billingSrc = read("public/js/billing.js");

  assert("1. /terms.html exists as a public file", fs.existsSync(termsPath) && terms.length > 500);
  assert("2. /privacy.html exists as a public file", fs.existsSync(privacyPath) && privacy.length > 500);
  assert("1b. terms.html is public (no app-nav / auth shell)", /data-public="true"/.test(terms) && !/mg-app-nav/.test(terms));
  assert("2b. privacy.html is public (no app-nav / auth shell)", /data-public="true"/.test(privacy) && !/mg-app-nav/.test(privacy));
  assert("3. login page links to terms and privacy", /href="\/terms\.html"/.test(indexSrc) && /href="\/privacy\.html"/.test(indexSrc));
  assert("3b. login states organization acceptance", /By activating and using Margin Guard, your organization agrees to the Margin Guard Terms of Service and acknowledges the Privacy Policy/.test(indexSrc));
  assert("3c. owner sidebar links terms and privacy", /href="\/terms\.html"/.test(navSrc) && /href="\/privacy\.html"/.test(navSrc));
  assert("3d. pretty URLs redirect without auth", /from = "\/terms"/.test(toml) && /from = "\/privacy"/.test(toml));
  assert("4. terms state USD $2,000 annual plan", /USD \$2,000/.test(terms) && /annual/i.test(terms));
  assert(
    "5. terms do not describe Stripe as SaaS subscription processor",
    /not processed by Stripe/.test(terms) &&
      !/Checkout seguro con Stripe/.test(terms) &&
      !/Suscribirme anual/.test(terms) &&
      !/billed (automatically )?by Stripe/i.test(terms)
  );
  assert("6. QuickBooks/Square manual billing", /QuickBooks/.test(terms) && /Square/.test(terms) && /manually/.test(terms));
  assert("7. Financial Connections is read-only balances", /read-only balance monitoring/.test(terms) && /balances only/.test(terms));
  assert(
    "8. no money-movement capability claim",
    /cannot be used by Margin Guard to debit/.test(terms) &&
      /initiate ACH/.test(terms) &&
      /not a bank/.test(terms) &&
      !/Margin Guard (will|can|may) (debit|initiate ACH|transfer funds)/i.test(terms)
  );
  assert(
    "9. privacy does not collect bank credentials",
    /does not receive your bank login credentials/.test(privacy) &&
      /does not receive or expose full bank account or routing numbers/.test(privacy)
  );
  assert("9b. privacy says personal information is not sold", /does not sell customer personal information/.test(privacy));
  assert("10. no unsupported certification claims in terms", !CERT_CLAIM.test(terms));
  assert("10b. no unsupported certification claims in privacy", !CERT_CLAIM.test(privacy));
  assert("10c. terms disclaim fiduciary/accountant/bank status", /not a bank/.test(terms) && /fiduciary/.test(terms) && /accountant/.test(terms));
  assert("11. owner login form and billing.js unchanged in role", /id="ownerLoginForm"/.test(indexSrc) && /signInWithPassword/.test(billingSrc) && /restore-owner-session/.test(billingSrc));
  assert("12. 004A file unchanged in tree", read("SUPABASE_MG_SALES_READY_004A_PUBLIC_SURFACE_HARDENING.sql").includes("'tenant_projects'"));
  assert("12b. 004B file unchanged in tree", read("SUPABASE_MG_SALES_READY_004B_QUOTES_INVOICES_RLS_HARDENING.sql").includes("'quotes_read_all'"));
  assert("12c. 004C file unchanged in tree", read("SUPABASE_MG_SALES_READY_004C_BUSINESS_BRANDING_GRANT_REVOKE.sql").includes("business_branding"));
  assert("AI disclosure present", /OpenAI/.test(terms) && /OpenAI/.test(privacy));
  assert("California contact without statutory claim", /does not claim that a particular California privacy statute applies/.test(privacy));
  assert("no browser table access added", !/\.from\(/.test(terms) && !/\.from\(/.test(privacy));

  console.log("");
  console.log(passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
