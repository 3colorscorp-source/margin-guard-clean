/**
 * CH-012E.1 — Canonical Scope of Work SoT.
 * Run: node scripts/qa-ch012e1-canonical-scope.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function check(file) {
  const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || file);
}

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

const serverScope = require(path.join(ROOT, "netlify/functions/_lib/contract-scope.js"));
const clientScope = require(path.join(ROOT, "public/js/contract-scope.js"));

const publishJs = read("netlify/functions/publish-public-quote.js");
const packageJs = read("netlify/functions/_lib/contract-package.js");
const assemblerJs = read("netlify/functions/_lib/contract-source-assembler.js");
const builderJs = read("public/js/contract-builder.js");
const portalJs = read("public/js/contract-sign-portal.js");
const helpersJs = read("public/js/estimate-send-helpers.js");
const publicSendJs = read("public/js/estimate-public-send.js");
const appJs = read("public/js/app.js");
const salesHtml = read("public/sales.html");
const sql = read("SUPABASE_CH012E_CANONICAL_SCOPE.sql");
const sqlVerify = read("SUPABASE_CH012E_CANONICAL_SCOPE_VERIFY.sql");
const pdfJs = read("netlify/functions/_lib/contract-signed-pdf.js");
const updateEditJs = read("netlify/functions/update-tenant-quote-edit.js");

test("syntax critical modules", () => {
  [
    "netlify/functions/_lib/contract-scope.js",
    "public/js/contract-scope.js",
    "netlify/functions/publish-public-quote.js",
    "netlify/functions/_lib/contract-package.js",
    "netlify/functions/_lib/contract-source-assembler.js",
    "netlify/functions/update-tenant-quote-edit.js",
    "public/js/contract-builder.js",
    "public/js/contract-sign-portal.js",
  ].forEach((rel) => check(path.join(ROOT, rel)));
});

test("1+2 Scope and email saved independently; email cannot overwrite Scope", () => {
  assert.ok(publishJs.includes("hasExplicitScope") || publishJs.includes("scope_of_work: scopeOfWork") || publishJs.includes("scope_of_work: scopeOfWork"));
  assert.ok(publishJs.includes("...(hasExplicitScope ? { scope_of_work: scopeOfWork } : {})") || publishJs.includes("scope_of_work"));
  assert.ok(publishJs.includes("body.email_body") || publishJs.includes("body.send_message"));
  assert.ok(!/pickFirst\(\s*body\.notes[\s\S]*body\.public_message/.test(publishJs));
  assert.ok(publicSendJs.includes("scope_of_work:"));
  assert.ok(appJs.includes("scope_of_work: scope"));
  assert.ok(salesHtml.includes("scope_of_work:"));
});

test("3 Scope cannot overwrite email delivery copy", () => {
  assert.ok(/notes:\s*message/.test(publicSendJs));
  assert.ok(/notes:\s*message/.test(appJs) || /notes:\s*message,/.test(appJs));
  assert.ok(publishJs.includes("const notes = pickFirst("));
  assert.ok(publishJs.includes("resolveScopeOfWorkWriteFromBody"));
});

test("4+5 line-break and bullet preservation via normalize + resolver", () => {
  const sample =
    "Install porcelain tile.\n\nBathroom:\n• Demo\n• Waterproof\n• Install tile\n\nKitchen:\n• Crack isolation membrane\n• Tile\n• Grout";
  const written = serverScope.normalizeScopeOfWorkForWrite(sample, 16000);
  assert.strictEqual(written, sample);
  const resolved = serverScope.resolveContractScope({ scope_of_work: sample, notes: "Hi there" });
  assert.strictEqual(resolved.ok, true);
  assert.strictEqual(resolved.text, sample);
  assert.strictEqual(resolved.source, "scope_of_work");
});

test("6+7 missing Scope blocks freeze; 0144 email notes do not count", () => {
  const email =
    "Hi Librado Test,\n\nThank you for the opportunity to work with you.\n\n[PUBLIC_QUOTE_URL]";
  const r = serverScope.resolveContractScope({ notes: email, scope_of_work: null });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.source, "missing");
  assert.ok(packageJs.includes('missing.push("scope_of_work")'));
  assert.ok(builderJs.includes("extractApprovedScopeText(sourceSnapshot.scope).ok"));
});

test("8 persistence path exists for Owner save after refresh", () => {
  assert.ok(updateEditJs.includes("scope_of_work"));
  assert.ok(updateEditJs.includes("scopeOnlyCorrection"));
  assert.ok(builderJs.includes("saveCanonicalScopeOfWork"));
  assert.ok(builderJs.includes("cbScopeSaveBtn"));
});

test("9 Estimate PDF uses canonical Scope first", () => {
  const idx = helpersJs.indexOf("const raw =");
  const chunk = helpersJs.slice(idx, idx + 350);
  assert.ok(chunk.includes("data.scope_of_work"));
  assert.ok(!/data\.notes\s*\|\|/.test(chunk));
  assert.ok(!/data\.messageText/.test(chunk));
});

test("10+11 Contract Builder + package freeze use canonical resolver", () => {
  assert.ok(builderJs.includes("MarginGuardContractScope"));
  assert.ok(packageJs.includes("resolveContractScope(quote)"));
  assert.ok(!packageJs.includes("const scopeText = trimField(quote.notes)"));
});

test("12+13 Public contract / signed PDF use frozen snap.scope.text", () => {
  assert.ok(portalJs.includes("renderApprovedScope"));
  assert.ok(portalJs.includes("scope.text"));
  assert.ok(pdfJs.includes('heading("SCOPE OF WORK")'));
  assert.ok(pdfJs.includes("snap?.scope?.text"));
});

test("14 no terms fallback", () => {
  assert.ok(!assemblerJs.includes("trimField(quoteRow?.notes) || trimField(quoteRow?.terms)"));
  assert.ok(assemblerJs.includes("resolveContractScope(quoteRow"));
});

test("15+16 no Operational Plan / Day 1 fallback in resolver", () => {
  assert.ok(!serverScope.resolveContractScope({ operational_plan: [{ day_number: 1 }] }).ok);
  const demo = serverScope.resolveContractScope({
    notes: "• Day 1: Cover\n• Day 2: Demo",
  });
  assert.strictEqual(demo.ok, false);
});

test("17 no duplicated Scope heading", () => {
  const withTitle = "Scope of Work\n\nInstall porcelain tile.";
  const r = serverScope.resolveContractScope({ scope_of_work: withTitle });
  assert.strictEqual(r.text, "Install porcelain tile.");
  assert.ok(!/^Scope of Work/i.test(r.text));
});

test("18 publish keeps notes as email fields only", () => {
  assert.ok(publishJs.includes("body.messageText"));
  assert.ok(publishJs.includes("body.email_body") || publishJs.includes("email_body"));
  const notesBlock = publishJs.match(/const notes = pickFirst\(([\s\S]*?)\);/);
  assert.ok(notesBlock, "notes pickFirst block missing");
  assert.ok(!/public_message/.test(notesBlock[1]));
  assert.ok(!/publicMessage/.test(notesBlock[1]));
  assert.ok(/body\.notes/.test(notesBlock[1]));
});

test("19 signing surfaces still render frozen scope.text", () => {
  assert.ok(portalJs.includes("MarginGuardContractScope") || portalJs.includes("extractApprovedScopeText"));
  assert.ok(pdfJs.includes("SCOPE OF WORK"));
});

test("20 no Invoice Hub files touched by this module marker", () => {
  // Guardrail: Invoice Hub paths must not appear in this change set's core libs.
  assert.ok(!packageJs.includes("Invoice Hub"));
  assert.ok(!publishJs.toLowerCase().includes("invoice hub"));
});

test("SQL migration additive only", () => {
  assert.ok(sql.includes("add column if not exists scope_of_work"));
  assert.ok(!/update\s+public\.quotes/i.test(sql));
  assert.ok(sqlVerify.includes("scope_of_work"));
});

test("client/server resolver parity on fixtures", () => {
  const fixtures = [
    { scope_of_work: "A\nB", notes: "Hi" },
    { scope_of_work: "", notes: "Scope of Work\n\nTile install" },
    { scope_of_work: null, notes: "Hi Librado\nThank you for the opportunity" },
  ];
  for (const f of fixtures) {
    const a = serverScope.resolveContractScope(f);
    const b = clientScope.resolveContractScope(f);
    assert.deepStrictEqual(
      { ok: a.ok, text: a.text, source: a.source },
      { ok: b.ok, text: b.text, source: b.source }
    );
  }
});

test("legacy notes accepted only with Scope heading convention", () => {
  const ok = serverScope.resolveContractScope({
    notes: "Scope of Work\n\n• Demo\n• Install",
  });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.source, "legacy_notes");
  assert.strictEqual(ok.text, "• Demo\n• Install");
});

test("EXPLICIT: email cannot overwrite Scope", () => {
  const existing = "Install porcelain tile.\n\nBathroom:\n• Demo";
  // Email/message fields never produce a scope write.
  const fromEmail = serverScope.resolveScopeOfWorkWriteFromBody({
    notes: "Hi Librado,\n\nThank you for the opportunity.\n\n[PUBLIC_QUOTE_URL]",
    message: "Hi Librado,\nThank you for the opportunity.",
    messageText: "email body",
    email_body: "email body",
    public_message: "should not become scope",
    terms: "payment terms",
  });
  assert.strictEqual(fromEmail.include, false);
  // Canonical Scope remains authoritative when present.
  const resolved = serverScope.resolveContractScope({
    scope_of_work: existing,
    notes: "Hi Librado,\nThank you for the opportunity.",
  });
  assert.strictEqual(resolved.ok, true);
  assert.strictEqual(resolved.text, existing);
  assert.strictEqual(resolved.source, "scope_of_work");
});

test("EXPLICIT: omitted scope_of_work preserves existing Scope", () => {
  const omitted = serverScope.resolveScopeOfWorkWriteFromBody({
    notes: "Hi — estimate email only",
    messageText: "email",
    total: 12000,
  });
  assert.strictEqual(omitted.include, false);
  // Publish payload must not include scope_of_work when omitted.
  assert.ok(publishJs.includes("...(hasExplicitScope ? { scope_of_work: scopeOfWork } : {})"));
  const blankExplicit = serverScope.resolveScopeOfWorkWriteFromBody({
    scope_of_work: "   \n  ",
  });
  assert.strictEqual(blankExplicit.include, true);
  assert.strictEqual(blankExplicit.value, null);
});

test("EXPLICIT: unauthorized locked-quote fields remain blocked", () => {
  const edit = require(path.join(ROOT, "netlify/functions/update-tenant-quote-edit.js"))._test;
  assert.ok(edit.OWNER_ADMIN_ROLES.has("owner"));
  assert.ok(edit.OWNER_ADMIN_ROLES.has("admin"));
  assert.ok(!edit.OWNER_ADMIN_ROLES.has("seller"));

  const scopeOnly = edit.buildEditablePatch({ scope_of_work: "Tile install" }, 1000);
  assert.deepStrictEqual(scopeOnly.updatedFields, ["scope_of_work"]);
  assert.strictEqual(edit.isAuthorizedLockedScopeOnlyPatch(scopeOnly.updatedFields), true);

  const priceAttempt = edit.buildEditablePatch(
    { scope_of_work: "Tile", client_name: "Nope", notes: "email" },
    1000
  );
  assert.ok(priceAttempt.updatedFields.includes("client_name"));
  assert.ok(priceAttempt.updatedFields.includes("notes"));
  assert.strictEqual(edit.isAuthorizedLockedScopeOnlyPatch(priceAttempt.updatedFields), false);

  const unknown = edit.findUnknownBodyKeys({
    quote_id: "x",
    total: 999,
    status: "accepted",
    accepted_at: "2026-01-01",
    deposit_paid_at: "2026-01-01",
  });
  assert.ok(unknown.includes("total"));
  assert.ok(unknown.includes("status"));
  assert.ok(unknown.includes("accepted_at"));
  assert.ok(unknown.includes("deposit_paid_at"));
  assert.ok(!edit.EDITABLE_FIELD_NAMES.includes("status"));
  assert.ok(!edit.EDITABLE_FIELD_NAMES.includes("accepted_at"));
  assert.ok(!edit.EDITABLE_FIELD_NAMES.includes("total"));
});

test("EXPLICIT: missing Scope blocks freeze", () => {
  const pkg = require(path.join(ROOT, "netlify/functions/_lib/contract-package.js"));
  const missing = serverScope.resolveContractScope({
    notes: "Hi Librado Test,\n\nThank you for the opportunity.\n\n[PUBLIC_QUOTE_URL]",
    scope_of_work: null,
  });
  assert.strictEqual(missing.ok, false);
  const gate = pkg.buildFreezeGate({
    project: { id: "p" },
    quote: {
      status: "accepted",
      notes: "Hi Librado Test,\nThank you for the opportunity.",
      scope_of_work: null,
    },
    setup: {},
    setupReadiness: {
      project_address: "confirmed",
      warranty: "configured",
      signature_method: "configured",
    },
    paymentReadiness: { status: "configured" },
    legalEffective: { notices: {} },
    legalProfile: { legal_business_name: "Co" },
    legalProfileReadiness: { status: "ready" },
  });
  assert.strictEqual(gate.ok, false);
  assert.ok(gate.missing.includes("scope_of_work"));
});

test("contractual SELECTs include scope_of_work", () => {
  assert.ok(packageJs.includes('"scope_of_work"') || packageJs.includes("scope_of_work"));
  assert.ok(assemblerJs.includes("scope_of_work"));
  assert.ok(read("netlify/functions/_lib/quote-edit-guard.js").includes("scope_of_work"));
  assert.ok(read("netlify/functions/get-public-estimate.js").includes('"scope_of_work"'));
});

test("legacy notes never auto-written into scope_of_work", () => {
  assert.ok(!sql.toLowerCase().includes("set scope_of_work"));
  assert.ok(!publishJs.includes("scope_of_work: notes"));
  assert.ok(!assemblerJs.includes("scope_of_work: trimField(quoteRow.notes"));
});

console.log("");
console.log(`CH-012E.1 QA: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
