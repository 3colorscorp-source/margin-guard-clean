const fetch = globalThis.fetch;
if (!fetch) {
  throw new Error("Global fetch is not available in this runtime.");
}

function getServiceConfig() {
  const url = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return { url, key };
}

/**
 * Resolve auth.users.id for an email via Supabase Auth Admin API (GoTrue).
 * Paginates until a matching email is found or pages are exhausted.
 */
async function resolveAuthUserIdByEmail(email) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized || !normalized.includes("@")) {
    return null;
  }

  const { url, key } = getServiceConfig();
  if (!url || !key) {
    console.warn("[auth-resolve-user-id] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    return null;
  }

  let page = 1;
  const perPage = 200;
  const maxPages = 25;

  while (page <= maxPages) {
    const res = await fetch(`${url}/auth/v1/admin/users?page=${page}&per_page=${perPage}`, {
      method: "GET",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
    });

    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = {};
    }

    if (!res.ok) {
      console.warn("[auth-resolve-user-id] auth admin users failed:", res.status, text?.slice(0, 200));
      return null;
    }

    const users = Array.isArray(data.users) ? data.users : [];
    for (const u of users) {
      if (String(u.email || "").trim().toLowerCase() === normalized) {
        return u.id ? String(u.id) : null;
      }
    }

    if (users.length < perPage) {
      break;
    }
    page += 1;
  }

  return null;
}

module.exports = { resolveAuthUserIdByEmail };
