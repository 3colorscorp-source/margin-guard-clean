/**
 * Owner gate for Financial Connections / bank monitoring.
 *
 * Authority: signed mg_session email + server tenant/membership resolution.
 * Does NOT require or trust session.c (cookie-carried Stripe customer id).
 * Seller/supervisor mg_device_session cookies are ignored (this module never reads them).
 */
"use strict";

const { readSessionFromEvent } = require("./session");
const { resolveTenantFromSession } = require("./tenant-for-session");

function json(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  };
}

async function requireFcOwnerTenant(event, deps = {}) {
  const readSession = deps.readSessionFromEvent || readSessionFromEvent;
  const resolveTenant = deps.resolveTenantFromSession || resolveTenantFromSession;
  const session = readSession(event);
  if (!session || !String(session.e || "").trim()) {
    return { ok: false, response: json(401, { error: "Unauthorized" }) };
  }
  const tenant = await resolveTenant(session, deps);
  if (!tenant?.id) {
    return { ok: false, response: json(404, { error: "Tenant not found" }) };
  }
  return { ok: true, session, tenant };
}

module.exports = { json, requireFcOwnerTenant };
