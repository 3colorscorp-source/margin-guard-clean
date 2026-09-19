/**
 * CH-007D — compact Article 1 Contractor Information (presentation only).
 * Isolated static QA. No backend, freeze, snapshot, or live contracts.
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
const html = fs.readFileSync(htmlPath, "utf8");
const js = fs.readFileSync(jsPath, "utf8");

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

const FIELD_IDS = [
  "cbLegalName",
  "cbLegalDba",
  "cbLegalEntity",
  "cbBizPhoneBody",
  "cbBizEmailBody",
  "cbBizAddressBody",
  "cbMailingAddress",
  "cbLicenseStatus",
  "cbLicenseNumber",
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
  "cbSignerName",
  "cbSignerTitle",
  "cbServiceState",
  "cbTimezone",
  "cbContractLang",
];

test("0 syntax contract-builder.js", () => {
  const r = spawnSync(process.execPath, ["--check", jsPath], { encoding: "utf8" });
  assert.strictEqual(r.status, 0, r.stderr || r.stdout);
});

test("1 Article 1 keeps every contractor field id", () => {
  FIELD_IDS.forEach((id) => {
    const matches = art1.split(`id="${id}"`).length - 1;
    assert.strictEqual(matches, 1, id);
  });
});

test("2 visual groups are Business Identity, License, Insurance & Bond", () => {
  assert.ok(art1.includes(">Business Identity<"));
  assert.ok(art1.includes(">License<"));
  assert.ok(art1.includes("Insurance &amp; Bond"));
  assert.ok(!art1.includes(">Identity<"));
  assert.ok(art1.includes(">Authorized Signer<"));
  assert.ok(art1.includes(">Jurisdiction Defaults<"));
});

test("3 group cards use a 3 / 2 / 1 column stack, not a vertical flex column", () => {
  const contractorCss = slice(style, "Article 1 only", ".cb-dba-line");
  assert.ok(contractorCss.includes("#art-contractor .cb-contractor-stack"));
  assert.ok(contractorCss.includes("display: grid"));
  assert.ok(!/flex-direction:\s*column/.test(contractorCss));
  assert.ok(contractorCss.includes("minmax(0, 1.7fr) minmax(0, 0.9fr) minmax(0, 1.1fr)"));
  assert.ok(art1.includes("cb-contractor-group--identity"));
  assert.ok(art1.includes("cb-contractor-group--license"));
  assert.ok(art1.includes("cb-contractor-group--insurance"));
  assert.ok(art1.includes("cb-contractor-group--signer"));
  assert.ok(art1.includes("cb-contractor-group--jurisdiction"));
  assert.ok(contractorCss.includes("grid-column: 2 / 4"));
  assert.match(
    style,
    /@media \(max-width: 1024px\) \{[\s\S]*?#art-contractor \.cb-contractor-stack[\s\S]*?repeat\(2, minmax\(0, 1fr\)\)/
  );
  assert.match(
    style,
    /@media \(max-width: 640px\) \{[\s\S]*?#art-contractor \.cb-contractor-stack[\s\S]*?minmax\(0, 1fr\)/
  );
  assert.ok(!art2.includes("cb-contractor-grid"));
  assert.ok(!art4.includes("cb-contractor-grid"));
  assert.ok(art2.includes("cb-meta-grid"));
  assert.ok(art4.includes("cb-meta-grid"));
});

test("4 addresses can span a full row and wrap instead of truncating", () => {
  assert.ok(art1.includes('id="cbBizAddressBody"'));
  assert.ok(art1.includes('id="cbMailingAddress"'));
  assert.ok(art1.includes("cb-contractor-field--full"));
  assert.ok(style.includes("#art-contractor .cb-contractor-field--full"));
  assert.ok(style.includes("grid-column: 1 / -1"));
  const contractorCss = slice(style, "Article 1 only", ".cb-dba-line");
  assert.ok(!/text-overflow\s*:\s*ellipsis/.test(contractorCss));
  assert.ok(!/overflow\s*:\s*hidden/.test(contractorCss));
  assert.ok(contractorCss.includes("overflow-wrap: break-word"));
});

test("5 Bond Show control and masked-field logic are unchanged", () => {
  assert.ok(js.includes("function setMaskedField"));
  assert.ok(js.includes('revealed ? "Hide" : "Show"'));
  assert.ok(js.includes("cb-show-secret"));
  assert.ok(js.includes("data-reveal"));
  assert.ok(js.includes('setMaskedField("cbBondNumber"'));
  assert.ok(js.includes('setMaskedField("cbGlPolicy"'));
  assert.ok(js.includes('setMaskedField("cbWcPolicy"'));
  assert.ok(js.includes('[data-reveal]'));
  assert.ok(style.includes(".cb-show-secret"));
  assert.ok(html.includes(".cb-show-secret,"));
});

test("6 print and frozen surfaces keep contractor fields and hide Show", () => {
  assert.ok(html.includes("id=\"cbPrintDraft\""));
  assert.ok(js.includes("prepareFullDocumentForPrint"));
  assert.ok(js.includes("window.print()"));
  const printCss = slice(style, "@media print", "a[href]::after");
  assert.ok(printCss.includes(".cb-show-secret"));
  assert.ok(html.includes("@media print"));
  assert.ok(style.includes("#art-contractor .cb-contractor-grid"));
  assert.match(
    style,
    /@media print \{[\s\S]*?#art-contractor \.cb-contractor-stack[\s\S]*?repeat\(2, minmax\(0, 1fr\)\)/
  );
  FIELD_IDS.forEach((id) => assert.ok(html.includes(`id="${id}"`), id));
});

test("7 no API / freeze / snapshot / validation logic changed in JS", () => {
  const diff = spawnSync("git", ["diff", "--", "public/js/contract-builder.js"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.strictEqual(diff.status, 0, diff.stderr);
  assert.strictEqual(String(diff.stdout || "").trim(), "", "contract-builder.js must stay unchanged");
});

test("8 other articles are not rewritten", () => {
  assert.ok(art2.includes("Customer Information"));
  assert.ok(art2.includes("cbCustomerName"));
  assert.ok(!art2.includes("cb-contractor-group"));
  const names = spawnSync("git", ["diff", "--name-only"], { cwd: ROOT, encoding: "utf8" });
  assert.strictEqual(names.status, 0, names.stderr);
  const files = String(names.stdout || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  files.forEach((file) => {
    assert.ok(
      file === "public/contract-builder.html" ||
        file === "scripts/qa-ch007d-contractor-info-compact.js",
      "unexpected file: " + file
    );
  });
});

console.log("");
console.log("CH-007D contractor info compact:", passed, "passed,", failed, "failed");
process.exit(failed === 0 ? 0 : 1);
