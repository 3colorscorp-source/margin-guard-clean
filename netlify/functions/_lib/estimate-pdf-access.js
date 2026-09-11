/**
 * Estimate PDF storage access (compatible phase).
 * Bucket remains public so existing email links keep working.
 * New sends emit a Netlify Function URL; this helper mints a short-lived
 * signed URL after public-token or Owner/Seller authorization and tenant match.
 * Do not flip the production bucket in this phase.
 */
"use strict";

const { getSupabaseConfig } = require("./supabase-admin");

const fetch = globalThis.fetch;
if (!fetch) {
  throw new Error("Global fetch is not available. Set Netlify's Node version to 18+.");
}

const ESTIMATE_PDF_BUCKET = "estimate-pdfs";
const SIGNED_URL_EXPIRES_SEC = 60;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FILE_RE = /^[A-Za-z0-9._-]+\.pdf$/i;

function trimField(value) {
  return String(value || "").trim();
}

function parseEstimatePdfObjectPath(raw) {
  const s = trimField(raw);
  if (!s || s.length > 512) return null;
  let decoded = s;
  try {
    decoded = decodeURIComponent(s);
  } catch (_err) {
    return null;
  }
  if (decoded.indexOf("\0") >= 0 || decoded.indexOf("\\") >= 0) return null;
  if (decoded.indexOf("..") >= 0) return null;
  if (decoded.charAt(0) === "/" || decoded.charAt(0) === ".") return null;
  const parts = decoded.split("/");
  if (parts.length !== 3) return null;
  const tenantId = parts[0];
  const day = parts[1];
  const fileName = parts[2];
  if (!UUID_RE.test(tenantId)) return null;
  if (!DATE_RE.test(day)) return null;
  if (!FILE_RE.test(fileName)) return null;
  return { tenantId, day, fileName, objectPath: `${tenantId}/${day}/${fileName}` };
}

function buildEstimatePdfAccessUrl(siteUrl, publicToken, objectPath) {
  const base = trimField(siteUrl).replace(/\/+$/, "");
  const parsed = parseEstimatePdfObjectPath(objectPath);
  if (!base || !parsed) return "";
  const q = new URLSearchParams({ path: parsed.objectPath });
  const token = trimField(publicToken);
  if (token) q.set("token", token);
  return `${base}/.netlify/functions/get-estimate-pdf?${q.toString()}`;
}

async function ensureEstimatePdfBucket() {
  const { url, key } = getSupabaseConfig();
  const response = await fetch(`${url}/storage/v1/bucket`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: key,
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      id: ESTIMATE_PDF_BUCKET,
      name: ESTIMATE_PDF_BUCKET,
      public: true,
      allowed_mime_types: ["application/pdf"],
    }),
  });

  if (response.ok || response.status === 409) return;

  const text = await response.text();
  const alreadyExists =
    response.status === 409 ||
    text.includes('"statusCode":"409"') ||
    text.includes('"statusCode":409') ||
    text.includes("Duplicate") ||
    text.includes("The resource already exists");
  if (alreadyExists) return;
  throw new Error(`Unable to ensure PDF bucket: ${text}`);
}

async function uploadEstimatePdf({ base64, fileName, estimateNumber, tenantId }) {
  if (!base64 || !fileName || !tenantId) return null;
  const parsedTenant = trimField(tenantId);
  if (!UUID_RE.test(parsedTenant)) return null;
  await ensureEstimatePdfBucket();

  const safeName =
    String(fileName || `Estimate-${estimateNumber || Date.now()}.pdf`)
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || `Estimate-${Date.now()}.pdf`;
  const withExt = /\.pdf$/i.test(safeName) ? safeName : `${safeName}.pdf`;
  const objectPath = `${parsedTenant}/${new Date().toISOString().slice(0, 10)}/${Date.now()}-${withExt}`;
  const encodedPath = objectPath
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  const bytes = Buffer.from(base64, "base64");
  const { url, key } = getSupabaseConfig();

  const uploadResponse = await fetch(`${url}/storage/v1/object/${ESTIMATE_PDF_BUCKET}/${encodedPath}`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/pdf",
      "x-upsert": "true",
    },
    body: bytes,
  });

  if (!uploadResponse.ok) {
    const text = await uploadResponse.text();
    throw new Error(`Unable to upload estimate PDF: ${text}`);
  }

  return { objectPath, bucket: ESTIMATE_PDF_BUCKET };
}

async function createEstimatePdfSignedUrl(objectPath, expiresIn = SIGNED_URL_EXPIRES_SEC) {
  const parsed = parseEstimatePdfObjectPath(objectPath);
  if (!parsed) {
    throw new Error("Invalid estimate PDF path");
  }
  const { url, key } = getSupabaseConfig();
  const encodedPath = parsed.objectPath
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  const ttl = Number(expiresIn) || SIGNED_URL_EXPIRES_SEC;
  const response = await fetch(`${url}/storage/v1/object/sign/${ESTIMATE_PDF_BUCKET}/${encodedPath}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: key,
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ expiresIn: ttl }),
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_err) {
    data = null;
  }
  if (!response.ok) {
    throw new Error("Unable to create signed download URL");
  }
  const signedPath = data?.signedURL || data?.signedUrl || data?.url || "";
  if (!signedPath) {
    throw new Error("Signed URL missing from storage response");
  }
  const absolute = String(signedPath).startsWith("http")
    ? String(signedPath)
    : `${url}/storage/v1${String(signedPath).startsWith("/") ? "" : "/"}${signedPath}`;
  return { download_url: absolute, expires_in: ttl };
}

module.exports = {
  ESTIMATE_PDF_BUCKET,
  SIGNED_URL_EXPIRES_SEC,
  parseEstimatePdfObjectPath,
  buildEstimatePdfAccessUrl,
  ensureEstimatePdfBucket,
  uploadEstimatePdf,
  createEstimatePdfSignedUrl,
};
