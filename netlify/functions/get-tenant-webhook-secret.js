/**
 * Internal-only: returns a tenant's Zapier webhook signing secret for server-side use (e.g. Zapier Code).
 * Do NOT call from the browser. Protect with INTERNAL_API_KEY (x-internal-key header).
 */
const crypto = require("crypto");
const fetch = globalThis.fetch;
if (!fetch) {
  throw new Error("Global fetch is not available in this runtime.");
}

const { getSupabaseConfig } = require("./_lib/supabase-admin");

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}

function headerInternalKey(event) {
  const h = event.headers || {};
  return String(h["x-internal-key"] || h["X-Internal-Key"] || "").trim();
}

/** Constant-time compare to reduce timing leaks on the internal API key. */
function timingSafeEqualString(a, b) {
  try {
    const bufA = Buffer.from(String(a), "utf8");
    const bufB = Buffer.from(String(b), "utf8");
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  } catch (_e) {
    return false;
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return json(405, { error: "method_not_allowed" });
  }

  const expectedKey = String(process.env.INTERNAL_API_KEY || "").trim();
  if (!expectedKey) {
    console.error("[get-tenant-webhook-secret] INTERNAL_API_KEY is not configured");
    return json(500, { error: "server_error" });
  }

  const providedKey = headerInternalKey(event);
  if (!providedKey || !timingSafeEqualString(providedKey, expectedKey)) {
    return json(401, { error: "unauthorized" });
  }

  const raw = event.queryStringParameters && event.queryStringParameters.tenant_email;
  const tenantEmail = String(raw == null ? "" : raw)
    .trim()
    .toLowerCase();
  if (!tenantEmail) {
    return json(400, { error: "tenant_email_required" });
  }

  let supabaseUrl;
  let serviceRoleKey;
  try {
    ({ url: supabaseUrl, key: serviceRoleKey } = getSupabaseConfig());
  } catch (_e) {
    console.error("[get-tenant-webhook-secret] Supabase configuration missing");
    return json(500, { error: "server_error" });
  }

  let rows;
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/tenants?owner_email=eq.${encodeURIComponent(tenantEmail)}&select=zapier_webhook_secret&limit=1`,
      {
        method: "GET",
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          Accept: "application/json"
        }
      }
    );
    const text = await res.text();
    if (!res.ok) {
      console.error("[get-tenant-webhook-secret] Supabase request failed", res.status);
      return json(500, { error: "server_error" });
    }
    try {
      rows = text ? JSON.parse(text) : [];
    } catch (_parse) {
      return json(500, { error: "server_error" });
    }
  } catch (err) {
    console.error("[get-tenant-webhook-secret] request error", err?.message || err);
    return json(500, { error: "server_error" });
  }

  const list = Array.isArray(rows) ? rows : [];
  const row = list[0];
  const secret =
    row && typeof row === "object" && row.zapier_webhook_secret != null
      ? String(row.zapier_webhook_secret).trim()
      : "";

  if (!secret) {
    return json(404, { error: "secret_not_found" });
  }

  return json(200, { dynamic_secret: secret });
};
