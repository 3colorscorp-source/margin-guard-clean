const { readSessionFromEvent } = require("./_lib/session");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");
const { supabaseRequest } = require("./_lib/supabase-admin");

const ALLOWED_BUCKETS = new Set([
  "operating",
  "reserve",
  "payroll",
  "tax",
  "profit",
]);

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  };
}

function sanitizeMapping(row, tenantId) {
  const bucket = String(row?.bucket || "").trim().toLowerCase();
  const accountId = String(row?.tenant_bank_account_id || "").trim();

  if (!bucket || !ALLOWED_BUCKETS.has(bucket)) return null;
  if (!accountId) return null;

  return {
    tenant_id: tenantId,
    bucket,
    tenant_bank_account_id: accountId,
  };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { error: "Method not allowed" });
    }

    const session = readSessionFromEvent(event);
    if (!session?.e) return json(401, { error: "Unauthorized" });

    const tenant = await resolveTenantFromSession(session);
    if (!tenant?.id) return json(404, { error: "Tenant not found" });

    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { error: "Invalid JSON" });
    }

    const incoming = Array.isArray(body?.mappings)
      ? body.mappings
      : Array.isArray(body)
        ? body
        : body?.bucket
          ? [body]
          : [];

    const sanitized = incoming
      .map((r) => sanitizeMapping(r, tenant.id))
      .filter(Boolean);

    const byBucket = new Map();
    for (const r of sanitized) byBucket.set(r.bucket, r);

    const payload = Array.from(byBucket.values());

    if (!payload.length) {
      return json(400, { error: "No valid mappings" });
    }

    const rows = await supabaseRequest(
      "tenant_financial_account_mapping?on_conflict=tenant_id,bucket",
      {
        method: "POST",
        body: payload,
        headers: {
          Prefer: "resolution=merge-duplicates,return=representation",
        },
      }
    );

    return json(200, {
      ok: true,
      saved: Array.isArray(rows) ? rows.length : 0,
      rows,
    });
  } catch (err) {
    return json(500, { error: err.message || "save_mapping_failed" });
  }
};
