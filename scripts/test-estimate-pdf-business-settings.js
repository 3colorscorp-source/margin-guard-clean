/**
 * Estimate PDF identity comes from Business Settings / tenant branding.
 * Empty fields stay empty — no invented "Business Name" or canned taglines.
 * Isolated: source + vm. No live Netlify/Supabase.
 * Run: node scripts/test-estimate-pdf-business-settings.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

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

const helpersSrc = read("public/js/estimate-send-helpers.js");
const salesHtml = read("public/sales.html");
const appJs = read("public/js/app.js");
const publicSend = read("public/js/estimate-public-send.js");
const builderJs = read("public/js/estimate-builder.js");
const pubEst = read("netlify/functions/get-public-estimate.js");
const bsHtml = read("public/business-settings.html");

ok("helpers do not invent Business Name", !/['\"]Business Name['\"]/.test(helpersSrc));
ok("helpers do not invent Professional Service Estimate", !/Professional Service Estimate/.test(helpersSrc));
ok("helpers do not invent Professional Estimate Delivery", !/Professional Estimate Delivery/.test(helpersSrc));
ok("sales PDF does not invent Business Name", !/safeBusinessName \|\| ['\"]Business Name['\"]/.test(salesHtml));
ok("sales PDF does not invent Professional Service Estimate", !/proposalSubtitle \|\| ['\"]Professional Service Estimate['\"]/.test(salesHtml));
ok("owner branding does not invent service line", !/cached\.serviceLine,\s*[\r\n]+\s*[\"']Professional Service Estimate[\"']/.test(appJs));
ok("shared send does not invent service line", !/payload\.serviceLine \|\| [\"']Professional Service Estimate[\"']/.test(publicSend));
ok("public estimate does not invent Business", !/\|\| [\"']Business[\"']/.test(pubEst));
ok("public header does not default to Business", !/let resolved = [\"']Business[\"']/.test(builderJs));
ok("Business Settings save keeps empty service line empty", /serviceLine: safeTrim\(document\.getElementById\('serviceLine'\)\?\.value \|\| ''\)/.test(bsHtml));
ok("Business Settings form does not fill invented service line", /setInputValue\('serviceLine', branding\.serviceLine \|\| settings\.serviceLine \|\| ''\)/.test(bsHtml));
ok("Business Settings slogan is labeled for the PDF", bsHtml.includes("Service line / slogan") && bsHtml.includes("The system will not replace it."));
ok("Business Settings defaults do not invent a slogan", /serviceLine: ''/.test(bsHtml.split("const DEFAULT_BRANDING")[1].split("const PRIMARY_TRADES")[0]));
ok("get-public-estimate overlays live business_email", /resolvedBusinessEmail/.test(pubEst));
ok("get-public-estimate overlays live business_phone", /resolvedBusinessPhone/.test(pubEst));
ok("get-public-estimate overlays live business_address", /resolvedBusinessAddress/.test(pubEst));

const helperSandbox = { window: {}, console };
helperSandbox.window.window = helperSandbox.window;
vm.runInNewContext(helpersSrc + "\nthis.__H = window.__MG_ESTIMATE_SEND_HELPERS__;", helperSandbox);
const H = helperSandbox.__H;
ok("resolvePdfBusinessIdentity is exported", typeof H.resolvePdfBusinessIdentity === "function");

const fromSettings = H.resolvePdfBusinessIdentity({
  settings: {
    bizName: "Three Colors Corp",
    businessEmail: "3colorscorp@gmail.com",
    businessPhone: "4089037976",
    businessAddress: "4176 Horner Street Union City Ca 94587",
    serviceLine: "walls and floor tile"
  },
  branding: { businessName: "IGNORE", serviceLine: "Tile Contractor" },
  businessName: "IGNORE PAYLOAD",
  serviceLine: "Professional Service Estimate"
});
eq("settings business name wins", fromSettings.businessName, "Three Colors Corp");
eq("settings email wins", fromSettings.businessEmail, "3colorscorp@gmail.com");
eq("settings phone wins", fromSettings.businessPhone, "4089037976");
eq("settings address wins", fromSettings.businessAddress, "4176 Horner Street Union City Ca 94587");
eq("settings slogan is used verbatim", fromSettings.serviceLine, "walls and floor tile");

const fromBranding = H.resolvePdfBusinessIdentity({
  settings: {},
  branding: {
    business_name: "Acme Tile LLC",
    business_email: "hello@acme.test",
    business_phone: "5550100",
    business_address: "1 Main St"
  }
});
eq("branding name used when settings empty", fromBranding.businessName, "Acme Tile LLC");
eq("branding email used when settings empty", fromBranding.businessEmail, "hello@acme.test");
eq("branding phone used when settings empty", fromBranding.businessPhone, "5550100");
eq("branding address used when settings empty", fromBranding.businessAddress, "1 Main St");

const empty = H.resolvePdfBusinessIdentity({ settings: {}, branding: {} });
eq("empty name is not invented", empty.businessName, "");
eq("empty email is not invented", empty.businessEmail, "");
eq("empty phone is not invented", empty.businessPhone, "");
eq("empty address is not invented", empty.businessAddress, "");
eq("empty service line is not invented", empty.serviceLine, "");
eq("placeholder Business Name is skipped", H.resolvePdfBusinessIdentity({ businessName: "Business Name" }).businessName, "");
eq("placeholder Business is skipped", H.resolvePdfBusinessIdentity({ businessName: "Business" }).businessName, "");

const tenantSlogan = H.buildEstimateTenantPayload(
  { businessName: "From Branding", serviceLine: "Tile Contractor" },
  { bizName: "From Settings", businessEmail: "owner@biz.test", serviceLine: "walls and floor tile" },
  { businessName: "From Payload", serviceLine: "Professional Service Estimate" }
);
eq("tenant payload settings name wins", tenantSlogan.businessName, "From Settings");
eq("tenant payload settings email wins", tenantSlogan.businessEmail, "owner@biz.test");
eq("tenant payload slogan stays the Business Settings text", tenantSlogan.serviceLine, "walls and floor tile");

const tenantEmptySlogan = H.buildEstimateTenantPayload(
  { businessName: "From Branding" },
  { bizName: "From Settings", businessEmail: "owner@biz.test" },
  { businessName: "From Payload" }
);
eq("tenant payload does not invent service line", tenantEmptySlogan.serviceLine, "");

console.log("Passed " + passed + " assertions.");
