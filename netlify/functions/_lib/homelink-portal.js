"use strict";

const crypto = require("crypto");

const DEV_ORIGIN = "http://127.0.0.1:4173";
const SCOPES = [
  "project:read",
  "documents:read",
  "quote:download",
  "contract:download",
  "requests:write",
  "reviews:write"
];
const COMMERCIAL = ["logo", "business_name", "business_phone", "business_email", "business_address", "license"];
const MAX_GRANT_MS = 90 * 24 * 60 * 60 * 1000;
const TICKET_MS = 10 * 60 * 1000;
const INVITE_MS = 30 * 60 * 1000;
const CLIENT_REF_RE = /^[A-Za-z0-9_-]{6,80}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{20,200}$/;
const FORBIDDEN_KEYS = [
  "client_email",
  "client_phone",
  "client_name",
  "customer_email",
  "customer_name",
  "customer_phone",
  "project_address",
  "job_site",
  "quote_project_address",
  "address_line1",
  "margin",
  "labor_cost",
  "labor_budget",
  "sale_price",
  "recommended_price",
  "minimum_price",
  "hourly_rate",
  "internal_notes",
  "notes",
  "tenant_id",
  "sell_subtotal"
];

function trim(value) {
  return String(value == null ? "" : value).trim();
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function newToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function exactOrigin(value) {
  const raw = trim(value);
  if (!raw || raw === "*") return "";
  try {
    const url = new URL(raw);
    if (url.username || url.password || url.search || url.hash) return "";
    if (url.pathname !== "/" && url.pathname !== "") return "";
    if (url.origin !== raw) return "";
    return url.origin;
  } catch (_err) {
    return "";
  }
}

function allowedOrigins(env) {
  const source = env || process.env;
  const configured = exactOrigin(source.HOMELINK_ORIGIN);
  return configured ? [DEV_ORIGIN, configured] : [DEV_ORIGIN];
}

function requestOrigin(event) {
  const headers = event && event.headers ? event.headers : {};
  return trim(headers.origin || headers.Origin);
}

function corsHeaders(event, env) {
  const origin = requestOrigin(event);
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Cache-Control": "no-store",
    Vary: "Origin"
  };
  if (allowedOrigins(env).indexOf(origin) !== -1) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function bearerToken(event) {
  const headers = event && event.headers ? event.headers : {};
  const header = trim(headers.authorization || headers.Authorization);
  const match = /^Bearer\s+([A-Za-z0-9_-]{20,200})$/.exec(header);
  return match ? match[1] : "";
}

function cityFromAddress(address) {
  const parts = trim(address).split(",").map(function (part) { return part.trim(); }).filter(Boolean);
  if (parts.length < 2) return "";
  let city = parts.length >= 3 ? parts[parts.length - 2] : parts[1];
  city = city.replace(/\b\d{5}(?:-\d{4})?\b/g, "").replace(/\b[A-Z]{2}\b/g, "").trim();
  if (!city || city === parts[0]) return "";
  return city.slice(0, 80);
}

function containsForbidden(value) {
  if (value == null) return false;
  if (Array.isArray(value)) return value.some(containsForbidden);
  if (typeof value !== "object") return false;
  return Object.keys(value).some(function (key) {
    return FORBIDDEN_KEYS.indexOf(key) !== -1 || containsForbidden(value[key]);
  });
}

function cleanList(values, allowed) {
  const seen = Object.create(null);
  const out = [];
  (Array.isArray(values) ? values : []).forEach(function (value) {
    const item = trim(value);
    if (!allowed[item] || seen[item]) return;
    seen[item] = true;
    out.push(item);
  });
  return out;
}

function clientRefFromName(name) {
  const slug = trim(name)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return CLIENT_REF_RE.test(slug) ? slug : "";
}

function validateIssue(body, now) {
  const src = body && typeof body === "object" ? body : {};
  if (Object.prototype.hasOwnProperty.call(src, "tenant_id")) {
    return { ok: false, status: 400, code: "tenant_forbidden" };
  }
  const projectId = trim(src.project_id).toLowerCase();
  const clientRef = trim(src.client_ref);
  const scopes = cleanList(src.scopes, Object.fromEntries(SCOPES.map(function (scope) { return [scope, true]; })));
  const commercial = cleanList(src.commercial, Object.fromEntries(COMMERCIAL.map(function (item) { return [item, true]; })));
  const expiresAt = Date.parse(src.expires_at);
  const current = Number(now || Date.now());
  if (!/^[0-9a-f-]{36}$/.test(projectId) || !CLIENT_REF_RE.test(clientRef) || !scopes.length) {
    return { ok: false, status: 400, code: "invalid_grant" };
  }
  if (!Number.isFinite(expiresAt) || expiresAt <= current || expiresAt > current + MAX_GRANT_MS) {
    return { ok: false, status: 400, code: "invalid_expiry" };
  }
  return {
    ok: true,
    grant: {
      projectId: projectId,
      clientRef: clientRef,
      scopes: scopes,
      commercial: commercial,
      expiresAt: new Date(expiresAt).toISOString()
    }
  };
}

function subjectMatches(grant, input) {
  const src = input && typeof input === "object" ? input : {};
  if (trim(src.tenant_id)) return { ok: false, status: 400, code: "tenant_forbidden" };
  if (!grant) return { ok: false, status: 401, code: "missing_grant" };
  if (trim(src.project_id) && trim(src.project_id).toLowerCase() !== String(grant.project_id || "").toLowerCase()) {
    return { ok: false, status: 403, code: "project_mismatch" };
  }
  if (trim(src.client_ref) && trim(src.client_ref) !== grant.client_ref) {
    return { ok: false, status: 403, code: "client_mismatch" };
  }
  return { ok: true };
}

function inviteUrl(code, env) {
  const source = env || process.env;
  const origin = exactOrigin(source.HOMELINK_ORIGIN) || DEV_ORIGIN;
  return origin + "/?invite=" + encodeURIComponent(code);
}

function inviteUsable(invite, now) {
  if (!invite) return { ok: false, status: 404, code: "not_found" };
  if (invite.used_at) return { ok: false, status: 409, code: "used" };
  if (Date.parse(invite.expires_at) <= Number(now || Date.now())) {
    return { ok: false, status: 403, code: "expired" };
  }
  return { ok: true };
}

function grantAllows(grant, scope, now) {
  if (!grant) return { ok: false, status: 401, code: "missing_grant" };
  if (grant.revoked_at) return { ok: false, status: 403, code: "revoked" };
  if (Date.parse(grant.expires_at) <= Number(now || Date.now())) {
    return { ok: false, status: 403, code: "expired" };
  }
  const scopes = Array.isArray(grant.scopes) ? grant.scopes : [];
  if (scopes.indexOf(scope) === -1) return { ok: false, status: 403, code: "scope_denied" };
  return { ok: true };
}

function consumeTicket(ticket, now) {
  if (!ticket) return { ok: false, status: 404, code: "not_found" };
  if (ticket.used_at) return { ok: false, status: 409, code: "used" };
  if (Date.parse(ticket.expires_at) <= Number(now || Date.now())) {
    return { ok: false, status: 403, code: "expired" };
  }
  return { ok: true };
}

function areaNames(breakdown) {
  const areas = breakdown && Array.isArray(breakdown.areas) ? breakdown.areas : [];
  return areas.map(function (area) {
    return {
      name: trim(area && area.name).slice(0, 80),
      scope: trim(area && area.scope).slice(0, 400)
    };
  }).filter(function (area) { return area.name; });
}

function quoteAccepted(quote) {
  if (!quote) return false;
  if (trim(quote.status).toLowerCase() === "accepted") return true;
  return trim(quote.accepted_at) !== "";
}

function commercialView(grant, branding, licenseNumber) {
  const allowed = Array.isArray(grant && grant.commercial) ? grant.commercial : [];
  const source = branding || {};
  const out = {};
  if (allowed.indexOf("logo") !== -1) {
    const logo = trim(source.logo_url);
    out.logo_url = /^https:\/\//.test(logo) ? logo : "";
  }
  if (allowed.indexOf("business_name") !== -1) out.business_name = trim(source.business_name);
  if (allowed.indexOf("business_phone") !== -1) out.business_phone = trim(source.business_phone);
  if (allowed.indexOf("business_email") !== -1) out.business_email = trim(source.business_email);
  if (allowed.indexOf("business_address") !== -1) out.business_address = trim(source.business_address);
  if (allowed.indexOf("license") !== -1) out.contractor_license_number = trim(licenseNumber);
  return out;
}

function projectSummary(input) {
  const project = input && input.project ? input.project : {};
  const quote = input && input.quote ? input.quote : {};
  const documents = {
    accepted_quote: quoteAccepted(quote),
    signed_contract: Boolean(input && input.signedContract)
  };
  const summary = {
    ok: true,
    project: {
      name: trim(project.project_name || quote.project_name),
      type: trim(quote.title || project.project_name).slice(0, 80),
      city: cityFromAddress(quote.project_address),
      status: trim(project.status)
    },
    commercial: commercialView(input && input.grant, input && input.branding, input && input.licenseNumber),
    documents: documents,
    areas: areaNames(quote.labor_area_breakdown)
  };
  if (input && input.sharedReview) summary.shared_review = sharedReview(input.sharedReview);
  return summary;
}

function quoteDownloadView(quote) {
  if (!quoteAccepted(quote)) return { ok: false, status: 404, code: "not_accepted" };
  return {
    ok: true,
    view: {
      project_name: trim(quote.project_name || quote.title),
      project_type: trim(quote.title).slice(0, 80),
      city: cityFromAddress(quote.project_address),
      total: Number(quote.total),
      currency: trim(quote.currency) || "USD",
      scope_of_work: trim(quote.scope_of_work),
      areas: areaNames(quote.labor_area_breakdown)
    }
  };
}

function safePhoto(value) {
  const photo = String(value || "");
  if (!/^data:image\/(png|jpeg|webp);base64,[a-zA-Z0-9+/=]+$/.test(photo)) return "";
  if (photo.length > 500000) return "";
  return photo;
}

function reviewRecord(input) {
  const src = input || {};
  return {
    opinion: trim(src.opinion).slice(0, 600),
    project_type: trim(src.project_type).slice(0, 80),
    city: trim(src.city).slice(0, 80),
    before_photo: safePhoto(src.before_photo),
    after_photo: safePhoto(src.after_photo),
    visibility: src.visibility === "shared" ? "shared" : "private"
  };
}

function sharedReview(record) {
  const clean = reviewRecord(record);
  if (clean.visibility !== "shared") return null;
  return {
    opinion: clean.opinion,
    project_type: clean.project_type,
    city: clean.city,
    before_photo: clean.before_photo,
    after_photo: clean.after_photo
  };
}

function serviceRequestInput(body) {
  const src = body && typeof body === "object" ? body : {};
  const title = trim(src.title).slice(0, 300);
  const details = trim(src.details).slice(0, 4000);
  if (title.length < 3 || details.length < 10) return { ok: false, status: 400, code: "invalid_request" };
  if (src.approve_warranty || src.create_project || src.tenant_id) {
    return { ok: false, status: 400, code: "forbidden_action" };
  }
  return { ok: true, title: title, details: details };
}

function tokenMatches(storedHash, rawToken) {
  if (!TOKEN_RE.test(rawToken) || !/^[a-f0-9]{64}$/.test(storedHash)) return false;
  const actual = Buffer.from(sha256(rawToken), "hex");
  const expected = Buffer.from(storedHash, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

module.exports = {
  DEV_ORIGIN,
  SCOPES,
  COMMERCIAL,
  TICKET_MS,
  INVITE_MS,
  FORBIDDEN_KEYS,
  sha256,
  newToken,
  exactOrigin,
  allowedOrigins,
  corsHeaders,
  bearerToken,
  cityFromAddress,
  containsForbidden,
  clientRefFromName,
  validateIssue,
  subjectMatches,
  inviteUrl,
  inviteUsable,
  grantAllows,
  consumeTicket,
  projectSummary,
  quoteDownloadView,
  reviewRecord,
  sharedReview,
  serviceRequestInput,
  tokenMatches
};
