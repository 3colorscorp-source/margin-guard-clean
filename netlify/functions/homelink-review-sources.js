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

function html(statusCode, body, lang) {
  const locale = lang === "es" ? "es" : "en";
  return {
    statusCode: statusCode,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY"
    },
    body: "<!DOCTYPE html><html lang=\"" + locale + "\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>HomeLink</title>" +
      "<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\"><link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin>" +
      "<link href=\"https://fonts.googleapis.com/css2?family=Figtree:wght@400;600;700&family=Source+Serif+4:opsz,wght@8..60,560;8..60,650&display=swap\" rel=\"stylesheet\">" +
      "<style>" +
      ":root{color-scheme:light;--cream:#f6f1e9;--ink:#1b2433;--muted:#5d6470;--navy:#13233a;--card:#fffdf9;--line:rgba(19,35,58,.12);--green:#174a37;--danger:#8d2d2d;--danger-bg:#fde8e4;--serif:\"Source Serif 4\",Georgia,serif;--sans:Figtree,\"Segoe UI\",sans-serif}" +
      "*{box-sizing:border-box}body{margin:0;min-height:100vh;font:16px/1.5 var(--sans);color:var(--ink);background:var(--cream)}" +
      ".band{background:var(--navy);color:#f5efe5;padding:28px 24px 22px}.band p{margin:0;letter-spacing:.16em;font-size:12px;font-weight:700}.wrap{width:min(560px,calc(100% - 32px));margin:-28px auto 48px}.card{background:var(--card);border:1px solid var(--line);border-radius:22px;box-shadow:0 1px 2px rgba(19,35,58,.05),0 18px 40px rgba(19,35,58,.08);padding:32px 28px 28px}" +
      "h1{margin:0 0 10px;font-family:var(--serif);font-size:40px;font-weight:560;letter-spacing:-.03em;line-height:1.05}.lead{margin:0 0 22px;color:var(--muted)}" +
      "label{display:block;margin:0 0 14px;font-size:13px;font-weight:700;letter-spacing:.04em;text-transform:uppercase}input{display:block;width:100%;margin-top:8px;min-height:52px;padding:12px 14px;border:1px solid var(--line);border-radius:14px;background:#fff;color:var(--ink);font:16px/1.4 var(--sans)}input:focus{outline:2px solid #d08a55;outline-offset:1px}" +
      "button{width:100%;margin-top:8px;min-height:54px;border:0;border-radius:14px;background:linear-gradient(180deg,#23694f,var(--green));color:#f4fbf6;font:600 18px/1 var(--sans);cursor:pointer;box-shadow:0 8px 18px rgba(23,74,55,.22)}button:focus-visible{outline:2px solid #d08a55;outline-offset:3px}" +
      ".error{margin:0 0 16px;padding:12px 14px;border-radius:14px;background:var(--danger-bg);color:var(--danger)}.plain{padding:48px 0}" +
      "</style></head><body><header class=\"band\"><p>HOMELINK</p></header><main class=\"wrap\"><section class=\"card\">" + body + "</section></main></body></html>"
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

function rawHeader(event, name) {
  const sources = [event && event.headers, event && event.multiValueHeaders];
  for (let i = 0; i < sources.length; i += 1) {
    const headers = sources[i];
    if (!headers) continue;
    const raw = headers[name] || headers[name.toLowerCase()];
    const value = Array.isArray(raw) ? raw[0] : raw;
    const text = trim(value).split(",")[0].trim();
    if (text) return text;
  }
  return "";
}

function sameSitePost(event) {
  const fetchSite = rawHeader(event, "sec-fetch-site").toLowerCase();
  if (fetchSite === "same-origin" || fetchSite === "same-site") return true;
  if (fetchSite === "cross-site") return false;
  const origin = rawHeader(event, "origin");
  if (!origin) return false;
  let originHost = "";
  try { originHost = new URL(origin).host.toLowerCase(); } catch (_err) { return false; }
  const hosts = [rawHeader(event, "x-forwarded-host"), rawHeader(event, "host")]
    .filter(Boolean)
    .map(function (host) { return host.toLowerCase().replace(/:\d+$/, ""); });
  if (!hosts.length) return true;
  return hosts.indexOf(originHost) !== -1;
}

function field(name, label, value) {
  return "<label>" + label + "<input name=\"" + name + "\" type=\"url\" inputmode=\"url\" maxlength=\"500\" placeholder=\"https://\" autocomplete=\"off\" spellcheck=\"false\" value=\"" + esc(value) + "\"></label>";
}

function formPage(lang, values, error) {
  const es = lang === "es";
  const title = es ? "Enlaces de reseñas" : "Review links";
  const lead = es
    ? "Estos enlaces quedan en tu cuenta. El cliente ve Abrir. HomeLink no escribe el número."
    : "These links stay on your account. The client sees Open. HomeLink does not write the count.";
  const save = es ? "Guardar en la cuenta" : "Save on the account";
  const message = error ? "<p class=\"error\">" + esc(error) + "</p>" : "";
  return html(error ? 400 : 200,
    "<h1>" + title + "</h1><p class=\"lead\">" + lead + "</p>" + message +
    "<form method=\"post\">" +
    field("google", "Google", values.google) +
    field("yelp", "Yelp", values.yelp) +
    field("website", es ? "Sitio web" : "Website", values.website) +
    "<button type=\"submit\">" + save + "</button></form>",
    lang
  );
}

function returnPage(origin, sources) {
  const packed = encodeURIComponent(JSON.stringify(sources));
  const target = JSON.stringify(origin + "/#rs=" + packed);
  return html(200, "<p class=\"plain\">Returning to HomeLink.</p><script>location.replace(" + target + ");</script>");
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
    if (!sameSitePost(event)) {
      const blocked = lang === "es"
        ? "Vuelve a abrir esta página desde HomeLink y guarda otra vez."
        : "Open this page again from HomeLink, then save.";
      return html(403, "<p class=\"plain\">" + blocked + "</p>", lang);
    }
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
