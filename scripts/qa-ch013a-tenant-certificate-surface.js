/**
 * Tenant Legal Certificate surface — no technical dumps in Contract Workflow.
 * Isolated static + existing CH-084 regression. No live contracts.
 * Run: node scripts/qa-ch013a-tenant-certificate-surface.js
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

const html = read("public/signature-workspace.html");
const js = read("public/js/signature-workspace.js");
const signHtml = read("public/contract-sign.html");
const signJs = read("public/js/contract-sign-portal.js");
const listSrc = read("netlify/functions/contract-certificates.js");
const createSrc = read("netlify/functions/contract-certificate-create.js");
const libSrc = read("netlify/functions/_lib/contract-certificate.js");
const ownerAdminSrc = read("netlify/functions/_lib/require-owner-or-admin.js");
const platformAdminSrc = read("netlify/functions/_lib/mg-support/require-platform-admin.js");
const platformFlagSrc = read("netlify/functions/_lib/mg-support/require-owner-session.js");

let passed = 0;
let failed = 0;
const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

function sliceBetween(src, startNeedle, endNeedle) {
  const start = src.indexOf(startNeedle);
  const end = src.indexOf(endNeedle, start + 1);
  assert.ok(start >= 0, "missing start " + startNeedle);
  assert.ok(end > start, "missing end " + endNeedle);
  return src.slice(start, end);
}

test("0 syntax workspace JS", () => {
  const r = spawnSync(process.execPath, ["--check", path.join(ROOT, "public/js/signature-workspace.js")], {
    encoding: "utf8",
  });
  assert.strictEqual(r.status, 0, r.stderr || r.stdout);
});

test("1 platform/system admin SoT is public.users.is_admin, not tenant Owner/Admin", () => {
  assert.ok(platformAdminSrc.includes("assertPlatformAdminSession"));
  assert.ok(platformAdminSrc.includes("loadPlatformAdminFlag"));
  assert.ok(platformAdminSrc.includes("Does not accept tenant owners via session.e + session.c"));
  assert.ok(platformFlagSrc.includes("users?id=eq."));
  assert.ok(platformFlagSrc.includes("select=id,is_admin"));
  assert.ok(platformFlagSrc.includes("row?.is_admin"));
  assert.ok(ownerAdminSrc.includes('OWNER_ADMIN_ROLES = new Set(["owner", "admin"])'));
  assert.ok(!ownerAdminSrc.includes("is_admin"));
  assert.ok(!js.includes("assertPlatformAdminSession"));
  assert.ok(!js.includes("loadPlatformAdminFlag"));
  assert.ok(!js.includes("is_admin"));
});

test("2 tenant certificate panel is professional fields only", () => {
  const certSec = sliceBetween(html, 'id="swSecCert"', 'id="swSecPdf"');
  assert.ok(certSec.includes("Certificate Number"));
  assert.ok(certSec.includes("Issued"));
  assert.ok(certSec.includes("swCertStatus"));
  assert.ok(certSec.includes("View Certificate"));
  assert.ok(!/Technical Verification/.test(certSec));
  assert.ok(!/Support Information/.test(certSec));
  assert.ok(!/certificate_json/.test(certSec));
  assert.ok(!/content_hash/.test(certSec));
  assert.ok(!/package_id/.test(certSec));
  assert.ok(!/signer_id/.test(certSec));
  assert.ok(!/envelope_id/.test(certSec));
  assert.ok(!/<pre/.test(certSec));
  assert.ok(!/<details/.test(certSec));
});

test("3 Legal Certificate modal does not render Support Information or JSON", () => {
  const viewCert = sliceBetween(
    js,
    '$("swViewCertBtn")?.addEventListener',
    '$("swGeneratePdfBtn")?.addEventListener'
  );
  assert.ok(viewCert.includes("Legal Certificate"));
  assert.ok(viewCert.includes("The signing certificate is ready for your records."));
  assert.ok(viewCert.includes("Number"));
  assert.ok(viewCert.includes("Issued"));
  assert.ok(viewCert.includes("Status"));
  assert.ok(viewCert.includes('btn("Close"'));
  assert.ok(!/Support Information/.test(viewCert));
  assert.ok(!/Technical Verification/.test(viewCert));
  assert.ok(!/certificate_json/.test(viewCert));
  assert.ok(!/content_hash/.test(viewCert));
  assert.ok(!/<details/.test(viewCert));
  assert.ok(!/<pre/.test(viewCert));
  assert.ok(!/JSON\.stringify/.test(viewCert));
});

test("4 tenant Owner and tenant Admin share the same non-technical certificate view", () => {
  assert.ok(js.includes("toTenantCertificate"));
  assert.ok(!/membershipRole|role === ["']admin["']|role === ["']owner["']/.test(js));
  assert.ok(listSrc.includes("requireOwnerOrAdmin"));
  assert.ok(createSrc.includes("requireOwnerOrAdmin"));
  assert.ok(!listSrc.includes("assertPlatformAdminSession"));
  assert.ok(!createSrc.includes("assertPlatformAdminSession"));
});

test("5 customer signing surface never receives certificate technical dumps", () => {
  assert.ok(!signHtml.includes("certificate_json"));
  assert.ok(!signHtml.includes("Support Information"));
  assert.ok(!signHtml.includes("Technical Verification"));
  assert.ok(!signJs.includes("certificate_json"));
  assert.ok(!signJs.includes("Support Information"));
  assert.ok(!signJs.includes("contract-certificates"));
});

test("6 technical certificate details are not left in the tenant DOM", () => {
  assert.ok(!html.includes("swCertHash"));
  assert.ok(!html.includes("swDevIds"));
  assert.ok(!html.includes('id="swSecDev"'));
  assert.ok(!html.includes("Internal IDs"));
  assert.ok(!js.includes("setText(\"swCertHash\""));
  assert.ok(!js.includes("setText(\"swDevIds\""));
  assert.ok(!js.includes("JSON.stringify(cert.certificate_json"));
  assert.ok(!js.includes("certificate_json"));
  assert.ok(!/console\.(log|debug|info)\(/.test(js));
});

test("7 certificate remains viewable/downloadable from Contract Workflow", () => {
  assert.ok(html.includes('id="swVisViewCertBtn"'));
  assert.ok(html.includes('id="swVisDownloadCertBtn"'));
  assert.ok(html.includes('id="swVisCompleteCertBtn"'));
  assert.ok(html.includes("Download Certificate"));
  assert.ok(js.includes('proxyClick("swVisViewCertBtn", "swViewCertBtn")'));
  assert.ok(js.includes('proxyClick("swVisDownloadCertBtn", "swViewCertBtn")'));
  assert.ok(js.includes('proxyClick("swVisCompleteCertBtn", "swViewCertBtn")'));
  assert.ok(js.includes("CERT_CREATE_API"));
  assert.ok(js.includes("CERTS_API"));
  assert.ok(js.includes("loadCertificates"));
});

test("8 technical certificate payload remains stored for audit", () => {
  assert.ok(libSrc.includes("serializeCertificate"));
  assert.ok(libSrc.includes("certificate_json:"));
  assert.ok(libSrc.includes("content_hash:"));
  assert.ok(libSrc.includes("wrapCertificateJson"));
  assert.ok(libSrc.includes("hashCertificateEvidence"));
  assert.ok(libSrc.includes("certificate_json: certificateJson"));
  assert.ok(createSrc.includes("createContractCertificate"));
  assert.ok(listSrc.includes("listCertificatesForEnvelope"));
  assert.ok(listSrc.includes("requireOwnerOrAdmin"));
  assert.ok(!listSrc.includes("assertPlatformAdminSession"));
  assert.ok(createSrc.includes("serializeTenantCertificate"));
  assert.ok(listSrc.includes("serializeTenantCertificate"));
});

test("9 list endpoint access is not expanded", () => {
  assert.ok(listSrc.includes('httpMethod !== "GET"'));
  assert.ok(listSrc.includes("requireOwnerOrAdmin"));
  assert.ok(listSrc.includes("owner_required") || ownerAdminSrc.includes("owner_required"));
  assert.ok(!listSrc.includes("is_admin"));
  assert.ok(!createSrc.includes("signer_id"));
  assert.ok(!listSrc.includes("certificate_json"));
  assert.ok(!createSrc.includes("certificate_json"));
});

const TENANT_CERT_KEYS = ["id", "certificate_number", "status", "issued_at"];
const CERT_LEAKS = [
  "certificate_json",
  "content_hash",
  "tenant_id",
  "envelope_id",
  "package_id",
  "project_id",
  "created_by",
  "created_at",
  "updated_at",
  "signer_id",
  "ip_address",
  "user_agent",
];
const FULL_CERT = {
  id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  tenant_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  envelope_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  package_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  project_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  certificate_number: "MG-CERT-PUBLICONLY",
  status: "issued",
  certificate_json: {
    schema: "ch-011h-v1",
    signers: [{ signer_id: "s1", ip_address: "1.2.3.4", user_agent: "UA" }],
  },
  content_hash: "ab".repeat(32),
  issued_at: "2026-01-01T00:00:00.000Z",
  created_by: "mmmmmmmm-mmmm-4mmm-8mmm-mmmmmmmmmmmm",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:01.000Z",
};

function assertNoLeaks(raw, label) {
  const text = typeof raw === "string" ? raw : JSON.stringify(raw);
  for (const leak of CERT_LEAKS) {
    assert.ok(!text.includes(leak), label + " leaked " + leak);
  }
}

function loadTenantCertHandlers() {
  const libRel = "../netlify/functions/_lib/contract-certificate";
  const gateRel = "../netlify/functions/_lib/require-owner-or-admin";
  const listRel = "../netlify/functions/contract-certificates";
  const createRel = "../netlify/functions/contract-certificate-create";
  [libRel, gateRel, listRel, createRel].forEach((rel) => {
    delete require.cache[require.resolve(rel)];
  });
  const lib = require(libRel);
  const gate = require(gateRel);
  gate.requireOwnerOrAdmin = async () => ({
    tenant: { id: FULL_CERT.tenant_id },
    membership: { id: FULL_CERT.created_by, role: "owner" },
  });
  lib.listCertificatesForEnvelope = async () => [lib.serializeCertificate(FULL_CERT)];
  lib.createContractCertificate = async () => ({
    ok: true,
    idempotent: true,
    certificate: lib.serializeCertificate(FULL_CERT),
  });
  return {
    lib,
    list: require(listRel),
    create: require(createRel),
  };
}

test("11 serializeTenantCertificate returns only public fields", () => {
  const lib = require("../netlify/functions/_lib/contract-certificate");
  const dto = lib.serializeTenantCertificate(FULL_CERT);
  assert.deepStrictEqual(Object.keys(dto), TENANT_CERT_KEYS);
  assert.deepStrictEqual(dto, {
    id: FULL_CERT.id,
    certificate_number: FULL_CERT.certificate_number,
    status: "issued",
    issued_at: FULL_CERT.issued_at,
  });
  assertNoLeaks(dto, "tenant DTO");
  const stored = lib.serializeCertificate(FULL_CERT);
  assert.strictEqual(stored.certificate_json.schema, "ch-011h-v1");
  assert.strictEqual(stored.content_hash, FULL_CERT.content_hash);
  assert.strictEqual(stored.envelope_id, FULL_CERT.envelope_id);
});

test("12 GET tenant certificates returns exactly the public DTO", async () => {
  const mods = loadTenantCertHandlers();
  const res = await mods.list.handler({
    httpMethod: "GET",
    queryStringParameters: { envelope_id: FULL_CERT.envelope_id },
    headers: {},
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.strictEqual(body.ok, true);
  assert.ok(Array.isArray(body.certificates));
  assert.strictEqual(body.certificates.length, 1);
  assert.deepStrictEqual(Object.keys(body.certificates[0]), TENANT_CERT_KEYS);
  assert.deepStrictEqual(body.certificates[0], {
    id: FULL_CERT.id,
    certificate_number: FULL_CERT.certificate_number,
    status: "issued",
    issued_at: FULL_CERT.issued_at,
  });
  assertNoLeaks(body.certificates[0], "GET certificate");
});

test("13 POST tenant certificate-create returns exactly the public DTO", async () => {
  const mods = loadTenantCertHandlers();
  const res = await mods.create.handler({
    httpMethod: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ envelope_id: FULL_CERT.envelope_id }),
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.idempotent, true);
  assert.deepStrictEqual(Object.keys(body.certificate), TENANT_CERT_KEYS);
  assert.deepStrictEqual(body.certificate, {
    id: FULL_CERT.id,
    certificate_number: FULL_CERT.certificate_number,
    status: "issued",
    issued_at: FULL_CERT.issued_at,
  });
  assertNoLeaks(body.certificate, "POST certificate");
  assert.ok(!JSON.stringify(body).includes("certificate_json"));
  assert.ok(!JSON.stringify(body).includes("content_hash"));
});

test("10 contractor+customer and customer-only signing still pass", () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts/qa-ch084-contractor-customer-signing.js")], {
    cwd: ROOT,
    encoding: "utf8",
    env: process.env,
  });
  assert.strictEqual(r.status, 0, r.stderr || r.stdout);
  assert.ok(/customer-only is the missing-field default/.test(r.stdout));
  assert.ok(/CH-084 contractor\+customer QA: \d+ passed, 0 failed/.test(r.stdout));
});

(async () => {
  for (const t of tests) {
    try {
      await t.fn();
      console.log("PASS", t.name);
      passed += 1;
    } catch (err) {
      console.log("FAIL", t.name, "-", err && err.message ? err.message : err);
      failed += 1;
    }
  }
  console.log("");
  console.log("Tenant certificate surface QA:", passed, "passed,", failed, "failed");
  process.exit(failed === 0 ? 0 : 1);
})();
