const fetch = globalThis.fetch;
if (!fetch) {
  throw new Error("Global fetch is not available.");
}

const { getSupabaseConfig } = require("./_lib/supabase-admin");

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
      return json(405, { error: "Method not allowed" });
    }

    let supabaseUrl;
    let serviceRoleKey;
    try {
      ({ url: supabaseUrl, key: serviceRoleKey } = getSupabaseConfig());
    } catch (_e) {
      return json(500, { error: "Missing server configuration" });
    }

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch (_e) {
      return json(400, { error: "Invalid JSON" });
    }

    const rawToken = body.token;
    const trimmed = String(rawToken ?? "").trim();
    if (trimmed.length < 10 || trimmed.length > 256) {
      return json(400, { error: "Invalid token" });
    }
    if (!/^[a-zA-Z0-9_]+$/.test(trimmed)) {
      return json(400, { error: "Invalid token" });
    }

    const action = String(body.action || "").trim().toLowerCase();
    const nowIso = new Date().toISOString();

    const patch = { updated_at: nowIso };

    if (action === "exclusions_ack") {
      const initials = String(body.exclusions_initials ?? body.exclusionsInitials ?? "")
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "")
        .slice(0, 10);
      if (!initials || initials.length < 1) {
        return json(400, { error: "Initials are required (letters or numbers, 1–10 characters)." });
      }
      patch.exclusions_initials = initials;
      patch.exclusions_acknowledged_at = nowIso;
    } else if (action === "change_order_ack") {
      patch.change_order_acknowledged_at = nowIso;
    } else {
      return json(400, { error: "Invalid action. Use exclusions_ack or change_order_ack." });
    }

    const path = `quotes?public_token=eq.${encodeURIComponent(trimmed)}&tenant_id=not.is.null`;

    const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        Prefer: "return=representation"
      },
      body: JSON.stringify(patch)
    });

    const text = await response.text();
    if (!response.ok) {
      return json(502, { error: text || "Failed to update quote" });
    }

    let rows = [];
    try {
      rows = JSON.parse(text);
    } catch {
      rows = [];
    }
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) {
      return json(404, { error: "Quote not found or token invalid." });
    }

    return json(200, {
      ok: true,
      action,
      row
    });
  } catch (err) {
    return json(500, { error: err.message || "Server error" });
  }
};
