/**
 * CH-011G — Signature capture QA (static + pure unit).
 * Run: node scripts/qa-ch011g-signature-capture.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const sqlPath = path.join(ROOT, "SUPABASE_CH011G_SIGNATURE_CAPTURE.sql");
const verifyPath = path.join(ROOT, "SUPABASE_CH011G_SIGNATURE_CAPTURE_VERIFY.sql");
const libPath = path.join(ROOT, "netlify/functions/_lib/contract-sign.js");
const handlerPath = path.join(ROOT, "netlify/functions/contract-sign.js");

const sqlSrc = fs.readFileSync(sqlPath, "utf8");
const verifySrc = fs.readFileSync(verifyPath, "utf8");
const libSrc = fs.readFileSync(libPath, "utf8");
const handlerSrc = fs.readFileSync(handlerPath, "utf8");

const lib = require("../netlify/functions/_lib/contract-sign");
const handlerMod = require("../netlify/functions/contract-sign");

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

function check(file) {
  const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  assert.strictEqual(r.status, 0, r.stderr || r.stdout);
}

test("syntax lib + handler", () => {
  check(libPath);
  check(handlerPath);
});

test("1-4. Invalid/revoked/expired token codes", () => {
  for (const code of ["invalid_token", "revoked", "expired"]) {
    assert.ok(libSrc.includes(`"${code}"`) || libSrc.includes(`'${code}'`));
  }
});

test("5. Already signed / recorded", () => {
  assert.ok(libSrc.includes("signature_already_recorded"));
});

test("6. Missing consent", () => {
  assert.ok(libSrc.includes("consent_required"));
  assert.ok(libSrc.includes("consentEsign !== true") || libSrc.includes("consent_esign"));
});

test("7-8. Typed + drawn success paths", () => {
  assert.ok(lib.SIGNATURE_METHODS.has("typed"));
  assert.ok(lib.SIGNATURE_METHODS.has("drawn"));
  const typed = lib.validateSignaturePayload("typed", { typed_name: "Jane Doe" });
  assert.ok(typed.ok);
  assert.strictEqual(typed.signature_json.typed_name, "Jane Doe");
  assert.ok(typed.signature_json.rendered_name);
  assert.ok(typed.signature_json.signed_at);
  const drawn = lib.validateSignaturePayload("drawn", {
    svg_path: "M10 10 L20 20",
  });
  assert.ok(drawn.ok);
  assert.strictEqual(drawn.signature_json.format, "svg_path");
  const drawnVec = lib.validateSignaturePayload("drawn", {
    paths: [{ x: 1, y: 2 }],
  });
  assert.ok(drawnVec.ok);
});

test("9-10. Signer signed + token consumed", () => {
  assert.ok(libSrc.includes('status: "signed"'));
  assert.ok(libSrc.includes("signed_at"));
  assert.ok(libSrc.includes('status: "consumed"'));
  assert.ok(libSrc.includes("consumed_at"));
});

test("11-13. Progression completed / next / package executed", () => {
  assert.ok(libSrc.includes("next_signer_pending"));
  assert.ok(libSrc.includes('progression = "completed"'));
  assert.ok(libSrc.includes('status: "completed"'));
  assert.ok(libSrc.includes('status: "executed"'));
  assert.ok(libSrc.includes("executed_at"));
});

test("14. Append-only audit", () => {
  assert.ok(sqlSrc.includes("tenant_contract_signature_events"));
  assert.ok(sqlSrc.includes("signature_event_append_only"));
  assert.ok(sqlSrc.includes("before update"));
  assert.ok(sqlSrc.includes("before delete"));
  assert.ok(libSrc.includes("tenant_contract_signature_events"));
});

test("15. Replay identical POST after success", () => {
  assert.ok(sqlSrc.includes("tenant_contract_signature_events_one_per_signer_uidx"));
  assert.ok(libSrc.includes('tokenStatus === "consumed"'));
  assert.ok(libSrc.includes("signature_already_recorded"));
  assert.ok(libSrc.includes("signer_status"));
  assert.ok(handlerSrc.includes("signer_status"));
  assert.ok(handlerSrc.includes("signed_at"));
  // Consumed-token branch returns 409 without writes
  assert.ok(
    /tokenStatus === "consumed"[\s\S]{0,500}signature_already_recorded/.test(libSrc)
  );
  assert.ok(
    /tokenStatus === "consumed"[\s\S]{0,500}signer_status/.test(libSrc)
  );
});

test("16. Optimistic concurrency", () => {
  assert.ok(libSrc.includes("stale_updated_at"));
  assert.ok(handlerSrc.includes("expected_updated_at"));
});

test("17. Owner APIs unchanged / token-only auth", () => {
  assert.ok(!handlerSrc.includes("requireOwnerOrAdmin"));
  assert.ok(!handlerSrc.includes("readSessionFromEvent"));
  assert.ok(handlerSrc.includes("signing_token"));
  assert.ok(handlerSrc.includes("_forbidden"));
  assert.ok(handlerSrc.includes('"tenant_id"'));
});

test("18-20. No Invoice Hub / Stripe / PI", () => {
  for (const src of [libSrc, handlerSrc]) {
    assert.ok(!/require\(["'].*stripe/i.test(src));
    assert.ok(!/project-payment-intent/.test(src));
    assert.ok(!/tenant_project_payments/.test(src));
    assert.ok(!/docusign|sendgrid|resend/i.test(src));
    assert.ok(!/ledger/i.test(src));
  }
});

test("21. Tenant isolation via token hash", () => {
  assert.ok(libSrc.includes("hashRawToken"));
  assert.ok(libSrc.includes("loadTokenByHash"));
  assert.ok(handlerSrc.includes('"signer_id"'));
  assert.ok(handlerSrc.includes('"envelope_id"'));
  assert.ok(handlerSrc.includes('"package_id"'));
});

test("22. XSS-safe typed signature", () => {
  const dirty = lib.sanitizeTypedName('<script>alert(1)</script>Jane');
  assert.ok(!dirty.includes("<"));
  assert.ok(!dirty.includes(">"));
  assert.ok(!/script/i.test(dirty));
  assert.ok(dirty.includes("Jane"));
  const empty = lib.validateSignaturePayload("typed", { typed_name: "<b></b>" });
  assert.ok(!empty.ok);
});

test("Empty / unsupported method", () => {
  assert.strictEqual(
    lib.validateSignaturePayload("typed", { typed_name: "   " }).code,
    "empty_signature_payload"
  );
  assert.strictEqual(
    lib.validateSignaturePayload("upload", { file: "x" }).code,
    "unsupported_signature_method"
  );
  assert.ok(
    /base64|Raster/i.test(
      lib.validateSignaturePayload("drawn", { svg_path: "data:image/png;base64,xxx" }).error || ""
    ) ||
      lib.validateSignaturePayload("drawn", { svg_path: "data:image/png;base64,xxx" }).code ===
        "unsupported_signature_method"
  );
});

test("Progression helpers", () => {
  const signers = [
    { id: "1", is_required: true, status: "signed", sign_order: 1 },
    { id: "2", is_required: true, status: "pending", sign_order: 2, role: "owner", party_name: "O" },
  ];
  assert.strictEqual(lib.nextPendingRequired(signers, "1").id, "2");
  assert.strictEqual(lib.allRequiredSigned(signers), false);
  signers[1].status = "signed";
  assert.strictEqual(lib.allRequiredSigned(signers), true);
});

test("SQL objects + verify", () => {
  assert.ok(sqlSrc.includes("signed_at"));
  assert.ok(sqlSrc.includes("executed_at"));
  assert.ok(sqlSrc.includes("'pending', 'signed'"));
  assert.ok(verifySrc.includes("CH-011G VERIFY"));
  assert.ok(fs.existsSync(verifyPath));
});

test("Handlers + version + no certificate/mail providers", () => {
  assert.strictEqual(typeof handlerMod.handler, "function");
  assert.strictEqual(lib.API_VERSION, "ch-011g-v1");
  assert.ok(!/docusign|sendgrid|nodemailer/i.test(libSrc));
  assert.ok(!/docusign|sendgrid|nodemailer/i.test(handlerSrc));
  assert.ok(!/generatePdf|signed_pdf|certificate_pdf/i.test(libSrc));
});

test("Never store raw token", () => {
  assert.ok(!sqlSrc.includes("raw_token"));
  assert.ok(sqlSrc.includes("token_id uuid not null"));
  assert.ok(sqlSrc.includes("Raw signing token never stored") || sqlSrc.includes("never stored"));
});

console.log(`CH-011G QA: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
