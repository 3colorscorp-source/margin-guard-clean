const fetch = globalThis.fetch;
if (!fetch) {
  throw new Error("Global fetch is not available in this runtime.");
}

const OPS = "track-estimate-view";

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}

function pickStr(v, maxLen) {
  const s = v == null || v === undefined ? "" : String(v).trim();
  if (!maxLen || maxLen < 1) return s;
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

/**
 * Public estimate view → Zapier (server-side URL only).
 * Body: { client_email, to_name, public_quote_url, business_name, tenant_email, owner_alert_email, additional_recipients }
 * Requires ZAPIER_ESTIMATE_VIEW_WEBHOOK_URL in Netlify env (never committed).
 */
exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { error: "Method not allowed" });
    }

    let raw = {};
    try {
      raw =
        typeof event.body === "string"
          ? JSON.parse(event.body || "{}")
          : event.body && typeof event.body === "object"
            ? event.body
            : {};
    } catch {
      return json(400, { error: "Invalid JSON" });
    }

    const client_email = pickStr(raw.client_email, 320);
    if (!client_email) {
      return json(400, { error: "client_email required" });
    }

    const outbound = {
      client_email,
      to_name: pickStr(raw.to_name, 200),
      public_quote_url: pickStr(raw.public_quote_url, 2000),
      business_name: pickStr(raw.business_name, 300),
      tenant_email: pickStr(raw.tenant_email, 320),
      owner_alert_email: pickStr(raw.owner_alert_email, 320),
      additional_recipients: pickStr(raw.additional_recipients, 1000)
    };

    const webhookUrl = String(process.env.ZAPIER_ESTIMATE_VIEW_WEBHOOK_URL || "").trim();
    if (!webhookUrl) {
      console.info(`[${OPS}] skipped (ZAPIER_ESTIMATE_VIEW_WEBHOOK_URL unset)`);
      return json(200, { ok: true, forwarded: false });
    }

    const resp = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(outbound)
    });

    if (!resp.ok) {
      console.warn(`[${OPS}] upstream non-OK`, { status: resp.status });
      return json(200, { ok: true, forwarded: false });
    }

    return json(200, { ok: true, forwarded: true });
  } catch (err) {
    console.warn(`[${OPS}] error`, { message: err && err.message ? String(err.message).slice(0, 200) : "unknown" });
    return json(200, { ok: true, forwarded: false });
  }
};
