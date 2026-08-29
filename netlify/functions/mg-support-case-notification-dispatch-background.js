/**
 * MG-SUPPORT-003E.2D2 — Support case notification background dispatch.
 * POST /.netlify/functions/mg-support-case-notification-dispatch-background
 *
 * Auth: SUPPORT_CASE_EMAIL_DISPATCH_SECRET via X-MG-Dispatch-Key.
 * Body: event_id only. Recipient, template, HMAC, and webhook are server-derived.
 * Returns 2xx after auth so Netlify does not retry a claimed event.
 */
"use strict";

const {
  assertDispatchAuth,
  parseDispatchBody,
  dispatchPendingEvent,
} = require("./_lib/mg-support/notification-delivery");

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

function safeBody(result) {
  return {
    ok: Boolean(result && result.ok),
    result: result && result.result ? result.result : "write_failed",
    event_id: result && result.event_id ? result.event_id : null,
    event_type: result && result.event_type ? result.event_type : null,
    case_ref: result && result.case_ref ? result.case_ref : null,
    delivery_status: result && result.delivery_status ? result.delivery_status : null,
    result_code: result && result.result_code ? result.result_code : null,
  };
}

function createHandler(deps = {}) {
  const dispatch = deps.dispatchPendingEvent || dispatchPendingEvent;

  return async function handler(event) {
    try {
      const method = String(event && event.httpMethod ? event.httpMethod : "POST").toUpperCase();
      if (method !== "POST") {
        return json(405, { ok: false, result: "invalid_request" });
      }

      const gate = assertDispatchAuth(event, deps);
      if (!gate.ok) {
        return json(gate.status, { ok: false, result: gate.result });
      }

      const parsed = parseDispatchBody(event && event.body);
      if (!parsed.ok) {
        return json(400, { ok: false, result: "invalid_request" });
      }

      const result = await dispatch(parsed.event_id, deps);
      return json(200, safeBody(result));
    } catch (_err) {
      console.error("[mg-support-notify]", { result: "write_failed" });
      return json(200, { ok: false, result: "write_failed" });
    }
  };
}

exports.handler = createHandler();
exports.createHandler = createHandler;
