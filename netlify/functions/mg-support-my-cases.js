/**
 * MG-SUPPORT-003E.1 — owner My Cases read-only list/detail.
 * GET /.netlify/functions/mg-support-my-cases
 *
 * Auth: signed owner session (e + c). Tenant from session only.
 * GET only. No OpenAI. No case writes. Does not reuse admin list.
 */
"use strict";

const { readSessionFromEvent } = require("./_lib/session");
const { assertOwnerSupportSession, hasOwnerEmailAndCustomer } = require("./_lib/mg-support/require-owner-session");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");
const {
  parseMyCasesQuery,
  readMyCasesList,
  readMyCasesDetail,
} = require("./_lib/mg-support/my-cases");

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(body),
  };
}

function isOverrideKey(name) {
  return /tenant|company|business|organization|workspace/i.test(String(name || ""));
}

function hasOverrideQuery(event) {
  const q = event?.queryStringParameters || {};
  return Object.keys(q || {}).some((k) => isOverrideKey(k));
}

function hasOverrideHeader(event) {
  const headers = event?.headers || {};
  return Object.keys(headers).some((k) => isOverrideKey(k));
}

function hasOverrideBody(event) {
  const raw = String(event?.body || "").trim();
  if (!raw) return false;
  try {
    const body = JSON.parse(raw);
    if (!body || typeof body !== "object" || Array.isArray(body)) return false;
    return Object.keys(body).some((k) => isOverrideKey(k));
  } catch (_err) {
    return false;
  }
}

function createHandler(deps = {}) {
  const readSession = deps.readSessionFromEvent || readSessionFromEvent;
  const assertSession = deps.assertOwnerSupportSession || assertOwnerSupportSession;
  const resolveTenant = deps.resolveTenantFromSession || resolveTenantFromSession;

  return async function handler(event) {
    try {
      const method = String(event?.httpMethod || "GET").toUpperCase();
      if (method !== "GET") {
        return json(405, { ok: false, result: "invalid_request", error: "Method not allowed." });
      }

      if (hasOverrideQuery(event) || hasOverrideHeader(event) || hasOverrideBody(event)) {
        return json(400, {
          ok: false,
          result: "invalid_request",
          error: "That request is not valid.",
        });
      }

      const parsed = parseMyCasesQuery(event?.queryStringParameters || {});
      if (!parsed.ok) {
        return json(400, {
          ok: false,
          result: "invalid_request",
          error: "That request is not valid.",
        });
      }

      const session = readSession(event);
      const sessionGate = await assertSession(session, deps);
      if (!sessionGate?.ok) {
        return json(401, {
          ok: false,
          result: "not_authorized",
          error: "Please sign in to use Ask Margin Guard.",
        });
      }
      if (!hasOwnerEmailAndCustomer(session)) {
        return json(401, {
          ok: false,
          result: "not_authorized",
          error: "Account diagnostics require an active tenant context.",
        });
      }

      let tenant = null;
      try {
        tenant = await resolveTenant(session);
      } catch (_err) {
        console.error("[mg-support-my-cases] tenant resolve failed");
        return json(502, {
          ok: false,
          result: "read_failed",
          error: "Support cases could not be loaded.",
        });
      }
      if (!tenant?.id) {
        return json(403, {
          ok: false,
          result: "no_tenant_context",
          error: "Account diagnostics require an active tenant context.",
        });
      }

      if (parsed.mode === "detail") {
        const lookedUp = await readMyCasesDetail(String(tenant.id), parsed.caseRef, deps);
        if (!lookedUp.ok) {
          if (lookedUp.result === "invalid_request") {
            return json(400, {
              ok: false,
              result: "invalid_request",
              error: "That request is not valid.",
            });
          }
          console.error("[mg-support-my-cases] detail read failed");
          return json(502, {
            ok: false,
            result: "read_failed",
            error: "Support cases could not be loaded.",
          });
        }
        if (lookedUp.result === "not_found") {
          return json(404, {
            ok: false,
            result: "not_found",
            error: "No support case matching that reference was found in your account.",
          });
        }
        return json(200, { ok: true, result: "ok", case: lookedUp.case });
      }

      const listed = await readMyCasesList(String(tenant.id), deps);
      if (!listed.ok) {
        console.error("[mg-support-my-cases] list read failed");
        return json(502, {
          ok: false,
          result: "read_failed",
          error: "Support cases could not be loaded.",
        });
      }
      return json(200, { ok: true, result: "ok", cases: listed.cases });
    } catch (_err) {
      console.error("[mg-support-my-cases] unhandled");
      return json(500, {
        ok: false,
        result: "read_failed",
        error: "Support cases could not be loaded.",
      });
    }
  };
}

exports.handler = createHandler();
exports.createHandler = createHandler;
