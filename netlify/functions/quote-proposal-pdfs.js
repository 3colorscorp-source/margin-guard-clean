/**
 * Owner/Seller management of optional quote proposal PDFs.
 * Reuses estimate-pdfs storage, owner/seller session guards, and quote tenancy.
 * Does not change quote price, status, accept, or deposit.
 */
"use strict";

const crypto = require("crypto");
const { supabaseRequest } = require("./_lib/supabase-admin");
const {
  resolveOwnerOrSellerContext,
  assertSellerOwnQuote,
} = require("./_lib/tenant-device-guard");
const { evaluateQuoteEditGuard } = require("./_lib/quote-edit-guard");
const { uploadEstimatePdf } = require("./_lib/estimate-pdf-access");
const {
  MAX_FILES,
  MAX_BYTES,
  UUID_RE,
  displayName,
  storageFileName,
  normalizeProposalPdfs,
  sessionProposalDocuments,
  decodePdfBase64,
  isMissingProposalPdfsColumn,
  mergeProposalPdfs,
  removeProposalPdf,
  replaceProposalPdf,
  pathsBelongToTenant,
} = require("./_lib/quote-proposal-pdfs");

const QUOTE_SELECT =
  "id,tenant_id,status,seller_membership_id,created_by_role,proposal_pdfs";
const MIGRATION = "SUPABASE_QUOTES_PROPOSAL_PDFS.sql";

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

function siteUrlFromEnv() {
  return String(process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.SITE_URL || "")
    .trim()
    .replace(/\/+$/, "");
}

function parseBody(raw) {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (_err) {
    return null;
  }
}

function newFileId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function missingColumnResponse() {
  return json(503, {
    ok: false,
    error: "Quote proposal PDF column is missing. Run SUPABASE_QUOTES_PROPOSAL_PDFS.sql in Supabase SQL editor, then retry.",
    migration: MIGRATION,
    code: "proposal_pdfs_column_missing",
  });
}

async function loadQuote(tenantId, quoteId) {
  const tid = encodeURIComponent(String(tenantId));
  const qid = encodeURIComponent(String(quoteId));
  try {
    const rows = await supabaseRequest(
      `quotes?id=eq.${qid}&tenant_id=eq.${tid}&select=${QUOTE_SELECT}&limit=1`,
      { method: "GET" }
    );
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  } catch (err) {
    if (isMissingProposalPdfsColumn(err && err.message)) {
      const errCol = new Error(MIGRATION);
      errCol.code = "proposal_pdfs_column_missing";
      throw errCol;
    }
    throw err;
  }
}

async function writeProposalPdfs(tenantId, quoteId, list) {
  const tid = encodeURIComponent(String(tenantId));
  const qid = encodeURIComponent(String(quoteId));
  try {
    const rows = await supabaseRequest(
      `quotes?id=eq.${qid}&tenant_id=eq.${tid}`,
      { method: "PATCH", body: { proposal_pdfs: list } }
    );
    return Array.isArray(rows) && rows[0] ? rows[0] : { proposal_pdfs: list };
  } catch (err) {
    if (isMissingProposalPdfsColumn(err && err.message)) {
      const errCol = new Error(MIGRATION);
      errCol.code = "proposal_pdfs_column_missing";
      throw errCol;
    }
    throw err;
  }
}

function filesPayload(list, siteUrl) {
  return sessionProposalDocuments(list, siteUrl);
}

