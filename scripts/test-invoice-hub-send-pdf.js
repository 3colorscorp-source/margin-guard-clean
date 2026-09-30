#!/usr/bin/env node
/**
 * Invoice Hub send — attach/store invoice PDF and include HMAC download URL.
 * Isolated: mocked Supabase/storage only. Dry-run only — no Zapier or DB writes.
 * Run: node scripts/test-invoice-hub-send-pdf.js
 */
"use strict";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET || "mg-invoice-hub-send-pdf-test-secret";
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "mg-invoice-hub-send-pdf-test-key";
process.env.ZAPIER_INVOICE_SEND_WEBHOOK_URL =
  process.env.ZAPIER_INVOICE_SEND_WEBHOOK_URL ||
  "https://hooks.zapier.com/hooks/catch/dry-run-must-not-call/";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const { buildSessionPayload, createSessionCookie } = require("../netlify/functions/_lib/session");
const {
  buildInvoicePdfAccessUrl,
  parseInvoicePdfObjectPath,
  signInvoicePdfAccess,
  verifyInvoicePdfAccess,
} = require("../netlify/functions/_lib/invoice-pdf-access");

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

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

function parse(res) {
  try {
    return JSON.parse(res.body || "{}");
  } catch (_err) {
    return {};
  }
}

function jsonRes(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return typeof body === "string" ? body : JSON.stringify(body);
    },
  };
}

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWNER_A = "owner-a@example.com";
const USER_A = "11111111-1111-4111-8111-111111111111";
const CUS_A = "cus_legacySendTest1";
const INV_A = "11111111-1111-4111-8111-111111111111";
const PUBLIC_TOKEN = "inv_testtoken12345";
const OBJECT_PATH = TENANT_A + "/2026-09-30/123-Invoice-INV-TEST-1.pdf";

const SAMPLE_PDF_B64 = Buffer.from("%PDF-1.4\n" + "x".repeat(120)).toString("base64");

function cookieFor(fields) {
  return createSessionCookie(
    buildSessionPayload({
      email: fields.e || "",
      tenantId: fields.t || "",
      userId: fields.u || "",
      customerId: fields.c || "",
    })
  );
}

function eventFor(fields, body) {
  return {
    httpMethod: "POST",
    headers: fields
      ? { cookie: cookieFor(fields), host: "marginguardsystem.netlify.app" }
      : { host: "marginguardsystem.netlify.app" },
    body: JSON.stringify(body || {}),
  };
}

function extractPath(url) {
  const s = String(url);
  const idx = s.indexOf("/rest/v1/");
  return idx >= 0 ? s.slice(idx + "/rest/v1/".length) : s;
}

function qp(restPath, key) {
  const q = restPath.split("?")[1] || "";
  const part = q.split("&").find((p) => p.startsWith(key + "="));
  if (!part) return "";
  return decodeURIComponent(part.slice(key.length + 1).replace(/^eq\./, ""));
}

function loadSendHandler() {
  [
    "../netlify/functions/_lib/supabase-admin",
    "../netlify/functions/_lib/membership-resolve",
    "../netlify/functions/_lib/owner-access",
    "../netlify/functions/_lib/tenant-for-session",
    "../netlify/functions/_lib/invoice-pdf-access",
    "../netlify/functions/send-invoice-zapier",
  ].forEach((rel) => {
    delete require.cache[require.resolve(rel)];
  });
  return require("../netlify/functions/send-invoice-zapier");
}

function loadGetPdfHandler() {
  [
    "../netlify/functions/_lib/supabase-admin",
    "../netlify/functions/_lib/invoice-pdf-access",
    "../netlify/functions/get-invoice-pdf",
  ].forEach((rel) => {
    delete require.cache[require.resolve(rel)];
  });
  return require("../netlify/functions/get-invoice-pdf");
}

const invoiceA = {
  id: INV_A,
  tenant_id: TENANT_A,
  public_token: PUBLIC_TOKEN,
  invoice_no: "INV-TEST-1",
  customer_name: "Test Client",
  customer_email: "client@example.com",
  project_name: "Test Project",
  amount: 100,
  paid_amount: 0,
  balance_due: 100,
  status: "draft",
  invoice_label: "Manual Invoice",
  notes: "Service details",
  currency: "USD",
};

