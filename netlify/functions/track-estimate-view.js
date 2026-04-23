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

function headerValue(v) {
  if (v == null) return "";
  if (Array.isArray(v)) return String(v[0] || "").trim();
  return String(v).trim();
}

/** Netlify may pass mixed-case keys; normalize for lookups. */
function lowerHeaderMap(headers) {
  const out = {};
  if (!headers || typeof headers !== "object") return out;
  for (const [k, v] of Object.entries(headers)) {
    out[String(k).toLowerCase()] = headerValue(v);
  }
  return out;
}

/**
 * Block link-preview crawlers and non-browser POSTs from consuming the one-time DB claim.
 *
 * Note: real tracking uses `fetch()` from estimate-public.html. Browsers send
 * Sec-Fetch-Mode `cors` or `same-origin` and Sec-Fetch-Dest `empty` — not `navigate`/`document`
 * (those apply to top-level document navigations). We allow both navigate+document and
 * cors/same-origin+empty so previews cannot masquerade as our fetch while humans still pass.
 */
function previewOrBotSkipReason(h) {
  const ua = pickStr(h["user-agent"], 4000).toLowerCase();
  if (!ua) return "no_user_agent";

  const botSubstrings = [
    "googlebot",
    "adsbot-google",
    "mediapartners-google",
    "feedfetcher-google",
    "google-read-aloud",
    "googleimageproxy",
    "google-web-preview",
    "google page renderer",
    "google-structured-data-testing-tool",
    "apis-google",
    "bingbot",
    "bingpreview",
    "msnbot",
    "slackbot",
    "twitterbot",
    "facebookexternalhit",
    "facebot",
    "linkedinbot",
    "whatsapp",
    "discordbot",
    "telegrambot",
    "pinterest",
    "embedly",
    "quora link preview",
    "skypeuripreview",
    "vkshare",
    "redditbot",
    "yandexbot",
    "baiduspider",
    "duckduckbot",
    "applebot",
    "amazonbot",
    "bytespider",
    "petalbot",
    "semrushbot",
    "ahrefsbot",
    "dotbot",
    "headlesschrome",
    "headless",
    "puppeteer",
    "playwright",
    "phantomjs",
    "ia_archiver",
    "python-requests",
    "axios/",
    "go-http-client",
    "apache-httpclient",
    "libwww-perl",
    "aiohttp"
  ];
  for (const b of botSubstrings) {
    if (ua.includes(b)) return "bot_user_agent";
  }
  if (/^curl\//i.test(ua) || /^wget\//i.test(ua) || /^scrapy/i.test(ua)) return "bot_user_agent";

  const purpose = `${h["sec-purpose"] || ""} ${h["purpose"] || ""}`.toLowerCase();
  if (purpose.includes("prefetch")) return "prefetch_purpose";

  const mode = pickStr(h["sec-fetch-mode"], 64).toLowerCase();
  const dest = pickStr(h["sec-fetch-dest"], 64).toLowerCase();

  if (mode || dest) {
    const okTopLevelNav = mode === "navigate" && dest === "document";
    const okBrowserFetch =
      (mode === "cors" || mode === "same-origin") && (dest === "empty" || dest === "");
    const okFetchModeOnly = (mode === "cors" || mode === "same-origin") && !dest;

    if (!okTopLevelNav && !okBrowserFetch && !okFetchModeOnly) {
      return "fetch_metadata";
    }
  }

  return "";
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

    const hdrs = lowerHeaderMap(event.headers || {});
    const skipReason = previewOrBotSkipReason(hdrs);
    if (skipReason) {
      console.info(`[${OPS}] skipped preview/bot traffic`, {
        reason: skipReason,
        sec_fetch_mode: pickStr(hdrs["sec-fetch-mode"], 64),
        sec_fetch_dest: pickStr(hdrs["sec-fetch-dest"], 64),
        sec_fetch_site: pickStr(hdrs["sec-fetch-site"], 64),
        ua_snippet: pickStr(hdrs["user-agent"], 120)
      });
      return json(200, {
        ok: true,
        forwarded: false,
        reason: "preview_skipped",
        skipped: "preview"
      });
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
      return json(200, {
        ok: true,
        forwarded: false,
        reason: "no_public_token"
      });
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
      return json(200, {
        ok: true,
        forwarded: false,
        claimed: true,
        reason: "env_missing"
      });
    }

    console.log("[track-estimate-view] outbound to Zapier:", outbound);

    let resp;
    try {
      resp = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(outbound)
      });
    } catch (zapErr) {
      console.warn(`[${OPS}] zapier fetch threw`, {
        message: zapErr && zapErr.message ? String(zapErr.message).slice(0, 200) : "unknown"
      });
      return json(200, {
        ok: true,
        forwarded: false,
        claimed: true,
        reason: "zapier_fetch_error"
      });
    }

    if (!resp.ok) {
      console.warn(`[${OPS}] upstream non-OK`, { status: resp.status });
      return json(200, {
        ok: true,
        forwarded: false,
        claimed: true,
        reason: "zapier_non_ok",
        zapier_status: resp.status
      });
    }

    return json(200, { ok: true, forwarded: true, claimed: true });
  } catch (err) {
    console.warn(`[${OPS}] error`, { message: err && err.message ? String(err.message).slice(0, 200) : "unknown" });
    return json(200, {
      ok: true,
      forwarded: false,
      reason: "unexpected_error"
    });
  }
};
