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

function makeToken(prefix = "qt") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
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

    const total =
      Number(body.total ?? body.recommended_total ?? body.recommendedTotal ?? 0) || 0;
    const depositRequired =
      Number(body.deposit_required ?? body.depositRequired ?? 1000) || 0;

    const publicToken = body.public_token || makeToken("qt");

    const payload = {
      project_name: body.project_name || body.projectName || "Project",
      client_name: body.client_name || body.clientName || "",
      client_email: body.client_email || body.customerEmail || "",
      status: body.status || "READY_TO_SEND",
      currency: body.currency || "USD",
      total: total,
      deposit_required: depositRequired,
      notes: body.notes || body.messageText || "",
      payment_link: body.payment_link || "",
      public_token: publicToken
    };

    const response = await fetch(`${supabaseUrl}/rest/v1/quotes`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        Prefer: "return=representation"
      },
      body: JSON.stringify(payload)
    });

    const text = await response.text();
    if (!response.ok) {
      return json(502, { error: text || "Supabase write failed" });
    }

    let rows = [];
    try {
      rows = JSON.parse(text);
    } catch {
      rows = [];
    }

    const row = Array.isArray(rows) ? rows[0] : null;
    const quoteId = row?.id || null;

    if (!quoteId) {
      return json(500, {
        error: "Quote was created but no quote id was returned by Supabase."
      });
    }

    const siteUrl =
      process.env.URL ||
      process.env.DEPLOY_PRIME_URL ||
      process.env.SITE_URL ||
      "";

    const publicUrl = `${siteUrl}/estimate-public.html?token=${encodeURIComponent(
      publicToken
    )}`;

    return json(200, {
      ok: true,
      quote_id: quoteId,
      public_token: publicToken,
      public_url: publicUrl,
      row
    });
  } catch (err) {
    return json(500, { error: err.message || "Server error" });
  }
};