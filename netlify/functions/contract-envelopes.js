/**
 * CH-011B — List Contract Envelopes for a package (Owner/Admin, read-only).
 * GET /.netlify/functions/contract-envelopes?package_id=...
 *
 * Newest first. No writes.
 */

"use strict";

const { requireOwnerOrAdmin } = require("./_lib/require-owner-or-admin");

const {
  API_VERSION,
  validUuid,
  unknownKeys,
  loadPackageForTenant,
  listEnvelopesForPackage,
  trimField,
} = require("./_lib/contract-envelope");

const ALLOWED_QUERY_KEYS = new Set(["package_id"]);

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function singleQueryValue(value) {
  if (Array.isArray(value)) return value[0];
  return value;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") {
      return json(204, {});
    }
    if (event.httpMethod !== "GET") {
      return json(405, {
        ok: false,
        error: "Method not allowed",
        code: "method_not_allowed",
      });
    }

    const query = event.queryStringParameters || {};
    const unknown = unknownKeys(query, ALLOWED_QUERY_KEYS);
    if (unknown.length) {
      return json(400, {
        ok: false,
        error: `Unknown query fields: ${unknown.join(", ")}`,
        code: "unknown_fields",
      });
    }

    const packageId = trimField(singleQueryValue(query.package_id)).toLowerCase();
    if (!validUuid(packageId)) {
      return json(400, {
        ok: false,
        error: "package_id is required",
        code: "invalid_package_id",
      });
    }

    const { tenant } = await requireOwnerOrAdmin(event);
    const pkg = await loadPackageForTenant(tenant.id, packageId);
    if (!pkg?.id) {
      return json(404, {
        ok: false,
        error: "Contract package not found",
        code: "not_found",
      });
    }

    const envelopes = await listEnvelopesForPackage(tenant.id, packageId);
    return json(200, {
      ok: true,
      version: API_VERSION,
      package_id: packageId,
      envelopes,
    });
  } catch (err) {
    if (err?.isGuardError) {
      return json(err.statusCode || 403, {
        ok: false,
        error: err.message,
        code: err.code,
      });
    }
    console.error("contract-envelopes", err);
    return json(500, {
      ok: false,
      error: "Server error",
      code: "server_error",
    });
  }
};

exports._test = {
  ALLOWED_QUERY_KEYS,
  API_VERSION,
};
