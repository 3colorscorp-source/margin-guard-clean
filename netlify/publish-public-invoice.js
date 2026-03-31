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

    const supabaseUrl = process.env.SUPABASE_URL || "https://yaagobzgozzozibublmj.supabase.co";
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!serviceRoleKey) {
      return json(500, { error: "Missing env SUPABASE_SERVICE_ROLE_KEY" });
    }

    const body = JSON.parse(event.body || "{}");
    const publicToken = body.public_token || `inv_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

    const payload = {
      public_token: publicToken,
      invoice_no: body.invoice_no || `INV-${Date.now()}`,
      customer_name: body.customer_name || "",
      customer_email: body.customer_email || "",
      project_name: body.project_name || "",
      amount: Number(body.amount || 0),
      paid_amount: Number(body.paid_amount || 0),
      balance_due: Number(body.balance_due || 0),
      issue_date: body.issue_date || new Date().toISOString().slice(0, 10),
      due_date: body.due_date || "",
      type: body.type || "service",
      notes: body.notes || "",
      payment_link: body.payment_link || "",
      business_name: body.business_name || "",
      logo_url: body.logo_url || "",
      accent_color: body.accent_color || "",
      currency: body.currency || "USD",
      status: body.status || "OPEN"
    };

    const response = await fetch(`${supabaseUrl}/rest/v1/invoices`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        Prefer: "resolution=merge-duplicates,return=representation"
      },
      body: JSON.stringify(payload)
    });

    const text = await response.text();
    if (!response.ok) {
      return json(502, { error: text || "Supabase write failed" });
    }

    const siteUrl = process.env.URL || process.env.DEPLOY_PRIME_URL || "";
    const baseUrl = siteUrl || "";
    const publicUrl = `${baseUrl}/invoice-public.html?token=${publicToken}`;

    return json(200, {
      ok: true,
      public_token: publicToken,
      public_url: publicUrl,
      raw: text
    });
  } catch (err) {
    return json(500, { error: err.message || "Server error" });
  }
};
