/**
 * CH-013A.31 — visual/presentation static QA (no backend, no email).
 * Run: node scripts/qa-ch013a31-signature-workspace-visual.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "public/signature-workspace.html"), "utf8");
const js = fs.readFileSync(path.join(ROOT, "public/js/signature-workspace.js"), "utf8");

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

test("0 syntax signature-workspace.js", () => {
  const r = spawnSync(process.execPath, ["--check", path.join(ROOT, "public/js/signature-workspace.js")], {
    encoding: "utf8",
  });
  assert.strictEqual(r.status, 0, r.stderr || r.stdout);
});

test("1 workflow rail + six steps present", () => {
  assert.ok(html.includes("premium-workflow"));
  assert.ok(html.includes('id="swVisWorkflow"'));
  for (let i = 1; i <= 6; i += 1) {
    assert.ok(html.includes(`data-sw-step="${i}"`));
    assert.ok(html.includes(`data-sw-panel="${i}"`));
  }
  assert.ok(html.includes("Review & Sign"));
  assert.ok(html.includes("Confirm Customer"));
  assert.ok(html.includes("Wait for Customer"));
  assert.ok(html.includes("Legal Certificate"));
  assert.ok(html.includes("Signed Documents"));
  assert.ok(html.includes("Complete"));
  assert.ok(html.includes("Support Information"));
});

test("2 one active panel logic", () => {
  assert.ok(js.includes("panel.hidden = i !== step"));
  assert.ok(js.includes("function computeVisualStep"));
  assert.ok(js.includes("function renderVisualWorkflow"));
});

test("3 existing action IDs preserved", () => {
  [
    "swEmailLinkBtn",
    "swEmailRetryBtn",
    "swCopyLinkBtn",
    "swSendBtn",
    "swCreateEnvelopeBtn",
    "swAddSignerBtn",
    "swIssueCertBtn",
    "swViewCertBtn",
    "swGeneratePdfBtn",
    "swOpenPdfBtn",
    "swDownloadPdfBtn",
    "swViewFrozenBtn",
    "swSecSend",
    "swSecCert",
    "swSecPdf",
    "swSecProgress",
  ].forEach((id) => assert.ok(html.includes(`id="${id}"`), id));
});

test("4 presentation proxies existing handlers", () => {
  assert.ok(js.includes("openConfirmCustomerModal"));
  assert.ok(js.includes("Continue to Contractor Signature"));
  assert.ok(js.includes('proxyClick("swVisCopyLinkBtn", "swCopyLinkBtn")'));
  assert.ok(js.includes('proxyClick("swVis3CopyLinkBtn", "swCopyLinkBtn")'));
  assert.ok(js.includes('proxyClick("swVisRetryEmailBtn", "swEmailRetryBtn")'));
  assert.ok(js.includes('proxyClick("swVisIssueCertBtn", "swIssueCertBtn")'));
  assert.ok(js.includes('proxyClick("swVisViewCertBtn", "swViewCertBtn")'));
  assert.ok(js.includes('proxyClick("swVisGeneratePdfBtn", "swGeneratePdfBtn")'));
  assert.ok(js.includes('proxyClick("swVisOpenPdfBtn", "swOpenPdfBtn")'));
});

test("5 polling unchanged", () => {
  assert.ok(js.includes("function pollEmailDeliveryStatus"));
  assert.ok(js.includes("EMAIL_POLL_FAST_TICKS"));
  assert.ok(js.includes("EMAIL_QUEUE_API"));
});

test("6 Support Information does not render certificate technical dumps", () => {
  assert.ok(html.includes('id="swAdvancedDetails"'));
  assert.ok(html.includes('id="swSecCert"'));
  const certSec = html.slice(html.indexOf('id="swSecCert"'), html.indexOf('id="swSecPdf"'));
  assert.ok(certSec.includes("Certificate Number"));
  assert.ok(certSec.includes("Issued"));
  assert.ok(certSec.includes("swCertStatus"));
  assert.ok(!certSec.includes("Technical Verification"));
  assert.ok(!certSec.includes("Support Information"));
  assert.ok(!html.includes("swCertHash"));
  assert.ok(!html.includes("swDevIds"));
  assert.ok(!html.includes('id="swSecDev"'));
});

test("7 step mapping rules present", () => {
  assert.ok(js.includes("if (completed && cert?.id && art?.id) return 6"));
  assert.ok(js.includes("if (completed && cert?.id) return 5"));
  assert.ok(js.includes("if (completed) return 4"));
  assert.ok(js.includes("if (emailSent || emailInFlight) return 3"));
  assert.ok(js.includes("if (isLinkReady()) return 2"));
});

test("8 no backend files modified", () => {
  const diff = spawnSync("git", ["diff", "--name-only", "--", "netlify/", "docs/", "scripts/"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.strictEqual(diff.status, 0, diff.stderr);
  const files = diff.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((f) =>
      !f.includes("qa-ch013a31") &&
      !f.includes("qa-ch013a-tenant-certificate-surface") &&
      !f.includes("qa-ch013a-guided-contract-signing") &&
      !f.includes("qa-ch013a-autodocs-behavior")
    );
  assert.deepStrictEqual(files, [], "unexpected non-UI diffs: " + files.join(", "));
});

test("9 only UI files changed in working tree for this task", () => {
  const diff = spawnSync("git", ["diff", "--name-only"], { cwd: ROOT, encoding: "utf8" });
  assert.strictEqual(diff.status, 0, diff.stderr);
  const allowed = new Set([
    "public/signature-workspace.html",
    "public/js/signature-workspace.js",
    "public/styles.css", // CH-013A.34/35 Experience tokens (additive)
    "scripts/qa-ch013a31-signature-workspace-visual.js",
    "scripts/qa-ch013a-tenant-certificate-surface.js",
    "scripts/qa-ch013a-guided-contract-signing.js",
    "scripts/qa-ch013a-autodocs-behavior.js",
  ]);
  diff.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach((file) => assert.ok(allowed.has(file), "unexpected modified file: " + file));
});

test("10 Contract Workflow adopts MG shell/status tokens", () => {
  assert.ok(html.includes("var(--mg-shell-workflow)"));
  assert.ok(html.includes("var(--mg-status-current)"));
  assert.ok(html.includes("var(--mg-status-complete)"));
  assert.ok(html.includes("var(--mg-button-height-hero)") || html.includes("var(--mg-btn-height-hero)"));
  assert.ok(html.includes("var(--mg-radius-hero)"));
  assert.ok(html.includes("var(--mg-modal-width)"));
});

console.log("\nCH-013A.31 signature workspace visual:", passed, "passed,", failed, "failed");
process.exit(failed === 0 ? 0 : 1);
