/**
 * CH-007D — Article 1 Contractor Information letterhead (presentation only).
 * Isolated static QA. Does not delete legal-profile fields from backend.
 * Run: node scripts/qa-ch007d-contractor-info-compact.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const htmlPath = path.join(ROOT, "public/contract-builder.html");
const jsPath = path.join(ROOT, "public/js/contract-builder.js");
const legalApiPath = path.join(ROOT, "netlify/functions/tenant-legal-profile.js");
const pdfPath = path.join(ROOT, "netlify/functions/_lib/contract-signed-pdf.js");
const html = fs.readFileSync(htmlPath, "utf8");
const js = fs.readFileSync(jsPath, "utf8");
const legalApi = fs.readFileSync(legalApiPath, "utf8");
const pdfSrc = fs.readFileSync(pdfPath, "utf8");
const { businessIdentityFromSnapshot } = require("../netlify/functions/_lib/contract-signed-pdf");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log("PASS", name);
    passed += 1;
  } catch (err) {
    console.log("FAIL", name, "-", err.message);
    failed += 1;
  }
}

function slice(src, startToken, endToken) {
  const start = src.indexOf(startToken);
  const end = src.indexOf(endToken, start + startToken.length);
  assert.ok(start >= 0 && end > start, `missing slice ${startToken}`);
  return src.slice(start, end);
}

const art1 = slice(html, 'id="art-contractor"', 'id="art-customer"');
const art2 = slice(html, 'id="art-customer"', 'id="art-property"');
const art4 = slice(html, 'id="art-quote"', 'id="art-scope"');
const style = slice(html, "<style>", "</style>");
const contractorCss = slice(style, "Article 1 only", ".cb-dba-line");

const VISIBLE_IDS = [
  "cbLegalName",
  "cbSignerName",
  "cbLicenseNumber",
  "cbBizAddressBody",
  "cbBizPhoneBody",
  "cbBizEmailBody",
];

const PRESENTATION_REMOVED_IDS = [
  "cbLegalEntity",
  "cbMailingAddress",
  "cbLicenseStatus",
  "cbLicenseClass",
  "cbLicenseState",
  "cbLicenseExp",
  "cbBondCompany",
  "cbBondNumber",
  "cbGlCarrier",
  "cbGlPolicy",
  "cbWcStatus",
  "cbWcCarrier",
  "cbWcPolicy",
  "cbSignerTitle",
  "cbServiceState",
  "cbTimezone",
  "cbContractLang",
];

const BACKEND_PROFILE_KEYS = [
  "entity_type",
  "mailing_address_line1",
  "contractor_license_status",
  "contractor_license_classification",
  "contractor_license_state",
  "contractor_license_expiration",
  "bond_company",
  "bond_number",
  "general_liability_carrier",
  "workers_comp_status",
  "authorized_signer_title",
  "primary_service_state",
  "timezone",
  "default_contract_language",
];

test("0 syntax contract-builder.js", () => {
  const r = spawnSync(process.execPath, ["--check", jsPath], { encoding: "utf8" });
  assert.strictEqual(r.status, 0, r.stderr || r.stdout);
});

test("1 Article 1 shows the six letterhead fields once", () => {
  VISIBLE_IDS.forEach((id) => {
    const matches = art1.split(`id="${id}"`).length - 1;
    assert.strictEqual(matches, 1, id);
  });
  assert.ok(art1.includes("cb-contractor-letterhead"));
  assert.ok(art1.includes("Contractor:"));
  assert.ok(art1.includes("id=\"cbLicenseLabel\""));
  assert.ok(art1.includes("id=\"cbLegalDba\""));
  assert.ok(art1.includes("id=\"cbLegalDba\" hidden") || art1.includes('id="cbLegalDba" hidden'));
});

test("2 settings / insurance / jurisdiction fields are gone from the contract", () => {
  PRESENTATION_REMOVED_IDS.forEach((id) => {
    assert.ok(!art1.includes(`id="${id}"`), id);
  });
  assert.ok(!art1.includes("Entity Type"));
  assert.ok(!art1.includes("License Status"));
  assert.ok(!art1.includes("Jurisdiction Defaults"));
  assert.ok(!art1.includes("Authorized Signer"));
  assert.ok(!art1.includes("Bond Company"));
  assert.ok(!art1.includes("Workers Comp"));
  assert.ok(!art1.includes("Mailing Address"));
  assert.ok(!art1.includes("Primary Service State"));
  assert.ok(!art1.includes("cb-contractor-group"));
  assert.ok(!art1.includes("cb-show-secret"));
  assert.ok(!art1.includes("data-reveal"));
  assert.ok(!art1.includes(">Show<"));
});

test("3 desktop two-column letterhead, one column on mobile, print keeps two columns", () => {
  assert.ok(contractorCss.includes("display: grid"));
  assert.ok(contractorCss.includes("minmax(0, 1fr) minmax(0, 1fr)"));
  assert.ok(!/flex-direction:\s*column/.test(contractorCss));
  assert.match(
    style,
    /@media \(max-width: 640px\) \{[\s\S]*?#art-contractor \.cb-contractor-letterhead[\s\S]*?minmax\(0, 1fr\)/
  );
  assert.match(
    style,
    /@media print \{[\s\S]*?#art-contractor \.cb-contractor-letterhead[\s\S]*?minmax\(0, 1fr\) minmax\(0, 1fr\)/
  );
  assert.ok(!art2.includes("cb-contractor-letterhead"));
  assert.ok(!art4.includes("cb-contractor-letterhead"));
  assert.ok(art2.includes("cb-meta-grid"));
  assert.ok(art4.includes("cb-meta-grid"));
});

test("4 address / email wrap instead of truncating", () => {
  assert.ok(contractorCss.includes("overflow-wrap: break-word"));
  assert.ok(contractorCss.includes("white-space: pre-wrap"));
  assert.ok(!/text-overflow\s*:\s*ellipsis/.test(contractorCss));
  assert.ok(!/#art-contractor \.cb-contractor-letterhead__name[\s\S]{0,200}overflow\s*:\s*hidden/.test(contractorCss));
});

test("5 JS still maps legal profile; Show/Hide is not used in Article 1", () => {
  assert.ok(js.includes("LEGAL_PROFILE_API"));
  assert.ok(js.includes("authorizedSignerName"));
  assert.ok(js.includes("authorizedSignerTitle"));
  assert.ok(js.includes("setText(\"cbLegalEntity\""));
  assert.ok(js.includes("setText(\"cbMailingAddress\""));
  assert.ok(js.includes("setText(\"cbLicenseStatus\""));
  assert.ok(js.includes("setText(\"cbBondCompany\""));
  assert.ok(js.includes("setMaskedField(\"cbBondNumber\""));
  assert.ok(js.includes("setMaskedField(\"cbGlPolicy\""));
  assert.ok(js.includes("setMaskedField(\"cbWcPolicy\""));
  assert.ok(js.includes("setText(\"cbSignerTitle\""));
  assert.ok(js.includes("setText(\"cbServiceState\""));
  assert.ok(js.includes("cbContractorNameLine"));
  assert.ok(js.includes("contractorLicenseHeading"));
  assert.ok(js.includes("function setMaskedField"));
  assert.ok(!art1.includes("cb-show-secret"));
});

test("6 Print Draft and freeze still use the same Article 1 HTML", () => {
  assert.ok(html.includes('id="cbPrintDraft"'));
  assert.ok(js.includes("prepareFullDocumentForPrint"));
  assert.ok(js.includes("window.print()"));
  assert.ok(js.includes("contract-package-freeze"));
  assert.ok(html.includes("@media print"));
});

test("7 backend legal profile still stores the hidden presentation fields", () => {
  BACKEND_PROFILE_KEYS.forEach((key) => {
    assert.ok(legalApi.includes(`"${key}"`), key);
  });
  assert.ok(js.includes("authorizedSignerName && p?.authorizedSignerTitle") ||
    js.includes("authorizedSignerName && p.authorizedSignerTitle") ||
    /authorizedSignerName && p\??\.authorizedSignerTitle/.test(js));
  assert.ok(js.includes("if (!(p.authorizedSignerName && p.authorizedSignerTitle))"));
});

test("8 signed PDF identity matches the six-line letterhead, not a settings dump", () => {
  const lines = businessIdentityFromSnapshot({
    business_settings: {
      legal_profile: {
        legal_business_name: "Harborline Builders LLC",
        dba_name: "",
        authorized_signer_name: "Alex Rivera",
        authorized_signer_title: "President",
        business_address_line1: "10 Pier Ave",
        business_city: "Oakland",
        business_state: "CA",
        business_postal_code: "94607",
        business_phone: "510-555-0199",
        business_email: "ops@harborline.test",
        contractor_license_number: "999000",
        contractor_license_state: "CA",
        contractor_license_status: "licensed",
        bond_company: "Should Not Appear",
        bond_number: "B-1",
        entity_type: "llc",
        primary_service_state: "CA",
      },
    },
  });
  assert.deepStrictEqual(lines, [
    "Harborline Builders LLC",
    "Contractor: Alex Rivera",
    "California Contractor License #: 999000",
    "10 Pier Ave",
    "Oakland, CA 94607",
    "510-555-0199",
    "ops@harborline.test",
  ]);
  assert.ok(!lines.some((l) => /President|Should Not Appear/.test(l)));
  assert.ok(!lines.some((l) => /^llc$/i.test(l)));
  const emptyDba = businessIdentityFromSnapshot({
    business_settings: {
      legal_profile: {
        legal_business_name: "Solo GC",
        dba_name: "",
        contractor_license_status: "exempt",
        contractor_license_number: "HIDDEN",
      },
    },
  });
  assert.ok(!emptyDba.some((l) => /DBA:/.test(l)));
  assert.ok(!emptyDba.some((l) => /HIDDEN/.test(l)));
  const identityFn = slice(pdfSrc, "function businessIdentityFromSnapshot", "function propertyLine");
  assert.ok(!identityFn.includes("Phone:"));
  assert.ok(!identityFn.includes("`License:"));
});

test("9 no Three Colors tenant data hardcoded in Article 1 surfaces", () => {
  const surfaces = art1 + contractorCss + js.slice(js.indexOf("function renderContractorArticle"));
  assert.doesNotMatch(surfaces, /Three Colors Corp/i);
  assert.doesNotMatch(surfaces, /1083733/);
  assert.doesNotMatch(surfaces, /3colorscorp@gmail\.com/i);
  assert.doesNotMatch(surfaces, /4176 Horner/i);
  assert.doesNotMatch(art1, /California Contractor License #: 1083733/);
  assert.ok(js.includes("contractorLicenseHeading"));
  assert.ok(js.includes("p?.contractorLicenseState || p?.businessState"));
});

test("10 other articles are not rewritten", () => {
  assert.ok(art2.includes("Customer Information"));
  assert.ok(art2.includes("cbCustomerName"));
  assert.ok(!art2.includes("cb-contractor-letterhead"));
  assert.ok(html.includes('id="art-scope"'));
  assert.ok(html.includes('id="art-signatures"'));
});

test("11 customer-only and contractor+customer signing policy files still exist", () => {
  const signing = path.join(ROOT, "scripts/qa-ch084-contractor-customer-signing.js");
  assert.ok(fs.existsSync(signing));
  const signingSrc = fs.readFileSync(signing, "utf8");
  assert.ok(/customer-only|customer_only|Customer only/i.test(signingSrc));
  assert.ok(/contractor/i.test(signingSrc));
});

console.log("");
console.log("CH-007D contractor info letterhead:", passed, "passed,", failed, "failed");
process.exit(failed === 0 ? 0 : 1);
