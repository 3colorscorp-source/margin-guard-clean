const { supabaseRequest } = require("./_lib/supabase-admin");
const { loadTenantDisplayForTenantId, pickFirst } = require("./_lib/tenant-display");

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}

/** Public columns returned to the browser (no ids). */
const QUOTE_PUBLIC_KEYS = [
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
  "status",
  "accepted_at",
  "exclusions_initials",
  "exclusions_acknowledged_at",
  "change_order_acknowledged_at"
];

/** Include tenant_id for server-side branding; id for audit logs only (stripped from public JSON). */
const QUOTE_FETCH_KEYS = [...QUOTE_PUBLIC_KEYS, "tenant_id", "id"];

const QUOTE_SELECT = QUOTE_FETCH_KEYS.join(",");

/** Treat generic placeholder stored on quotes so real tenant names can win in pickFirst. */
function skipHeaderPlaceholderName(value) {
  const t = String(value ?? "").trim();
  if (!t) return "";
  if (/^business$/i.test(t)) return "";
  return t;
}

/** Normalize tenant branding logo for public clients (absolute http(s), never scheme-relative). */
function normalizePublicLogoUrl(value) {
  let s = String(value ?? "").trim();
  if (!s) return "";
  if (s.startsWith("//")) s = `https:${s}`;
  try {
    const u = new URL(s);
    if (u.protocol === "http:" || u.protocol === "https:") return u.href;
  } catch (_e) {
    /* ignore */
  }
  return "";
}

/**
 * Public estimate API: isolated to one quote row matched by public_token only.
 * Response is a whitelisted subset — no ids, no tenant_id in JSON.
 * Tenant branding (name + logo) is resolved server-side from tenant_id for header display only.
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

    console.log("[MG Public Estimate Financials]", {
      quoteId: row.id,
      publicToken: trimmed,
      total: row.total,
      deposit_required: row.deposit_required
    });

    let td = null;
    let tenantBrandingBusinessName = "";
    let tenantBrandingCompanyName = "";
    let tenantLogoUrl = "";
    const tenantId = row.tenant_id;

    let deposit_payment_available = false;
    let ownerSettings = null;

    if (tenantId) {
      try {
        td = await loadTenantDisplayForTenantId(tenantId);
        tenantBrandingBusinessName = pickFirst(td.branding_business_name, td.business_name);
        tenantBrandingCompanyName = pickFirst(td.branding_company_name);
        tenantLogoUrl = normalizePublicLogoUrl(td.logo_url);
      } catch (_e) {
        td = null;
        tenantBrandingBusinessName = "";
        tenantBrandingCompanyName = "";
        tenantLogoUrl = "";
      }

      try {
        const osRows = await supabaseRequest(
          `owner_settings?tenant_id=eq.${encodeURIComponent(String(tenantId))}&select=deposit_payment_link&limit=1`
        );
        ownerSettings = Array.isArray(osRows) && osRows[0] ? osRows[0] : null;
      } catch (_e3) {
        ownerSettings = null;
      }

      deposit_payment_available = !!ownerSettings?.deposit_payment_link;
    }

    const resolvedBusinessName =
      pickFirst(
        skipHeaderPlaceholderName(estimate.business_name),
        skipHeaderPlaceholderName(estimate.company_name),
        td ? td.branding_business_name : "",
        td ? td.business_name : ""
      ) || "Business";

    return json(200, {
      ok: true,
      estimate: {
        ...estimate,
        business_name: resolvedBusinessName,
        tenant_branding_business_name: tenantBrandingBusinessName,
        tenant_branding_company_name: tenantBrandingCompanyName,
        logo_url: tenantLogoUrl,
        deposit_payment_available,
        deposit_payment_link: ownerSettings?.deposit_payment_link || null,
        items: []
      }
    });
  } catch (err) {
    return json(500, { error: err.message || "Server error" });
  }
};

const QUOTE_NUMERIC_KEYS = new Set(["total", "deposit_required"]);

function pickPublicEstimateFields(row) {
  const keys = QUOTE_PUBLIC_KEYS;
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
