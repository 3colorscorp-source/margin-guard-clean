/**
 * GET invoice PDF via public invoice token.
 * Browser clicks get a view/download page. raw=1 or Zapier fetches return the PDF.
 * Token + HMAC authorizes only that invoice's canonical object path.
 */
"use strict";

const { supabaseRequest } = require("./_lib/supabase-admin");
const {
  parseInvoicePdfObjectPath,
  verifyInvoicePdfAccess,
  fetchInvoicePdfBytes,
} = require("./_lib/invoice-pdf-access");

function json(statusCode, payload) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "private, no-store",
    },
    body: JSON.stringify(payload),
  };
}

function html(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
    body: String(body || ""),
  };
}

function pdfResponse(bytes, fileName, asDownload) {
  const safe = String(fileName || "Invoice.pdf")
    .replace(/[^\w.\-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "Invoice.pdf";
  const withExt = /\.pdf$/i.test(safe) ? safe : safe + ".pdf";
  const disposition = asDownload
    ? `attachment; filename="${withExt}"`
    : `inline; filename="${withExt}"`;
  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": disposition,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
    isBase64Encoded: true,
    body: Buffer.from(bytes).toString("base64"),
  };
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function flagOn(raw) {
  return /^(1|true|yes|download)$/i.test(String(raw || "").trim());
}

function withMode(qs, mode) {
  const next = Object.assign({}, qs || {});
  delete next.raw;
  delete next.view;
  delete next.dl;
  delete next.download;
  if (mode === "raw") next.raw = "1";
  if (mode === "dl") next.dl = "1";
  const params = new URLSearchParams();
  Object.keys(next).forEach((key) => {
    const value = next[key];
    if (value == null || value === "") return;
    params.set(key, String(value));
  });
  return "/.netlify/functions/get-invoice-pdf?" + params.toString();
}

function viewerPage({ fileName, viewUrl, downloadUrl }) {
  const title = escapeHtml(fileName || "Invoice.pdf");
  const viewHref = escapeHtml(viewUrl);
  const dlHref = escapeHtml(downloadUrl);
  return (
    "<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"utf-8\"/>" +
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"/>" +
    "<title>" + title + "</title>" +
    "<style>" +
    "body{margin:0;background:#eef2f6;font-family:Arial,Helvetica,sans-serif;color:#111827;}" +
    ".bar{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;" +
    "padding:16px 20px;background:#fff;border-bottom:1px solid #e5e7eb;}" +
    ".name{font-weight:700;font-size:15px;}" +
    ".actions{display:flex;flex-wrap:wrap;gap:10px;}" +
    ".btn{display:inline-block;padding:12px 22px;border-radius:4px;text-decoration:none;" +
    "font-weight:700;font-size:14px;letter-spacing:.03em;}" +
    ".btn-primary{background:#0f8a5f;color:#fff;}" +
    ".btn-secondary{background:#fff;color:#111827;border:1px solid #d1d5db;}" +
    "embed,iframe{width:100%;height:calc(100vh - 72px);border:0;background:#525659;}" +
    "</style></head><body>" +
    "<div class=\"bar\"><div class=\"name\">" + title + "</div>" +
    "<div class=\"actions\">" +
    "<a class=\"btn btn-primary\" href=\"" + viewHref + "\">View PDF</a>" +
    "<a class=\"btn btn-secondary\" href=\"" + dlHref + "\">Download PDF</a>" +
    "</div></div>" +
    "<embed src=\"" + viewHref + "\" type=\"application/pdf\" />" +
    "</body></html>"
  );
}

function normalizePublicToken(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";
  if (trimmed.length < 8 || trimmed.length > 256) return "";
  if (!/^[a-zA-Z0-9_]+$/.test(trimmed)) return "";
  return trimmed;
}

async function tenantFromPublicToken(token) {
  const rows = await supabaseRequest(
    `invoices?public_token=eq.${encodeURIComponent(token)}&tenant_id=not.is.null&select=id,tenant_id&limit=2`
  );
  const list = Array.isArray(rows) ? rows : [];
  if (list.length !== 1 || !list[0]?.tenant_id) return null;
  return String(list[0].tenant_id);
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "GET") {
      return json(405, { error: "Method not allowed" });
    }

    const qs = event.queryStringParameters || {};
    const parsed = parseInvoicePdfObjectPath(qs.path || qs.object_path || "");
    if (!parsed) {
      return json(400, { error: "Invalid path" });
    }

    const publicToken = normalizePublicToken(qs.token || qs.public_token || qs.publicToken);
    if (!publicToken) {
      return json(401, { error: "Unauthorized" });
    }
    const sig = String(qs.sig || qs.signature || "").trim();
    if (!verifyInvoicePdfAccess(publicToken, parsed.objectPath, sig)) {
      return json(401, { error: "Unauthorized" });
    }
    const authorizedTenant = await tenantFromPublicToken(publicToken);
    if (!authorizedTenant) {
      return json(401, { error: "Unauthorized" });
    }
    if (String(authorizedTenant).toLowerCase() !== parsed.tenantId) {
      return json(403, { error: "Forbidden" });
    }

    const asDownload = flagOn(qs.dl) || flagOn(qs.download);
    const asRaw = asDownload || flagOn(qs.raw) || flagOn(qs.view);
    const accept = String(event.headers && (event.headers.accept || event.headers.Accept) || "");
    const htmlClick = !asRaw && /text\/html/i.test(accept);

    if (htmlClick) {
      return html(200, viewerPage({
        fileName: parsed.fileName,
        viewUrl: withMode(qs, "raw"),
        downloadUrl: withMode(qs, "dl"),
      }));
    }

    const file = await fetchInvoicePdfBytes(parsed.objectPath);
    return pdfResponse(file.bytes, file.fileName || parsed.fileName, asDownload);
  } catch (_err) {
    return json(500, { error: "Unable to load invoice PDF" });
  }
};
