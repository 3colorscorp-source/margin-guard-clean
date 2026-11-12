/**
 * Optional 3D-view / proposal PDFs on an existing quote.
 * Metadata is quotes.proposal_pdfs jsonb. Bytes stay in estimate-pdfs
 * using the existing 3-part tenant/date/file.pdf path + HMAC download.
 */
"use strict";

const { getSupabaseConfig } = require("./supabase-admin");
const {
  ESTIMATE_PDF_BUCKET,
  parseEstimatePdfObjectPath,
  signEstimatePdfAccess,
  buildEstimatePdfAccessUrl,
  ensureEstimatePdfBucket,
} = require("./estimate-pdf-access");

const MAX_FILES = 6;
const MAX_BYTES = 12 * 1024 * 1024;
const NAME_MAX = 180;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function trimField(value) {
  return String(value || "").trim();
}

function isMissingProposalPdfsColumn(text) {
  const t = String(text || "").toLowerCase();
  if (!/42703|column|schema cache|could not find/i.test(t)) return false;
  return /proposal_pdfs/i.test(t);
}

function displayName(raw) {
  let s = trimField(raw).replace(/\\/g, "/");
  const slash = s.lastIndexOf("/");
  if (slash >= 0) s = s.slice(slash + 1);
  s = s.replace(/[\u0000-\u001f<>:"|?*]+/g, "_").replace(/\s+/g, " ").slice(0, NAME_MAX);
  if (!s) s = "proposal.pdf";
  if (!/\.pdf$/i.test(s)) s += ".pdf";
  return s;
}

function storageFileName(id, display) {
  const shortId = UUID_RE.test(String(id || "")) ? String(id).slice(0, 8) : "file";
  const safe =
    displayName(display)
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "proposal";
  const withoutExt = safe.replace(/\.pdf$/i, "") || "proposal";
  return `${shortId}-${withoutExt}.pdf`;
}

function normalizeProposalPdfs(raw) {
  const src = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();
  for (const row of src) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const id = trimField(row.id);
    if (!UUID_RE.test(id)) continue;
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    const parsed = parseEstimatePdfObjectPath(row.object_path || row.objectPath || "");
    if (!parsed) continue;
    const sizeN = Math.max(0, Math.floor(Number(row.size) || 0));
    const uploadedAt = trimField(row.uploaded_at || row.uploadedAt).slice(0, 40);
    seen.add(key);
    out.push({
      id,
      name: displayName(row.name || row.file_name || row.fileName || parsed.fileName),
      object_path: parsed.objectPath,
      size: sizeN,
      uploaded_at: uploadedAt || null,
    });
    if (out.length >= MAX_FILES) break;
  }
  return out;
}

function buildProposalPdfAccessUrl(siteUrl, publicToken, objectPath) {
  const parsed = parseEstimatePdfObjectPath(objectPath);
  if (!parsed) return "";
  const token = trimField(publicToken);
  if (token) {
    const absolute = buildEstimatePdfAccessUrl(siteUrl, token, parsed.objectPath);
    if (absolute) return absolute;
    const sig = signEstimatePdfAccess(token, parsed.objectPath);
    if (!sig) return "";
    const q = new URLSearchParams({
      path: parsed.objectPath,
      token,
      sig,
    });
    return `/.netlify/functions/get-estimate-pdf?${q.toString()}`;
  }
  const fromHelper = buildEstimatePdfAccessUrl(siteUrl, "", parsed.objectPath);
  if (fromHelper) return fromHelper;
  const q = new URLSearchParams({ path: parsed.objectPath });
  const base = trimField(siteUrl).replace(/\/+$/, "");
  const rel = `/.netlify/functions/get-estimate-pdf?${q.toString()}`;
  return base ? `${base}${rel}` : rel;
}

function publicProposalDocuments(raw, publicToken, siteUrl) {
  return normalizeProposalPdfs(raw)
    .map((row) => {
      const url = buildProposalPdfAccessUrl(siteUrl, publicToken, row.object_path);
      return url ? { name: row.name, url } : null;
    })
    .filter(Boolean);
}

function sessionProposalDocuments(raw, siteUrl) {
  return normalizeProposalPdfs(raw).map((row) => ({
    id: row.id,
    name: row.name,
    size: row.size,
    uploaded_at: row.uploaded_at,
    object_path: row.object_path,
    url: buildProposalPdfAccessUrl(siteUrl, "", row.object_path),
  }));
}

function isPdfBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 5) return false;
  return buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46;
}

function decodePdfBase64(raw) {
  let s = trimField(raw);
  const comma = s.indexOf(",");
  if (/^data:application\/pdf;base64,/i.test(s) && comma >= 0) {
    s = s.slice(comma + 1);
  }
  if (!s) return null;
  if (s.length > Math.ceil(MAX_BYTES * 1.4) + 80) return null;
  let buf;
  try {
    buf = Buffer.from(s, "base64");
  } catch (_err) {
    return null;
  }
  if (!isPdfBuffer(buf) || buf.length < 5 || buf.length > MAX_BYTES) return null;
  return buf;
}

