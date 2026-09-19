/**
 * CH-007D — Article 3 Property presentation (no Coming Soon; 3 address states).
 * Isolated static QA. Does not delete backend property columns.
 * Run: node scripts/qa-ch007d-article3-property-clean.js
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

const art3 = slice(html, 'id="art-property"', 'id="art-quote"');
const art1 = slice(html, 'id="art-contractor"', 'id="art-customer"');
const art2 = slice(html, 'id="art-customer"', 'id="art-property"');

test("0 syntax contract-builder.js", () => {
  const r = spawnSync(process.execPath, ["--check", jsPath], { encoding: "utf8" });
  assert.strictEqual(r.status, 0, r.stderr || r.stdout);
});

test("1 Coming Soon / optional details are gone from Article 3", () => {
  assert.ok(!art3.includes("cb-prop-secondary"));
  assert.ok(!/Coming soon/i.test(art3));
  assert.ok(!/Optional details/i.test(art3));
  assert.ok(!/Site notes/i.test(art3));
  assert.ok(!/Access notes/i.test(art3));
  assert.ok(!/GPS location/i.test(art3));
  assert.ok(!/Photos/i.test(art3));
  assert.ok(!html.includes("cb-prop-secondary"));
});

test("2 Article 3 keeps Project, Project Address, and confirmation status", () => {
  assert.ok(art3.includes("cb-prop-workspace__eyebrow"));
  assert.ok(art3.includes(">Project<"));
  assert.ok(art3.includes("id=\"cbProjectName\""));
  assert.ok(art3.includes("Project Address"));
  assert.ok(art3.includes("id=\"cbPropLine1\""));
  assert.ok(art3.includes("id=\"cbPropConfirmBadge\""));
  assert.ok(art3.includes("id=\"cbPropConfirmText\""));
});

test("3 missing vs unconfirmed vs confirmed copy is distinct", () => {
  assert.ok(js.includes('message: "Add the project address to continue."'));
  assert.ok(js.includes('"Confirm the project address to continue."'));
  assert.ok(js.includes('badgeText.textContent = "Add the project address to continue."'));
  assert.ok(js.includes('badgeText.textContent = "Confirm the project address to continue."'));
  assert.ok(js.includes('badgeText.textContent = "Property Address Confirmed"'));
  const addIdx = js.indexOf("Add the project address to continue.");
  const confirmIdx = js.indexOf("Confirm the project address to continue.");
  assert.ok(addIdx > 0 && confirmIdx > 0);
  assert.ok(js.includes("if (!present)"));
  assert.ok(js.includes("Needs confirmation"));
  assert.ok(!js.includes("Address looks complete — Save to confirm"));
});

test("4 CTAs follow empty / unconfirmed / confirmed", () => {
  assert.ok(js.includes('saveLabel: "Confirm Project Address"'));
  assert.ok(js.includes('"Add Project Address"'));
  assert.ok(js.includes('"Edit Project Address"'));
  assert.ok(js.includes('"Confirm Project Address"'));
  assert.ok(js.includes("cbWsConfirmProperty"));
  assert.ok(js.includes("function workspaceConfirmProperty"));
  assert.ok(js.includes("propertyBlocksContinue"));
  assert.ok(js.includes("!propertyConfigured(sourceSnapshot?.contractSetup)"));
  assert.ok(!js.includes('saveLabel: "Confirm Property"'));
  assert.ok(!js.includes('editLabel: "Edit Property"'));
});

test("5 confirmation stays explicit; address is not auto-rewritten", () => {
  assert.ok(js.includes("confirm_property_address: true"));
  assert.ok(js.includes("function propertyConfigured"));
  assert.ok(js.includes("project_address || \"\").toLowerCase() === \"confirmed\"") ||
    js.includes('project_address || "").toLowerCase() === "confirmed"'));
  assert.ok(js.includes("await savePropertyWorkspace(fields)"));
  assert.ok(!/property_city:\s*\"CA\"/.test(js));
});

test("6 backend property setup API is still used", () => {
  assert.ok(js.includes("CONTRACT_SETUP_API"));
  assert.ok(js.includes("property_address_line1"));
  assert.ok(js.includes("property_address_line2"));
  assert.ok(js.includes("property_city"));
  assert.ok(js.includes("property_state"));
  assert.ok(js.includes("property_postal_code"));
  assert.ok(js.includes("id=\"cbPropEditLine1\"") || html.includes('id="cbPropEditLine1"'));
});

test("7 other articles are not rewritten", () => {
  assert.ok(art1.includes("Contractor Information"));
  assert.ok(art2.includes("Customer Information"));
  assert.ok(html.includes('id="art-quote"'));
  assert.ok(html.includes('id="art-payment"'));
  assert.ok(html.includes('id="art-schedule"'));
  assert.ok(html.includes('id="art-signatures"'));
  assert.ok(!art1.includes("Coming soon"));
});

test("8 Preview and Print still expand Article 3 without Coming Soon", () => {
  assert.ok(html.includes("is-preview"));
  assert.ok(html.includes("is-printing"));
  assert.ok(html.includes("id=\"cbPrintDraft\""));
  assert.ok(!/is-preview[\s\S]{0,200}Coming soon/i.test(html));
});

console.log("");
console.log("CH-007D Article 3 property clean:", passed, "passed,", failed, "failed");
process.exit(failed === 0 ? 0 : 1);
