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

function trimStr(v, maxLen) {
  const s = String(v ?? "").trim();
  if (maxLen && s.length > maxLen) return s.slice(0, maxLen);
  return s;
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

    const rawToken = body.token ?? body.public_token ?? body.publicToken;
    const trimmed = String(rawToken ?? "").trim();
    if (trimmed.length < 10 || trimmed.length > 256) {
      return json(400, { error: "Invalid token" });
    }
    if (!/^[a-zA-Z0-9_]+$/.test(trimmed)) {
      return json(400, { error: "Invalid token" });
    }

    const request_title = trimStr(body.request_title ?? body.requestTitle, 300);
    const request_description = trimStr(
      body.request_description ?? body.requestDescription,
      12000
    );
    const request_area = trimStr(body.request_area ?? body.requestArea, 500);
    const preferred_timing = trimStr(
      body.preferred_timing ?? body.preferredTiming,
      500
    );

    if (!request_title || request_title.length < 3) {
      return json(400, { error: "Please enter a short title for your request (at least 3 characters)." });
    }
    if (!request_description || request_description.length < 10) {
      return json(400, {
        error: "Please describe the additional work in more detail (at least 10 characters)."
      });
    }

    const path = `quotes?public_token=eq.${encodeURIComponent(trimmed)}&tenant_id=not.is.null&select=id,tenant_id&limit=2`;

    const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`
      }
    });

    const text = await response.text();
    let rows = [];
    try {
      rows = text ? JSON.parse(text) : [];
    } catch {
      rows = [];
    }

    if (!response.ok) {
      return json(502, { error: text || "Failed to read quote" });
    }

    if (!Array.isArray(rows) || rows.length === 0) {
      return json(404, { error: "Quote not found for this link." });
    }
    if (rows.length > 1) {
      return json(500, { error: "Invalid quote reference" });
    }

    const quote = rows[0];
    const quoteId = quote.id;
    const tenantId = quote.tenant_id;

    if (!quoteId || !tenantId) {
      return json(400, { error: "Quote is missing scope; contact the contractor." });
    }

    const nowIso = new Date().toISOString();
    const insertPayload = {
      quote_id: quoteId,
      tenant_id: tenantId,
      public_token: trimmed,
      request_title,
      request_description,
      request_area,
      preferred_timing,
      status: "submitted",
      updated_at: nowIso
    };

    const insertRes = await fetch(`${supabaseUrl}/rest/v1/quote_change_requests`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        Prefer: "return=representation"
      },
      body: JSON.stringify(insertPayload)
    });

    const insertText = await insertRes.text();
    let inserted = [];
    try {
      inserted = insertText ? JSON.parse(insertText) : [];
    } catch {
      inserted = [];
    }

    if (!insertRes.ok) {
      return json(502, {
        error:
          typeof inserted === "object" && inserted?.message
            ? inserted.message
            : insertText || "Failed to save request"
      });
    }

    const row = Array.isArray(inserted) ? inserted[0] : inserted;

    return json(200, {
      ok: true,
      id: row?.id || null
    });
  } catch (err) {
    return json(500, { error: err.message || "Server error" });
  }
};
