/**
 * CH-011D — Lookup / validate signing token by raw value.
 * GET /.netlify/functions/contract-signing-token?token=
 * Validates active / expired / revoked / consumed. Never returns raw token or hash.
 */

"use strict";

const {
  API_VERSION,
  lookupSigningToken,
  trimField,
} = require("./_lib/contract-signing-token");

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function queryParam(event, key) {
  const q = event?.queryStringParameters || {};
  return trimField(q[key]);
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") return json(204, {});
    if (event.httpMethod !== "GET") {
      return json(405, {
        ok: false,
        error: "Method not allowed",
        code: "method_not_allowed",
      });
    }

    const result = await lookupSigningToken({
      rawToken: queryParam(event, "token"),
    });

    if (!result.ok) {
      return json(result.status || 400, {
        ok: false,
        error: result.error,
        code: result.code,
        token: result.token || undefined,
        version: API_VERSION,
      });
    }

    return json(200, {
      ok: true,
      version: API_VERSION,
      validity: result.validity,
      token: result.token,
    });
  } catch (err) {
    console.error("contract-signing-token", err);
    return json(500, {
      ok: false,
      error: "Server error",
      code: "server_error",
    });
  }
};

exports._test = { API_VERSION };