async function withDb(fn, opts) {
  const prev = globalThis.fetch;
  const zapierCalls = [];
  const writes = [];
  const storagePosts = [];
  const restGets = [];
  const resendCalls = [];
  const failUpload = !!(opts && opts.failUpload);
  const allowInvoicePatch = !!(opts && opts.allowInvoicePatch);

  globalThis.fetch = async (url, fetchOpts) => {
    const method = String((fetchOpts && fetchOpts.method) || "GET").toUpperCase();
    const urlStr = String(url);
    if (/api\.resend\.com\/emails/i.test(urlStr)) {
      let parsed = {};
      try {
        parsed = JSON.parse((fetchOpts && fetchOpts.body) || "{}");
      } catch (_err) {
        parsed = {};
      }
      resendCalls.push({ method, parsed });
      return jsonRes(200, { id: "re_test" });
    }
    if (/hooks\.zapier\.com/i.test(urlStr)) {
      zapierCalls.push({ method, url: urlStr });
      return jsonRes(200, { ok: true });
    }
    if (/\/storage\/v1\/bucket/.test(urlStr)) {
      storagePosts.push({ kind: "bucket", method, url: urlStr });
      return jsonRes(200, { name: "invoice-pdfs" });
    }
    if (/\/storage\/v1\/object\/sign\/invoice-pdfs\//.test(urlStr) && method === "POST") {
      storagePosts.push({ kind: "sign", method, url: urlStr });
      return jsonRes(200, {
        signedURL: "https://example.supabase.co/storage/v1/object/sign/invoice-pdfs/signed-test.pdf",
      });
    }
    if (/signed-test\.pdf/.test(urlStr)) {
      const bytes = Buffer.from("%PDF-1.4 test-invoice-pdf");
      return {
        ok: true,
        status: 200,
        async arrayBuffer() {
          return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        },
        async text() {
          return bytes.toString("utf8");
        },
      };
    }
    if (/\/storage\/v1\/object\/invoice-pdfs\//.test(urlStr)) {
      storagePosts.push({ kind: "object", method, url: urlStr });
      if (failUpload) return jsonRes(500, { message: "upload failed" });
      return jsonRes(200, { Key: "invoice-pdfs/uploaded" });
    }
    if (/\/storage\/v1\//.test(urlStr)) {
      return jsonRes(404, { message: "unmocked storage " + urlStr });
    }
    const restPath = extractPath(urlStr);
    const table = restPath.split("?")[0];
    if (method !== "GET") {
      writes.push({ method, table, path: restPath.slice(0, 180) });
      if (allowInvoicePatch && method === "PATCH" && table === "invoices") {
        return jsonRes(200, [
          {
            ...invoiceA,
            status: "issued",
            sent_at: "2026-09-30T00:00:00.000Z",
          },
        ]);
      }
      return jsonRes(403, { message: "writes are not allowed in this test" });
    }
    restGets.push({ table, path: restPath.slice(0, 220) });
    if (table === "profiles") {
      const email = qp(restPath, "email");
      const tenantId = qp(restPath, "tenant_id");
      if (email === OWNER_A && (!tenantId || tenantId === TENANT_A)) {
        return jsonRes(200, [
          {
            id: "prof-a",
            tenant_id: TENANT_A,
            email: OWNER_A,
            role: "owner",
            status: "active",
            auth_user_id: USER_A,
          },
        ]);
      }
      return jsonRes(200, []);
    }
    if (table === "tenants") {
      const id = qp(restPath, "id");
      const cus = qp(restPath, "stripe_customer_id");
      if (cus === CUS_A || !id || id === TENANT_A) {
        return jsonRes(200, [
          {
            id: TENANT_A,
            slug: "tenant-a",
            name: "Tenant A",
            owner_email: OWNER_A,
            plan_status: "active",
            stripe_customer_id: CUS_A,
          },
        ]);
      }
      return jsonRes(200, []);
    }
    if (table === "invoices") {
      const tenantId = qp(restPath, "tenant_id");
      const id = qp(restPath, "id");
      const token = qp(restPath, "public_token");
      if (id === INV_A && tenantId === TENANT_A) return jsonRes(200, [invoiceA]);
      if (token === PUBLIC_TOKEN) return jsonRes(200, [{ id: INV_A, tenant_id: TENANT_A }]);
      return jsonRes(200, []);
    }
    if (table === "quotes") {
      return jsonRes(500, { message: "quotes must not be used for invoice PDF" });
    }
    return jsonRes(404, { message: "unmocked " + restPath });
  };

  try {
    return await fn({ zapierCalls, writes, storagePosts, restGets, resendCalls });
  } finally {
    globalThis.fetch = prev;
  }
}

