const { supabaseRequest } = require("./_lib/supabase-admin");

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}

/** Columns fetched from quotes — public_token is the ONLY lookup key; no id, no tenant join. */
const QUOTE_SELECT = [
  "business_name",
  "company_name",
  "business_email",
  "business_phone",
  "business_address",
  "title",
  "project_name",
  "client_name",
  "client_email",
  "client_phone",
  "project_address",
  "job_site",
  "total",
  "currency",
  "deposit_required",
  "notes",
  "terms",
  "status"
].join(",");

/**
 * Public estimate API: isolated to one quote row matched by public_token only.
 * Response is a whitelisted subset — no ids, no tenant_id, no joins.
 */
exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "GET") {
      return json(405, { error: "Method Not Allowed" });
    }

    const raw = event.queryStringParameters?.token;
    if (raw === undefined || raw === null) {
      return json(400, { error: "Missing token" });
    }
    const trimmed = String(raw).trim();
    if (trimmed === "") {
      return json(400, { error: "Missing token" });
    }
    if (trimmed.length < 10 || trimmed.length > 256) {
      return json(400, { error: "Invalid token" });
    }
    if (!/^[a-zA-Z0-9_]+$/.test(trimmed)) {
      return json(400, { error: "Invalid token" });
    }

    const path = `quotes?public_token=eq.${encodeURIComponent(trimmed)}&tenant_id=not.is.null&select=${QUOTE_SELECT}&limit=2`;

    let rows;
    try {
      rows = await supabaseRequest(path, { method: "GET" });
    } catch (err) {
      return json(502, { error: err.message || "Failed to read quote" });
    }

    if (!Array.isArray(rows)) {
      return json(502, { error: "Unexpected response" });
    }

    if (rows.length === 0) {
      return json(404, { error: "Estimate not found" });
    }

    if (rows.length > 1) {
      return json(500, { error: "Invalid quote reference" });
    }

    const row = rows[0];
    const estimate = pickPublicEstimateFields(row);

    return json(200, {
      ok: true,
      estimate: {
        ...estimate,
        items: []
      }
    });
  } catch (err) {
    return json(500, { error: err.message || "Server error" });
  }
};

const QUOTE_NUMERIC_KEYS = new Set(["total", "deposit_required"]);

function pickPublicEstimateFields(row) {
  const keys = QUOTE_SELECT.split(",");
  const out = {};
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(row, k)) {
      continue;
    }
    const v = row[k];
    if (QUOTE_NUMERIC_KEYS.has(k)) {
      const n = Number(v);
      out[k] = Number.isFinite(n) ? n : 0;
      continue;
    }
    out[k] = v === null || v === undefined ? "" : String(v);
  }
  return out;
}
