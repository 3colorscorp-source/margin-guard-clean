/**
 * CH-013A.2.0 — Signing Link Builder.
 * Sole authority for secure signing URL construction.
 *
 * CRITICAL: A signing URL may be built ONLY when an authorized caller supplies
 * the raw token from the one-time token mint response. Never rebuild from
 * token_hash, token_id, generation_id, or any database metadata.
 */

"use strict";

const API_VERSION = "ch-013a20-v1";
const DEFAULT_PATH_SHAPE = "/contract-sign?token={token}";

/** Fields that must never be treated as a raw signing token. */
const FORBIDDEN_TOKEN_SOURCES = Object.freeze([
  "token_hash",
  "token_id",
  "generation_id",
  "invitation_id",
  "hash",
]);

function trimField(value) {
  return value == null ? "" : String(value).trim();
}

function resolvePublicOrigin(explicitOrigin) {
  const fromArg = trimField(explicitOrigin);
  if (fromArg) return fromArg.replace(/\/+$/, "");
  const fromEnv =
    trimField(process.env.PUBLIC_SITE_URL) ||
    trimField(process.env.SITE_URL) ||
    trimField(process.env.URL);
  if (fromEnv) return fromEnv.replace(/\/+$/, "");
  return "";
}

/**
 * Reject any attempt to construct a link from hash / id metadata.
 */
function assertNoForbiddenSources(input = {}) {
  for (const key of FORBIDDEN_TOKEN_SOURCES) {
    if (
      Object.prototype.hasOwnProperty.call(input, key) &&
      input[key] != null &&
      trimField(input[key]) !== ""
    ) {
      return {
        ok: false,
        error: `SigningLinkBuilder cannot use ${key} to build a URL`,
        code: "forbidden_token_source",
      };
    }
  }
  return { ok: true };
}

/**
 * Build a secure signing URL from a one-shot raw token only.
 *
 * @param {{
 *   raw_token?: string,
 *   public_origin?: string,
 *   path_shape?: string,
 *   expires_at?: string|null,
 *   generation_number?: number|null,
 * }} input
 */
function buildSigningLink(input = {}) {
  const forbidden = assertNoForbiddenSources(input);
  if (!forbidden.ok) return forbidden;

  const rawToken = trimField(input.raw_token);
  if (!rawToken) {
    return {
      ok: false,
      error: "link_unavailable: raw_token is required; cannot reconstruct from hash or ids",
      code: "link_unavailable",
    };
  }

  const pathShape = trimField(input.path_shape) || DEFAULT_PATH_SHAPE;
  if (!pathShape.includes("{token}")) {
    return {
      ok: false,
      error: "path_shape must include {token}",
      code: "invalid_path_shape",
    };
  }

  const path = pathShape.replace("{token}", encodeURIComponent(rawToken));
  let url = path;
  if (!/^https?:\/\//i.test(path)) {
    const origin = resolvePublicOrigin(input.public_origin);
    if (!origin) {
      url = path.startsWith("/") ? path : `/${path}`;
    } else {
      url = `${origin}${path.startsWith("/") ? "" : "/"}${path}`;
    }
  }

  return {
    ok: true,
    api_version: API_VERSION,
    signing_link: {
      url,
      path_shape: DEFAULT_PATH_SHAPE,
      expires_at: input.expires_at || null,
      generation_number:
        input.generation_number != null ? Number(input.generation_number) : null,
    },
  };
}

module.exports = {
  API_VERSION,
  DEFAULT_PATH_SHAPE,
  FORBIDDEN_TOKEN_SOURCES,
  buildSigningLink,
  resolvePublicOrigin,
  assertNoForbiddenSources,
  trimField,
};
