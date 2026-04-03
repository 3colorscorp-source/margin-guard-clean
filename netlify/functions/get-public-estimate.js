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
    if (event.httpMethod !== "GET") {
      return json(405, { error: "Method Not Allowed" });
    }

    const supabaseUrl =
      process.env.SUPABASE_URL || "https://yaagobzgozzozibublmj.supabase.co";
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!serviceRoleKey) {
      return json(500, { error: "Missing env SUPABASE_SERVICE_ROLE_KEY" });
    }

    const token = event.queryStringParameters?.token || "";
    if (!token) {
      return json(400, { error: "Missing token" });
    }

    const quoteRes = await fetch(
      `${supabaseUrl}/rest/v1/quotes?public_token=eq.${encodeURIComponent(token)}&select=*`,
      {
        method: "GET",
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          "Content-Type": "application/json"
        }
      }
    );

    const quoteText = await quoteRes.text();
    if (!quoteRes.ok) {
      return json(502, { error: quoteText || "Failed to read quote" });
    }

    let quotes = [];
    try {
      quotes = JSON.parse(quoteText);
    } catch {
      quotes = [];
    }

    const quote = Array.isArray(quotes) ? quotes[0] : null;
    if (!quote) {
      return json(404, { error: "Estimate not found" });
    }

    const itemsRes = await fetch(
      `${supabaseUrl}/rest/v1/quote_items?quote_id=eq.${encodeURIComponent(quote.id)}&select=*&order=sort_order.asc`,
      {
        method: "GET",
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          "Content-Type": "application/json"
        }
      }
    );

    const itemsText = await itemsRes.text();
    let items = [];
    if (itemsRes.ok) {
      try {
        items = JSON.parse(itemsText);
      } catch {
        items = [];
      }
    }

    return json(200, {
      ok: true,
      estimate: {
        ...quote,
        items: Array.isArray(items) ? items : []
      }
    });
  } catch (err) {
    return json(500, { error: err.message || "Server error" });
  }
};