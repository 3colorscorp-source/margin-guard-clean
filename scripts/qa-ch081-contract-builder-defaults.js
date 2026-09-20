/**
 * CH-081 — Contract Builder payment/signature defaults (no live data).
 * Run: node scripts/qa-ch081-contract-builder-defaults.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const helperPath = path.join(ROOT, "public/js/contract-payment-defaults.js");
const jsPath = path.join(ROOT, "public/js/contract-builder.js");
const htmlPath = path.join(ROOT, "public/contract-builder.html");
const pdfPath = path.join(ROOT, "netlify/functions/_lib/contract-signed-pdf.js");
const freezePath = path.join(ROOT, "netlify/functions/_lib/contract-package.js");
const setupPath = path.join(ROOT, "netlify/functions/project-contract-setup.js");
const payApiPath = path.join(ROOT, "netlify/functions/project-contract-payment-schedule.js");

const helper = require("../public/js/contract-payment-defaults.js");
const pdfLib = require("../netlify/functions/_lib/contract-signed-pdf");
const js = fs.readFileSync(jsPath, "utf8");
const html = fs.readFileSync(htmlPath, "utf8");
const pdfSrc = fs.readFileSync(pdfPath, "utf8");
const freezeSrc = fs.readFileSync(freezePath, "utf8");
const setupSrc = fs.readFileSync(setupPath, "utf8");
const payApiSrc = fs.readFileSync(payApiPath, "utf8");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log("PASS", name);
  } catch (err) {
    failed += 1;
    console.log("FAIL", name, "-", err.message);
  }
}

function check(file) {
  const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || "syntax failed");
}

function centsSum(items) {
  return items.reduce((sum, row) => sum + row.amount_cents, 0);
}

function extractPdfText(buffer) {
  const raw = buffer.toString("latin1");
  const streams = [];
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m;
  while ((m = re.exec(raw))) streams.push(m[1]);
  function unescapePdfLiteral(s) {
    return String(s || "")
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\([()\\])/g, "$1");
  }
  return streams
    .map((stream) => {
      const lines = [];
      const tre = /\(((?:\\.|[^\\)])*)\) Tj/g;
      let tm;
      while ((tm = tre.exec(stream))) lines.push(unescapePdfLiteral(tm[1]));
      return lines.filter((t) => String(t).trim());
    })
    .join("\n");
}

function samplePdfCtx(items) {
  return {
    snap: {
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
      quote: { id: "q1", title: "Kitchen", total: 110.06, currency: "USD" },
      price: { contract_total: 110.06, currency: "USD" },
      scope: { text: "Install cabinets." },
      payment_schedule: { items },
      warranty: {
        duration_value: 1,
        duration_unit: "year",
        summary: "Workmanship warranty",
        exclusions: "Acts of God",
      },
      terms: { quote_terms: "Net 15" },
      legal_notices: { notices: { contract_notice: "Agreement." } },
    },
    pkg: {
      id: "33333333-3333-4333-8333-333333333333",
      version: 1,
      status: "executed",
      content_hash: "a".repeat(64),
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
        id: "11111111-1111-4111-8111-111111111111",
        role: "customer",
        party_name: "Pat Customer",
        email: "pat@example.com",
        sign_order: 1,
        status: "signed",
        signed_at: "2026-08-01T12:00:00.000Z",
        is_required: true,
      },
    ],
    events: [
      {
        id: "22222222-2222-4222-8222-222222222222",
        signer_id: "11111111-1111-4111-8111-111111111111",
        signature_method: "typed",
        signature_json: {
          method: "typed",
          typed_name: "Pat Customer",
          rendered_name: "Pat Customer",
          signed_at: "2026-08-01T12:00:00.000Z",
        },
        signed_at: "2026-08-01T12:00:00.000Z",
        ip_address: "1.2.3.4",
        user_agent: "qa",
      },
    ],
    generatedAt: "2026-08-01T12:15:00.000Z",
  };
}

test("syntax helper, builder, pdf lib", () => {
  check(helperPath);
  check(jsPath);
  check(pdfPath);
});

test("1. $110.06 / $1.00 seeds $1.00 + $109.06 future_obligation", () => {
  const result = helper.buildDefaultPaymentSchedule({
    contractTotal: 110.06,
    depositRequired: 1.0,
    items: [],
    readinessStatus: "missing",
  });
  assert.strictEqual(result.seeded, true);
  assert.strictEqual(result.items.length, 2);
  assert.strictEqual(result.items[0].label, "Initial Scheduling Payment");
  assert.strictEqual(result.items[0].amount, 1);
  assert.strictEqual(result.items[0].amount_cents, 100);
  assert.strictEqual(result.items[0].due_rule, "on_signature");
  assert.strictEqual(result.items[0].item_role, "future_obligation");
  assert.strictEqual(result.items[1].label, "Progress & Final Billing");
  assert.strictEqual(result.items[1].amount, 109.06);
  assert.strictEqual(result.items[1].amount_cents, 10906);
  assert.strictEqual(result.items[1].due_rule, "custom");
  assert.strictEqual(result.items[1].item_role, "future_obligation");
  assert.strictEqual(centsSum(result.items), 11006);
  assert.ok(!result.items.some((row) => row.due_rule === "on_completion"));
  assert.ok(!result.items.some((row) => row.item_role === "applied_payment"));
});

test("2. deposit 0 seeds one Progress & Final Billing row", () => {
  const result = helper.buildDefaultPaymentSchedule({
    contractTotal: 110.06,
    depositRequired: 0,
    items: [],
  });
  assert.strictEqual(result.seeded, true);
  assert.strictEqual(result.items.length, 1);
  assert.strictEqual(result.items[0].label, "Progress & Final Billing");
  assert.strictEqual(result.items[0].amount_cents, 11006);
  assert.strictEqual(result.items[0].due_rule, "custom");
  assert.strictEqual(result.items[0].item_role, "future_obligation");
});

test("3. deposit equal to total seeds only Initial Scheduling Payment", () => {
  const result = helper.buildDefaultPaymentSchedule({
    contractTotal: 110.06,
    depositRequired: 110.06,
    items: [],
  });
  assert.strictEqual(result.seeded, true);
  assert.strictEqual(result.items.length, 1);
  assert.strictEqual(result.items[0].label, "Initial Scheduling Payment");
  assert.strictEqual(result.items[0].amount_cents, 11006);
  assert.strictEqual(result.items[0].due_rule, "on_signature");
});

test("4. deposit greater than total does not seed and warns", () => {
  const result = helper.buildDefaultPaymentSchedule({
    contractTotal: 110.06,
    depositRequired: 200,
    items: [],
  });
  assert.strictEqual(result.seeded, false);
  assert.strictEqual(result.items.length, 0);
  assert.strictEqual(result.code, "deposit_exceeds_total");
  assert.match(String(result.warning), /greater than the contract total/i);
});

test("5. integer-cent rounding", () => {
  assert.strictEqual(helper.toMoneyCents(110.06), 11006);
  assert.strictEqual(helper.toMoneyCents(1), 100);
  assert.strictEqual(helper.toMoneyCents(0), 0);
  assert.strictEqual(helper.centsToNumber(10906), 109.06);
  const result = helper.buildDefaultPaymentSchedule({
    contractTotal: 19.99,
    depositRequired: 0.1,
    items: [],
  });
  assert.strictEqual(result.items[0].amount_cents, 10);
  assert.strictEqual(result.items[1].amount_cents, 1989);
  assert.strictEqual(centsSum(result.items), 1999);
});

test("6. existing items are not overwritten", () => {
  const result = helper.buildDefaultPaymentSchedule({
    contractTotal: 110.06,
    depositRequired: 1,
    items: [{ label: "Owner stage", amount: 110.06 }],
  });
  assert.strictEqual(result.seeded, false);
  assert.strictEqual(result.overwriteProtected, true);
  assert.strictEqual(result.items.length, 0);
});

test("7. confirmed schedule is not overwritten", () => {
  const byStatus = helper.buildDefaultPaymentSchedule({
    contractTotal: 110.06,
    depositRequired: 1,
    items: [],
    scheduleStatus: "confirmed",
  });
  const byReadiness = helper.buildDefaultPaymentSchedule({
    contractTotal: 110.06,
    depositRequired: 1,
    items: [],
    readinessStatus: "configured",
  });
  const byFlag = helper.buildDefaultPaymentSchedule({
    contractTotal: 110.06,
    depositRequired: 1,
    items: [],
    confirmed: true,
  });
  assert.strictEqual(byStatus.seeded, false);
  assert.strictEqual(byReadiness.seeded, false);
  assert.strictEqual(byFlag.seeded, false);
});

test("8. load path does not POST payment or signature", () => {
  const initStart = js.indexOf("async function init()");
  assert.ok(initStart >= 0);
  const initBody = js.slice(initStart, js.indexOf("void init();"));
  assert.doesNotMatch(initBody, /postJson/);
  assert.match(js, /applyLocalPaymentDefaults/);
  assert.match(js, /function applyLocalPaymentDefaults/);
  assert.doesNotMatch(js, /applyLocalPaymentDefaults[\s\S]{0,400}postJson/);
});

test("9. signature not_configured shows Email link without silent persist", () => {
  assert.match(js, /DEFAULT_SIGNATURE_METHOD_UI\s*=\s*"email_link"/);
  assert.match(html, /value="email_link"[^>]*selected|selected[^>]*value="email_link"/);
  assert.match(js, /signatureMethodFromSetup\(setupBundle\.setup\) \|\| DEFAULT_SIGNATURE_METHOD_UI/);
  const initBody = js.slice(js.indexOf("async function init()"), js.indexOf("void init();"));
  assert.doesNotMatch(initBody, /postJson/);
  assert.match(js, /function saveSignatureWorkspace/);
  assert.match(js, /signature_method:\s*method/);
});

test("10. persisted signature method is preferred over UI default", () => {
  assert.match(
    js,
    /const method = fromSetup \|\| fromEdits \|\| DEFAULT_SIGNATURE_METHOD_UI/
  );
});

test("11. PDF uses human due labels and never due: custom", () => {
  assert.ok(!helper.DUE_RULES_ALLOWED.includes("on_acceptance"));
  assert.strictEqual(helper.INITIAL_SCHEDULING_DUE_RULE, "on_signature");
  assert.strictEqual(helper.dueRuleCustomerLabel("on_signature"), "Due upon acceptance");
  assert.strictEqual(helper.dueRuleCustomerLabel("on_completion"), "Due upon completion");
  assert.strictEqual(helper.dueRuleCustomerLabel("custom", { omitCustom: true }), "");
  assert.strictEqual(
    helper.dueRuleCustomerLabel("custom"),
    "As scheduled in this Agreement"
  );
  assert.doesNotMatch(helper.dueRuleCustomerLabel("custom"), /custom/i);
  assert.doesNotMatch(pdfSrc, /due: \$\{due\}/);
  assert.match(pdfSrc, /article7DueRuleLabel/);

  const seeded = helper.buildDefaultPaymentSchedule({
    contractTotal: 110.06,
    depositRequired: 1,
    items: [],
  });
  const text = extractPdfText(
    pdfLib.renderSignedContractPdf(samplePdfCtx(seeded.items)).buffer
  );
  assert.ok(!text.includes("Due upon completion"));
  assert.ok(text.includes("Deposit Due Now") || text.includes("Contract Total"));
  assert.ok(!text.includes("due: custom"));
  assert.ok(!text.includes("future_obligation"));
  assert.ok(!text.includes("applied_payment"));
  assert.ok(!text.includes("on_signature"));
  assert.ok(!text.includes("on_completion"));

  const legacy = extractPdfText(
    pdfLib.renderSignedContractPdf(
      samplePdfCtx([{ sequence_number: 1, label: "Deposit", amount: 1, due_rule: "custom" }])
    ).buffer
  );
  assert.ok(!legacy.includes("due: custom"));
  assert.ok(!/due: custom/i.test(legacy));
});

test("12. freeze still requires persisted signature and confirmed payment", () => {
  assert.match(freezeSrc, /setup\?\.signature_method && setup\.signature_method !== "not_configured"/);
  assert.match(freezeSrc, /missing\.push\("signature_method"\)/);
  assert.match(freezeSrc, /paymentReadiness\.status !== "configured"/);
  assert.match(freezeSrc, /missing\.push\("payment_schedule"\)/);
  assert.match(setupSrc, /signature_method:\s*signatureMethodStatus/);
  assert.match(payApiSrc, /schedule_total_mismatch/);
  assert.match(js, /signatureConfigured\(setupBundle\)/);
  assert.doesNotMatch(js, /readiness_incomplete[\s\S]{0,80}bypass/i);
});

test("on_acceptance is not invented; customize plan remains non-technical", () => {
  assert.ok(!helper.DUE_RULES_ALLOWED.includes("on_acceptance"));
  assert.doesNotMatch(html, /id="cbPayAdvancedToggle"/);
  assert.doesNotMatch(js, /paymentAdvancedEdit/);
  assert.match(js, /data-pay-action="delete"/);
  assert.match(js, /data-pay-field="due_rule"/);
  assert.doesNotMatch(js, /Future obligation — payment is still due/);
  assert.match(html, /contract-payment-defaults\.js/);
  assert.match(js, /Customize Payment Plan/);
});

test("frozen/executed packages do not seed", () => {
  const frozen = helper.buildDefaultPaymentSchedule({
    contractTotal: 110.06,
    depositRequired: 1,
    items: [],
    packageStatus: "executed",
  });
  const ready = helper.buildDefaultPaymentSchedule({
    contractTotal: 110.06,
    depositRequired: 1,
    items: [],
    packageStatus: "ready",
  });
  assert.strictEqual(frozen.seeded, false);
  assert.strictEqual(ready.seeded, false);
});

console.log("");
console.log(`CH-081 Contract Builder defaults: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
