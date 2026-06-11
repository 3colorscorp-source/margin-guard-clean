/**
 * Step 3E-C14-E2G-B2 — Public Supabase URL + anon key for browser clients.
 * Returns only public config; no auth, DB, or secrets.
 */

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=300",
    },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "GET") {
      return json(405, { ok: false, error: "method_not_allowed" });
    }

    const supabaseUrl = String(process.env.SUPABASE_URL || "")
      .trim()
      .replace(/\/+$/, "");
    const supabaseAnonKey = String(process.env.SUPABASE_ANON_KEY || "").trim();

    if (!supabaseUrl || !supabaseAnonKey) {
      return json(503, { ok: false, error: "supabase_public_config_missing" });
    }

    return json(200, {
      ok: true,
      supabaseUrl,
      supabaseAnonKey,
    });
  } catch (_err) {
    return json(500, { ok: false, error: "supabase_public_config_missing" });
  }
};
