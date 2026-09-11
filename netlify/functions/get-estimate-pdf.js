/**
 * GET estimate PDF via public quote token or Owner/Seller session.
 * Public token + HMAC authorizes only that quote's canonical object path.
 * Owner/Seller sessions are tenant-scoped after role checks.
 * Compatible phase: does not change the production bucket.
 */
"use strict";

const { supabaseRequest } = require("./_lib/supabase-admin");
const { resolveOwnerOrSellerContext } = require("./_lib/tenant-device-guard");
const {
  parseEstimatePdfObjectPath,
  verifyEstimatePdfAccess,
  createEstimatePdfSignedUrl,
  SIGNED_URL_EXPIRES_SEC,
} = require("./_lib/estimate-pdf-access");

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
  if (trimmed.length < 10 || trimmed.length > 256) return "";
  if (!/^[a-zA-Z0-9_]+$/.test(trimmed)) return "";
  return trimmed;
}

async function tenantFromPublicToken(token) {
  const rows = await supabaseRequest(
    `quotes?public_token=eq.${encodeURIComponent(token)}&tenant_id=not.is.null&select=id,tenant_id&limit=2`
  );
  const list = Array.isArray(rows) ? rows : [];
  if (list.length !== 1 || !list[0]?.tenant_id) return null;
  return String(list[0].tenant_id);
}

async function tenantFromSession(event) {
  try {
    const ctx = await resolveOwnerOrSellerContext(event);
    return ctx?.tenant?.id ? String(ctx.tenant.id) : null;
  } catch (err) {
    if (err && err.isGuardError) return null;
    throw err;
  }
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "GET") {
      return json(405, { error: "Method not allowed" });
    }

    const qs = event.queryStringParameters || {};
    const parsed = parseEstimatePdfObjectPath(qs.path || qs.object_path || "");
    if (!parsed) {
      return json(400, { error: "Invalid path" });
    }

    const publicToken = normalizePublicToken(qs.token || qs.public_token || qs.publicToken);
    let authorizedTenant = null;
    if (publicToken) {
      const sig = String(qs.sig || qs.signature || "").trim();
      if (!verifyEstimatePdfAccess(publicToken, parsed.objectPath, sig)) {
        return json(401, { error: "Unauthorized" });
      }
      authorizedTenant = await tenantFromPublicToken(publicToken);
      if (!authorizedTenant) {
        return json(401, { error: "Unauthorized" });
      }
    } else {
      authorizedTenant = await tenantFromSession(event);
      if (!authorizedTenant) {
        return json(401, { error: "Unauthorized" });
      }
    }

    if (String(authorizedTenant).toLowerCase() !== parsed.tenantId) {
      return json(403, { error: "Forbidden" });
    }

    const signed = await createEstimatePdfSignedUrl(parsed.objectPath, SIGNED_URL_EXPIRES_SEC);
    return redirect(signed.download_url);
  } catch (_err) {
    return json(500, { error: "Unable to load estimate PDF" });
  }
};