async function main() {
  const sendSrc = read("netlify/functions/send-invoice-zapier.js");
  const getSrc = read("netlify/functions/get-invoice-pdf.js");
  const accessSrc = read("netlify/functions/_lib/invoice-pdf-access.js");
  const appSrc = read("public/js/app.js");
  const estimateAccess = read("netlify/functions/_lib/estimate-pdf-access.js");
  const getEstimate = read("netlify/functions/get-estimate-pdf.js");

  ok("send uploads invoice PDF", /uploadInvoicePdf/.test(sendSrc) && /buildInvoicePdfAccessUrl/.test(sendSrc));
  ok("send uses View Invoice button letter", /applyClientFacingZapierEmail/.test(sendSrc) && /buildInvoiceClientHtml/.test(sendSrc));
  ok("Email Body is plaintext not HTML", /payload\["Email Body"\] = text/.test(sendSrc) && !/payload\["Email Body"\] = html/.test(sendSrc));
  ok("send can deliver HTML plus PDF via Resend", /sendInvoiceViaResend/.test(sendSrc) && /attachments/.test(sendSrc));
  ok("send attaches pdf as file url like quotes", /attachInvoicePdfFile/.test(sendSrc) && /payload\.file = fileUrl/.test(sendSrc));
  ok("send does not ship pdf_base64 to Zapier", !/payload\.pdf_base64 = pdfBase64/.test(sendSrc));
  ok("send does not reuse estimate PDF access", !/estimate-pdf-access/.test(sendSrc) && !/get-estimate-pdf/.test(sendSrc));
  ok("invoice PDF bucket is invoice-pdfs", /INVOICE_PDF_BUCKET = "invoice-pdfs"/.test(accessSrc));
  ok("invoice PDF HMAC is invoice-pdf-v1", /invoice-pdf-v1/.test(accessSrc));
  ok("get-invoice-pdf looks up invoices public_token", /invoices\?public_token=/.test(getSrc));
  ok("get-invoice-pdf does not look up quotes", !/quotes\?public_token=/.test(getSrc));
  ok("get-invoice-pdf does not import estimate-pdf", !/estimate-pdf-access/.test(getSrc) && !/get-estimate-pdf/.test(getSrc));
  ok("estimate PDF helpers were not rewritten for invoices", /ESTIMATE_PDF_BUCKET = "estimate-pdfs"/.test(estimateAccess));
  ok("get-estimate-pdf still uses quotes", /quotes\?public_token=/.test(getEstimate));
  ok("hub still generates the invoice PDF at send", /buildHubInvoicePdfForSend/.test(appSrc));
  ok("hub Download PDF uses the same send builder", /async function hubDrawerDownloadPdf[\s\S]{0,1200}buildHubInvoicePdfForSend/.test(appSrc));
  ok("hub Download PDF saves a file", /function downloadGeneratedInvoicePdf[\s\S]{0,900}a\.download/.test(appSrc));

  const parsed = parseInvoicePdfObjectPath(OBJECT_PATH);
  ok("invoice pdf path parses", !!(parsed && parsed.objectPath === OBJECT_PATH && parsed.tenantId === TENANT_A));
  const sig = signInvoicePdfAccess(PUBLIC_TOKEN, OBJECT_PATH);
  ok("invoice pdf HMAC signs", /^[0-9a-f]{64}$/.test(sig));
  ok("invoice pdf HMAC verifies", verifyInvoicePdfAccess(PUBLIC_TOKEN, OBJECT_PATH, sig));
  ok("invoice pdf HMAC rejects other token", !verifyInvoicePdfAccess("inv_other_token_xx", OBJECT_PATH, sig));
  const accessUrl = buildInvoicePdfAccessUrl("https://marginguardsystem.netlify.app", PUBLIC_TOKEN, OBJECT_PATH);
  ok("access url uses get-invoice-pdf", /\/\.netlify\/functions\/get-invoice-pdf\?/.test(accessUrl));
  ok("access url carries invoice token", accessUrl.includes("token=" + PUBLIC_TOKEN));

  await withDb(async ({ zapierCalls, writes, storagePosts }) => {
    const handler = loadSendHandler();
    const res = await handler.handler(
      eventFor(
        { e: OWNER_A, t: TENANT_A, u: USER_A, c: "" },
        {
          id: INV_A,
          dry_run: true,
          pdfBase64: SAMPLE_PDF_B64,
          pdfFileName: "Invoice-INV-TEST-1.pdf",
        }
      )
    );
    eq("dry_run with pdf is 200", res.statusCode, 200);
    const body = parse(res);
    ok("dry_run ok", body.ok === true);
    const payload = body.payload || {};
    const emailBody = String(payload["Email Body"] || payload.email_body || "");
    const html = String(payload["Email Html"] || payload.email_html || "");
    const pdfUrl = String(payload.pdf_url || payload.pdfUrl || "");
    ok("payload has pdf_url", /get-invoice-pdf/.test(pdfUrl) && pdfUrl.includes("token=" + PUBLIC_TOKEN));
    ok("payload pdf_url is the raw file", /raw=1/.test(pdfUrl));
    ok("payload file is the pdf url not base64", String(payload.file || "") === pdfUrl);
    ok("payload does not include pdf_base64", !payload.pdf_base64);
    ok("Email Body is plaintext not HTML source", !emailBody.includes("<!DOCTYPE") && !emailBody.includes("<a href="));
    ok("Email Body has View invoice url", emailBody.includes("View invoice") && emailBody.includes("invoice-public.html"));
    ok("Email Body does not include invoice summary", !/Invoice summary/.test(emailBody) && !/Contract total/.test(emailBody));
    ok("Email Body does not include pdf function url", !/get-invoice-pdf/.test(emailBody));
    ok("Email Html has View Invoice button", html.includes("View Invoice") && /bgcolor="#0f8a5f"/.test(html));
    ok("Email Html does not add a second pdf button", !html.includes("View PDF"));
    ok("canonical amounts were not converted", body.canonical && body.canonical.contract_total === 100);
    ok("storage received invoice-pdfs upload", storagePosts.some((p) => p.kind === "object"));
    eq("dry-run did not call Zapier", zapierCalls.length, 0);
    eq("dry-run did not PATCH invoice", writes.length, 0);
  });

  await withDb(async ({ storagePosts }) => {
    const handler = loadSendHandler();
    const res = await handler.handler(
      eventFor(
        { e: OWNER_A, t: TENANT_A, u: USER_A, c: "" },
        {
          id: INV_A,
          dry_run: true,
          pdfBase64: SAMPLE_PDF_B64,
        }
      )
    );
    eq("upload failure still sends email", res.statusCode, 200);
    const body = parse(res);
    const emailBody = String((body.payload && body.payload["Email Body"]) || "");
    ok("upload failure omits pdf_url", !String(body.payload && body.payload.pdf_url || "").trim());
    ok("upload failure still has View invoice url", emailBody.includes("View invoice") && emailBody.includes("invoice-public.html"));
    ok("upload failure Email Body is not HTML source", !emailBody.includes("<!DOCTYPE") && !emailBody.includes("<a href="));
    ok("failed upload attempted invoice-pdfs", storagePosts.some((p) => p.kind === "object"));
  }, { failUpload: true });

  const prevKey = process.env.RESEND_API_KEY;
  const prevFrom = process.env.RESEND_FROM_EMAIL;
  process.env.RESEND_API_KEY = "re_test_key";
  process.env.RESEND_FROM_EMAIL = "billing@example.com";
  try {
    await withDb(async ({ zapierCalls, resendCalls, writes }) => {
      const handler = loadSendHandler();
      const res = await handler.handler(
        eventFor(
          { e: OWNER_A, t: TENANT_A, u: USER_A, c: "" },
          {
            id: INV_A,
            pdfBase64: SAMPLE_PDF_B64,
            pdfFileName: "Invoice-INV-TEST-1.pdf",
          }
        )
      );
      eq("resend send is 200", res.statusCode, 200);
      const body = parse(res);
      eq("resend delivery", body.delivery, "resend");
      eq("resend skips Zapier Gmail", zapierCalls.length, 0);
      eq("resend called once", resendCalls.length, 1);
      const mail = (resendCalls[0] && resendCalls[0].parsed) || {};
      ok(
        "resend html has View Invoice button",
        String(mail.html || "").includes("View Invoice") && /bgcolor="#0f8a5f"/.test(String(mail.html || ""))
      );
      ok("resend html has no invoice summary", !/Invoice summary/.test(String(mail.html || "")));
      ok(
        "resend attaches the generated pdf",
        Array.isArray(mail.attachments) &&
          mail.attachments[0] &&
          String(mail.attachments[0].filename || "").indexOf("Invoice") >= 0 &&
          String(mail.attachments[0].content || "").length > 80
      );
      ok("invoice marked sent after resend", writes.some((w) => w.method === "PATCH" && w.table === "invoices"));
    }, { allowInvoicePatch: true });
  } finally {
    if (prevKey == null) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = prevKey;
    if (prevFrom == null) delete process.env.RESEND_FROM_EMAIL;
    else process.env.RESEND_FROM_EMAIL = prevFrom;
  }

  await withDb(async ({ restGets }) => {
    const handler = loadGetPdfHandler();
    const url = new URL(buildInvoicePdfAccessUrl("https://marginguardsystem.netlify.app", PUBLIC_TOKEN, OBJECT_PATH));
    const qs = {};
    url.searchParams.forEach((value, key) => {
      qs[key] = value;
    });
    const res = await handler.handler({
      httpMethod: "GET",
      queryStringParameters: qs,
    });
    eq("valid invoice pdf streams the file", res.statusCode, 200);
    ok("streams application/pdf", String(res.headers && res.headers["Content-Type"] || "").includes("application/pdf"));
    ok("inline disposition for view", /inline/i.test(String(res.headers && res.headers["Content-Disposition"] || "")));
    ok("pdf body is base64", res.isBase64Encoded === true && String(res.body || "").length > 8);
    ok("get-invoice-pdf queried invoices not quotes", restGets.some((g) => g.table === "invoices"));
    ok("get-invoice-pdf never queried quotes", !restGets.some((g) => g.table === "quotes"));
  });

  await withDb(async () => {
    const handler = loadGetPdfHandler();
    const url = new URL(buildInvoicePdfAccessUrl("https://marginguardsystem.netlify.app", PUBLIC_TOKEN, OBJECT_PATH));
    const qs = {};
    url.searchParams.forEach((value, key) => {
      qs[key] = value;
    });
    const res = await handler.handler({
      httpMethod: "GET",
      headers: { accept: "text/html,application/xhtml+xml" },
      queryStringParameters: qs,
    });
    eq("browser click gets the viewer page", res.statusCode, 200);
    const page = String(res.body || "");
    ok("viewer is HTML", String(res.headers && res.headers["Content-Type"] || "").includes("text/html"));
    ok("viewer has View PDF button", page.includes("View PDF") && page.includes("btn-primary"));
    ok("viewer has Download PDF button", page.includes("Download PDF") && page.includes("dl=1"));
    ok("viewer embeds the PDF", /<embed /i.test(page) && /raw=1/.test(page));
  });

  await withDb(async () => {
    const handler = loadGetPdfHandler();
    const url = new URL(buildInvoicePdfAccessUrl("https://marginguardsystem.netlify.app", PUBLIC_TOKEN, OBJECT_PATH));
    const qs = {};
    url.searchParams.forEach((value, key) => {
      qs[key] = value;
    });
    qs.dl = "1";
    const res = await handler.handler({
      httpMethod: "GET",
      queryStringParameters: qs,
    });
    eq("download mode is 200", res.statusCode, 200);
    ok("download disposition is attachment", /attachment/i.test(String(res.headers && res.headers["Content-Disposition"] || "")));
  });

  await withDb(async () => {
    const handler = loadGetPdfHandler();
    const wrongPath = TENANT_B + "/2026-09-30/123-Invoice-INV-TEST-1.pdf";
    const url = new URL(buildInvoicePdfAccessUrl("https://marginguardsystem.netlify.app", PUBLIC_TOKEN, wrongPath));
    const qs = {};
    url.searchParams.forEach((value, key) => {
      qs[key] = value;
    });
    const res = await handler.handler({
      httpMethod: "GET",
      queryStringParameters: qs,
    });
    eq("other-tenant path is 403", res.statusCode, 403);
  });

  console.log("\n" + passed + " passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
