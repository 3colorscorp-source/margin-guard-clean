#!/usr/bin/env node
/**
 * Optional 3D view / proposal PDFs on existing quotes.
 * Isolated source + helper assertions. No live Netlify, Zapier, or storage writes.
 * Run: node scripts/test-quote-proposal-pdfs.js
 */
"use strict";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET || "mg-quote-proposal-pdfs-test-secret";
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "mg-quote-proposal-pdfs-test-key";
process.env.SITE_URL = process.env.SITE_URL || "https://example.test";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const {
  MAX_FILES,
  MAX_BYTES,
  displayName,
  storageFileName,
  normalizeProposalPdfs,
  publicProposalDocuments,
  sessionProposalDocuments,
  decodePdfBase64,
  isMissingProposalPdfsColumn,
  mergeProposalPdfs,
  removeProposalPdf,
  pathsBelongToTenant,
} = require("../netlify/functions/_lib/quote-proposal-pdfs");
const { parseEstimatePdfObjectPath } = require("../netlify/functions/_lib/estimate-pdf-access");
const { EDITABLE_FIELD_NAMES } = require("../netlify/functions/_lib/quote-edit-guard");
const { QUOTE_PUBLIC_KEYS } = require("../netlify/functions/get-public-estimate")._test;

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FILE_ID = "11111111-1111-4111-8111-111111111111";
const FILE_ID_B = "22222222-2222-4222-8222-222222222222";

let passed = 0;
function ok(label, cond) {
  assert.ok(cond, label);
  passed += 1;
  console.log("PASS " + label);
}
function eq(label, a, b) {
  assert.strictEqual(a, b, label + " expected " + JSON.stringify(b) + " got " + JSON.stringify(a));
  passed += 1;
  console.log("PASS " + label);
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function checkSyntax(rel) {
  const r = spawnSync(process.execPath, ["--check", path.join(ROOT, rel)], {
    encoding: "utf8",
  });
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || rel);
}

const sql = read("SUPABASE_QUOTES_PROPOSAL_PDFS.sql");
const libSrc = read("netlify/functions/_lib/quote-proposal-pdfs.js");
const fnSrc = read("netlify/functions/quote-proposal-pdfs.js");
const publicEstSrc = read("netlify/functions/get-public-estimate.js");
const sendSrc = read("netlify/functions/send-quote-zapier.js");
const ownerHtml = read("public/owner.html");
const salesHtml = read("public/sales.html");
const publicHtml = read("public/estimate-public.html");
const builderSrc = read("public/js/estimate-builder.js");
const clientSrc = read("public/js/quote-proposal-pdfs.js");
const appSrc = read("public/js/app.js");
const publicSendSrc = read("public/js/estimate-public-send.js");
const guardSrc = read("netlify/functions/_lib/quote-edit-guard.js");

[
  "netlify/functions/_lib/quote-proposal-pdfs.js",
  "netlify/functions/quote-proposal-pdfs.js",
  "netlify/functions/get-public-estimate.js",
  "netlify/functions/send-quote-zapier.js",
  "public/js/quote-proposal-pdfs.js",
  "public/js/estimate-builder.js",
  "public/js/estimate-public-send.js",
].forEach((rel) => {
  checkSyntax(rel);
  ok("syntax " + rel, true);
});

ok("sql adds jsonb column on quotes, not a new table", /alter table public\.quotes/.test(sql) && /proposal_pdfs jsonb/.test(sql) && !/create table/i.test(sql));
ok("handler reuses estimate-pdfs upload", /uploadEstimatePdf/.test(fnSrc));
ok("handler uses owner or seller context", /resolveOwnerOrSellerContext/.test(fnSrc) && /assertSellerOwnQuote/.test(fnSrc));
ok("handler does not create a second send path", !/send-quote-zapier/.test(fnSrc) && !/ZAPIER/.test(fnSrc));
ok("lib keeps 3-part storage paths", /parseEstimatePdfObjectPath/.test(libSrc));

eq("max files is 6", MAX_FILES, 6);
ok("max bytes stays under Netlify 6MB body", MAX_BYTES <= 3.5 * 1024 * 1024);

const pdfBuf = Buffer.from("%PDF-1.4 fake proposal stream\n%%EOF", "utf8");
const decoded = decodePdfBase64(pdfBuf.toString("base64"));
ok("accepts %PDF magic", Boolean(decoded) && decoded[0] === 0x25);
ok("rejects non-pdf base64", decodePdfBase64(Buffer.from("hello").toString("base64")) == null);

eq("displayName keeps pdf suffix", displayName("Kitchen 3D View.PDF"), "Kitchen 3D View.PDF");
const stored = storageFileName(FILE_ID, "Kitchen 3D View.pdf");
ok("storage filename is path-safe", /^[A-Za-z0-9._-]+\.pdf$/.test(stored));

const objectPath = `${TENANT_A}/2026-11-12/${stored}`;
ok("example object path parses as 3 parts", Boolean(parseEstimatePdfObjectPath(objectPath)));

