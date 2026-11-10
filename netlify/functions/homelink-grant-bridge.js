"use strict";

const { requireOwnerOrAdmin } = require("./_lib/require-owner-or-admin");
const portal = require("./_lib/homelink-portal");
const store = require("./_lib/homelink-portal-store");
const handoff = require("./_lib/homelink-handoff");

function trim(value) {
  return String(value == null ? "" : value).trim();
}

function json(statusCode, body) {
  return {
    statusCode: statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer"
    },
    body: JSON.stringify(body)
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
    body: "<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>HomeLink access</title></head><body>" + body + "</body></html>"
  };
}

function requestFields(event) {
  const query = event.queryStringParameters || {};
  let body = {};
  if (event.body) {
    try {
      body = JSON.parse(event.body);
    } catch (_err) {
      body = {};
    }
  }
  if (!body || typeof body !== "object") body = {};
  const pick = function (key) {
    return body[key] != null && String(body[key]) !== "" ? body[key] : query[key];
  };
  const list = function (key) {
    const value = pick(key);
    if (Array.isArray(value)) return value;
    return String(value || "").split(",").map(trim).filter(Boolean);
  };
  return {
    action: pick("action") === "revoke" ? "revoke" : "issue",
    project_id: trim(pick("project_id")),
    client_ref: trim(pick("client_ref")),
    expires_at: trim(pick("expires_at")),
    scopes: list("scopes"),
    commercial: list("commercial"),
    grant_id: trim(pick("grant_id"))
  };
}

function foreignOrigin(event) {
  const headers = event && event.headers ? event.headers : {};
  const origin = trim(headers.origin || headers.Origin);
  if (!origin) return false;
  const host = trim(headers["x-forwarded-host"] || headers["X-Forwarded-Host"] || headers.host || headers.Host).split(",")[0].trim();
  if (!host) return true;
  try {
    return new URL(origin).host !== host;
  } catch (_err) {
    return true;
  }
}

function page(fields) {
  const payload = JSON.stringify(fields).replace(/</g, "\\u003c");
  return html(200, [
    "<h1>Confirm HomeLink access</h1>",
    "<p>Margin Guard will check the contractor session on this site. The session cookie stays here.</p>",
    "<p id=\"summary\"></p>",
    "<button id=\"confirm\" type=\"button\">Confirm and issue</button>",
    "<p id=\"status\"></p>",
    "<p><a id=\"invite\" href=\"\"></a></p>",
    "<script type=\"application/json\" id=\"request\">" + payload + "</script>",
    "<script>",
    "var request = JSON.parse(document.getElementById(\"request\").textContent);",
    "document.getElementById(\"summary\").textContent = request.action === \"revoke\" ? \"Revoke grant \" + request.grant_id : \"Project \" + request.project_id + \" for \" + request.client_ref;",
    "document.getElementById(\"confirm\").textContent = request.action === \"revoke\" ? \"Confirm and revoke\" : \"Confirm and issue\";",
    "document.getElementById(\"confirm\").addEventListener(\"click\", function () {",
    "  fetch(location.pathname, { method: \"POST\", credentials: \"same-origin\", headers: { \"Content-Type\": \"application/json\" }, body: JSON.stringify(request) })",
    "    .then(function (res) { return res.json(); })",
    "    .then(function (body) {",
    "      document.getElementById(\"status\").textContent = body.ok ? \"Invitation ready.\" : (body.code || \"Unable to issue access\");",
    "      var link = document.getElementById(\"invite\");",
    "      if (body.invite_url) { link.href = body.invite_url; link.textContent = body.invite_url; }",
    "    });",
    "});",
    "</script>"
  ].join(""));
}

async function postAccept(origin, proof) {
  const base = portal.exactOrigin(String(origin || "").trim().replace(/\/+$/, ""));
  if (!base) return { status: 503, body: { ok: false, code: "handoff_not_configured" } };
  const response = await fetch(base + "/.netlify/functions/homelink-grant-accept", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(proof)
  });
  let body = {};
  try {
    body = await response.json();
  } catch (_err) {
    body = { ok: false, code: "invalid_handoff" };
  }
  return { status: response.status, body: body };
}

exports.handler = async function (event, deps) {
  const options = deps || {};
  const ownerGate = options.requireOwnerOrAdmin || requireOwnerOrAdmin;
  const findProject = options.projectForTenant || store.projectForTenant;
  const deliver = options.postAccept || postAccept;
  const secret = options.secret || process.env.HOMELINK_HANDOFF_SECRET;
  const origin = options.homeOrigin || process.env.HOMELINK_ORIGIN;
  const now = options.now || Date.now();
  try {
    if (event.httpMethod === "GET") {
      try {
        await ownerGate(event);
      } catch (err) {
        const code = err && err.code ? err.code : "no_session";
        return html(err && err.statusCode ? err.statusCode : 401, "<p>" + code + "</p>");
      }
      return page(requestFields(event));
    }
    if (event.httpMethod !== "POST") return json(405, { ok: false, code: "method_not_allowed" });
    if (foreignOrigin(event)) return json(403, { ok: false, code: "cookie_not_shared" });
    let actor;
    try {
      actor = await ownerGate(event);
    } catch (err) {
      return json(err && err.statusCode ? err.statusCode : 401, { ok: false, code: err && err.code ? err.code : "no_session" });
    }
    const fields = requestFields(event);
    if (fields.action === "revoke") {
      const sealed = handoff.seal(secret, {
        action: "revoke",
        tenantId: actor.tenant.id,
        membershipId: actor.membership && actor.membership.id,
        tenantName: actor.tenant.name,
        grantId: fields.grant_id
      }, now);
      if (!sealed.ok) return json(503, { ok: false, code: sealed.code });
      const accepted = await deliver(origin, sealed.proof);
      return json(accepted.status, {
        ok: Boolean(accepted.body && accepted.body.ok),
        code: accepted.body && accepted.body.code,
        grant_id: accepted.body && accepted.body.grant_id
      });
    }
    const validated = portal.validateIssue(fields, now);
    if (!validated.ok) return json(validated.status, { ok: false, code: validated.code });
    const project = await findProject(actor.tenant.id, validated.grant.projectId);
    if (!project || String(project.id).toLowerCase() !== validated.grant.projectId) {
      return json(404, { ok: false, code: "project_not_found" });
    }
    const sealed = handoff.seal(secret, {
      action: "issue",
      tenantId: actor.tenant.id,
      membershipId: actor.membership && actor.membership.id,
      tenantName: actor.tenant.name,
      project: project,
      grant: {
        project_id: validated.grant.projectId,
        client_ref: validated.grant.clientRef,
        expires_at: validated.grant.expiresAt,
        scopes: validated.grant.scopes,
        commercial: validated.grant.commercial
      }
    }, now);
    if (!sealed.ok) return json(503, { ok: false, code: sealed.code });
    const accepted = await deliver(origin, sealed.proof);
    const body = accepted.body || {};
    return json(accepted.status, {
      ok: Boolean(body.ok),
      code: body.code,
      grant_id: body.grant_id,
      project_id: body.project_id,
      client_ref: body.client_ref,
      expires_at: body.expires_at,
      invite_url: body.invite_url
    });
  } catch (_err) {
    return json(500, { ok: false, code: "server_error" });
  }
};
