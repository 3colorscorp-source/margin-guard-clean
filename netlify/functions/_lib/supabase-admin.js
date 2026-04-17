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
    throw new Error(typeof data === "string" ? data : (data?.message || data?.error || "Supabase request failed"));
  }

  return data;
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
