/**
 * CH-011I PDF render — encoding, wrap, terms, hash, pagination.
 * Run: node scripts/qa-ch011i-signed-pdf-render.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const libPath = path.join(ROOT, "netlify/functions/_lib/contract-signed-pdf.js");
const pdfUtilPath = path.join(ROOT, "netlify/functions/_lib/simple-pdf.js");

const libSrc = fs.readFileSync(libPath, "utf8");
const pdfUtilSrc = fs.readFileSync(pdfUtilPath, "utf8");
const lib = require("../netlify/functions/_lib/contract-signed-pdf");
const pdfUtil = require("../netlify/functions/_lib/simple-pdf");

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

function sampleSnap(overrides = {}) {
  return {
    schema: "ch-011a-v1",
    business_settings: {
      source: "business_settings",
      legal_profile: {
        legal_business_name: "Acme Builders LLC",
        business_phone: "555-0100",
        business_email: "ops@acme.test",
        business_address_line1: "1 Main St",
        business_city: "Hayward",
        business_state: "CA",
        business_postal_code: "94544",
        contractor_license_number: "LIC-9",
      },
      branding: { business_name: "Acme" },
    },
    customer: { name: "Pat Customer", email: "pat@example.com", phone: "555-2" },
    project: { id: "proj-1", name: "Kitchen Remodel", status: "active" },
    property: {
      address_line1: "99 Oak Ave",
      city: "Hayward",
      state: "CA",
      postal_code: "94544",
    },
    quote: {
      id: "q1",
      title: "Kitchen Remodel Contract",
      total: 12000,
      currency: "USD",
      deposit_required: 2000,
    },
    price: { contract_total: 12000, currency: "USD", deposit_required: 2000 },
    scope: { text: "Demo and install cabinets." },
    payment_schedule: {
      items: [
        {
          sequence_number: 1,
          label: "Deposit",
          amount: 2000,
          due_rule: "on_signing",
        },
        {
          sequence_number: 2,
          label: "Final",
          percentage: 80,
          due_rule: "on_completion",
        },
      ],
    },
    warranty: {
      duration_value: 1,
      duration_unit: "year",
      summary: "Workmanship warranty",
      exclusions: "Acts of God",
    },
    terms: { quote_terms: "Net 15 after invoice." },
    legal_notices: {
      notices: {
        contract_notice: "This is a binding agreement.",
        payment_notice: "Payments due as scheduled.",
      },
    },
    ...overrides,
  };
}

function sampleCtx(opts = {}) {
  const signerId = "11111111-1111-4111-8111-111111111111";
  const eventId = "22222222-2222-4222-8222-222222222222";
  const method = opts.method || "typed";
  const sj =
    opts.signature_json ||
    (method === "typed"
      ? {
          method: "typed",
          typed_name: "Pat Customer",
          rendered_name: "Pat Customer",
          signed_at: "2026-08-01T12:00:00.000Z",
        }
      : {
          method: "drawn",
          format: "svg_path",
          svg_path: "M10 40 C 20 10, 40 10, 50 40",
          signed_at: "2026-08-01T12:00:00.000Z",
        });
  return {
    snap: opts.snap || sampleSnap(),
    pkg: {
      id: "33333333-3333-4333-8333-333333333333",
      version: 2,
      status: "executed",
      content_hash:
        opts.contentHash ||
        "a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00",
    },
    envelope: {
      id: "44444444-4444-4444-8444-444444444444",
      status: "completed",
      completed_at: "2026-08-01T12:05:00.000Z",
      project_id: "55555555-5555-4555-8555-555555555555",
    },
    certificate: {
      id: "66666666-6666-4666-8666-666666666666",
      certificate_number: "MG-CERT-ABCDEF0123456789",
      content_hash: "b".repeat(64),
      issued_at: "2026-08-01T12:10:00.000Z",
    },
    signers: [
      {
        id: signerId,
        role: "customer",
        party_name: "Pat Customer",
        email: "pat@example.com",
        sign_order: 1,
        status: "signed",
        is_required: true,
        signed_at: "2026-08-01T12:00:00.000Z",
      },
    ],
    events: [
      {
        id: eventId,
        signer_id: signerId,
        signature_method: method,
        signature_json: sj,
        signed_at: "2026-08-01T12:00:00.000Z",
        ip_address: "1.2.3.4",
        user_agent: "qa",
      },
    ],
    generatedAt: "2026-08-01T12:15:00.000Z",
  };
}

function unescapePdfLiteral(raw) {
  return String(raw || "")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\\(/g, "(")
    .replace(/\\\)/g, ")")
    .replace(/\\\\/g, "\\");
}

function extractPdfText(buffer) {
  const s = buffer.toString("latin1");
  const parts = [];
  const re = /\(((?:\\.|[^\\)])*)\) Tj/g;
  let m;
  while ((m = re.exec(s))) parts.push(unescapePdfLiteral(m[1]));
  return parts.join("\n");
}

function pageBodyLines(buffer) {
  const s = buffer.toString("latin1");
  const streams = [];
  const re = /stream\n([\s\S]*?)\nendstream/g;
  let m;
  while ((m = re.exec(s))) streams.push(m[1]);
  return streams.map((stream) => {
    const lines = [];
    const tre = /\(((?:\\.|[^\\)])*)\) Tj/g;
    let tm;
    while ((tm = tre.exec(stream))) lines.push(unescapePdfLiteral(tm[1]));
    return lines.slice(0, -1).filter((t) => String(t).trim());
  });
}

const PACKAGE_HASH =
  "a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00";

test("syntax", () => {
  check(libPath);
  check(pdfUtilPath);
});

test("PDF begins with %PDF-", () => {
  const { buffer } = lib.renderSignedContractPdf(sampleCtx());
  assert.strictEqual(buffer.slice(0, 5).toString(), "%PDF-");
});

test("known Unicode does not become ?", () => {
  assert.strictEqual(pdfUtil.normalizePdfUnicode("em—en–minus−"), "em-en-minus-");
  assert.strictEqual(pdfUtil.normalizePdfUnicode("• ·"), "* *");
  assert.strictEqual(pdfUtil.normalizePdfUnicode("‘it’s’"), "'it's'");
  assert.strictEqual(pdfUtil.normalizePdfUnicode("“quoted”"), '"quoted"');
  assert.strictEqual(pdfUtil.normalizePdfUnicode("a\u00A0b"), "a b");
  assert.strictEqual(pdfUtil.escapePdfText("Hello—world"), "Hello-world");
  assert.ok(!pdfUtil.escapePdfText("Hello—world • ‘x’").includes("?"));
  const ctx = sampleCtx({
    snap: sampleSnap({
      scope: { text: "Demo — cabinets • ‘custom’ and “quoted” work" },
      warranty: {
        duration_value: 1,
        duration_unit: "year",
        summary: "Workmanship — one year",
      },
    }),
  });
  const text = extractPdfText(lib.renderSignedContractPdf(ctx).buffer);
  assert.ok(text.includes("Demo - cabinets * 'custom' and \"quoted\" work"));
  assert.ok(text.includes("Workmanship - one year"));
  assert.ok(!text.includes("Demo ?"));
  assert.ok(!text.includes("? cabinets"));
});

test("backslash and parentheses remain escaped", () => {
  const escaped = pdfUtil.escapePdfText("Path C:\\Jobs (unit)");
  assert.strictEqual(escaped, "Path C:\\\\Jobs \\(unit\\)");
  const ctx = sampleCtx({
    snap: sampleSnap({ scope: { text: "See file C:\\Jobs (unit) notes." } }),
  });
  const raw = lib.renderSignedContractPdf(ctx).buffer.toString("latin1");
  assert.ok(raw.includes("C:\\\\Jobs \\(unit\\)"));
});

test("empty Terms renders Not specified", () => {
  const empty = sampleCtx({ snap: sampleSnap({ terms: { quote_terms: "" } }) });
  const missing = sampleCtx({ snap: sampleSnap({ terms: {} }) });
  for (const ctx of [empty, missing]) {
    const text = extractPdfText(lib.renderSignedContractPdf(ctx).buffer);
    assert.ok(text.includes("Terms"));
    assert.ok(text.includes("Not specified"));
    assert.ok(!text.includes("Terms\n?"));
  }
});

test("package hash is full 64 chars, no ellipsis truncate", () => {
  assert.strictEqual(PACKAGE_HASH.length, 64);
  assert.ok(!libSrc.includes("slice(0, 16)"));
  assert.ok(!libSrc.includes("…"));
  const text = extractPdfText(lib.renderSignedContractPdf(sampleCtx()).buffer);
  assert.ok(text.includes(PACKAGE_HASH));
  assert.ok(!text.includes("Package hash " + PACKAGE_HASH.slice(0, 16) + "..."));
});

test("payment separator is ASCII; due_rule custom is not printed", () => {
  const ctx = sampleCtx({
    snap: sampleSnap({
      quote: {
        id: "q1",
        title: "Kitchen Remodel Contract",
        total: 12000,
        currency: "USD",
        deposit_required: 1,
      },
      price: { contract_total: 12000, currency: "USD", deposit_required: 1 },
      payment_schedule: {
        items: [
          {
            sequence_number: 1,
            label: "Deposit",
            amount: 1,
            due_rule: "custom",
          },
        ],
      },
    }),
  });
  const text = extractPdfText(lib.renderSignedContractPdf(ctx).buffer);
  assert.ok(text.includes("Deposit"));
  assert.ok(text.includes("USD 1.00"));
  assert.ok(
    text.includes("Deposit Due Now") ||
      text.includes("Balance After Deposit") ||
      text.includes("Payment Stages")
  );
  assert.ok(!text.includes("due upon completion"));
  assert.ok(!text.includes("Remaining Payment Schedule"));
  assert.ok(!text.includes("?"));
  assert.ok(!text.includes("due: custom"));
});

test("legacy snapshot omits cadence copy; frozen field is printed exactly", () => {
  const dueText = extractPdfText(lib.renderSignedContractPdf(sampleCtx()).buffer).replace(
    /\n/g,
    " "
  );
  assert.ok(!dueText.includes("progress invoices are sent every two weeks"));
  assert.ok(!dueText.includes("billed every two weeks based on progress"));
  assert.ok(!dueText.includes("Deposit Still Due"));

  const stored = "Frozen cadence copy for this package only.";
  const storedCtx = sampleCtx({
    snap: sampleSnap({
      payment_schedule: {
        items: [
          { sequence_number: 1, label: "Deposit", amount: 2000, due_rule: "on_signing" },
          { sequence_number: 2, label: "Final", amount: 10000, due_rule: "on_completion" },
        ],
        invoice_cadence_copy: stored,
      },
    }),
  });
  const storedText = extractPdfText(lib.renderSignedContractPdf(storedCtx).buffer).replace(
    /\n/g,
    " "
  );
  assert.ok(storedText.includes(stored));
  assert.ok(!storedText.includes("progress invoices are sent every two weeks"));
  assert.ok(!storedText.includes("billed every two weeks based on progress"));

  const PaymentConfirm = require("../public/js/contract-payment-confirm.js");
  const copy = PaymentConfirm.INVOICE_CADENCE_COPY;
  const newFreeze = sampleCtx({
    snap: sampleSnap({
      payment_schedule: {
        items: [
          { sequence_number: 1, label: "Deposit", amount: 2000, due_rule: "on_signing" },
          { sequence_number: 2, label: "Final", amount: 10000, due_rule: "on_completion" },
        ],
        deposit_status_copy: "The $2,000.00 deposit is due now.",
        invoice_cadence_copy: copy,
      },
    }),
  });
  const newText = extractPdfText(lib.renderSignedContractPdf(newFreeze).buffer).replace(
    /\n/g,
    " "
  );
  assert.ok(newText.includes("The $2,000.00 deposit is due now."));
  assert.ok(newText.includes("billed every two weeks based on progress"));
  assert.ok(!newText.includes("due upon completion"));

  const paidFull = sampleCtx({
    snap: sampleSnap({
      payment_schedule: {
        items: [
          { sequence_number: 1, label: "Deposit", amount: 2000, due_rule: "on_signing" },
          { sequence_number: 2, label: "Final", amount: 10000, due_rule: "on_completion" },
        ],
        deposit: {
          status: "paid",
          verified_paid: true,
          amount: 2000,
          paid_at: "2026-09-01T12:00:00.000Z",
          source: "tenant_project_payments",
        },
      },
    }),
  });
  const paidText = extractPdfText(lib.renderSignedContractPdf(paidFull).buffer).replace(/\n/g, " ");
  assert.ok(!paidText.includes("progress invoices are sent every two weeks"));
  assert.ok(!paidText.includes("Deposit Still Due"));

  const partial = sampleCtx({
    snap: sampleSnap({
      payment_schedule: {
        items: [
          { sequence_number: 1, label: "Deposit", amount: 2000, due_rule: "on_signing" },
          { sequence_number: 2, label: "Final", amount: 10000, due_rule: "on_completion" },
        ],
        deposit: {
          status: "paid",
          verified_paid: true,
          amount: 500,
          paid_at: "2026-09-01T12:00:00.000Z",
          source: "tenant_project_payments",
        },
        invoice_cadence_copy: copy,
        deposit_status_copy: "A partial deposit has been received. $1,500.00 remains due toward the deposit.",
      },
    }),
  });
  const partialText = extractPdfText(lib.renderSignedContractPdf(partial).buffer).replace(
    /\n/g,
    " "
  );
  assert.ok(partialText.includes("Deposit Still Due"));
  assert.ok(partialText.includes("billed every two weeks based on progress"));
});

test("signature, certificate, envelope, package, hashes remain", () => {
  const ctx = sampleCtx();
  const text = extractPdfText(lib.renderSignedContractPdf(ctx).buffer);
  assert.ok(text.includes("Pat Customer"));
  assert.ok(text.includes("Signature (typed)"));
  assert.ok(text.includes("MG-CERT-ABCDEF0123456789"));
  assert.ok(text.includes("44444444-4444-4444-8444-444444444444"));
  assert.ok(text.includes("33333333-3333-4333-8333-333333333333"));
  assert.ok(text.includes(PACKAGE_HASH));
  assert.ok(text.includes("b".repeat(64)));
  assert.ok(text.includes("immutable contract package snapshot"));
});

test("no blind pageBreak before Signatures", () => {
  assert.ok(!/pageBreak\s*:\s*true/.test(libSrc));
  assert.ok(libSrc.includes("keepTogetherHeight"));
});

test("long fixture does not orphan 1-2 lines before Signatures", () => {
  const notices = {};
  for (let i = 0; i < 28; i += 1) {
    notices[`notice_${String(i).padStart(2, "0")}`] =
      `Legal notice ${i}. The contractor shall perform the work in a workmanlike manner. `.repeat(
        6
      );
  }
  const ctx = sampleCtx({
    snap: sampleSnap({
      terms: { quote_terms: "" },
      legal_notices: { notices },
    }),
  });
  const buffer = lib.renderSignedContractPdf(ctx).buffer;
  const pages = pageBodyLines(buffer);
  assert.ok(pages.length >= 2, `expected multiple pages, got ${pages.length}`);
  for (let i = 0; i < pages.length - 1; i += 1) {
    const nextHasSignatures = pages[i + 1].some((line) =>
      /^Signatures$/.test(line.trim())
    );
    if (nextHasSignatures && pages[i].length <= 2) {
      throw new Error(
        `page ${i + 1} has only ${pages[i].length} line(s) before Signatures page`
      );
    }
  }
});

test("Helvetica wrap is compact, not one-character-per-line", () => {
  const maxWidth = 612 - 54 * 2;
  const wrapped = pdfUtil.wrapTextToWidth(
    "The contractor shall furnish all labor and materials.",
    10,
    maxWidth
  );
  assert.strictEqual(wrapped.length, 1);
  const hashLines = pdfUtil.wrapTextToWidth(
    `Package hash ${PACKAGE_HASH}`,
    10,
    maxWidth
  );
  assert.ok(hashLines.join("").includes(PACKAGE_HASH));
  assert.ok(hashLines.length <= 2);
  assert.ok(hashLines.every((line) => line.length >= 8));
  const helloW = pdfUtil.measureTextWidth("Hello", 10);
  assert.ok(helloW > 20 && helloW < 40, `Hello width ${helloW}`);
});

test("fonts + spacing operators present in PDF", () => {
  assert.ok(pdfUtilSrc.includes("/Encoding /WinAnsiEncoding"));
  const raw = lib.renderSignedContractPdf(sampleCtx()).buffer.toString("latin1");
  assert.ok(raw.includes("/BaseFont /Helvetica"));
  assert.ok(raw.includes("/WinAnsiEncoding"));
  assert.ok(raw.includes("0 Tc"));
  assert.ok(raw.includes("0 Tw"));
  assert.ok(raw.includes("100 Tz"));
});

test("same fixture is deterministic", () => {
  const a = lib.renderSignedContractPdf(sampleCtx());
  const b = lib.renderSignedContractPdf(sampleCtx());
  assert.strictEqual(a.sha256, b.sha256);
  assert.strictEqual(a.buffer.compare(b.buffer), 0);
  assert.strictEqual(a.sha256.length, 64);
});

test("storage/auth invariants unchanged in this PR", () => {
  assert.ok(libSrc.includes('STORAGE_BUCKET = "contract-signed-pdfs"'));
  assert.ok(libSrc.includes("public: false"));
  assert.ok(libSrc.includes("idempotent: true"));
  assert.ok(libSrc.includes("sha256Hex"));
  assert.ok(!/object\/public\//.test(libSrc));
});

console.log("");
console.log(`CH-011I PDF render QA: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
