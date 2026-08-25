/**
 * MG-SUPPORT-003C — platform-admin Support Inbox list.
 * GET /.netlify/functions/mg-support-admin-list-cases
 *
 * Auth: HMAC mg_session + public.users.is_admin. session.c not required.
 * Read-only. No OpenAI. No browser-supplied tenant id.
 */
"use strict";

const { assertPlatformAdminSession } = require("./_lib/mg-support/require-platform-admin");
const { parseListQuery, listAdminCases } = require("./_lib/mg-support/admin-cases");

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

function createHandler(deps = {}) {
  const assertAdmin = deps.assertPlatformAdminSession || assertPlatformAdminSession;

  return async function handler(event) {
    try {
      const method = String(event?.httpMethod || "GET").toUpperCase();
      if (method !== "GET") {
        return json(405, { ok: false, result: "invalid_request", error: "Method not allowed." });
      }

      const parsed = parseListQuery(event?.queryStringParameters || {});
      if (!parsed.ok) {
        return json(400, {
          ok: false,
          result: "invalid_request",
          error: "That request is not valid.",
        });
      }

      const gate = await assertAdmin(event, deps);
      if (!gate?.ok) {
        return json(401, {
          ok: false,
          result: "not_authorized",
          error: "Platform administrator access is required.",
        });
      }

      const listed = await listAdminCases(parsed.filters, deps);
      if (!listed.ok) {
        console.error("[mg-support-admin]", { result: listed.result });
        return json(502, {
          ok: false,
          result: "read_failed",
          error: "Support cases could not be loaded.",
        });
      }

      return json(200, {
        ok: true,
        result: "ok",
        filters: listed.filters,
        counts: listed.counts,
        cases: listed.cases,
        page: listed.page,
      });
    } catch (_err) {
      console.error("[mg-support-admin]", { result: "read_failed" });
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
