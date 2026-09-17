/**
 * Generate a representative signed-contract sample PDF and rasterize pages.
 * Local evidence only — does not upload or overwrite live artifacts.
 * Run: node scripts/qa-ch011i-render-sample-pdf.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const lib = require("../netlify/functions/_lib/contract-signed-pdf");

const ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(ROOT, ".qa-ch011i-pdf-render");

const PACKAGE_HASH =
  "a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00";

function sampleSnap() {
  const notices = {
    contract_notice:
      "This is a binding agreement between the contractor and the customer.",
    payment_notice: "Payments are due as scheduled. Late balances may pause work.",
    change_order_notice:
      "Changes to scope require a written change order before extra work proceeds.",
  };
  for (let i = 0; i < 8; i += 1) {
    notices[`site_condition_${i}`] =
      `Site condition ${i}: Hidden conditions, moisture, or substrate repairs ` +
      `discovered after start may require additional work and schedule adjustment.`;
  }
  return {
    schema: "ch-011a-v1",
    business_settings: {
      source: "business_settings",
      legal_profile: {
        legal_business_name: "Acme Builders LLC",
        dba_name: "Acme Home",
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
    customer: {
      name: "Pat Customer",
      email: "pat@example.com",
      phone: "555-2",
    },
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
    scope: {
      text:
        "Demo existing cabinets — prepare walls • install new boxes and doors. " +
        "Customer’s selections include “white shaker” doors and quartz tops.",
    },
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
          label: "Progress",
          amount: 5000,
          due_rule: "custom",
        },
        {
          sequence_number: 3,
          label: "Final",
          percentage: 42,
          due_rule: "on_completion",
        },
      ],
    },
    warranty: {
      duration_value: 1,
      duration_unit: "year",
      summary: "Workmanship warranty — one year from completion.",
      exclusions: "Acts of God; owner-supplied materials.",
    },
    terms: { quote_terms: "" },
    legal_notices: { notices },
  };
}

function sampleCtx() {
  const signerId = "11111111-1111-4111-8111-111111111111";
  const eventId = "22222222-2222-4222-8222-222222222222";
  return {
    snap: sampleSnap(),
    pkg: {
      id: "33333333-3333-4333-8333-333333333333",
      version: 2,
      status: "executed",
      content_hash: PACKAGE_HASH,
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

function rasterize(pdfPath, outDir) {
  const attempts = [];

  function run(cmd, args, label) {
    const r = spawnSync(cmd, args, {
      encoding: "utf8",
      windowsHide: true,
      cwd: outDir,
    });
    attempts.push({
      label,
      status: r.status,
      error: r.error ? r.error.message : "",
      stderr: (r.stderr || "").slice(0, 400),
    });
    return r.status === 0;
  }

  const pdftoppm = path.join(outDir, "page");
  if (run("pdftoppm", ["-png", pdfPath, pdftoppm], "pdftoppm")) return "pdftoppm";
  if (run("magick", ["-density", "140", pdfPath, path.join(outDir, "page.png")], "magick")) {
    return "magick";
  }
  if (
    run(
      "gswin64c",
      [
        "-dSAFER",
        "-dBATCH",
        "-dNOPAUSE",
        "-sDEVICE=png16m",
        "-r140",
        `-sOutputFile=${path.join(outDir, "page-%d.png")}`,
        pdfPath,
      ],
      "gswin64c"
    )
  ) {
    return "gswin64c";
  }
  if (
    run(
      "gs",
      [
        "-dSAFER",
        "-dBATCH",
        "-dNOPAUSE",
        "-sDEVICE=png16m",
        "-r140",
        `-sOutputFile=${path.join(outDir, "page-%d.png")}`,
        pdfPath,
      ],
      "gs"
    )
  ) {
    return "gs";
  }

  const py = `
import sys
pdf, out = sys.argv[1], sys.argv[2]
try:
    import pypdfium2 as pdfium
except ImportError:
    sys.exit(2)
doc = pdfium.PdfDocument(pdf)
for i, page in enumerate(doc):
    bitmap = page.render(scale=140/72)
    pil = bitmap.to_pil()
    pil.save(f"{out}/page-{i+1}.png")
    page.close()
doc.close()
`;
  const pyFile = path.join(outDir, "_rasterize.py");
  fs.writeFileSync(pyFile, py, "utf8");
  const pip = spawnSync("python", ["-m", "pip", "install", "pypdfium2", "-q"], {
    encoding: "utf8",
    windowsHide: true,
  });
  attempts.push({
    label: "pip pypdfium2",
    status: pip.status,
    error: pip.error ? pip.error.message : "",
    stderr: (pip.stderr || "").slice(0, 400),
  });
  const pyRun = spawnSync("python", [pyFile, pdfPath, outDir], {
    encoding: "utf8",
    windowsHide: true,
  });
  attempts.push({
    label: "pypdfium2",
    status: pyRun.status,
    error: pyRun.error ? pyRun.error.message : "",
    stderr: (pyRun.stderr || "").slice(0, 800),
    stdout: (pyRun.stdout || "").slice(0, 400),
  });
  if (pyRun.status === 0) return "pypdfium2";

  return { failed: true, attempts };
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const { buffer, sha256 } = lib.renderSignedContractPdf(sampleCtx());
  const pdfPath = path.join(OUT_DIR, "signed-contract-sample.pdf");
  fs.writeFileSync(pdfPath, buffer);
  const report = {
    pdf: pdfPath,
    bytes: buffer.length,
    sha256,
    magic: buffer.slice(0, 5).toString(),
    rasterizer: null,
    pages: [],
  };
  const raster = rasterize(pdfPath, OUT_DIR);
  report.rasterizer = raster;
  const pngs = fs
    .readdirSync(OUT_DIR)
    .filter((f) => /\.png$/i.test(f))
    .sort();
  report.pages = pngs.map((f) => path.join(OUT_DIR, f));
  fs.writeFileSync(
    path.join(OUT_DIR, "report.json"),
    JSON.stringify(report, null, 2)
  );
  console.log(JSON.stringify(report, null, 2));
  if (raster && raster.failed) process.exit(2);
}

main();
