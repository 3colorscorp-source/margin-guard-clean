"use strict";

const { requireOwnerOrAdmin } = require("./_lib/require-owner-or-admin");
const { supabaseRequest } = require("./_lib/supabase-admin");
const portal = require("./_lib/homelink-portal");

const ACCEPTED = { accepted: true, approved: true };
const SENT = { sent: true, ready_to_send: true };

function trim(value) {
  return String(value == null ? "" : value).trim();
}

function clip(value, max) {
  return trim(value).slice(0, max);
}

function rowView(row) {
  return {
    project_name: clip(row && (row.project_name || row.title), 120),
    client_name: clip(row && row.client_name, 80)
  };
}

function splitQuotes(rows) {
  const accepted = [];
  const sent = [];
  const list = Array.isArray(rows) ? rows : [];
  for (let i = 0; i < list.length; i += 1) {
    const row = list[i];
    const status = trim(row && row.status).toLowerCase();
    if (ACCEPTED[status] && accepted.length < 40) accepted.push(rowView(row));
    else if (SENT[status] && sent.length < 40) sent.push(rowView(row));
  }
  return { accepted: accepted, sent: sent };
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
    body: "<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>HomeLink quotes</title></head><body>" + body + "</body></html>"
  };
}

async function listForTenant(tenantId) {
  const data = await supabaseRequest(
    "quotes?tenant_id=eq." + encodeURIComponent(tenantId) +
    "&status=in.(accepted,approved,sent,ready_to_send)" +
    "&select=project_name,title,client_name,status,created_at" +
    "&order=created_at.desc&limit=80"
  );
  return Array.isArray(data) ? data : [];
}

function returnPage(origin, board) {
  const packed = encodeURIComponent(JSON.stringify(board));
  const target = JSON.stringify(origin + "/#qb=" + packed);
  return html(200, "<p>Returning to HomeLink.</p><script>location.replace(" + target + ");</script>");
}

exports.splitQuotes = splitQuotes;

exports.handler = async function (event, deps) {
  const options = deps || {};
  const ownerGate = options.requireOwnerOrAdmin || requireOwnerOrAdmin;
  const load = options.listForTenant || listForTenant;
  const origin = portal.exactOrigin(options.homeOrigin || process.env.HOMELINK_ORIGIN);
  try {
    if (!event || event.httpMethod !== "GET") return html(405, "<p>method_not_allowed</p>");
    const query = event.queryStringParameters || {};
    if (Object.prototype.hasOwnProperty.call(query, "tenant_id")) return html(400, "<p>tenant_forbidden</p>");
    let actor;
    try {
      actor = await ownerGate(event);
    } catch (err) {
      const code = err && err.code ? err.code : "no_session";
      return html(err && err.statusCode ? err.statusCode : 401, "<p>" + code + "</p>");
    }
    const tenantId = actor && actor.tenant && actor.tenant.id;
    if (!tenantId) return html(401, "<p>no_session</p>");
    if (!origin) return html(503, "<p>handoff_not_configured</p>");
    const board = splitQuotes(await load(tenantId));
    return returnPage(origin, board);
  } catch (_err) {
    return html(500, "<p>server_error</p>");
  }
};
