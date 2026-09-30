/**
 * GET invoice PDF via public invoice token.
 * Token + HMAC authorizes only that invoice's canonical object path.
 * Signed URLs are minted server-side with service_role.
 */
"use strict";

const { supabaseRequest } = require("./_lib/supabase-admin");
const {
  parseInvoicePdfObjectPath,
  verifyInvoicePdfAccess,
  createInvoicePdfSignedUrl,
  SIGNED_URL_EXPIRES_SEC,
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

function redirect(url) {
  return {
    statusCode: 302,
    headers: {
      Location: url,
      "Cache-Control": "private, no-store",
    },
    body: "",
  };
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

    const signed = await createInvoicePdfSignedUrl(parsed.objectPath, SIGNED_URL_EXPIRES_SEC);
    return redirect(signed.download_url);
  } catch (_err) {
    return json(500, { error: "Unable to load invoice PDF" });
  }
};