async function assertCanManageQuote(ctx, quoteId) {
  const guard = await evaluateQuoteEditGuard(ctx.tenant.id, quoteId);
  if (guard.invalidQuoteId) {
    return { error: json(400, { ok: false, error: "Invalid quote_id", code: "invalid_quote_id" }) };
  }
  if (guard.notFound || !guard.quote) {
    return { error: json(404, { ok: false, error: "Quote not found", code: "quote_not_found" }) };
  }
  const quote = await loadQuote(ctx.tenant.id, quoteId);
  if (!quote) {
    return { error: json(404, { ok: false, error: "Quote not found", code: "quote_not_found" }) };
  }
  assertSellerOwnQuote(ctx, quote);
  if (guard.edit && guard.edit.locked) {
    return {
      error: json(409, {
        ok: false,
        error: "This quote is locked. Proposal PDFs can no longer be changed.",
        code: "quote_locked",
        lock_reasons: guard.edit.lock_reasons || [],
      }),
    };
  }
  if (guard.edit && guard.edit.is_editable === false) {
    return {
      error: json(409, {
        ok: false,
        error: "This quote cannot be edited.",
        code: "quote_not_editable",
      }),
    };
  }
  return { quote, guard };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 204, headers: { "Cache-Control": "private, no-store" }, body: "" };
    }
    if (!["GET", "POST", "DELETE"].includes(event.httpMethod)) {
      return json(405, { ok: false, error: "Method not allowed" });
    }

    const ctx = await resolveOwnerOrSellerContext(event);
    const tenantId = String(ctx.tenant.id);
    const siteUrl = siteUrlFromEnv();

    if (event.httpMethod === "GET") {
      const qs = event.queryStringParameters || {};
      const quoteId = String(qs.quote_id || qs.quoteId || "").trim();
      if (!UUID_RE.test(quoteId)) {
        return json(400, { ok: false, error: "quote_id is required", code: "quote_id_required" });
      }
      const quote = await loadQuote(tenantId, quoteId);
      if (!quote) {
        return json(404, { ok: false, error: "Quote not found", code: "quote_not_found" });
      }
      assertSellerOwnQuote(ctx, quote);
      const files = normalizeProposalPdfs(quote.proposal_pdfs);
      return json(200, {
        ok: true,
        quote_id: quote.id,
        files: filesPayload(files, siteUrl),
        max_files: MAX_FILES,
        max_bytes: MAX_BYTES,
      });
    }

    const body = parseBody(event.body);
    if (!body) {
      return json(400, { ok: false, error: "Invalid JSON", code: "invalid_json" });
    }

    if (event.httpMethod === "DELETE") {
      const quoteId = String(body.quote_id || body.quoteId || "").trim();
      const fileId = String(body.id || body.file_id || "").trim();
      if (!UUID_RE.test(quoteId) || !UUID_RE.test(fileId)) {
        return json(400, { ok: false, error: "quote_id and id are required", code: "quote_file_required" });
      }
      const managed = await assertCanManageQuote(ctx, quoteId);
      if (managed.error) return managed.error;
      const next = removeProposalPdf(managed.quote.proposal_pdfs, fileId);
      const saved = await writeProposalPdfs(tenantId, quoteId, next);
      return json(200, {
        ok: true,
        quote_id: quoteId,
        files: filesPayload(saved.proposal_pdfs || next, siteUrl),
      });
    }

    const action = String(body.action || "upload").trim().toLowerCase();
    const quoteId = String(body.quote_id || body.quoteId || "").trim();

    if (action === "attach") {
      if (!UUID_RE.test(quoteId)) {
        return json(400, { ok: false, error: "quote_id is required", code: "quote_id_required" });
      }
      const managed = await assertCanManageQuote(ctx, quoteId);
      if (managed.error) return managed.error;
      const incoming = Array.isArray(body.files) ? body.files : [];
      const merged = mergeProposalPdfs(managed.quote.proposal_pdfs, incoming, tenantId);
      if (!merged) {
        return json(403, { ok: false, error: "Forbidden", code: "tenant_path_mismatch" });
      }
      if (merged.length > MAX_FILES) {
        return json(400, {
          ok: false,
          error: `A quote can include up to ${MAX_FILES} proposal PDFs.`,
          code: "too_many_files",
        });
      }
      const saved = await writeProposalPdfs(tenantId, quoteId, merged);
      return json(200, {
        ok: true,
        quote_id: quoteId,
        files: filesPayload(saved.proposal_pdfs || merged, siteUrl),
      });
    }

    const buf = decodePdfBase64(body.content_base64 || body.contentBase64 || body.pdfBase64);
    if (!buf) {
      return json(400, {
        ok: false,
        error: `Choose a PDF up to ${Math.floor(MAX_BYTES / (1024 * 1024) * 10) / 10} MB.`,
        code: "invalid_pdf",
      });
    }

    const name = displayName(body.filename || body.file_name || body.name || "proposal.pdf");
    const replaceId = String(body.replace_id || body.replaceId || "").trim();
    let existing = [];
    let managed = null;

    if (quoteId) {
      if (!UUID_RE.test(quoteId)) {
        return json(400, { ok: false, error: "Invalid quote_id", code: "invalid_quote_id" });
      }
      managed = await assertCanManageQuote(ctx, quoteId);
      if (managed.error) return managed.error;
      existing = normalizeProposalPdfs(managed.quote.proposal_pdfs);
      const countAfter = replaceId && UUID_RE.test(replaceId) ? existing.filter((row) => row.id.toLowerCase() !== replaceId.toLowerCase()).length + 1 : existing.length + 1;
      if (countAfter > MAX_FILES) {
        return json(400, {
          ok: false,
          error: `A quote can include up to ${MAX_FILES} proposal PDFs.`,
          code: "too_many_files",
        });
      }
    }

    const id = newFileId();
    const uploaded = await uploadEstimatePdf({
      base64: buf.toString("base64"),
      fileName: storageFileName(id, name),
      estimateNumber: quoteId || "proposal",
      tenantId,
    });
    if (!uploaded || !uploaded.objectPath) {
      return json(503, { ok: false, error: "Unable to store the PDF.", code: "upload_failed" });
    }
    if (!pathsBelongToTenant([{ id, object_path: uploaded.objectPath }], tenantId)) {
      return json(403, { ok: false, error: "Forbidden", code: "tenant_path_mismatch" });
    }

    const row = {
      id,
      name,
      object_path: uploaded.objectPath,
      size: buf.length,
      uploaded_at: new Date().toISOString(),
    };

    if (!quoteId) {
      return json(200, {
        ok: true,
        file: filesPayload([row], siteUrl)[0],
        files: filesPayload([row], siteUrl),
        max_files: MAX_FILES,
        max_bytes: MAX_BYTES,
      });
    }

    const next = replaceId && UUID_RE.test(replaceId)
      ? replaceProposalPdf(existing, replaceId, row)
      : normalizeProposalPdfs([...existing, row]);
    const saved = await writeProposalPdfs(tenantId, quoteId, next);
    return json(200, {
      ok: true,
      quote_id: quoteId,
      file: filesPayload([row], siteUrl)[0],
      files: filesPayload(saved.proposal_pdfs || next, siteUrl),
      max_files: MAX_FILES,
      max_bytes: MAX_BYTES,
    });
  } catch (err) {
    if (err && err.code === "proposal_pdfs_column_missing") {
      return missingColumnResponse();
    }
    if (err && err.isGuardError) {
      return json(err.statusCode || 403, { ok: false, error: err.message, code: err.code });
    }
    console.error("[quote-proposal-pdfs]", err);
    return json(500, { ok: false, error: err.message || "Server error" });
  }
};

exports._test = {
  MAX_FILES,
  MAX_BYTES,
};
