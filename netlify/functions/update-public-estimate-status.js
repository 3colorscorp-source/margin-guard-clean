const fetch = globalThis.fetch;
if (!fetch) {
  throw new Error("Global fetch is not available in this runtime.");
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { error: "Method Not Allowed" });
    }

    const supabaseUrl =
      process.env.SUPABASE_URL || "https://yaagobzgozzozibublmj.supabase.co";
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!serviceRoleKey) {
      return json(500, { error: "Missing env SUPABASE_SERVICE_ROLE_KEY" });
    }

    const body = JSON.parse(event.body || "{}");
    const token = body.token || "";
    const status = String(body.status || "").trim().toLowerCase();

    if (!token) {
      return json(400, { error: "Missing token" });
    }

    if (!["accepted", "declined"].includes(status)) {
      return json(400, { error: "Invalid status" });
    }

    const nowIso = new Date().toISOString();

    const patch = {
      status,
      updated_at: nowIso
    };

    if (status === "accepted") patch.accepted_at = nowIso;
    if (status === "declined") patch.declined_at = nowIso;

    const response = await fetch(
      `${supabaseUrl}/rest/v1/quotes?public_token=eq.${encodeURIComponent(token)}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          Prefer: "return=representation"
        },
        body: JSON.stringify(patch)
      }
    );

    const text = await response.text();
    if (!response.ok) {
      return json(502, { error: text || "Failed to update estimate status" });
    }

    let rows = [];
    try {
      rows = JSON.parse(text);
    } catch {
      rows = [];
    }

    const row = Array.isArray(rows) ? rows[0] : null;

    return json(200, {
      ok: true,
      status,
      row
    });
  } catch (err) {
    return json(500, { error: err.message || "Server error" });
  }
};