function pathsBelongToTenant(list, tenantId) {
  const tid = trimField(tenantId).toLowerCase();
  if (!tid) return false;
  return normalizeProposalPdfs(list).every((row) => {
    const parsed = parseEstimatePdfObjectPath(row.object_path);
    return parsed && parsed.tenantId === tid;
  });
}

function mergeProposalPdfs(existing, incoming, tenantId) {
  const current = normalizeProposalPdfs(existing);
  const add = normalizeProposalPdfs(incoming);
  if (!pathsBelongToTenant(add, tenantId)) return null;
  const byId = new Map(current.map((row) => [row.id.toLowerCase(), row]));
  for (const row of add) {
    byId.set(row.id.toLowerCase(), row);
  }
  return normalizeProposalPdfs([...byId.values()]);
}

function removeProposalPdf(existing, fileId) {
  const id = trimField(fileId).toLowerCase();
  if (!UUID_RE.test(id)) return normalizeProposalPdfs(existing);
  return normalizeProposalPdfs(existing).filter((row) => row.id.toLowerCase() !== id);
}

function replaceProposalPdf(existing, fileId, nextRow) {
  const without = removeProposalPdf(existing, fileId);
  return normalizeProposalPdfs([...without, nextRow]);
}

function encodeObjectPath(objectPath) {
  return String(objectPath || "")
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

async function createProposalPdfSignedUpload({ fileName, tenantId, estimateNumber }) {
  const parsedTenant = trimField(tenantId).toLowerCase();
  if (!UUID_RE.test(parsedTenant)) return null;
  await ensureEstimatePdfBucket();
  const safeName =
    String(fileName || `proposal-${estimateNumber || Date.now()}.pdf`)
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || `proposal-${Date.now()}.pdf`;
  const withExt = /\.pdf$/i.test(safeName) ? safeName : `${safeName}.pdf`;
  const objectPath = `${parsedTenant}/${new Date().toISOString().slice(0, 10)}/${Date.now()}-${withExt}`;
  const encodedPath = encodeObjectPath(objectPath);
  const { url, key } = getSupabaseConfig();
  const response = await fetch(
    `${url}/storage/v1/object/upload/sign/${ESTIMATE_PDF_BUCKET}/${encodedPath}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ upsert: true }),
    }
  );
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_err) {
    data = null;
  }
  if (!response.ok || !data) {
    throw new Error(`Unable to create signed upload: ${text || response.status}`);
  }
  const token = trimField(data.token);
  let signedPath = trimField(data.url || data.signedUrl || data.signedURL);
  if (!signedPath && token) {
    signedPath =
      `/object/upload/sign/${ESTIMATE_PDF_BUCKET}/${encodedPath}?token=${encodeURIComponent(token)}`;
  }
  if (!signedPath) {
    throw new Error("Signed upload URL missing from storage response");
  }
  if (token && signedPath.indexOf("token=") < 0) {
    signedPath += (signedPath.indexOf("?") >= 0 ? "&" : "?") + "token=" + encodeURIComponent(token);
  }
  const uploadUrl = /^https?:\/\//i.test(signedPath)
    ? signedPath
    : `${url}/storage/v1${signedPath.charAt(0) === "/" ? "" : "/"}${signedPath}`;
  return { objectPath, bucket: ESTIMATE_PDF_BUCKET, uploadUrl };
}

async function peekProposalPdf(objectPath) {
  const parsed = parseEstimatePdfObjectPath(objectPath);
  if (!parsed) return null;
  const { url, key } = getSupabaseConfig();
  const encodedPath = encodeObjectPath(parsed.objectPath);
  const response = await fetch(`${url}/storage/v1/object/${ESTIMATE_PDF_BUCKET}/${encodedPath}`, {
    method: "GET",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Range: "bytes=0-7",
    },
  });
  if (!response.ok && response.status !== 206) return null;
  const buf = Buffer.from(await response.arrayBuffer());
  if (buf.length < 4 || buf[0] !== 0x25 || buf[1] !== 0x50 || buf[2] !== 0x44 || buf[3] !== 0x46) {
    return null;
  }
  let size = buf.length;
  const range = String(response.headers.get("content-range") || "").match(/\/(\d+)\s*$/);
  if (range) size = Number(range[1]);
  else {
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > 0) size = length;
  }
  return { objectPath: parsed.objectPath, size };
}

module.exports = {
  MAX_FILES,
  MAX_BYTES,
  UUID_RE,
  displayName,
  storageFileName,
  normalizeProposalPdfs,
  publicProposalDocuments,
  sessionProposalDocuments,
  buildProposalPdfAccessUrl,
  isPdfBuffer,
  decodePdfBase64,
  isMissingProposalPdfsColumn,
  pathsBelongToTenant,
  mergeProposalPdfs,
  removeProposalPdf,
  replaceProposalPdf,
  createProposalPdfSignedUpload,
  peekProposalPdf,
};
