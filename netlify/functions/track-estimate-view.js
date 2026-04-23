const fetch = globalThis.fetch;
if (!fetch) {
  throw new Error("Global fetch is not available in this runtime.");
}

const { supabaseRequest } = require("./_lib/supabase-admin");

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

/** Same rules as get-public-estimate token validation. */
function normalizePublicToken(raw) {
  const t = raw == null ? "" : String(raw).trim();
  if (!t || t.length < 10 || t.length > 256) return "";
  if (!/^[a-zA-Z0-9_]+$/.test(t)) return "";
  return t;
}

/**
 * Public estimate view → claim row once → Zapier (server-side URL only).
 * Body: { public_token (or token / publicToken), client_email (or clientEmail), ... }
 * Dedupe: PATCH quotes WHERE public_token = ? AND first_view_tracked_at IS NULL; forward only if a row was updated.
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

    console.log("[track-estimate-view] received payload (raw keys):", Object.keys(raw));

    const client_email = pickStr(raw.client_email, 320) || pickStr(raw.clientEmail, 320);
    if (!client_email) {
      console.warn("[track-estimate-view] missing client_email after parse");
      return json(400, { error: "client_email required" });
    }

    const public_token = normalizePublicToken(
      pickStr(raw.public_token, 256) || pickStr(raw.token, 256) || pickStr(raw.publicToken, 256)
    );
    if (!public_token) {
      console.warn("[track-estimate-view] missing public_token; cannot dedupe server-side");
      return json(200, { ok: true, forwarded: false, reason: "no_public_token" });
    }

    const nowIso = new Date().toISOString();
    let claimed = false;
    try {
      const path = `quotes?public_token=eq.${encodeURIComponent(public_token)}&first_view_tracked_at=is.null`;
      const rows = await supabaseRequest(path, {
        method: "PATCH",
        body: {
          first_view_tracked_at: nowIso,
          followup_sequence_started_at: nowIso
        }
      });
      claimed = Array.isArray(rows) && rows.length > 0;
    } catch (err) {
      console.warn("[track-estimate-view] claim failed", {
        message: err && err.message ? String(err.message).slice(0, 500) : "unknown"
      });
      return json(200, { ok: true, forwarded: false, reason: "claim_error" });
    }

    if (!claimed) {
      console.info(`[${OPS}] skip forward (already tracked or no matching quote)`);
      return json(200, { ok: true, forwarded: false, already_tracked: true });
    }

    const claimedRow = rows[0] && typeof rows[0] === "object" ? rows[0] : {};
    /** Same `quotes.status` as public estimate API (`get-public-estimate` → estimate.status). Snapshot at claim time. */
    const quote_status = pickStr(claimedRow.status, 80);

    const outbound = {
      client_email,
      quote_status,
      to_name: pickStr(raw.to_name, 200),
      public_quote_url: pickStr(raw.public_quote_url, 2000),
      business_name: pickStr(raw.business_name, 300),
      tenant_email: pickStr(raw.tenant_email, 320),
      owner_alert_email: pickStr(raw.owner_alert_email, 320),
      additional_recipients: pickStr(raw.additional_recipients, 1000)
    };

    const webhookUrl = String(process.env.ZAPIER_ESTIMATE_VIEW_WEBHOOK_URL || "").trim();
    if (!webhookUrl) {
      console.info(`[${OPS}] skipped (ZAPIER_ESTIMATE_VIEW_WEBHOOK_URL unset); claim already written`);
      return json(200, { ok: true, forwarded: false, claimed: true });
    }

    console.log("[track-estimate-view] outbound to Zapier:", outbound);

    const resp = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(outbound)
    });

    if (!resp.ok) {
      console.warn(`[${OPS}] upstream non-OK`, { status: resp.status });
      return json(200, { ok: true, forwarded: false, claimed: true });
    }

    return json(200, { ok: true, forwarded: true, claimed: true });
  } catch (err) {
    console.warn(`[${OPS}] error`, { message: err && err.message ? String(err.message).slice(0, 200) : "unknown" });
    return json(200, { ok: true, forwarded: false });
  }
};
