/**
 * MG-SUPPORT-003C — platform-admin Support case resolve/reopen.
 * POST /.netlify/functions/mg-support-admin-update-case
 *
 * Auth: HMAC mg_session + public.users.is_admin. session.c not required.
 * Closed PATCH only. No OpenAI. No DELETE. Browser never sets status.
 */
"use strict";

const { assertPlatformAdminSession } = require("./_lib/mg-support/require-platform-admin");
const { parseUpdateBody, updateAdminCase } = require("./_lib/mg-support/admin-cases");

const MAX_BODY_CHARS = 4096;

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
      if (method !== "POST") {
        return json(405, { ok: false, result: "invalid_request", error: "Method not allowed." });
      }

      const rawBody = event?.body == null ? "" : String(event.body);
      if (rawBody.length > MAX_BODY_CHARS) {
        return json(400, { ok: false, result: "invalid_request", error: "Request is too large." });
      }

      let body = {};
      try {
        body = rawBody ? JSON.parse(rawBody) : {};
      } catch (_err) {
        return json(400, { ok: false, result: "invalid_request", error: "Send a JSON body." });
      }

      const parsed = parseUpdateBody(body);
      if (!parsed.ok) {
        return json(400, {
          ok: false,
          result: "invalid_request",
          error: "That request is not valid.",
        });
      }

      const q = event?.queryStringParameters || {};
      if (Object.keys(q).length) {
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

      const updated = await updateAdminCase(
        { case_id: parsed.case_id, action: parsed.action },
        deps
      );
      if (!updated.ok) {
        console.error("[mg-support-admin]", {
          result: updated.result,
          action: parsed.action,
          case_id: parsed.case_id,
        });
        return json(updated.result === "write_failed" ? 502 : 400, {
          ok: false,
          result: updated.result,
          error: "The support case could not be updated.",
        });
      }

      console.log("[mg-support-admin]", {
        result: updated.result,
        action: parsed.action,
        case_id: parsed.case_id,
      });

      const http =
        updated.result === "not_found"
          ? 404
          : 200;
      return json(http, {
        ok: updated.result !== "not_found",
        result: updated.result,
        case_id: updated.case_id || parsed.case_id,
        case_ref: updated.case_ref || null,
        status: updated.status || null,
        resolved_at: updated.resolved_at === undefined ? null : updated.resolved_at,
        updated_at: updated.updated_at || null,
      });
    } catch (_err) {
      console.error("[mg-support-admin]", { result: "write_failed" });
      return json(500, {
        ok: false,
        result: "write_failed",
        error: "The support case could not be updated.",
      });
    }
  };
}

exports.handler = createHandler();
exports.createHandler = createHandler;
