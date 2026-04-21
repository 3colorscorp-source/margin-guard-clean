const fetch = globalThis.fetch;
if (!fetch) {
  throw new Error("Global fetch is not available in this runtime.");
}

/**
 * Service-role Supabase access. Requires explicit env (no project URL fallback).
 */
function getSupabaseConfig() {
  const url = String(process.env.SUPABASE_URL || "")
    .trim()
    .replace(/\/+$/, "");
  if (!url) {
    throw new Error("Missing SUPABASE_URL");
  }
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");
  return { url, key };
}

async function supabaseRequest(path, { method = "GET", body, headers } = {}) {
  const { url, key } = getSupabaseConfig();
  const response = await fetch(`${url}/rest/v1/${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      apikey: key,
      Authorization: `Bearer ${key}`,
      Prefer: "return=representation",
      ...(headers || {})
    },
    body: body == null ? undefined : JSON.stringify(body)
  });

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_err) {
    data = text;
  }

  if (!response.ok) {
    const detail = formatSupabaseErrorBody(data, text, response.status);
    const err = new Error(detail);
    err.status = response.status;
    err.supabaseRaw = typeof text === "string" ? text.slice(0, 4000) : "";
    throw err;
  }

  return data;
}

/** PostgREST often returns { message, code, details } or an array of those objects. */
function formatSupabaseErrorBody(data, rawText, status) {
  if (typeof data === "string" && data.trim()) {
    return `Supabase HTTP ${status}: ${data.slice(0, 2000)}`;
  }
  if (Array.isArray(data) && data.length) {
    const parts = data.map((row) => {
      if (!row || typeof row !== "object") return String(row);
      return [row.message, row.details, row.hint, row.code].filter(Boolean).join(" | ");
    });
    return `Supabase HTTP ${status}: ${parts.join(" ; ")}`;
  }
  if (data && typeof data === "object") {
    const m = [data.message, data.error, data.details, data.hint, data.code].filter(Boolean).join(" | ");
    if (m) return `Supabase HTTP ${status}: ${m}`;
  }
  const tail = typeof rawText === "string" && rawText.trim() ? rawText.slice(0, 2000) : "";
  return tail ? `Supabase HTTP ${status}: ${tail}` : `Supabase HTTP ${status}: request failed`;
}

function toSlug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || `tenant-${Date.now()}`;
}

module.exports = {
  supabaseRequest,
  getSupabaseConfig,
  toSlug
};
