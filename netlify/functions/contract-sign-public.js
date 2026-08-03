/**
 * CH-011F — Public contract signing read.
 * GET /.netlify/functions/contract-sign-public?token=
 * Token-gated. Read-only. No session. No mutations.
 */

"use strict";

const { trimField } = require("./_lib/contract-signing-token");
const {
  API_VERSION,
  loadPublicContractByToken,
} = require("./_lib/contract-sign-public");

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

    // Do not log the raw token.
    const result = await loadPublicContractByToken(queryParam(event, "token"));
    if (!result.ok) {
      return json(result.status || 400, {
        ok: false,
        error: result.error,
        code: result.code,
        version: API_VERSION,
      });
    }

    return json(200, {
      ok: true,
      version: API_VERSION,
      contract: result.contract,
    });
  } catch (err) {
    console.error(
      "contract-sign-public",
      err?.message || err,
      err?.supabaseStatus || "",
      String(err?.supabaseRaw || "").slice(0, 200)
    );
    return json(500, {
      ok: false,
      error: "Server error",
      code: "server_error",
    });
  }
};

exports._test = { API_VERSION };
