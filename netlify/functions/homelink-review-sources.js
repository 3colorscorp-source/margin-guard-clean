"use strict";

const { requireOwnerOrAdmin } = require("./_lib/require-owner-or-admin");
const { supabaseRequest } = require("./_lib/supabase-admin");
const portal = require("./_lib/homelink-portal");

const SECRET_PARAM = /^(token|secret|password|passwd|pwd|auth|key|sig|session|code|jwt)$/i;

function trim(value) {
  return String(value == null ? "" : value).trim();
}

function reviewSourceUrl(value) {
  const text = trim(value);
  if (!text || text.length > 500) return "";
  let url;
  try { url = new URL(text); } catch (_err) { return ""; }
  if (url.protocol !== "https:" || url.username || url.password) return "";
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(url.hostname)) return "";
  for (const name of url.searchParams.keys()) {
    if (SECRET_PARAM.test(name)) return "";
  }
  url.hash = "";
  return url.toString();
}

function reviewSources(row) {
  const source = row && typeof row === "object" ? row : {};
  return {
    google: reviewSourceUrl(source.google_review_url || source.google),
    yelp: reviewSourceUrl(source.yelp_review_url || source.yelp),
    website: reviewSourceUrl(source.website_url || source.website)
  };
}

function html(statusCode, body) {
  return {
    statusCode: statusCode,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY"
    },
    body: "<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>HomeLink reviews</title></head><body>" + body + "</body></html>"
  };
}

function esc(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

function formBody(event) {
  const raw = event && event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64").toString("utf8")
    : String(event && event.body || "");
  return new URLSearchParams(raw);
}

function sameSitePost(event) {
  const headers = event && event.headers ? event.headers : {};
  const origin = trim(headers.origin || headers.Origin);
  const host = trim(headers.host || headers.Host).toLowerCase();
  if (!origin || !host) return false;
  try {
    return new URL(origin).host.toLowerCase() === host;
  } catch (_err) {
    return false;
  }
}

function formPage(lang, values, error) {
  const es = lang === "es";
  const title = es ? "Enlaces de reseñas" : "Review links";
  const lead = es
    ? "Estos enlaces quedan en tu cuenta. El cliente ve Abrir. HomeLink no escribe el número."
    : "These links stay on your account. The client sees Open. HomeLink does not write the count.";
  const save = es ? "Guardar en la cuenta" : "Save on the account";
  const message = error ? "<p>" + esc(error) + "</p>" : "";
  return html(error ? 400 : 200,
    "<h1>" + title + "</h1><p>" + lead + "</p>" + message +
    "<form method=\"post\">" +
    "<p><label>Google<br><input name=\"google\" type=\"url\" maxlength=\"500\" value=\"" + esc(values.google) + "\"></label></p>" +
    "<p><label>Yelp<br><input name=\"yelp\" type=\"url\" maxlength=\"500\" value=\"" + esc(values.yelp) + "\"></label></p>" +
    "<p><label>" + (es ? "Sitio web" : "Website") + "<br><input name=\"website\" type=\"url\" maxlength=\"500\" value=\"" + esc(values.website) + "\"></label></p>" +
    "<p><button type=\"submit\">" + save + "</button></p></form>"
  );
}

function returnPage(origin, sources) {
  const packed = encodeURIComponent(JSON.stringify(sources));
  const target = JSON.stringify(origin + "/#rs=" + packed);
  return html(200, "<p>Returning to HomeLink.</p><script>location.replace(" + target + ");</script>");
}

async function loadSources(tenantId, request) {
  const data = await request(
    "tenant_branding?tenant_id=eq." + encodeURIComponent(tenantId) +
    "&select=google_review_url,yelp_review_url,website_url&limit=1"
  );
  return reviewSources(Array.isArray(data) ? data[0] : null);
}

async function saveSources(tenantId, sources, request) {
  const existing = await request(
    "tenant_branding?tenant_id=eq." + encodeURIComponent(tenantId) + "&select=tenant_id&limit=1"
  );
  const row = {
    google_review_url: sources.google,
    yelp_review_url: sources.yelp,
    website_url: sources.website
  };
  if (Array.isArray(existing) && existing.length) {
    await request(
      "tenant_branding?tenant_id=eq." + encodeURIComponent(tenantId),
      { method: "PATCH", body: row }
    );
    return;
  }
  await request("tenant_branding", {
    method: "POST",
    body: Object.assign({ tenant_id: tenantId }, row)
  });
}

exports.reviewSourceUrl = reviewSourceUrl;
exports.reviewSources = reviewSources;

exports.handler = async function (event, deps) {
  const options = deps || {};
  const ownerGate = options.requireOwnerOrAdmin || requireOwnerOrAdmin;
  const request = options.supabaseRequest || supabaseRequest;
  const origin = portal.exactOrigin(options.homeOrigin || process.env.HOMELINK_ORIGIN);
  const query = event && event.queryStringParameters ? event.queryStringParameters : {};
  const lang = trim(query.lang).toLowerCase() === "es" ? "es" : "en";
  try {
    if (!event || (event.httpMethod !== "GET" && event.httpMethod !== "POST")) {
      return html(405, "<p>method_not_allowed</p>");
    }
    if (Object.prototype.hasOwnProperty.call(query, "tenant_id")) return html(400, "<p>tenant_forbidden</p>");
    let actor;
    try {
      actor = await ownerGate(event);
    } catch (err) {
      const code = err && err.code ? err.code : "no_session";
      return html(err && err.statusCode ? err.statusCode : 401, "<p>" + esc(code) + "</p>");
    }
    const tenantId = actor && actor.tenant && actor.tenant.id;
    if (!tenantId) return html(401, "<p>no_session</p>");
    if (!origin) return html(503, "<p>handoff_not_configured</p>");
    if (event.httpMethod === "GET") {
      let stored = { google: "", yelp: "", website: "" };
      try { stored = await loadSources(tenantId, request); } catch (_err) { stored = { google: "", yelp: "", website: "" }; }
      const typed = reviewSources(query);
      return formPage(lang, {
        google: typed.google || stored.google,
        yelp: typed.yelp || stored.yelp,
        website: typed.website || stored.website
      }, "");
    }
    if (!sameSitePost(event)) return html(403, "<p>cross_site</p>");
    const body = formBody(event);
    const submitted = {
      google: trim(body.get("google")),
      yelp: trim(body.get("yelp")),
      website: trim(body.get("website"))
    };
    const sources = reviewSources(submitted);
    if ((submitted.google && !sources.google) || (submitted.yelp && !sources.yelp) || (submitted.website && !sources.website)) {
      const bad = lang === "es"
        ? "Usa un enlace https:// sin usuario, contraseña ni tokens."
        : "Use an https:// link with no user, password, or token.";
      return formPage(lang, submitted, bad);
    }
    try {
      await saveSources(tenantId, sources, request);
    } catch (_err) {
      const notReady = lang === "es"
        ? "La cuenta todavía no puede guardar estos enlaces."
        : "The account cannot store these links yet.";
      return formPage(lang, sources, notReady);
    }
    return returnPage(origin, sources);
  } catch (_err) {
    return html(500, "<p>server_error</p>");
  }
};
