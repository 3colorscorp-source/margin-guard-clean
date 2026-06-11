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
 * @returns {Promise<{ status: "found"|"not_found"|"resolve_failed", userId: string|null }>}
 */
async function resolveAuthUserIdByEmailDetailed(email) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized || !normalized.includes("@")) {
    return { status: "not_found", userId: null };
  }

  const { url, key } = getServiceConfig();
  if (!url || !key) {
    return { status: "resolve_failed", userId: null };
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

    let data = {};
    try {
      const text = await res.text();
      data = text ? JSON.parse(text) : {};
    } catch {
      data = {};
    }

    if (!res.ok) {
      return { status: "resolve_failed", userId: null };
    }

    const users = Array.isArray(data.users) ? data.users : [];
    for (const u of users) {
      if (String(u.email || "").trim().toLowerCase() === normalized) {
        return u.id
          ? { status: "found", userId: String(u.id) }
          : { status: "not_found", userId: null };
      }
    }

    if (users.length < perPage) {
      break;
    }
    page += 1;
  }

  return { status: "not_found", userId: null };
}

/**
 * Resolve auth.users.id for an email via Supabase Auth Admin API (GoTrue).
 * Paginates until a matching email is found or pages are exhausted.
 */
async function resolveAuthUserIdByEmail(email) {
  const result = await resolveAuthUserIdByEmailDetailed(email);
  return result.status === "found" ? result.userId : null;
}

module.exports = { resolveAuthUserIdByEmail, resolveAuthUserIdByEmailDetailed };