const normalized = normalizeProposalPdfs([
  {
    id: FILE_ID,
    name: "Dining-Room-lookalike.pdf",
    object_path: `${TENANT_A}/2026-11-12/view-one.pdf`,
    size: 1200,
  },
  {
    id: "not-a-uuid",
    object_path: `${TENANT_A}/2026-11-12/bad.pdf`,
  },
  {
    id: FILE_ID_B,
    object_path: `${TENANT_B}/2026-11-12/other-tenant.pdf`,
    name: "leak.pdf",
  },
]);
eq("normalize keeps uuid rows", normalized.length, 2);
ok("normalize does not invent a table", normalized.every((row) => row.object_path.split("/").length === 3));

ok(
  "pathsBelongToTenant rejects another tenant",
  pathsBelongToTenant(
    [{ id: FILE_ID, object_path: `${TENANT_B}/2026-11-12/x.pdf` }],
    TENANT_A
  ) === false
);

const merged = mergeProposalPdfs(
  [{ id: FILE_ID, name: "a.pdf", object_path: `${TENANT_A}/2026-11-12/a.pdf`, size: 1 }],
  [{ id: FILE_ID_B, name: "b.pdf", object_path: `${TENANT_A}/2026-11-12/b.pdf`, size: 2 }],
  TENANT_A
);
eq("merge keeps both files for the same tenant", merged.length, 2);
eq(
  "cross-tenant merge is rejected",
  mergeProposalPdfs(
    [],
    [{ id: FILE_ID, name: "x.pdf", object_path: `${TENANT_B}/2026-11-12/x.pdf` }],
    TENANT_A
  ),
  null
);

const removed = removeProposalPdf(merged, FILE_ID);
eq("remove drops only that id", removed.length, 1);
eq("remove keeps the other file", removed[0].id, FILE_ID_B);

const docs = publicProposalDocuments(
  [{ id: FILE_ID, name: "View A.pdf", object_path: `${TENANT_A}/2026-11-12/view-a.pdf` }],
  "publictoken123",
  "https://example.test"
);
eq("public list has one document", docs.length, 1);
ok("public list has name and hmac url", docs[0].name === "View A.pdf" && /get-estimate-pdf/.test(docs[0].url) && /sig=/.test(docs[0].url));
ok("public list omits object_path", docs[0].object_path == null);

const sessionDocs = sessionProposalDocuments(
  [{ id: FILE_ID, name: "View A.pdf", object_path: `${TENANT_A}/2026-11-12/view-a.pdf`, size: 9 }],
  "https://example.test"
);
ok("session list keeps object_path for attach", sessionDocs[0].object_path === `${TENANT_A}/2026-11-12/view-a.pdf`);

ok("missing column helper matches PostgREST 42703", isMissingProposalPdfsColumn('column quotes.proposal_pdfs does not exist 42703'));
ok("missing column helper ignores other errors", !isMissingProposalPdfsColumn("jwt expired"));

ok("QUOTE_PUBLIC_KEYS omits raw proposal_pdfs", !QUOTE_PUBLIC_KEYS.includes("proposal_pdfs"));
ok("QUOTE_PUBLIC_KEYS omits object_path", !QUOTE_PUBLIC_KEYS.includes("object_path"));
ok("public estimate emits proposal_documents", /proposal_documents/.test(publicEstSrc));
ok("public estimate does not put object_path on QUOTE_PUBLIC_KEYS", !/QUOTE_PUBLIC_KEYS[\s\S]{0,400}object_path/.test(publicEstSrc));
ok("editable quote fields do not include proposal_pdfs", !EDITABLE_FIELD_NAMES.includes("proposal_pdfs"));
ok("quote-edit-guard still omits total/status", !EDITABLE_FIELD_NAMES.includes("total") && !EDITABLE_FIELD_NAMES.includes("status"));

ok("owner quote screen has proposal PDF host", /id="ownerProposalPdfsSection"/.test(ownerHtml));
ok("seller quote screen has proposal PDF host", /id="salesProposalPdfsSection"/.test(salesHtml));
ok("owner and seller load the shared widget", /quote-proposal-pdfs\.js/.test(ownerHtml) && /quote-proposal-pdfs\.js/.test(salesHtml));
ok("public estimate has proposal PDF section", /id="publicEstimateProposalPdfsSection"/.test(publicHtml));
ok("public builder renders proposal_documents", /function renderProposalDocuments/.test(builderSrc) && /proposal_documents/.test(builderSrc));
ok("widget title is 3D Views / Proposal PDFs", /3D Views \/ Proposal PDFs/.test(clientSrc));
ok("widget can bind an existing quote id", /function setActiveQuote/.test(clientSrc));
ok("feature is not Dining Room only", !/dining room/i.test(clientSrc + fnSrc + libSrc + ownerHtml + salesHtml));

ok("owner reset clears proposalPdfs", /proposalPdfs: \[\]/.test(appSrc));
ok("send attaches PDFs before Zapier", /attachToQuote/.test(appSrc) && /attachToQuote/.test(salesHtml) && /attachToQuote/.test(publicSendSrc));
ok("send still uses send-quote-zapier", /send-quote-zapier/.test(appSrc) && /send-quote-zapier/.test(salesHtml));
ok("send-quote-zapier stays on the existing public quote link", /public_quote_url/.test(sendSrc) && /estimate-public.html/.test(sendSrc));
ok("handler checks quote lock before writes", /evaluateQuoteEditGuard/.test(fnSrc) && /quote_locked/.test(fnSrc));
ok("guard source still has no proposal_pdfs writes", !/proposal_pdfs/.test(guardSrc));

console.log("\nQuote proposal PDFs: " + passed + " passed");
